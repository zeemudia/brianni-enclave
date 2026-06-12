import { randomUUID } from 'node:crypto';

import {
  PARSER_REJECTION_TOOL_NAME,
  type AgentRequestContext,
  type ChatMessage,
  type ChatProcessor,
  type MemoryMutationEnvelope,
  type SkillPack,
  type ToolCallLedgerEntry,
  type ToolInvocationFrame,
  type ToolResultFrame,
  type ToolName,
  type UsageReportRouteKind,
} from '@calypso/chat-types';

import type { ToolGateway } from '../tools';
import type { ProviderResponseLike } from '../usage-report';
import { assembleSystemPrompt } from './prompt';
import { ToolCallStreamParser } from './parse-tool-call';
import { sanitizeToolOutputForModel } from './tool-output-sanitizer';
import { REINJECT_CHAIN } from './harness/chain';
import { runReinjectChain } from './harness/reinject-chain';
import type { LifecycleHooks, TurnContext } from './harness/types';

type ClientOnlyBinaryWrite = NonNullable<
  Awaited<ReturnType<ToolGateway['dispatch']>>['clientOnlyBinaryWrite']
>;

export interface AgentLoopDeps {
  gateway: ToolGateway;
  provider: ChatProcessor;
  pack: SkillPack;
  /** Server-minted at POST /v1/agent; carried verbatim through the turn. */
  agentTurnId: string;
  /** Maximum tool-call iterations per turn. Defaults to 10. */
  maxToolCalls?: number;
  /** Encrypted client-local context for prompt assembly. */
  requestContext?: AgentRequestContext;
  /**
   * Full effective skill tool scope for orchestrator workers whose runtime pack
   * is narrowed to a subtask. Used only for capability wording in the prompt;
   * the Available tools list and gateway enforcement still use pack.toolScopes.
   */
  fullSkillToolScopes?: readonly ToolName[];
  /**
   * Waits for the client-only binary write ACK that corresponds to a
   * transform output. The loop yields the write request first, then
   * reinjects this terminal status into the model instead of the
   * intermediate `awaiting_client_write` result.
   */
  awaitBinaryWriteAck?: (
    payload: ClientOnlyBinaryWrite,
  ) => Promise<ToolResultFrame>;
  /**
   * Waits for the client's durable-persist ACK for a memory.write after
   * the signed envelope has been delivered (`memory-write-signed`). The
   * loop MUST gate on this before telling the model the write succeeded:
   * signing is Phase 1; the client only durably persists + ACKs in
   * Phase 2/3. Resolves `ok` with the server-authoritative recordVersion
   * once the client posts /tool-result-ack, or an error outcome on
   * persist failure / ack mismatch / timeout. Mirrors
   * {@link awaitBinaryWriteAck}.
   */
  awaitMemoryWriteAck?: (payload: {
    invocationId: string;
    agentTurnId: string;
  }) => Promise<MemoryWriteAckResult>;
  /** Cancels provider/tool-loop work when orchestration or the client aborts. */
  abortSignal?: AbortSignal;
  /**
   * Observer/transformer hooks into the turn (onTurnStart, transformOutChunk,
   * onToolInvoke, onTurnEnd). Run in array order; cannot change control flow.
   * See harness/types.ts and docs/design/agent-harness-middleware.md.
   */
  hooks?: readonly LifecycleHooks[];
}

/** Terminal outcome of the client's durable memory.write ACK round-trip. */
export interface MemoryWriteAckResult {
  outcome: 'ok' | 'error';
  reason?: string;
  /** Server-authoritative record version, present on a confirmed write. */
  recordVersion?: number;
}

export type AgentLoopEvent =
  | { kind: 'chunk'; text: string }
  | { kind: 'tool-invocation'; frame: ToolInvocationFrame }
  /**
   * Internal-only signal that a dispatched tool produced a result, carrying the
   * tool name + the RAW `resultJson` (this fires before sanitizeToolOutputForModel
   * runs on the reinjected copy). The orchestrator executor consumes it to carry
   * a bounded, defanged digest of read-result tools (e.g. web.fetch
   * `{status, bodyText}`) across the subtask boundary into a dependent subtask's
   * working memory — otherwise only the worker's prose summary survives and the
   * dependent step cannot report status / content. Because the digest is
   * interpolated into the dependent worker's prompt, the executor defangs the
   * excerpt (escapeFences + stripDangerousPrefixes) exactly as the model
   * sanitizer would. This event is NOT forwarded to the wire
   * (mapAllowedWorkerEvent drops it; the index.ts wire switch has no case for it):
   * the client already learns tool results via the tool-invocation round-trip, so
   * it purely feeds in-enclave memory and never leaks raw bodies to the client.
   */
  | {
      kind: 'tool-result';
      toolName: ToolInvocationFrame['toolName'];
      outcome: ToolResultFrame['outcome'];
      resultJson: ToolResultFrame['resultJson'];
    }
  | {
      kind: 'ledger';
      entry: Omit<ToolCallLedgerEntry, 'id'>;
    }
  | {
      kind: 'usage';
      routeKind: UsageReportRouteKind;
      response: ProviderResponseLike;
    }
  /**
   * Codex finding #1: signed memory.write envelope delivered back to
   * the CLIENT (not the model) so the client can call
   * MemoryStorage.saveMemory with the signed bytes. The router
   * translates this into an encrypted CHAT_CHUNK with
   * `_type: 'memory_write_signed'`; the client transport routes it to
   * the tool-fulfiller's memory.write completion handler which calls
   * saveMemory and posts /tool-result-ack.
   */
  | {
      kind: 'memory-write-signed';
      invocationId: string;
      signedEnvelope: MemoryMutationEnvelope;
      signature: string;
      signedBlobB64: string;
    }
  | {
      kind: 'binary-write-request';
      payload: ClientOnlyBinaryWrite;
    }
  | { kind: 'done' }
  | { kind: 'error'; reason: string };

const DEFAULT_MAX_TOOL_CALLS = 10;

/** Recursively freeze a value so a lifecycle hook cannot mutate it. Cycle-safe
 *  via a visited set (a malformed cyclic frame must not blow the stack). */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value && typeof value === 'object') {
    const obj = value as object;
    if (seen.has(obj)) return value;
    seen.add(obj);
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v, seen);
    }
    Object.freeze(value);
  }
  return value;
}

/** Run an observer hook action, swallowing any throw: hooks are observers and
 *  MUST NOT alter the turn's control flow (the contract in harness/types.ts).
 *  A first-party hook bug is isolated, not allowed to abort a user's turn. */
function safeFire(action: () => void): void {
  try {
    action();
  } catch {
    /* observer hook failure is isolated from the turn */
  }
}

/**
 * Drive a single agent turn:
 *   1. Build the system prompt for the active skill pack.
 *   2. Stream provider tokens through the tool-call parser.
 *   3. On a parsed tool call → dispatch via the gateway, sanitize the
 *      result, reinject as a tool-result `user` message, restart the
 *      provider stream.
 *   4. On `maxToolCalls` exceeded → emit `error` with TOOL_LIMIT_EXCEEDED.
 *   5. When the provider stream completes with no pending tool → emit `done`.
 *
 * The loop is generator-based so the caller (wire dispatch / vsock router)
 * can pull events as they arrive and forward each `chunk` / `tool-invocation`
 * /`ledger` frame to the client over the encrypted vsock channel.
 */
export async function* runAgentLoop(
  deps: AgentLoopDeps,
  input: { messages: ChatMessage[]; model?: string },
): AsyncGenerator<AgentLoopEvent> {
  const maxToolCalls = deps.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const systemPrompt = assembleSystemPrompt(deps.pack, {
    ...deps.requestContext,
    fullSkillToolScopes: deps.fullSkillToolScopes,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...input.messages,
  ];

  // Lifecycle hooks (observer/transformer; cannot change control flow).
  const hooks = deps.hooks ?? [];
  // The pack does not change within a turn — freeze one clone so a hook cannot
  // mutate scope/namespace policy that later prepareInvocation/dispatch reads.
  const frozenPack =
    hooks.length > 0 ? deepFreeze(structuredClone(deps.pack)) : deps.pack;
  // Each fire gets a FROZEN snapshot of turn state: hooks observe, they cannot
  // mutate the live `messages` array / its contents, the pack, and they cannot
  // reach `deps` to swap the gateway/provider. Rebuilt per fire so the message
  // snapshot is current (messages grows across the turn).
  const hookContext = (): TurnContext =>
    Object.freeze({
      pack: frozenPack,
      agentTurnId: deps.agentTurnId,
      messages: Object.freeze(messages.map((m) => Object.freeze({ ...m }))),
    });
  // Chain transformOutChunk across hooks in array order; the first `null` drops
  // the chunk. A non-string/non-null return or a throw is ignored (defensive).
  // With no hooks this returns the text unchanged, keeping the hook-free path
  // byte-identical.
  const transformChunk = (input: string): string | null => {
    let text = input;
    for (const hook of hooks) {
      if (!hook.transformOutChunk) continue;
      let next: string | null;
      try {
        next = hook.transformOutChunk(text);
      } catch {
        continue;
      }
      if (next === null) return null;
      if (typeof next === 'string') text = next;
    }
    return text;
  };
  for (const hook of hooks) safeFire(() => hook.onTurnStart?.(hookContext()));

  let toolCallsUsed = 0;
  let providerCallIndex = 0;
  // onTurnEnd must fire EXACTLY ONCE per turn, on ANY termination. The graceful
  // terminals call fireTurnEnd explicitly; the finally below covers every
  // non-graceful exit (provider/dispatch/ACK rejection, abort-signal, a
  // middleware throw, or the caller abandoning the generator). The guard makes
  // it exactly-once.
  let turnEnded = false;
  const completedFolderWrites = new Map<string, ToolResultFrame>();
  const fireTurnEnd = (reason: 'done' | 'error'): void => {
    if (turnEnded) return;
    turnEnded = true;
    if (hooks.length === 0) return;
    const ctx = hookContext();
    for (const hook of hooks) safeFire(() => hook.onTurnEnd?.(reason, ctx));
  };

  try {
    while (true) {
      // M1: observe the abort signal at every loop iteration. The signal
      // is also forwarded to the provider (below), but a provider that
      // ignores it — or an abort landing between tool dispatch and the
      // next provider call — must still terminate the turn promptly.
      deps.abortSignal?.throwIfAborted();

      const parser = new ToolCallStreamParser();
      let pendingTool: ToolInvocationFrame | null = null;
      let pendingParseError: string | null = null;

      const stream = deps.provider.streamChat(messages, {
        model: input.model ?? '',
        signal: deps.abortSignal,
      });
      const routeKind: UsageReportRouteKind =
        providerCallIndex === 0 ? 'agent_worker' : 'agent_tool_continue';
      providerCallIndex += 1;
      let finalResponse: unknown;

      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalResponse = next.value;
          break;
        }
        if (pendingTool || pendingParseError) continue;
        const chunk = next.value;
        const delta = chunk.choices[0]?.delta.content;
        if (typeof delta !== 'string' || delta.length === 0) continue;
        for (const ev of parser.push(delta)) {
          if (ev.kind === 'text') {
            const text = transformChunk(ev.value);
            if (text !== null) yield { kind: 'chunk', text };
          } else if (ev.kind === 'tool') {
            // Codex finding #2: invocationId is enclave-minted, not
            // model-controlled. A model-supplied id (ev.payload.invocationId)
            // could collide across concurrent turns on one TEE session AND
            // could be predicted by an attacker upstream. We mint fresh
            // here and ignore whatever the model emitted.
            pendingTool = {
              invocationId: randomUUID(),
              agentTurnId: deps.agentTurnId,
              toolName: ev.payload.toolName,
              args: ev.payload.args,
            };
            break;
          } else if (ev.kind === 'parse-error') {
            pendingParseError = ev.reason;
            break;
          }
        }
      }

      if (isProviderResponseLike(finalResponse)) {
        yield { kind: 'usage', routeKind, response: finalResponse };
      }

      // Drain residual parser state when the stream ended without a tool fence.
      if (!pendingTool && !pendingParseError) {
        for (const ev of parser.flush()) {
          if (ev.kind === 'text') {
            const text = transformChunk(ev.value);
            if (text !== null) yield { kind: 'chunk', text };
          } else if (ev.kind === 'parse-error') {
            pendingParseError = ev.reason;
          }
        }
      }

      if (pendingParseError) {
        // Reinject as a tool-result-style untrusted block telling the model to
        // retry its tool call. Counts against the maxToolCalls budget so a
        // malformed-fence loop cannot run forever.
        toolCallsUsed += 1;
        if (toolCallsUsed > maxToolCalls) {
          fireTurnEnd('error');
          yield { kind: 'error', reason: 'TOOL_LIMIT_EXCEEDED' };
          return;
        }
        // Synthesise a ledger entry for the audit trail. A parser-level
        // TIER_C_D_BANNED / UNKNOWN_TOOL_NAME means the model TRIED to invoke
        // something forbidden — the user's Activity panel must see this even
        // though the gateway never ran. Other parse errors (malformed JSON,
        // missing fields) are logged the same way so the count of "attempted
        // tool calls this turn" stays consistent with the budget.
        yield {
          kind: 'ledger',
          entry: {
            invokedAt: new Date().toISOString(),
            // <parser-rejection> sentinel: distinct from any Tier A/B tool
            // name so Chunk J's Activity UI can render rejected attempts
            // honestly rather than mis-attributing them to memory.list.
            toolName: PARSER_REJECTION_TOOL_NAME,
            scope: '',
            approvedPath: null,
            outcome: 'gateway_rejected',
            reason: pendingParseError,
            skillPackId: deps.pack.id,
            turnId: deps.agentTurnId,
          },
        };
        const message = sanitizeToolOutputForModel({
          toolName: 'parser',
          outcome: 'error',
          reason: pendingParseError,
          payload: { hint: 'Emit a single <tool>{...}</tool> JSON block.' },
        });
        messages.push({ role: 'user', content: message });
        continue;
      }

      if (!pendingTool) {
        fireTurnEnd('done');
        yield { kind: 'done' };
        return;
      }

      toolCallsUsed += 1;
      if (toolCallsUsed > maxToolCalls) {
        fireTurnEnd('error');
        yield { kind: 'error', reason: 'TOOL_LIMIT_EXCEEDED' };
        return;
      }

      const duplicateFolderWriteKey =
        pendingTool.toolName === 'folder.write'
          ? duplicateSideEffectKey(pendingTool)
          : null;
      if (
        duplicateFolderWriteKey &&
        completedFolderWrites.has(duplicateFolderWriteKey)
      ) {
        const previous = completedFolderWrites.get(duplicateFolderWriteKey)!;
        messages.push({
          role: 'user',
          content: sanitizeToolOutputForModel({
            toolName: pendingTool.toolName,
            outcome: previous.outcome,
            reason: 'DUPLICATE_WRITE_SUPPRESSED',
            payload: {
              ...(isRecord(previous.resultJson) ? previous.resultJson : {}),
              duplicateSuppressed: true,
            },
          }),
        });
        continue;
      }

      // R7 Finding A (Codex): for memory.write the wire frame the client
      // receives must be the SANITISED one (server-pinned namespace,
      // enclave-canonicalised record + recordSerialisedHash + mutationId),
      // not the model's raw frame. prepareInvocation runs the same
      // validation the gateway would, returns the sanitised frame for
      // memory.write, and caches the prepared state for dispatch to
      // re-use (so we don't sign with a different mutationId / clock).
      const prepared = deps.gateway.prepareInvocation(
        pendingTool,
        deps.pack,
        deps.agentTurnId,
      );
      if (!prepared.ok) {
        yield { kind: 'ledger', entry: prepared.ledgerEntry };
        messages.push({
          role: 'user',
          content: sanitizeToolOutputForModel({
            toolName: pendingTool.toolName,
            outcome: prepared.gatewayResult.outcome,
            reason: prepared.reason,
            payload: null,
          }),
        });
        continue;
      }

      if (hooks.length > 0) {
        // Frozen clone: a hook cannot mutate the object that gets dispatched.
        const hookFrame = deepFreeze(structuredClone(prepared.wireFrame));
        const ctx = hookContext();
        for (const hook of hooks) {
          safeFire(() => hook.onToolInvoke?.(hookFrame, ctx));
        }
      }
      yield { kind: 'tool-invocation', frame: prepared.wireFrame };

      const result = await deps.gateway.dispatch(
        prepared.wireFrame,
        deps.pack,
        deps.agentTurnId,
      );
      if (
        duplicateFolderWriteKey &&
        (result.outcome === 'ok' || result.outcome === 'denied_by_user')
      ) {
        completedFolderWrites.set(duplicateFolderWriteKey, result);
      }

      // Post-dispatch handling is the reinjection middleware chain (memory.write
      // ACK-gate → ledger → binary-write ACK-gate → tool-result digest → default
      // sanitize+reinject). ORDER IS THE SECURITY CONTRACT — see
      // harness/chain.ts and docs/design/agent-harness-middleware.md. `yield*`
      // streams each middleware's wire events live (load-bearing: the ACK-gates
      // must emit their request frame to the client BEFORE blocking on its ACK).
      const { reinjection } = yield* runReinjectChain(REINJECT_CHAIN, {
        // The frame that was actually dispatched (canonicalised args for
        // memory.write); its invocationId/toolName match pendingTool, so the
        // wire `memory-write-signed` id and ACK correlation are unchanged.
        invocation: prepared.wireFrame,
        result,
        ctx: { agentTurnId: deps.agentTurnId, deps },
      });
      messages.push(reinjection);
    }
  } finally {
    // Any non-graceful termination (a throw from the provider/gateway/ACK
    // awaiter or a middleware, or the caller abandoning the generator) still
    // ends the turn. fireTurnEnd is a no-op if a graceful terminal already ran,
    // so onTurnEnd fires exactly once.
    fireTurnEnd('error');
  }
}

function duplicateSideEffectKey(frame: ToolInvocationFrame): string {
  return `${frame.toolName}:${stableJson(frame.args)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isProviderResponseLike(value: unknown): value is ProviderResponseLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.provider === 'string' &&
    value.provider.length > 0 &&
    typeof value.model === 'string' &&
    value.model.length > 0
  );
}
