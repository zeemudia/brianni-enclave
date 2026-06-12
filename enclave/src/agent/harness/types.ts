import type {
  ChatMessage,
  SkillPack,
  ToolInvocationFrame,
} from "@calypso/chat-types";

import type { AgentLoopDeps, AgentLoopEvent } from "../loop";
import type { DispatchResult } from "../../tools";

/** The per-turn state a lifecycle hook may read. Deliberately excludes `deps`
 *  (hooks are observers, not plumbing — they must not be able to swap the
 *  gateway/provider). The driver hands hooks a FROZEN snapshot of `messages`
 *  per fire, so a hook cannot mutate live loop state. */
export interface TurnContext {
  readonly pack: SkillPack;
  readonly agentTurnId: string;
  readonly messages: readonly Readonly<ChatMessage>[];
}

/**
 * Observer / transformer hooks into the agent loop (the LangChain "custom
 * harness" middleware pattern, dependency-free). All are optional and
 * side-effect-only except `transformOutChunk`. Multiple hook objects run in
 * array order. None may change loop control flow — that is the reinjection
 * chain's job.
 */
export interface LifecycleHooks {
  /** Fired once after the system prompt is assembled, before the first stream. */
  onTurnStart?(ctx: TurnContext): void;
  /** Transform a streamed text chunk before it reaches the wire. Return the
   *  (possibly rewritten) text, or `null` to DROP the chunk entirely. Hooks
   *  chain: each receives the previous hook's output; the first `null` wins. */
  transformOutChunk?(text: string): string | null;
  /** Fired for each tool invocation that is dispatched (the enclave-minted,
   *  R7-sanitised wire frame), just before the `tool-invocation` event. The
   *  frame is a frozen clone — mutating it cannot affect what is dispatched. */
  onToolInvoke?(frame: Readonly<ToolInvocationFrame>, ctx: TurnContext): void;
  /** Fired EXACTLY ONCE as the turn terminates, on ANY exit:
   *  `done` (stream ended cleanly) or `error` — where `error` covers
   *  TOOL_LIMIT_EXCEEDED AND every non-graceful termination (a throw from the
   *  provider/gateway/ACK awaiter or a middleware, an aborted abort-signal, or
   *  the caller abandoning the generator). Suitable for span-close / cleanup. */
  onTurnEnd?(reason: "done" | "error", ctx: TurnContext): void;
}

/**
 * Hook/middleware decomposition of the enclave agent harness.
 * See `docs/design/agent-harness-middleware.md`.
 *
 * These types are deliberately dependency-free — the whole point of the
 * refactor is to capture the LangChain "custom harness" pattern WITHOUT
 * expanding the enclave's trusted computing base / PCR0 measurement.
 */

/** What a reinjection middleware produces: the message the model hears next.
 *  Ledger entries are emitted as yielded `{ kind: 'ledger' }` events (so their
 *  wire ordering is controlled by middleware position, not buried in a return
 *  value) — see `ledgerEmitter` and `memoryWriteAckGate`. */
export interface ReinjectOutcome {
  reinjection: ChatMessage;
}

/** The slice of per-turn state a reinjection middleware may read. Reinjection
 *  middleware are first-party plumbing (not user hooks), so they DO get `deps`
 *  (for the ACK awaiters). Kept minimal — no live message array; middleware
 *  return their message, they do not push it. */
export interface ReinjectTurnContext {
  readonly agentTurnId: string;
  readonly deps: AgentLoopDeps;
}

/** Everything a reinjection middleware sees about one dispatched tool call. */
export interface ToolResultContext {
  /** The exact frame that was dispatched (`prepared.wireFrame`): enclave-minted
   *  invocationId, and for memory.write the R7-canonicalised args. */
  readonly invocation: ToolInvocationFrame;
  /** The raw gateway dispatch result (pre-sanitisation for the model). */
  readonly result: DispatchResult;
  readonly ctx: ReinjectTurnContext;
}

/**
 * The onion. Given a dispatched tool's raw result, decide what is yielded to
 * the wire AND what message the model hears next. `next()` runs the rest of the
 * chain (default sanitize+reinject lives at the tail). A middleware MAY
 * short-circuit by returning without calling `next` — that is exactly what the
 * ACK-gates do.
 *
 * Async-generator-shaped (not value-returning) because emitting wire events
 * mid-await is load-bearing: the memory.write gate yields `memory-write-signed`
 * to the client BEFORE awaiting the durable-persist ACK.
 */
export type ReinjectMiddleware = (
  rc: ToolResultContext,
  next: () => AsyncGenerator<AgentLoopEvent, ReinjectOutcome>,
) => AsyncGenerator<AgentLoopEvent, ReinjectOutcome>;
