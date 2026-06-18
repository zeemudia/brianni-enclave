import { describe, it, expect, vi } from "vitest";
import { runAgentLoop, type AgentLoopEvent } from "../loop";
import type { ToolGateway } from "../../tools";
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  SkillPack,
  ToolInvocationFrame,
} from "@calypso/chat-types";
import { buildConnectorListView } from "../prompt";

const RUNTIME_CATALOG_VIEW = [
  {
    connectorId: "google-calendar",
    displayName: "[C_1]",
    operations: [
      { id: "probe_runtime_op", mutating: false, paramsSchema: { q: {} } },
    ],
  },
];

function mkPack(scopes: SkillPack["toolScopes"]): SkillPack {
  return {
    id: "personal-agent.default",
    version: 1,
    displayName: "Default",
    description: "test",
    systemPromptBlock: "You are Calypso.",
    toolScopes: scopes,
    capabilitySuiteIds: ["text"],
    defaultNamespace: "default",
    linkedFolderScopes: {},
    uiHints: { icon: "default", accentToken: "accent-default" },
  };
}

function mkProvider(): { provider: ChatProcessor; captured: ChatMessage[][] } {
  const captured: ChatMessage[][] = [];
  const turns = [
    `<tool>${JSON.stringify({ toolName: "connector.list", args: {} })}</tool>`,
    `<tool>${JSON.stringify({
      toolName: "connector.read",
      args: { connectorId: "google-calendar", operation: "probe_runtime_op" },
    })}</tool>`,
    "Done.",
  ];
  return {
    captured,
    provider: {
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        captured.push(JSON.parse(JSON.stringify(messages)));
        yield {
          id: `c${captured.length}`,
          choices: [
            {
              delta: { content: turns[captured.length - 1] ?? "Done." },
              finish_reason: "stop",
            },
          ],
        };
      },
    },
  };
}

describe("C1 harness integration — runAgentLoop carries a runtime op id end-to-end (R3-1)", () => {
  it("connector.list result (from buildConnectorListView) feeds a connector.read whose op id is in no source", async () => {
    const pack = mkPack(["connector.list", "connector.read", "connector.act"]);
    const { provider, captured } = mkProvider();
    const readFrames: ToolInvocationFrame[] = [];
    const mkLedger = (toolName: string) => ({
      invokedAt: new Date().toISOString(),
      toolName,
      scope: "",
      approvedPath: null,
      outcome: "ok" as const,
      // The ledger entry's `reason` is nullable (Omit<ToolCallLedgerEntry,'id'>,
      // tool-protocol.ts:163 — z.string().nullable()), so `null` is correct here.
      reason: null,
      skillPackId: pack.id,
      turnId: "t_c1",
    });

    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async (frame: ToolInvocationFrame) => {
        // DispatchResult is ToolResultFrame & { ledgerEntry }. ToolResultFrame's
        // `reason` is `string | undefined` (tool-protocol.ts:29 — .optional(),
        // NOT nullable): on the ok path the real loop omits it, and
        // sanitizeToolOutputForModel would crash on a `null` reason. So the
        // success returns here carry no `reason` key, matching the real shape.
        if (frame.toolName === "connector.list") {
          return {
            invocationId: frame.invocationId,
            outcome: "ok" as const,
            resultJson: JSON.stringify({
              ok: true,
              data: buildConnectorListView(RUNTIME_CATALOG_VIEW),
            }),
            ledgerEntry: mkLedger("connector.list"),
          };
        }
        readFrames.push(frame);
        return {
          invocationId: frame.invocationId,
          outcome: "ok" as const,
          resultJson: JSON.stringify({ ok: true, data: { events: [] } }),
          ledgerEntry: mkLedger(frame.toolName),
        };
      }),
    } as unknown as ToolGateway;

    const events: AgentLoopEvent[] = [];
    for await (const ev of runAgentLoop(
      { gateway, provider, pack, agentTurnId: "t_c1", maxToolCalls: 5 },
      { messages: [{ role: "user", content: "what's on my calendar?" }] },
    )) {
      events.push(ev);
    }

    // ---- LOAD-BEARING: a runtime-only op id reached the gateway ----
    expect(readFrames).toHaveLength(1);
    expect(readFrames[0].toolName).toBe("connector.read");
    expect(JSON.parse(JSON.stringify(readFrames[0].args)).operation).toBe(
      "probe_runtime_op",
    );

    // The turn completed cleanly.
    expect(events.filter((e) => e.kind === "done")).toHaveLength(1);

    // ---- SECONDARY: the op id survived the reinjection into the next turn ----
    // The connector.list result is reinjected as the trailing user message the
    // model sees on its second provider call; the op id rides in verbatim.
    const t2 = captured[1];
    expect(t2[t2.length - 1].content).toContain("probe_runtime_op");
  });
});
