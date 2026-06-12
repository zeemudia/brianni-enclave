import { describe, it, expect } from "vitest";

import { memoryWriteAckGate } from "../middleware/memory-write-ack";
import type {
  ReinjectOutcome,
  ReinjectTurnContext,
  ToolResultContext,
} from "../types";
import type {
  AgentLoopDeps,
  AgentLoopEvent,
  MemoryWriteAckResult,
} from "../../loop";
import type { DispatchResult } from "../../../tools";
import type {
  MemoryMutationEnvelope,
  ToolCallLedgerEntry,
  ToolInvocationFrame,
} from "@calypso/chat-types";

async function drain(
  gen: AsyncGenerator<AgentLoopEvent, ReinjectOutcome>,
): Promise<{ events: AgentLoopEvent[]; outcome: ReinjectOutcome }> {
  const events: AgentLoopEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, outcome: step.value };
}

const TURN = "turn-1";

function mkCtx(
  awaitMemoryWriteAck?: AgentLoopDeps["awaitMemoryWriteAck"],
): ReinjectTurnContext {
  return {
    agentTurnId: TURN,
    deps: { awaitMemoryWriteAck } as unknown as AgentLoopDeps,
  };
}

function mkLedger(
  outcome: ToolCallLedgerEntry["outcome"],
): Omit<ToolCallLedgerEntry, "id"> {
  return {
    invokedAt: "2026-06-04T00:00:00.000Z",
    toolName: "memory.write",
    scope: "memory:write",
    approvedPath: null,
    outcome,
    reason: null,
    skillPackId: "personal-agent.default",
    turnId: TURN,
  };
}

const ENVELOPE = { mutationId: "m1" } as unknown as MemoryMutationEnvelope;

function mkSignedMemoryWrite(): ToolResultContext {
  const invocation: ToolInvocationFrame = {
    invocationId: "inv-1",
    agentTurnId: TURN,
    toolName: "memory.write",
    args: {},
  };
  const result: DispatchResult = {
    invocationId: "inv-1",
    outcome: "ok",
    resultJson: {
      signedEnvelope: ENVELOPE,
      signature: "sig-abc",
      signedBlobB64: "blob-b64",
    },
    ledgerEntry: mkLedger("ok"),
  };
  return { invocation, result, ctx: mkCtx() };
}

/** A `next` that fails the test if the gate does not short-circuit. */
const failNext = async function* (): AsyncGenerator<
  AgentLoopEvent,
  ReinjectOutcome
> {
  throw new Error("next() should not be called for a signed memory.write");
};

const passThroughOutcome: ReinjectOutcome = {
  reinjection: { role: "user", content: "PASSED-THROUGH" },
};
const okNext = async function* (): AsyncGenerator<
  AgentLoopEvent,
  ReinjectOutcome
> {
  return passThroughOutcome;
};

describe("memoryWriteAckGate", () => {
  it("confirmed: delivers the signed envelope then reports recordVersion", async () => {
    const rc = mkSignedMemoryWrite();
    rc.ctx.deps.awaitMemoryWriteAck = async () => ({
      outcome: "ok",
      recordVersion: 7,
    });

    const { events, outcome } = await drain(memoryWriteAckGate(rc, failNext));

    // Signed envelope to the client FIRST, then the confirmed-write ledger.
    expect(events).toEqual([
      {
        kind: "memory-write-signed",
        invocationId: "inv-1",
        signedEnvelope: ENVELOPE,
        signature: "sig-abc",
        signedBlobB64: "blob-b64",
      },
      { kind: "ledger", entry: mkLedger("ok") },
    ]);
    expect(outcome.reinjection.role).toBe("user");
    expect(outcome.reinjection.content).toContain("outcome: ok");
    expect(outcome.reinjection.content).toContain('"recordVersion": 7');
    expect(outcome.reinjection.content).toContain('"ok": true');
  });

  it("unconfirmed: a persist failure flips the ledger + reinjection to error", async () => {
    const rc = mkSignedMemoryWrite();
    rc.ctx.deps.awaitMemoryWriteAck = async () => ({
      outcome: "error",
      reason: "PERSIST_FAILED",
    });

    const { events, outcome } = await drain(memoryWriteAckGate(rc, failNext));

    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("memory-write-signed");
    expect(events[1]).toEqual({
      kind: "ledger",
      entry: { ...mkLedger("error"), reason: "PERSIST_FAILED" },
    });
    expect(outcome.reinjection.content).toContain("outcome: error");
    expect(outcome.reinjection.content).toContain("Reason: PERSIST_FAILED");
    expect(outcome.reinjection.content).toContain('"ok": false');
  });

  it("falls back to MEMORY_WRITE_ACK_UNAVAILABLE when no awaiter is wired", async () => {
    const rc = mkSignedMemoryWrite();
    rc.ctx.deps.awaitMemoryWriteAck = undefined;

    const { events, outcome } = await drain(memoryWriteAckGate(rc, failNext));

    expect(events[1]).toMatchObject({
      kind: "ledger",
      entry: { outcome: "error", reason: "MEMORY_WRITE_ACK_UNAVAILABLE" },
    });
    expect(outcome.reinjection.content).toContain(
      "Reason: MEMORY_WRITE_ACK_UNAVAILABLE",
    );
  });

  it("emits the signed envelope BEFORE blocking on the durable-persist ACK", async () => {
    const rc = mkSignedMemoryWrite();
    let release!: (r: MemoryWriteAckResult) => void;
    rc.ctx.deps.awaitMemoryWriteAck = () =>
      new Promise<MemoryWriteAckResult>((resolve) => {
        release = resolve;
      });

    const gen = memoryWriteAckGate(rc, failNext);

    // The signed-envelope frame surfaces before the awaiter is ever invoked:
    // proof the client hears it before the gate blocks on the durable ACK.
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect((first.value as { kind: string }).kind).toBe("memory-write-signed");
    expect(release).toBeUndefined();

    // Resuming reaches the await (which assigns `release` and blocks); kick it
    // off without awaiting, then unblock it.
    const afterAwaitP = gen.next();
    await new Promise((r) => setTimeout(r, 0));
    expect(release).toBeDefined();
    release({ outcome: "ok", recordVersion: 1 });

    // Post-await the gate yields the ledger, then returns the reinjection.
    const ledgerStep = await afterAwaitP;
    expect(ledgerStep.done).toBe(false);
    expect((ledgerStep.value as { kind: string }).kind).toBe("ledger");
    const final = await gen.next();
    expect(final.done).toBe(true);
    expect((final.value as ReinjectOutcome).reinjection.content).toContain(
      "outcome: ok",
    );
  });

  it("passes through tool results that are not a signed memory.write", async () => {
    const webFetch: ToolResultContext = {
      invocation: {
        invocationId: "inv-2",
        agentTurnId: TURN,
        toolName: "web.fetch",
        args: {},
      },
      result: {
        invocationId: "inv-2",
        outcome: "ok",
        resultJson: { status: 200, bodyText: "hi" },
        ledgerEntry: { ...mkLedger("ok"), toolName: "web.fetch" },
      },
      ctx: mkCtx(),
    };

    const { events, outcome } = await drain(
      memoryWriteAckGate(webFetch, okNext),
    );

    expect(events).toEqual([]); // no memory-write-signed frame
    expect(outcome).toBe(passThroughOutcome);
  });

  it("passes through a memory.write that produced no signed envelope", async () => {
    const rc = mkSignedMemoryWrite();
    rc.result.resultJson = { ok: true }; // degenerate: no signedEnvelope

    const { events, outcome } = await drain(memoryWriteAckGate(rc, okNext));

    expect(events).toEqual([]);
    expect(outcome).toBe(passThroughOutcome);
  });
});
