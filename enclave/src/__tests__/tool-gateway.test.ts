import { describe, it, expect, vi } from "vitest";

import { ToolGateway, type ClientBridge } from "../tools";
import type { SkillPack } from "@calypso/chat-types";

const defaultPack: SkillPack = {
  id: "personal-agent.default",
  version: 1,
  displayName: "Default",
  description: "Default pack.",
  systemPromptBlock: "You are Calypso.",
  toolScopes: ["memory.list", "memory.read"],
  capabilitySuiteIds: ["text"],
  defaultNamespace: "default",
  linkedFolderScopes: {},
  uiHints: { icon: "default", accentToken: "accent-default" },
};

function bridge(stub?: Partial<ClientBridge>): ClientBridge {
  return {
    invokeClient: vi.fn().mockResolvedValue({
      invocationId: "x",
      outcome: "ok",
    }),
    ...stub,
  };
}

describe("ToolGateway", () => {
  it("rejects out-of-scope tools with OUT_OF_SCOPE", async () => {
    const gw = new ToolGateway({ clientBridge: bridge() });
    const r = await gw.dispatch(
      {
        invocationId: "inv_a",
        agentTurnId: "turn_a",
        toolName: "email.draft",
        args: {},
      },
      defaultPack,
      "turn_a",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toContain("OUT_OF_SCOPE");
    expect(r.ledgerEntry.outcome).toBe("gateway_rejected");
    expect(r.ledgerEntry.toolName).toBe("email.draft");
    expect(r.ledgerEntry.skillPackId).toBe("personal-agent.default");
    expect(r.ledgerEntry.turnId).toBe("turn_a");
  });

  it("rejects banned Tier C tools even when pack erroneously lists them", async () => {
    const widePack = {
      ...defaultPack,
      toolScopes: ["memory.list", "mailbox.read" as never],
    };
    const gw = new ToolGateway({ clientBridge: bridge() });
    const r = await gw.dispatch(
      {
        invocationId: "inv_b",
        agentTurnId: "turn_b",
        toolName: "mailbox.read" as never,
        args: {},
      },
      widePack as never,
      "turn_b",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toContain("TIER_C_D_BANNED");
  });

  it("happy path: memory.list emits a TOOL_INVOCATION and surfaces the client result", async () => {
    // R14 Finding A (Codex): Tier-A memory.list parses every record
    // with MemoryRecordSchema; mocked records must be fully shaped.
    const fullRecord = {
      id: "m1",
      namespace: "default",
      baseVersion: 0,
      tombstoneEpoch: 0,
      dreamSessionId: "turn_c",
      kind: "fact",
      text: "hi",
      structured: {},
      tags: [],
      provenance: [
        {
          excerpt: "hi",
          excerptHash: "a".repeat(64),
          sourceRef: { type: "conversation", conversationId: "c1" },
          extractedAt: "2026-05-13T00:00:00.000Z",
          dreamSessionId: "turn_c",
        },
      ],
      confidence: 0.9,
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      supersededBy: null,
      visibleToUser: true,
    };
    const invokeClient = vi.fn().mockResolvedValue({
      invocationId: "inv_c",
      outcome: "ok",
      resultJson: { records: [fullRecord] },
    });
    const gw = new ToolGateway({ clientBridge: { invokeClient } });
    const r = await gw.dispatch(
      {
        invocationId: "inv_c",
        agentTurnId: "turn_c",
        toolName: "memory.list",
        args: { namespace: "default" },
      },
      defaultPack,
      "turn_c",
    );
    expect(r.outcome).toBe("ok");
    expect(invokeClient).toHaveBeenCalledTimes(1);
    expect(invokeClient.mock.calls[0][0].toolName).toBe("memory.list");
    expect(invokeClient.mock.calls[0][0].args).toEqual({
      namespace: "default",
    });
    expect(r.ledgerEntry.scope).toBe("memory/default");
    expect(r.ledgerEntry.outcome).toBe("ok");
  });

  it("preserves invocationId on rejected calls (no bridge round-trip)", async () => {
    const invokeClient = vi.fn();
    const gw = new ToolGateway({ clientBridge: { invokeClient } });
    const r = await gw.dispatch(
      {
        invocationId: "inv_d",
        agentTurnId: "turn_d",
        toolName: "calendar.read" as never,
        args: {},
      },
      defaultPack,
      "turn_d",
    );
    expect(r.invocationId).toBe("inv_d");
    expect(invokeClient).not.toHaveBeenCalled();
  });

  it("includes an ISO timestamp on every ledger entry", async () => {
    const gw = new ToolGateway({ clientBridge: bridge() });
    const r = await gw.dispatch(
      {
        invocationId: "inv_e",
        agentTurnId: "turn_e",
        toolName: "email.draft",
        args: {},
      },
      defaultPack,
      "turn_e",
    );
    expect(() => new Date(r.ledgerEntry.invokedAt).toISOString()).not.toThrow();
  });
});
