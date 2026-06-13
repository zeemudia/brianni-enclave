/**
 * B1 — Abort during tool execution (enclave loop level).
 * Spec: docs/launch/agent-capability-verification.md §3 (Suite B, P0).
 *
 * The accepted residual under test: `gateway.dispatch` is NOT
 * AbortSignal-aware — an abort landing while the loop is parked awaiting a
 * TOOL_RESULT does not interrupt the dispatch promise itself. Containment is
 * layered instead:
 *   - the router-level per-invocation watchdog guarantees dispatch always
 *     settles (INVOCATION_TIMEOUT — see enclave/src/index.ts
 *     buildResolverPromise and enclave/src/__tests__/invocation-timeout.test.ts);
 *   - the loop observes the signal at every iteration (loop.ts M1
 *     `throwIfAborted`), so the FIRST resumption after dispatch settles
 *     terminates the turn;
 *   - the loop's `finally` fires onTurnEnd exactly once on ANY exit,
 *     including the caller abandoning the generator.
 *
 * These tests prove the containment at the loop level: after an abort, the
 * ledger entry for the in-flight invocation still closes, no further
 * model/client frames are yielded, the provider is never re-consulted,
 * onTurnEnd fires exactly once with 'error', a rejected pending ACK awaiter
 * surfaces as the generator's own rejection, and nothing escapes as an
 * unhandled rejection.
 *
 * Adapter-level abort threading (M1: signal → fetch / SDK requestOptions) is
 * covered by enclave/src/__tests__/adapter-stream-errors.test.ts — not
 * duplicated here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  runAgentLoop,
  type AgentLoopDeps,
  type AgentLoopEvent,
  type MemoryWriteAckResult,
} from "../loop";
import type { ToolGateway } from "../../tools";
import type { LifecycleHooks } from "../harness/types";
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  SkillPack,
  ToolCallLedgerEntry,
  ToolInvocationFrame,
} from "@calypso/chat-types";

function mkPack(scopes: SkillPack["toolScopes"]): SkillPack {
  return {
    id: "personal-agent.default",
    version: 1,
    displayName: "Default",
    description: "test pack",
    systemPromptBlock: "You are Calypso.",
    toolScopes: scopes,
    capabilitySuiteIds: ["text"],
    defaultNamespace: "default",
    linkedFolderScopes: {},
    uiHints: { icon: "default", accentToken: "accent-default" },
  };
}

function mkLedger(
  toolName: string,
  outcome: ToolCallLedgerEntry["outcome"],
  reason: string | null,
): Omit<ToolCallLedgerEntry, "id"> {
  return {
    invokedAt: new Date().toISOString(),
    toolName: toolName as ToolCallLedgerEntry["toolName"],
    scope: "",
    approvedPath: null,
    outcome,
    reason,
    skillPackId: "personal-agent.default",
    turnId: "turn_b1",
  };
}

/** Provider that yields a tool fence on its FIRST call and plain text on any
 *  later call — an aborted turn must never reach the later calls. */
function mkToolThenTextProvider(toolJson: string): {
  provider: ChatProcessor;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      async *streamChat(_messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        calls += 1;
        const content =
          calls === 1 ? `<tool>${toolJson}</tool>` : "Should never stream.";
        yield {
          id: `c${calls}`,
          choices: [{ delta: { content }, finish_reason: "stop" }],
        };
      },
    },
  };
}

/** Let pending promise jobs (NOT timers) run to quiescence. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Pump the generator until the given event kind has been yielded; returns
 *  every event seen so far (inclusive). Fails fast if the loop terminates
 *  before the kind appears. */
async function pumpUntil(
  gen: AsyncGenerator<AgentLoopEvent>,
  kind: AgentLoopEvent["kind"],
): Promise<AgentLoopEvent[]> {
  const seen: AgentLoopEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    seen.push(step.value);
    if (step.value.kind === kind) return seen;
    step = await gen.next();
  }
  throw new Error(`generator finished before yielding a '${kind}' event`);
}

/** Drain the generator to termination, splitting yielded events from the
 *  terminal rejection (if any). */
async function drainToEnd(
  gen: AsyncGenerator<AgentLoopEvent>,
  first?: Promise<IteratorResult<AgentLoopEvent>>,
): Promise<{ events: AgentLoopEvent[]; rejection: unknown }> {
  const events: AgentLoopEvent[] = [];
  try {
    let step = await (first ?? gen.next());
    while (!step.done) {
      events.push(step.value);
      step = await gen.next();
    }
    return { events, rejection: null };
  } catch (err) {
    return { events, rejection: err };
  }
}

const MEMORY_LIST_TOOL = JSON.stringify({
  toolName: "memory.list",
  args: { namespace: "default" },
});

const MEMORY_WRITE_TOOL = JSON.stringify({
  toolName: "memory.write",
  args: {
    delta: {
      action: "ADD",
      record: { kind: "fact", text: "User prefers dark mode." },
    },
  },
});

describe("runAgentLoop — abort during tool execution (B1)", () => {
  // The spec's "no unhandled rejection" clause: track process-level
  // unhandledRejection across each test. Vitest would also fail the run on
  // one, but the explicit assertion documents the contract.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.removeListener("unhandledRejection", onUnhandled);
  });

  it("abort while awaiting TOOL_RESULT: watchdog-resolved dispatch closes the ledger, then the loop terminates with no further model/client frames", async () => {
    const pack = mkPack(["memory.list"]);
    const { provider, calls } = mkToolThenTextProvider(MEMORY_LIST_TOOL);

    // Controllable dispatch: parks the loop exactly where a real turn waits
    // for the client's TOOL_RESULT. Deliberately ignores the abort signal —
    // that is the accepted residual this test contains.
    let resolveDispatch!: (result: unknown) => void;
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveDispatch = resolve;
          }),
      ),
    } as unknown as ToolGateway;

    const turnEnds: string[] = [];
    const hooks: LifecycleHooks[] = [
      { onTurnEnd: (reason) => turnEnds.push(reason) },
    ];
    const controller = new AbortController();
    const abortErr = new Error("CLIENT_ABORTED");
    const deps: AgentLoopDeps = {
      gateway,
      provider,
      pack,
      agentTurnId: "turn_b1",
      abortSignal: controller.signal,
      hooks,
    };
    const gen = runAgentLoop(deps, {
      messages: [{ role: "user", content: "hi" }],
    });

    // 1. Run until the TOOL_INVOCATION frame goes out.
    const before = await pumpUntil(gen, "tool-invocation");
    const invocationId = (
      before.at(-1) as Extract<AgentLoopEvent, { kind: "tool-invocation" }>
    ).frame.invocationId;

    // 2. Resume: the loop is now parked on gateway.dispatch.
    let nextSettled = false;
    const pendingNext = gen.next().then((step) => {
      nextSettled = true;
      return step;
    });
    await tick();
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(nextSettled).toBe(false);

    // 3. Abort mid-dispatch. The dispatch promise is NOT signal-aware, so
    //    nothing settles — this is the residual, observed directly.
    controller.abort(abortErr);
    await tick();
    expect(nextSettled).toBe(false);

    // 4. The router-level watchdog eventually settles the bridge with
    //    INVOCATION_TIMEOUT (enclave/src/index.ts resolveWithTimeout).
    //    Simulate that containment frame.
    resolveDispatch({
      invocationId,
      outcome: "error",
      reason: "INVOCATION_TIMEOUT",
      ledgerEntry: mkLedger("memory.list", "error", "INVOCATION_TIMEOUT"),
    });

    const { events: after, rejection } = await drainToEnd(gen, pendingNext);

    // The generator terminates by rethrowing the abort reason (M1
    // throwIfAborted at the next loop iteration).
    expect(rejection).toBe(abortErr);

    // Ledger entry closed: the audit trail records the timed-out invocation
    // even though the turn was aborted.
    const ledgers = after.filter((e) => e.kind === "ledger");
    expect(ledgers).toHaveLength(1);
    expect(
      (ledgers[0] as Extract<AgentLoopEvent, { kind: "ledger" }>).entry,
    ).toMatchObject({ outcome: "error", reason: "INVOCATION_TIMEOUT" });
    expect(after[0]?.kind).toBe("ledger");

    // No further model/client frames after the abort: only the ledger close
    // and the internal (never-on-the-wire) tool-result digest may follow.
    for (const ev of after) {
      expect(["ledger", "tool-result"]).toContain(ev.kind);
    }
    expect(after.some((e) => e.kind === "chunk")).toBe(false);
    expect(after.some((e) => e.kind === "done")).toBe(false);
    expect(after.some((e) => e.kind === "tool-invocation")).toBe(false);

    // The model is never re-consulted after the abort.
    expect(calls()).toBe(1);

    // fireTurnEnd fired exactly once, with 'error'.
    expect(turnEnds).toEqual(["error"]);

    // Nothing escaped as an unhandled rejection.
    await tick();
    await tick();
    expect(unhandled).toEqual([]);
  });

  it("dispatch REJECTING after abort (vsock teardown) surfaces as the generator's own rejection — turn ends exactly once, nothing unhandled", async () => {
    const pack = mkPack(["memory.list"]);
    const { provider, calls } = mkToolThenTextProvider(MEMORY_LIST_TOOL);

    let rejectDispatch!: (err: unknown) => void;
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectDispatch = reject;
          }),
      ),
    } as unknown as ToolGateway;

    const turnEnds: string[] = [];
    const controller = new AbortController();
    const gen = runAgentLoop(
      {
        gateway,
        provider,
        pack,
        agentTurnId: "turn_b1",
        abortSignal: controller.signal,
        hooks: [{ onTurnEnd: (reason) => turnEnds.push(reason) }],
      },
      { messages: [{ role: "user", content: "hi" }] },
    );

    await pumpUntil(gen, "tool-invocation");
    const pendingNext = gen.next();
    await tick();

    controller.abort(new Error("CLIENT_ABORTED"));
    const teardown = new Error("VSOCK_CONNECTION_CLOSED");
    rejectDispatch(teardown);

    const { events: after, rejection } = await drainToEnd(gen, pendingNext);

    // The loop is parked ON the dispatch await, so the dispatch rejection is
    // what propagates — handled by the caller, not left dangling.
    expect(rejection).toBe(teardown);
    expect(after).toEqual([]);
    expect(calls()).toBe(1);
    expect(turnEnds).toEqual(["error"]);

    await tick();
    await tick();
    expect(unhandled).toEqual([]);
  });

  it("abort while awaiting the memory.write durable ACK: rejected pending ACK resolver terminates the turn with no phantom success", async () => {
    const pack = mkPack(["memory.write"]);
    const { provider, calls } = mkToolThenTextProvider(MEMORY_WRITE_TOOL);

    // Gateway returns a SIGNED memory.write (the path that suspends the loop
    // on the durable-persist ACK — harness/middleware/memory-write-ack.ts).
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async (frame: ToolInvocationFrame) => ({
        invocationId: frame.invocationId,
        outcome: "ok" as const,
        resultJson: {
          signedEnvelope: { namespace: "default", contentHash: "c".repeat(64) },
          signature: "sig-b64",
          signedBlobB64: "blob-b64",
        },
        ledgerEntry: mkLedger("memory.write", "ok", null),
      })),
    } as unknown as ToolGateway;

    // Pending ACK resolver that the wire layer REJECTS on abort/teardown —
    // the spec's "pending ACK resolvers rejected" clause.
    let rejectAck!: (err: unknown) => void;
    const awaitMemoryWriteAck = vi.fn(
      () =>
        new Promise<MemoryWriteAckResult>((_resolve, reject) => {
          rejectAck = reject;
        }),
    );

    const turnEnds: string[] = [];
    const controller = new AbortController();
    const abortErr = new Error("CLIENT_ABORTED");
    const gen = runAgentLoop(
      {
        gateway,
        provider,
        pack,
        agentTurnId: "turn_b1",
        abortSignal: controller.signal,
        awaitMemoryWriteAck,
        hooks: [{ onTurnEnd: (reason) => turnEnds.push(reason) }],
      },
      { messages: [{ role: "user", content: "remember this" }] },
    );

    // The signed envelope reaches the client BEFORE the loop blocks on the
    // ACK — then resume, parking the turn on the pending ACK promise.
    const before = await pumpUntil(gen, "memory-write-signed");
    const pendingNext = gen.next();
    await tick();
    expect(awaitMemoryWriteAck).toHaveBeenCalledTimes(1);

    controller.abort(abortErr);
    rejectAck(abortErr);

    const { events: after, rejection } = await drainToEnd(gen, pendingNext);

    expect(rejection).toBe(abortErr);
    // No phantom success: no post-abort frames at all — in particular no
    // 'ok' ledger entry and no second provider call telling the model the
    // write landed.
    expect(after).toEqual([]);
    const allLedgers = [...before, ...after].filter((e) => e.kind === "ledger");
    expect(allLedgers).toEqual([]);
    expect(calls()).toBe(1);
    expect(turnEnds).toEqual(["error"]);

    await tick();
    await tick();
    expect(unhandled).toEqual([]);
  });

  it("caller abandoning the generator after abort (router outer-drain break) still ends the turn exactly once and never dispatches", async () => {
    const pack = mkPack(["memory.list"]);
    const { provider, calls } = mkToolThenTextProvider(MEMORY_LIST_TOOL);

    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(),
    } as unknown as ToolGateway;

    const turnEnds: string[] = [];
    const controller = new AbortController();
    const gen = runAgentLoop(
      {
        gateway,
        provider,
        pack,
        agentTurnId: "turn_b1",
        abortSignal: controller.signal,
        hooks: [{ onTurnEnd: (reason) => turnEnds.push(reason) }],
      },
      { messages: [{ role: "user", content: "hi" }] },
    );

    // Consume up to the TOOL_INVOCATION yield. The generator is suspended AT
    // the yield — dispatch has not run yet. This is the router's L1 path:
    // `if (connectionAbort.signal.aborted) break;` abandons the drain.
    await pumpUntil(gen, "tool-invocation");
    controller.abort(new Error("CLIENT_ABORTED"));

    const returned = await gen.return(undefined as never);
    expect(returned.done).toBe(true);

    // finally ran: turn ended exactly once with 'error'; the abandoned
    // invocation was never dispatched.
    expect(turnEnds).toEqual(["error"]);
    expect(gateway.dispatch).not.toHaveBeenCalled();
    expect(calls()).toBe(1);

    // The generator is closed for good — no further frames.
    const afterClose = await gen.next();
    expect(afterClose.done).toBe(true);

    await tick();
    await tick();
    expect(unhandled).toEqual([]);
  });
});
