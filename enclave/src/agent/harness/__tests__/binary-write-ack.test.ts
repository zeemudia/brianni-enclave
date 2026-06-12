import { describe, it, expect } from "vitest";

import { binaryWriteAckGate } from "../middleware/binary-write-ack";
import type {
  ReinjectOutcome,
  ReinjectTurnContext,
  ToolResultContext,
} from "../types";
import type { AgentLoopDeps, AgentLoopEvent } from "../../loop";
import type { DispatchResult } from "../../../tools";
import type {
  ToolCallLedgerEntry,
  ToolInvocationFrame,
  ToolResultFrame,
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
  awaitBinaryWriteAck?: AgentLoopDeps["awaitBinaryWriteAck"],
): ReinjectTurnContext {
  return {
    agentTurnId: TURN,
    deps: { awaitBinaryWriteAck } as unknown as AgentLoopDeps,
  };
}

function mkLedger(): Omit<ToolCallLedgerEntry, "id"> {
  return {
    invokedAt: "2026-06-04T00:00:00.000Z",
    toolName: "image.transform",
    scope: "media:transform",
    approvedPath: null,
    outcome: "ok",
    reason: null,
    skillPackId: "personal-agent.default",
    turnId: TURN,
  };
}

const BINARY_PAYLOAD = {
  folderId: "folder-1",
  displayName: "Photos",
  request: { kind: "binary-write" },
  chunks: [],
} as unknown as NonNullable<DispatchResult["clientOnlyBinaryWrite"]>;

function mkBinaryWrite(): ToolResultContext {
  const invocation: ToolInvocationFrame = {
    invocationId: "inv-1",
    agentTurnId: TURN,
    toolName: "image.transform",
    args: {},
  };
  const result: DispatchResult = {
    invocationId: "inv-1",
    outcome: "ok",
    resultJson: { status: "awaiting_client_write" },
    ledgerEntry: mkLedger(),
    clientOnlyBinaryWrite: BINARY_PAYLOAD,
  };
  return { invocation, result, ctx: mkCtx() };
}

const failNext = async function* (): AsyncGenerator<
  AgentLoopEvent,
  ReinjectOutcome
> {
  throw new Error("next() should not be called for a binary write");
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

describe("binaryWriteAckGate", () => {
  it("confirmed: emits the binary-write request then reinjects the ACK result", async () => {
    const rc = mkBinaryWrite();
    rc.ctx.deps.awaitBinaryWriteAck = async (): Promise<ToolResultFrame> => ({
      invocationId: "inv-1",
      outcome: "ok",
      resultJson: { status: "ok", path: "Photos/out.png" },
    });

    const { events, outcome } = await drain(binaryWriteAckGate(rc, failNext));

    expect(events).toEqual([
      { kind: "binary-write-request", payload: BINARY_PAYLOAD },
    ]);
    expect(outcome.reinjection.content).toContain("outcome: ok");
    expect(outcome.reinjection.content).toContain("Photos/out.png");
  });

  it("falls back to BINARY_WRITE_ACK_UNAVAILABLE when no awaiter is wired", async () => {
    const rc = mkBinaryWrite();
    rc.ctx.deps.awaitBinaryWriteAck = undefined;

    const { events, outcome } = await drain(binaryWriteAckGate(rc, failNext));

    expect(events[0].kind).toBe("binary-write-request");
    expect(outcome.reinjection.content).toContain(
      "BINARY_WRITE_ACK_UNAVAILABLE",
    );
  });

  it("emits the binary-write request BEFORE blocking on the ACK", async () => {
    const rc = mkBinaryWrite();
    let release!: (r: ToolResultFrame) => void;
    rc.ctx.deps.awaitBinaryWriteAck = () =>
      new Promise<ToolResultFrame>((resolve) => {
        release = resolve;
      });

    const gen = binaryWriteAckGate(rc, failNext);
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect((first.value as { kind: string }).kind).toBe("binary-write-request");
    expect(release).toBeUndefined();

    const afterP = gen.next();
    await new Promise((r) => setTimeout(r, 0));
    expect(release).toBeDefined();
    release({ invocationId: "inv-1", outcome: "ok", resultJson: { status: "ok" } });
    const final = await afterP;
    expect(final.done).toBe(true);
  });

  it("passes through a result with no clientOnlyBinaryWrite", async () => {
    const rc = mkBinaryWrite();
    rc.result.clientOnlyBinaryWrite = undefined;

    const { events, outcome } = await drain(binaryWriteAckGate(rc, okNext));

    expect(events).toEqual([]);
    expect(outcome).toBe(passThroughOutcome);
  });

  it("passes through a non-ok result even if a binary payload is present", async () => {
    const rc = mkBinaryWrite();
    rc.result.outcome = "error";

    const { events, outcome } = await drain(binaryWriteAckGate(rc, okNext));

    expect(events).toEqual([]);
    expect(outcome).toBe(passThroughOutcome);
  });
});
