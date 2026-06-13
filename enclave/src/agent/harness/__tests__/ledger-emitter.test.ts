import { describe, it, expect } from "vitest";

import { ledgerEmitter } from "../middleware/ledger-emitter";
import { toolResultDigestEmitter } from "../middleware/tool-result-digest";
import { defaultSanitizeReinject } from "../middleware/default-sanitize-reinject";
import { REINJECT_CHAIN } from "../chain";
import { runReinjectChain } from "../reinject-chain";
import type {
  ReinjectOutcome,
  ReinjectTurnContext,
  ToolResultContext,
} from "../types";
import type { AgentLoopDeps, AgentLoopEvent } from "../../loop";
import type { DispatchResult } from "../../../tools";
import {
  PARSER_REJECTION_TOOL_NAME,
  ToolCallLedgerEntrySchema,
  type ToolCallLedgerEntry,
  type ToolInvocationFrame,
  type ToolName,
} from "@calypso/chat-types";

// B9 — dedicated unit coverage for ledgerEmitter beyond what
// chain-middlewares.test.ts already asserts (happy-path "yields entry then
// delegates"). This file pins down: wire shape vs the chat-types schema,
// pass-through-by-reference (NO clamping in the emitter), early-emission
// ordering, attempt/error entries, malformed input, and chain position.

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

const TURN = "turn-ledger-1";
const ctx: ReinjectTurnContext = {
  agentTurnId: TURN,
  deps: {} as unknown as AgentLoopDeps,
};

function mkLedger(
  toolName: ToolCallLedgerEntry["toolName"],
  overrides: Partial<Omit<ToolCallLedgerEntry, "id">> = {},
): Omit<ToolCallLedgerEntry, "id"> {
  return {
    invokedAt: "2026-06-13T00:00:00.000Z",
    toolName,
    scope: "",
    approvedPath: null,
    outcome: "ok",
    reason: null,
    skillPackId: "personal-agent.default",
    turnId: TURN,
    ...overrides,
  };
}

function mkRc(
  toolName: ToolName,
  result: Partial<DispatchResult>,
): ToolResultContext {
  const invocation: ToolInvocationFrame = {
    invocationId: "inv-ledger-1",
    agentTurnId: TURN,
    toolName,
    args: {},
  };
  return {
    invocation,
    result: {
      invocationId: "inv-ledger-1",
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

describe("ledgerEmitter — event shape", () => {
  it("yields exactly one event, passing the gateway entry through BY REFERENCE (no clone, no rewrite)", async () => {
    const entry = mkLedger("web.fetch");
    const rc = mkRc("web.fetch", { ledgerEntry: entry });

    const { events, outcome } = await drain(ledgerEmitter(rc, okNext));

    expect(events).toHaveLength(1);
    const event = events[0] as Extract<AgentLoopEvent, { kind: "ledger" }>;
    expect(event.kind).toBe("ledger");
    // Reference identity: the emitter is a pure pass-through. Any clamping or
    // shaping must therefore happen in the producer (gateway) or the consumer
    // (client-side schema parse) — see the no-clamping test below.
    expect(event.entry).toBe(entry);
    expect(outcome).toBe(passThroughOutcome);
  });

  it("emits an entry whose shape (plus the consumer-minted id) satisfies ToolCallLedgerEntrySchema — every required field present", async () => {
    const rc = mkRc("web.fetch", {});
    const { events } = await drain(ledgerEmitter(rc, okNext));

    const event = events[0] as Extract<AgentLoopEvent, { kind: "ledger" }>;
    // The wire contract: the client appends an id and persists the entry. A
    // gateway-shaped entry + id must round-trip through the schema.
    const parsed = ToolCallLedgerEntrySchema.safeParse({
      ...event.entry,
      id: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it("emits a <parser-rejection> sentinel entry unchanged, and the sentinel is schema-valid", async () => {
    // loop.ts synthesises this entry for rejected fences; the same schema must
    // accept it so the Activity panel can render rejected attempts honestly.
    const entry = mkLedger(PARSER_REJECTION_TOOL_NAME, {
      outcome: "gateway_rejected",
      reason: "UNKNOWN_TOOL_NAME:bogus",
    });
    const rc = mkRc("web.fetch", { ledgerEntry: entry });

    const { events } = await drain(ledgerEmitter(rc, okNext));

    const event = events[0] as Extract<AgentLoopEvent, { kind: "ledger" }>;
    expect(event.entry).toBe(entry);
    expect(
      ToolCallLedgerEntrySchema.safeParse({ ...event.entry, id: 1 }).success,
    ).toBe(true);
  });

  it("emits for error and gateway_rejected outcomes too — the ledger records attempts, not just successes", async () => {
    const entry = mkLedger("web.fetch", {
      outcome: "gateway_rejected",
      reason: "EGRESS_TAINTED",
    });
    const rc = mkRc("web.fetch", {
      outcome: "gateway_rejected",
      reason: "EGRESS_TAINTED",
      ledgerEntry: entry,
    });

    const { events } = await drain(ledgerEmitter(rc, okNext));

    expect(events).toEqual([{ kind: "ledger", entry }]);
  });
});

describe("ledgerEmitter — clamping", () => {
  it("performs NO clamping: oversized fields pass through unchanged; the only size gate is the schema at the consumer", async () => {
    const oversizedScope = "s".repeat(300); // schema cap is .max(256)
    const hugeReason = "r".repeat(10_000); // schema has NO cap on reason
    const entry = mkLedger("web.fetch", {
      scope: oversizedScope,
      reason: hugeReason,
    });
    const rc = mkRc("web.fetch", { ledgerEntry: entry });

    const { events } = await drain(ledgerEmitter(rc, okNext));

    const event = events[0] as Extract<AgentLoopEvent, { kind: "ledger" }>;
    // Pass-through verbatim — the emitter does not slice or drop fields.
    expect(event.entry).toBe(entry);
    expect(event.entry.scope).toHaveLength(300);
    expect(event.entry.reason).toHaveLength(10_000);

    // Where the clamp actually lives: ToolCallLedgerEntrySchema. scope > 256
    // fails schema parse at the consumer; nothing enclave-side enforces it
    // before the wire (the router JSON.stringifies the entry as-is).
    const parsed = ToolCallLedgerEntrySchema.safeParse({ ...entry, id: 0 });
    expect(parsed.success).toBe(false);

    // Documented gap (P3): `reason` has no .max() in the schema, so an
    // arbitrarily large reason string passes end-to-end — entry below differs
    // from the rejected one only by a schema-conformant scope.
    const reasonOnly = ToolCallLedgerEntrySchema.safeParse({
      ...entry,
      scope: "",
      id: 0,
    });
    expect(reasonOnly.success).toBe(true);
  });
});

describe("ledgerEmitter — ordering", () => {
  it("emits the ledger entry BEFORE any event yielded by the rest of the chain (early-emission contract)", async () => {
    const laterNext = async function* (): AsyncGenerator<
      AgentLoopEvent,
      ReinjectOutcome
    > {
      yield { kind: "chunk", text: "downstream" };
      return passThroughOutcome;
    };
    const rc = mkRc("web.fetch", {});

    const { events } = await drain(ledgerEmitter(rc, laterNext));

    expect(events.map((e) => e.kind)).toEqual(["ledger", "chunk"]);
  });

  it("orders ledger before the tool-result digest in the real sub-chain, ending in the sanitized reinjection", async () => {
    const rc = mkRc("web.fetch", { resultJson: { status: 200 } });

    const { events, outcome } = await drain(
      runReinjectChain(
        [ledgerEmitter, toolResultDigestEmitter, defaultSanitizeReinject],
        rc,
      ),
    );

    expect(events.map((e) => e.kind)).toEqual(["ledger", "tool-result"]);
    expect(outcome.reinjection.role).toBe("user");
    expect(outcome.reinjection.content).toContain(
      "Tool result — web.fetch — outcome: ok",
    );
  });
});

describe("ledgerEmitter — malformed input", () => {
  it("passes a result with a MISSING ledgerEntry straight through (trust-the-gateway: no throw, no filtering)", async () => {
    // The emitter has no defensive branch — a gateway bug that omits the
    // ledgerEntry yields `entry: undefined` on the wire rather than failing
    // the turn. Documented behavior, not an endorsement: the consumer's
    // schema parse is the only guard.
    const rc: ToolResultContext = {
      invocation: {
        invocationId: "inv-x",
        agentTurnId: TURN,
        toolName: "web.fetch",
        args: {},
      },
      result: {
        invocationId: "inv-x",
        outcome: "ok",
      } as unknown as DispatchResult,
      ctx,
    };

    const { events, outcome } = await drain(ledgerEmitter(rc, okNext));

    expect(events).toHaveLength(1);
    expect(events[0]).toHaveProperty("kind", "ledger");
    expect(events[0]).toHaveProperty("entry", undefined);
    expect(outcome).toBe(passThroughOutcome);
  });
});

describe("ledgerEmitter — chain position", () => {
  it("sits at index 1 of REINJECT_CHAIN: after the memory-write ACK gate, before every other emitter", () => {
    // Order is the security contract (chain.ts): the signed memory.write gate
    // must be able to short-circuit BEFORE this emitter so an unconfirmed
    // write never gets an early 'ok' ledger entry.
    expect(REINJECT_CHAIN).toHaveLength(5);
    expect(REINJECT_CHAIN[1]).toBe(ledgerEmitter);
  });
});
