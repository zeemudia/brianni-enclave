import { describe, it, expect } from "vitest";

import { MSG } from "../index";

describe("MSG agent-loop constants (Chunk H wire contract)", () => {
  it("AGENT_REQUEST === 0x0c", () => {
    expect(MSG.AGENT_REQUEST).toBe(0x0c);
  });

  it("TOOL_INVOCATION === 0x0d", () => {
    expect(MSG.TOOL_INVOCATION).toBe(0x0d);
  });

  it("TOOL_RESULT === 0x0e", () => {
    expect(MSG.TOOL_RESULT).toBe(0x0e);
  });

  it("AGENT_DONE === 0x0f", () => {
    expect(MSG.AGENT_DONE).toBe(0x0f);
  });

  it("RESEARCH_QUERY_APPROVAL === 0x15 (enclave→client Layer-3 approval request)", () => {
    expect(MSG.RESEARCH_QUERY_APPROVAL).toBe(0x15);
  });

  it("RESEARCH_QUERY_APPROVAL_RESULT === 0x16 (client→enclave approval response)", () => {
    expect(MSG.RESEARCH_QUERY_APPROVAL_RESULT).toBe(0x16);
  });

  it("CLAIMS_SUMMARY === 0x17 (enclave→client claims audit-summary frame)", () => {
    // Must be the next free value after the Phase-3 0x15/0x16 pair — NOT 0x15
    // (the original plan predated the Layer-3 reverse-channel taking 0x15/0x16).
    expect(MSG.CLAIMS_SUMMARY).toBe(0x17);
  });

  it("EGRESS_PROMOTION_REQUEST/RESULT === 0x18/0x19 (consent-gated private->web bridge)", () => {
    expect(MSG.EGRESS_PROMOTION_REQUEST).toBe(0x18);
    expect(MSG.EGRESS_PROMOTION_RESULT).toBe(0x19);
  });

  it("no two MSG values collide", () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });

  it("does not overlap with existing chat or dream constants", () => {
    const agentValues = new Set([
      MSG.AGENT_REQUEST,
      MSG.TOOL_INVOCATION,
      MSG.TOOL_RESULT,
      MSG.AGENT_DONE,
    ]);
    const existing = [
      MSG.ATTESTATION_REQUEST,
      MSG.ATTESTATION_RESPONSE,
      MSG.KEY_EXCHANGE,
      MSG.KEY_EXCHANGE_ACK,
      MSG.CHAT_REQUEST,
      MSG.CHAT_CHUNK,
      MSG.CHAT_DONE,
      MSG.CHAT_ERROR,
      MSG.HEALTH_PING,
      MSG.HEALTH_PONG,
      MSG.USAGE_REPORT,
      MSG.DREAM_REQUEST,
      MSG.DREAM_CHUNK,
      MSG.DREAM_FINALISE,
      MSG.DREAM_DONE,
      MSG.DREAM_ERROR,
      MSG.RESEARCH_QUERY_APPROVAL,
      MSG.RESEARCH_QUERY_APPROVAL_RESULT,
      MSG.CLAIMS_SUMMARY,
    ];
    for (const existingValue of existing) {
      expect(agentValues.has(existingValue as never)).toBe(false);
    }
  });
});
