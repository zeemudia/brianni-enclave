/**
 * §12 #2 destructive-resource guard — runAgentLoop integration.
 *
 * Unlike connector-c1-harness.test.ts (which stubs the gateway with vi.fn and so
 * never exercises dispatchConnector), this drives a REAL ToolGateway with a loaded
 * (signed) connector registry through the REAL runAgentLoop, so the §12 #2 guard in
 * dispatchConnector is actually hit. A stub provider emits a destructive
 * connector.act then a mutating connector.act on the SAME connector; the loop
 * dispatches both through the same gateway with the same agentTurnId, so the second
 * trips the turn-scoped lock and the loop reinjects the gateway rejection.
 *
 * Connector/op literals here are fine: __tests__ is excluded from the
 * connectors-no-measured-coupling gate, and the ids are NEUTRAL anyway.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  canonicalConnectorsSigningInput,
  type ChatChunk,
  type ChatMessage,
  type ChatProcessor,
  type SkillPack,
  type ToolInvocationFrame,
  type ToolResultFrame,
} from "@calypso/chat-types";

import { runAgentLoop, type AgentLoopEvent } from "../../agent/loop";
import { ToolGateway, type ClientBridge, type ToolGatewayDeps } from "../index";
import {
  initConnectorRegistry,
  __resetConnectorRegistryForTest,
} from "../../connectors/registry";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const verifyKeyPem = publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

function signedCatalog(version = 1) {
  const connectors = [
    {
      id: "test-connector",
      displayName: "Test Connector",
      provider: "test",
      platforms: ["web", "ios", "android"],
      oauthScopes: ["thing.write"],
      operations: [
        {
          id: "destroy_thing",
          mutating: true,
          destructive: true,
          requiredScope: ["thing.write"],
          paramsSchema: {},
        },
        {
          id: "make_thing",
          mutating: true,
          destructive: false,
          requiredScope: ["thing.write"],
          paramsSchema: {},
        },
      ],
      mcp: null,
    },
  ];
  const signature = edSign(
    null,
    canonicalConnectorsSigningInput(version, connectors),
    privateKey,
  ).toString("base64");
  return { version, connectors, signature };
}

function mkPack(): SkillPack {
  return {
    id: "personal-agent.default",
    version: 1,
    displayName: "Default",
    description: "test",
    systemPromptBlock: "You are Calypso.",
    toolScopes: ["connector.list", "connector.read", "connector.act"],
    capabilitySuiteIds: ["text"],
    defaultNamespace: "default",
    linkedFolderScopes: {},
    uiHints: { icon: "default", accentToken: "accent-default" },
  };
}

const connectedConnectors = [
  {
    connectorId: "test-connector",
    displayName: "[C_1]",
    status: "connected" as const,
    grantedScopes: ["thing.write"],
  },
];

const modeEchoes = [
  { connectorId: "test-connector", writePermissionMode: "auto" as const },
];

function okBridge(): ClientBridge {
  return {
    invokeClient: (frame: ToolInvocationFrame) =>
      Promise.resolve<ToolResultFrame>({
        invocationId: frame.invocationId,
        outcome: "ok",
        resultJson: { ok: true, data: { done: true } },
      }),
  };
}

function mkDeps(over: Partial<ToolGatewayDeps> = {}): ToolGatewayDeps {
  return {
    clientBridge: okBridge(),
    connectedConnectors,
    connectorModeEchoes: modeEchoes,
    ...over,
  };
}

/** A provider that emits the destructive act, then the mutating act, then stops. */
function mkProvider(): ChatProcessor {
  const turns = [
    `<tool>${JSON.stringify({
      toolName: "connector.act",
      args: { connectorId: "test-connector", operation: "destroy_thing", params: {} },
    })}</tool>`,
    `<tool>${JSON.stringify({
      toolName: "connector.act",
      args: { connectorId: "test-connector", operation: "make_thing", params: {} },
    })}</tool>`,
    "Done.",
  ];
  let call = 0;
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      const content = turns[call] ?? "Done.";
      call += 1;
      yield {
        id: `c${call}`,
        choices: [{ delta: { content }, finish_reason: "stop" }],
      };
    },
  };
}

afterEach(() => {
  __resetConnectorRegistryForTest();
});

describe("§12 #2 destructive-resource guard (runAgentLoop integration)", () => {
  it("destroy then a same-connector mutate → the 2nd yields a gateway_rejected CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED ledger entry, re-injected", async () => {
    initConnectorRegistry(signedCatalog(), verifyKeyPem);
    const gateway = new ToolGateway(mkDeps());
    const provider = mkProvider();
    const pack = mkPack();

    const events: AgentLoopEvent[] = [];
    const captured: ChatMessage[][] = [];
    // Wrap the provider so we can inspect the reinjected tool-result messages.
    // Mirrors connector-c1-harness.test.ts: a narrowed streamChat(messages) impl
    // is structurally assignable to ChatProcessor (the loop only passes messages
    // it cares about), so we don't reproduce the full options arg here.
    const recordingProvider = {
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        captured.push(JSON.parse(JSON.stringify(messages)));
        yield* provider.streamChat(messages, {
          model: "test-model",
        } as Parameters<ChatProcessor["streamChat"]>[1]);
      },
    } as unknown as ChatProcessor;

    for await (const ev of runAgentLoop(
      {
        gateway,
        provider: recordingProvider,
        pack,
        agentTurnId: "turn_loop_1",
        maxToolCalls: 5,
      },
      { messages: [{ role: "user", content: "clean up my stuff" }] },
    )) {
      events.push(ev);
    }

    // Both acts were dispatched as tool invocations.
    const invocations = events.filter(
      (e): e is Extract<AgentLoopEvent, { kind: "tool-invocation" }> =>
        e.kind === "tool-invocation",
    );
    expect(invocations).toHaveLength(2);

    // The SECOND connector.act tripped the turn-scoped destructive lock — a
    // gateway_rejected ledger entry with the generic reason was emitted.
    const ledgers = events.filter(
      (e): e is Extract<AgentLoopEvent, { kind: "ledger" }> =>
        e.kind === "ledger",
    );
    const blocked = ledgers.find(
      (e) => e.entry.reason === "CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED",
    );
    expect(blocked).toBeDefined();
    expect(blocked!.entry.outcome).toBe("gateway_rejected");
    expect(blocked!.entry.toolName).toBe("connector.act");

    // The loop re-injected the gateway result: the model's 3rd provider call sees
    // a trailing tool-result user message carrying the rejection reason.
    expect(captured.length).toBeGreaterThanOrEqual(3);
    const t3 = captured[2];
    expect(t3[t3.length - 1].role).toBe("user");
    expect(t3[t3.length - 1].content).toContain(
      "CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED",
    );

    // The turn completed cleanly (the rejection is a corrective reinjection, not
    // a turn abort).
    expect(events.filter((e) => e.kind === "done")).toHaveLength(1);
  });
});
