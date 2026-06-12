import { describe, it, expect } from "vitest";

import {
  ToolInvocationFrameSchema,
  ToolResultFrameSchema,
  ToolCallLedgerEntrySchema,
  type ToolInvocationFrame,
  type ToolResultFrame,
  type ToolCallLedgerEntry,
  ToolResultOutcomeSchema,
  PARSER_REJECTION_TOOL_NAME,
} from "../tool-protocol";

describe("ToolInvocationFrameSchema", () => {
  it("accepts a folder.write invocation frame", () => {
    const frame: ToolInvocationFrame = ToolInvocationFrameSchema.parse({
      invocationId: "inv_01",
      agentTurnId: "turn_01",
      toolName: "folder.write",
      args: {
        path: "/Career/draft.md",
        contentPreview: "# Counter offer",
        contentBytesB64: "IyBmb28=",
      },
    });
    expect(frame.toolName).toBe("folder.write");
    expect(frame.agentTurnId).toBe("turn_01");
  });

  it("accepts a memory.list invocation frame", () => {
    const frame = ToolInvocationFrameSchema.parse({
      invocationId: "inv_02",
      agentTurnId: "turn_01",
      toolName: "memory.list",
      args: { namespace: "default" },
    });
    expect(frame.toolName).toBe("memory.list");
  });

  it("rejects a frame with a Tier C/D tool name", () => {
    for (const banned of [
      "email.send",
      "mailbox.read",
      "calendar.read",
      "event.create",
      "form.submit",
    ]) {
      expect(() =>
        ToolInvocationFrameSchema.parse({
          invocationId: "x",
          agentTurnId: "turn_x",
          toolName: banned,
          args: {},
        }),
      ).toThrow();
    }
  });

  it("rejects empty invocationId or agentTurnId", () => {
    expect(() =>
      ToolInvocationFrameSchema.parse({
        invocationId: "",
        agentTurnId: "turn",
        toolName: "memory.list",
        args: {},
      }),
    ).toThrow();
    expect(() =>
      ToolInvocationFrameSchema.parse({
        invocationId: "inv",
        agentTurnId: "",
        toolName: "memory.list",
        args: {},
      }),
    ).toThrow();
  });

  it("rejects invocationId or agentTurnId over 64 chars", () => {
    expect(() =>
      ToolInvocationFrameSchema.parse({
        invocationId: "x".repeat(65),
        agentTurnId: "turn",
        toolName: "memory.list",
        args: {},
      }),
    ).toThrow();
    expect(() =>
      ToolInvocationFrameSchema.parse({
        invocationId: "inv",
        agentTurnId: "x".repeat(65),
        toolName: "memory.list",
        args: {},
      }),
    ).toThrow();
  });
});

describe("ToolResultFrameSchema", () => {
  it("accepts an ok outcome with resultJson", () => {
    const frame: ToolResultFrame = ToolResultFrameSchema.parse({
      invocationId: "inv_01",
      outcome: "ok",
      resultJson: { records: [] },
    });
    expect(frame.outcome).toBe("ok");
  });

  it("accepts a denied_by_user outcome", () => {
    const frame = ToolResultFrameSchema.parse({
      invocationId: "inv_01",
      outcome: "denied_by_user",
      reason: "user clicked Deny",
    });
    expect(frame.outcome).toBe("denied_by_user");
  });

  it("accepts a gateway_rejected outcome", () => {
    const frame = ToolResultFrameSchema.parse({
      invocationId: "inv_01",
      outcome: "gateway_rejected",
      reason: "TIER_C_D_BANNED",
    });
    expect(frame.outcome).toBe("gateway_rejected");
  });

  it("rejects unknown outcomes", () => {
    expect(() =>
      ToolResultFrameSchema.parse({
        invocationId: "inv_01",
        outcome: "fobared",
      }),
    ).toThrow();
  });

  it("ToolResultOutcomeSchema enumerates exactly 4 outcomes", () => {
    expect(ToolResultOutcomeSchema.options.length).toBe(4);
    for (const o of ["ok", "denied_by_user", "gateway_rejected", "error"]) {
      expect(ToolResultOutcomeSchema.options).toContain(o);
    }
  });

  it("reason has a length cap (≤256)", () => {
    expect(() =>
      ToolResultFrameSchema.parse({
        invocationId: "inv_01",
        outcome: "error",
        reason: "x".repeat(257),
      }),
    ).toThrow();
  });
});

describe("ToolCallLedgerEntrySchema", () => {
  it("accepts a denied_by_user ledger entry", () => {
    const entry: ToolCallLedgerEntry = ToolCallLedgerEntrySchema.parse({
      id: 1,
      invokedAt: "2026-05-11T00:00:00Z",
      toolName: "folder.write",
      scope: "Career",
      approvedPath: null,
      outcome: "denied_by_user",
      reason: null,
      skillPackId: "personal-agent.default",
      turnId: "turn_01",
    });
    expect(entry.outcome).toBe("denied_by_user");
    expect(entry.approvedPath).toBeNull();
  });

  it("accepts an ok ledger entry with approvedPath", () => {
    const entry = ToolCallLedgerEntrySchema.parse({
      id: 42,
      invokedAt: "2026-05-11T00:00:00Z",
      toolName: "folder.write",
      scope: "Career",
      approvedPath: "/Career/draft.md",
      outcome: "ok",
      reason: null,
      skillPackId: "personal-agent.career",
      turnId: "turn_99",
    });
    expect(entry.approvedPath).toBe("/Career/draft.md");
  });

  it("rejects non-integer id", () => {
    expect(() =>
      ToolCallLedgerEntrySchema.parse({
        id: 1.5,
        invokedAt: "2026-05-11T00:00:00Z",
        toolName: "memory.list",
        scope: "default",
        approvedPath: null,
        outcome: "ok",
        reason: null,
        skillPackId: "personal-agent.default",
        turnId: "turn_01",
      }),
    ).toThrow();
  });

  it("rejects a Tier C/D tool name in a ledger entry", () => {
    expect(() =>
      ToolCallLedgerEntrySchema.parse({
        id: 1,
        invokedAt: "2026-05-11T00:00:00Z",
        toolName: "mailbox.read",
        scope: "anything",
        approvedPath: null,
        outcome: "ok",
        reason: null,
        skillPackId: "personal-agent.default",
        turnId: "turn_01",
      }),
    ).toThrow();
  });

  it("rejects non-ISO invokedAt timestamps", () => {
    expect(() =>
      ToolCallLedgerEntrySchema.parse({
        id: 1,
        invokedAt: "not-a-date",
        toolName: "memory.list",
        scope: "default",
        approvedPath: null,
        outcome: "ok",
        reason: null,
        skillPackId: "personal-agent.default",
        turnId: "turn_01",
      }),
    ).toThrow();
  });
});

describe("Ledger sentinel — <parser-rejection>", () => {
  it("PARSER_REJECTION_TOOL_NAME is the literal '<parser-rejection>'", () => {
    expect(PARSER_REJECTION_TOOL_NAME).toBe("<parser-rejection>");
  });

  it("ToolCallLedgerEntrySchema accepts the sentinel as toolName", () => {
    const entry: ToolCallLedgerEntry = ToolCallLedgerEntrySchema.parse({
      id: 1,
      invokedAt: "2026-05-13T00:00:00Z",
      toolName: PARSER_REJECTION_TOOL_NAME,
      scope: "",
      approvedPath: null,
      outcome: "gateway_rejected",
      reason: "TIER_C_D_BANNED:email.send",
      skillPackId: "personal-agent.default",
      turnId: "turn_01",
    });
    expect(entry.toolName).toBe(PARSER_REJECTION_TOOL_NAME);
  });

  it("ToolInvocationFrameSchema still REJECTS the sentinel (only real tools may be invoked)", () => {
    expect(() =>
      ToolInvocationFrameSchema.parse({
        invocationId: "inv",
        agentTurnId: "turn",
        toolName: PARSER_REJECTION_TOOL_NAME,
        args: {},
      }),
    ).toThrow();
  });
});
