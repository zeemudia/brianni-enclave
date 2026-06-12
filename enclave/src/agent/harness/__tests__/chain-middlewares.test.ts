import { describe, it, expect } from "vitest";

import { ledgerEmitter } from "../middleware/ledger-emitter";
import { toolResultDigestEmitter } from "../middleware/tool-result-digest";
import { defaultSanitizeReinject } from "../middleware/default-sanitize-reinject";
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
  ToolName,
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
const ctx: ReinjectTurnContext = {
  agentTurnId: TURN,
  deps: {} as unknown as AgentLoopDeps,
};

function mkLedger(toolName: ToolName): Omit<ToolCallLedgerEntry, "id"> {
  return {
    invokedAt: "2026-06-04T00:00:00.000Z",
    toolName,
    scope: "",
    approvedPath: null,
    outcome: "ok",
    reason: null,
    skillPackId: "personal-agent.default",
    turnId: TURN,
  };
}

function mkRc(
  toolName: ToolName,
  result: Partial<DispatchResult>,
): ToolResultContext {
  const invocation: ToolInvocationFrame = {
    invocationId: "inv-1",
    agentTurnId: TURN,
    toolName,
    args: {},
  };
  return {
    invocation,
    result: {
      invocationId: "inv-1",
      outcome: "ok",
      ledgerEntry: mkLedger(toolName),
      ...result,
    } as DispatchResult,
    ctx,
  };
}

const passThroughOutcome: ReinjectOutcome = {
  reinjection: { role: "user", content: "PASSED-THROUGH" },
};
const okNext = async function* (): AsyncGenerator<
  AgentLoopEvent,
  ReinjectOutcome
> {
  return passThroughOutcome;
};
const terminalNext = async function* (): AsyncGenerator<
  AgentLoopEvent,
  ReinjectOutcome
> {
  throw new Error("REINJECT_CHAIN_EXHAUSTED");
};

describe("ledgerEmitter", () => {
  it("yields result.ledgerEntry then delegates to next", async () => {
    const rc = mkRc("web.fetch", { resultJson: { status: 200 } });

    const { events, outcome } = await drain(ledgerEmitter(rc, okNext));

    expect(events).toEqual([
      { kind: "ledger", entry: mkLedger("web.fetch") },
    ]);
    expect(outcome).toBe(passThroughOutcome);
  });
});

describe("toolResultDigestEmitter", () => {
  it("emits an internal tool-result digest for a normal read, then delegates", async () => {
    const rc = mkRc("web.fetch", {
      resultJson: { status: 200, bodyText: "hi" },
    });

    const { events, outcome } = await drain(
      toolResultDigestEmitter(rc, okNext),
    );

    expect(events).toEqual([
      {
        kind: "tool-result",
        toolName: "web.fetch",
        outcome: "ok",
        resultJson: { status: 200, bodyText: "hi" },
      },
    ]);
    expect(outcome).toBe(passThroughOutcome);
  });

  it("suppresses the digest for an unconfirmed memory.write (never leak bytes)", async () => {
    const rc = mkRc("memory.write", { resultJson: { ok: true } });

    const { events, outcome } = await drain(
      toolResultDigestEmitter(rc, okNext),
    );

    expect(events).toEqual([]);
    expect(outcome).toBe(passThroughOutcome);
  });
});

describe("defaultSanitizeReinject (terminal)", () => {
  it("sanitises a normal tool result into the model reinjection", async () => {
    const rc = mkRc("web.fetch", {
      resultJson: { status: 200, bodyText: "hello" },
    });

    const { outcome } = await drain(defaultSanitizeReinject(rc, terminalNext));

    expect(outcome.reinjection.role).toBe("user");
    expect(outcome.reinjection.content).toContain("outcome: ok");
    expect(outcome.reinjection.content).toContain("hello");
  });

  it("reinjects an honest error for an unconfirmed memory.write, never the bytes", async () => {
    const rc = mkRc("memory.write", {
      resultJson: { secret: "should-not-appear" },
    });

    const { outcome } = await drain(defaultSanitizeReinject(rc, terminalNext));

    expect(outcome.reinjection.content).toContain("outcome: error");
    expect(outcome.reinjection.content).toContain("MEMORY_WRITE_NOT_CONFIRMED");
    expect(outcome.reinjection.content).toContain('"ok": false');
    expect(outcome.reinjection.content).not.toContain("should-not-appear");
  });

  it("passes a tool error outcome + reason through to the model", async () => {
    const rc = mkRc("web.fetch", {
      outcome: "error",
      reason: "FETCH_TIMEOUT",
      resultJson: null,
    });

    const { outcome } = await drain(defaultSanitizeReinject(rc, terminalNext));

    expect(outcome.reinjection.content).toContain("outcome: error");
    expect(outcome.reinjection.content).toContain("Reason: FETCH_TIMEOUT");
  });
});
