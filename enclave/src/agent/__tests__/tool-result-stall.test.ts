/**
 * B2 — Tool-result stall watchdog (the 504-hang residual).
 * Spec: docs/launch/agent-capability-verification.md §3 (Suite B, P0).
 *
 * Spec-scenario → file map (so B2 traces cleanly):
 *   (a) "No TOOL_RESULT ever arrives → INVOCATION_TIMEOUT reinjected, turn
 *       completes" — the ROUTER-level wiring (per-invocation watchdog resolves
 *       the bridge, loop retries, AGENT_DONE) is covered by
 *       enclave/src/__tests__/invocation-timeout.test.ts and is NOT duplicated
 *       here. What that test does not assert — that the MODEL is told the
 *       truth (reinjection carries outcome:error + INVOCATION_TIMEOUT, never a
 *       phantom result) and the ledger closes with the error — is covered
 *       below at the loop level.
 *   (b) "Chunks trickle forever → absolute deadline (10× budget) still fires"
 *       — covered by invocation-timeout.test.ts ("chunk refreshes cannot
 *       extend an invocation beyond the absolute lifetime cap"), which pins
 *       the absoluteInvocationDeadline / ×10 / remainingMs-clamp logic in
 *       index.ts. Not duplicated here.
 *   (c) "Stall during memory.write ACK wait → MEMORY_WRITE_ACK_TIMEOUT, model
 *       told the truth" — covered HERE. The happy/error ACK paths live in
 *       harness/__tests__/memory-write-ack.test.ts; the STALL path (awaiter
 *       never settles until the production timeout fallback fires) did not
 *       exist anywhere.
 *
 * `buildMemoryWriteAckPromise` is a closure inside the AGENT_REQUEST handler
 * (enclave/src/index.ts) and is not exportable without a production change,
 * so the behavioural test below replicates its exact contract (timer →
 * resolve {outcome:'error', reason:'MEMORY_WRITE_ACK_TIMEOUT'}, resolver-map
 * cleanup) against the REAL production constant, and a static-source test —
 * the same house pattern invocation-timeout.test.ts uses for the absolute
 * deadline — pins that index.ts wires that same fallback.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runAgentLoop,
  type AgentLoopEvent,
  type MemoryWriteAckResult,
} from "../loop";
import { MEMORY_WRITE_ACK_TIMEOUT_MS } from "../../session";
import type { ToolGateway } from "../../tools";
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  SkillPack,
  ToolCallLedgerEntry,
  ToolInvocationFrame,
} from "@calypso/chat-types";

const here = dirname(fileURLToPath(import.meta.url));

function enclaveIndexSourcePath(): string {
  const marker = `${sep}.stryker-tmp${sep}`;
  const sandboxIdx = here.indexOf(marker);
  if (sandboxIdx >= 0) return join(here.slice(0, sandboxIdx), "enclave/src/index.ts");
  return join(here, "..", "..", "index.ts");
}

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
    turnId: "turn_b2",
  };
}

/** Provider that emits a tool fence first, then text — capturing the message
 *  transcript each call so the reinjection (what the model is TOLD) can be
 *  inspected. */
function mkCapturingProvider(
  toolJson: string,
  followUpText: string,
): { provider: ChatProcessor; captured: ChatMessage[][] } {
  const captured: ChatMessage[][] = [];
  return {
    captured,
    provider: {
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        captured.push(JSON.parse(JSON.stringify(messages)));
        const content =
          captured.length === 1 ? `<tool>${toolJson}</tool>` : followUpText;
        yield {
          id: `c${captured.length}`,
          choices: [{ delta: { content }, finish_reason: "stop" }],
        };
      },
    },
  };
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

describe("tool-result stall watchdog (B2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- (a) loop-level gap: the model is told the truth about the timeout ----

  it("(a) INVOCATION_TIMEOUT reinjection tells the model outcome:error and the ledger closes with the error — turn still completes", async () => {
    const pack = mkPack(["memory.list"]);
    const { provider, captured } = mkCapturingProvider(
      MEMORY_LIST_TOOL,
      "That tool timed out; here is what I know without it.",
    );

    // Dispatch resolves with the exact frame the router watchdog produces
    // when no TOOL_RESULT ever arrives (index.ts resolveWithTimeout).
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async (frame: ToolInvocationFrame) => ({
        invocationId: frame.invocationId,
        outcome: "error" as const,
        reason: "INVOCATION_TIMEOUT",
        ledgerEntry: mkLedger("memory.list", "error", "INVOCATION_TIMEOUT"),
      })),
    } as unknown as ToolGateway;

    const events: AgentLoopEvent[] = [];
    for await (const ev of runAgentLoop(
      { gateway, provider, pack, agentTurnId: "turn_b2" },
      { messages: [{ role: "user", content: "hi" }] },
    )) {
      events.push(ev);
    }

    // Turn completes (no hang, no TOOL_LIMIT_EXCEEDED spiral): exactly one
    // done, zero error frames, and the model got a second call to wrap up.
    expect(events.filter((e) => e.kind === "done")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(0);
    expect(captured).toHaveLength(2);

    // The error outcome is on the audit ledger.
    const ledgers = events.filter((e) => e.kind === "ledger");
    expect(ledgers).toHaveLength(1);
    expect(
      (ledgers[0] as Extract<AgentLoopEvent, { kind: "ledger" }>).entry,
    ).toMatchObject({ outcome: "error", reason: "INVOCATION_TIMEOUT" });

    // And the MODEL is told the truth: the reinjected tool result carries the
    // error, not a phantom success and not silence.
    const reinjected = captured[1][captured[1].length - 1];
    expect(reinjected.role).toBe("user");
    expect(reinjected.content).toContain("outcome: error");
    expect(reinjected.content).toContain("INVOCATION_TIMEOUT");
    expect(reinjected.content).not.toContain("outcome: ok");
  });

  // ---- (c) stall during the memory.write durable-ACK wait ----

  it("(c) ACK stall: the turn stays parked (model hears nothing) until MEMORY_WRITE_ACK_TIMEOUT_MS, then reinjects an honest MEMORY_WRITE_ACK_TIMEOUT", async () => {
    vi.useFakeTimers();

    const pack = mkPack(["memory.write"]);
    const { provider, captured } = mkCapturingProvider(
      MEMORY_WRITE_TOOL,
      "I could not confirm that save.",
    );

    // Signed memory.write → the loop suspends on the durable-persist ACK.
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

    // Faithful replica of index.ts `buildMemoryWriteAckPromise` (a closure in
    // the AGENT_REQUEST handler — see the static test below, which pins the
    // production source to this contract): timer fallback resolves an honest
    // error and clears the pending resolver. The client NEVER acks — the
    // resolver in the map is never fired. The timeout uses the production
    // constant, not a test-local number.
    const pendingResolvers = new Map<
      string,
      (result: MemoryWriteAckResult) => void
    >();
    const buildMemoryWriteAckPromise = (
      key: string,
    ): Promise<MemoryWriteAckResult> =>
      new Promise<MemoryWriteAckResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingResolvers.delete(key);
          resolve({ outcome: "error", reason: "MEMORY_WRITE_ACK_TIMEOUT" });
        }, MEMORY_WRITE_ACK_TIMEOUT_MS);
        pendingResolvers.set(key, (result) => {
          clearTimeout(timer);
          pendingResolvers.delete(key);
          resolve(result);
        });
      });

    const gen = runAgentLoop(
      {
        gateway,
        provider,
        pack,
        agentTurnId: "turn_b2",
        awaitMemoryWriteAck: ({ invocationId, agentTurnId }) =>
          buildMemoryWriteAckPromise(`${agentTurnId}::${invocationId}`),
      },
      { messages: [{ role: "user", content: "remember this" }] },
    );

    // Pump until the signed envelope has gone out to the client.
    const events: AgentLoopEvent[] = [];
    let step = await gen.next();
    while (!step.done) {
      events.push(step.value);
      if (step.value.kind === "memory-write-signed") break;
      step = await gen.next();
    }
    expect(events.at(-1)?.kind).toBe("memory-write-signed");

    // Resume: the loop parks on the ACK promise. Flush microtasks (no timer
    // advance) so the awaiter registers its resolver + timeout.
    let nextSettled = false;
    const pendingNext = gen.next().then((s) => {
      nextSettled = true;
      return s;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingResolvers.size).toBe(1);

    // STALL: one tick short of the budget the turn is still parked and the
    // model has heard NOTHING (no second provider call, no ledger, no
    // reinjection) — no premature failure, no phantom success.
    await vi.advanceTimersByTimeAsync(MEMORY_WRITE_ACK_TIMEOUT_MS - 1);
    expect(nextSettled).toBe(false);
    expect(captured).toHaveLength(1);

    // The deadline fires: fallback resolves, resolver map is cleaned up.
    await vi.advanceTimersByTimeAsync(1);
    const ledgerStep = await pendingNext;
    expect(nextSettled).toBe(true);
    expect(pendingResolvers.size).toBe(0);

    // The ledger closes with the truthful error (memoryWriteAckGate flips
    // the sign-time 'ok' entry — the write was never confirmed durable).
    expect(ledgerStep.done).toBe(false);
    const ledgerEv = ledgerStep.value as Extract<
      AgentLoopEvent,
      { kind: "ledger" }
    >;
    expect(ledgerEv.kind).toBe("ledger");
    expect(ledgerEv.entry).toMatchObject({
      outcome: "error",
      reason: "MEMORY_WRITE_ACK_TIMEOUT",
    });

    // Drain to completion: the turn ends (no hang) ...
    const rest: AgentLoopEvent[] = [];
    let tail = await gen.next();
    while (!tail.done) {
      rest.push(tail.value);
      tail = await gen.next();
    }
    expect(rest.filter((e) => e.kind === "done")).toHaveLength(1);

    // ... and the MODEL was told the truth: an error outcome with the
    // timeout reason, never a recordVersion / ok payload.
    expect(captured).toHaveLength(2);
    const reinjected = captured[1][captured[1].length - 1];
    expect(reinjected.role).toBe("user");
    expect(reinjected.content).toContain("outcome: error");
    expect(reinjected.content).toContain("MEMORY_WRITE_ACK_TIMEOUT");
    expect(reinjected.content).toContain('"ok": false');
    expect(reinjected.content).not.toContain('"ok": true');
    expect(reinjected.content).not.toContain("recordVersion");
    // Signed-envelope bytes still never reach the model on the stall path.
    expect(reinjected.content).not.toContain("sig-b64");
  });

  it("(c) production wiring: index.ts builds the ACK promise with the MEMORY_WRITE_ACK_TIMEOUT fallback and resolver cleanup", () => {
    // House pattern (see invocation-timeout.test.ts "absolute lifetime cap"):
    // the builder is a closure inside handleMessage and cannot be imported,
    // so pin the production source to the contract the behavioural test
    // above replicates.
    const indexSource = readFileSync(enclaveIndexSourcePath(), "utf8");
    expect(indexSource).toContain("buildMemoryWriteAckPromise");
    expect(indexSource).toContain('reason: "MEMORY_WRITE_ACK_TIMEOUT"');
    // The timer is armed with the shared production constant ...
    expect(indexSource).toMatch(/\}, MEMORY_WRITE_ACK_TIMEOUT_MS\);/);
    // ... and both settle paths clear the pending resolver entry.
    expect(indexSource).toContain("pendingMemoryWriteAckResolvers.delete");
  });

  // The ACK stall bound is 5 minutes, deliberately matching the R8-H1
  // signed-finalisation replay window (NOT the 60 s an earlier draft of
  // the B2 spec claimed — docs/launch/agent-capability-verification.md
  // was corrected to 5 min). Pinned so the constant cannot drift without
  // revisiting both the spec figure and the replay-recovery window.
  it("(c-spec) the ACK stall watchdog bound is 5 min, in lockstep with the R8-H1 replay window", () => {
    expect(MEMORY_WRITE_ACK_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});
