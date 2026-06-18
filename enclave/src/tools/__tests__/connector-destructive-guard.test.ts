/**
 * §12 #2 — single-mode, turn-scoped destructive-resource guard (direct dispatch).
 *
 * Drives the FULL admission → budget → guard → ledger → fulfilment path through
 * the public ToolGateway.dispatch surface, with an initialized (signed) connector
 * registry. The connector/op literals named here are fine: this __tests__ file is
 * excluded from the connectors-no-measured-coupling gate (it skips __tests__ dirs),
 * and the ids are deliberately NEUTRAL (test-connector / destroy_thing / …) so they
 * never collide with the committed google-calendar catalog either way.
 *
 * The guard is coarse + resource-BLIND (the enclave sees only masked params and,
 * per the S5 invariant, cannot trust client confirm-state): once a `destructive`
 * connector.act is admitted for a connector this turn, ANY further mutating
 * connector.act on THAT SAME connector for the rest of the turn is rejected. It is
 * keyed ONLY off the catalog `destructive`/`mutating` flags — no connector/op id is
 * named in the measured source.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  canonicalConnectorsSigningInput,
  type SkillPack,
  type ToolInvocationFrame,
  type ToolResultFrame,
} from "@calypso/chat-types";

import { ToolGateway, type ClientBridge, type ToolGatewayDeps } from "../index";
import {
  initConnectorRegistry,
  __resetConnectorRegistryForTest,
} from "../../connectors/registry";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const verifyKeyPem = publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

// A signed catalog with TWO neutral connectors. test-connector has:
//  - destroy_thing  : mutating + DESTRUCTIVE  (the lock-arming op)
//  - make_thing     : mutating, NOT destructive
//  - change_thing   : mutating, NOT destructive
//  - peek_thing     : non-mutating read
// other-connector mirrors it (used to prove the lock is scoped per connector).
function signedCatalog(version = 1) {
  const ops = [
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
    {
      id: "change_thing",
      mutating: true,
      destructive: false,
      requiredScope: ["thing.write"],
      paramsSchema: {},
    },
    {
      id: "peek_thing",
      mutating: false,
      destructive: false,
      requiredScope: "thing.read",
      paramsSchema: {},
    },
  ];
  const connectors = [
    {
      id: "test-connector",
      displayName: "Test Connector",
      provider: "test",
      platforms: ["web", "ios", "android"],
      oauthScopes: ["thing.read", "thing.write"],
      operations: ops,
      mcp: null,
    },
    {
      id: "other-connector",
      displayName: "Other Connector",
      provider: "test",
      platforms: ["web", "ios", "android"],
      oauthScopes: ["thing.read", "thing.write"],
      operations: ops,
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

function loadRegistry() {
  initConnectorRegistry(signedCatalog(), verifyKeyPem);
}

function mkPack(
  scopes: string[] = ["connector.list", "connector.read", "connector.act"],
): SkillPack {
  return {
    id: "personal-agent.default",
    version: 1,
    displayName: "Default",
    description: "test pack",
    systemPromptBlock: "You are Calypso.",
    toolScopes: scopes as SkillPack["toolScopes"],
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
    grantedScopes: ["thing.read", "thing.write"],
  },
  {
    connectorId: "other-connector",
    displayName: "[C_2]",
    status: "connected" as const,
    grantedScopes: ["thing.read", "thing.write"],
  },
];

const modeEchoes = [
  { connectorId: "test-connector", writePermissionMode: "auto" as const },
  { connectorId: "other-connector", writePermissionMode: "auto" as const },
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

function actFrame(
  connectorId: string,
  operation: string,
): ToolInvocationFrame {
  return {
    invocationId: `inv_${operation}_${connectorId}`,
    agentTurnId: "turn_1",
    toolName: "connector.act",
    args: { connectorId, operation, params: {} },
  };
}

function readFrame(
  connectorId: string,
  operation: string,
): ToolInvocationFrame {
  return {
    invocationId: `inv_${operation}_${connectorId}`,
    agentTurnId: "turn_1",
    toolName: "connector.read",
    args: { connectorId, operation, params: {} },
  };
}

const TURN = "turn_1";

afterEach(() => {
  __resetConnectorRegistryForTest();
});

describe("§12 #2 destructive-resource guard (direct dispatch)", () => {
  it("a destructive act THEN a mutating act on the SAME connector → the SECOND is rejected CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED (first fulfils)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());

    // 1st: the destructive act — fulfils (it is the lock-arming op, never blocked).
    const first = await gw.dispatch(
      actFrame("test-connector", "destroy_thing"),
      mkPack(),
      TURN,
    );
    expect(first.outcome).toBe("ok");

    // 2nd: ANY further mutating act on the same connector — rejected.
    const second = await gw.dispatch(
      actFrame("test-connector", "make_thing"),
      mkPack(),
      TURN,
    );
    expect(second.outcome).toBe("gateway_rejected");
    expect(second.reason).toBe("CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED");
    expect(second.ledgerEntry.reason).toBe(
      "CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED",
    );
    expect(second.ledgerEntry.outcome).toBe("gateway_rejected");
    expect(second.ledgerEntry.toolName).toBe("connector.act");
  });

  it("the destructive act ITSELF is NOT blocked (the very first one fulfils)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      actFrame("test-connector", "destroy_thing"),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("ok");
  });

  it("two NON-destructive mutating acts (no prior destructive) → BOTH fulfil", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const first = await gw.dispatch(
      actFrame("test-connector", "make_thing"),
      mkPack(),
      TURN,
    );
    expect(first.outcome).toBe("ok");
    const second = await gw.dispatch(
      actFrame("test-connector", "change_thing"),
      mkPack(),
      TURN,
    );
    expect(second.outcome).toBe("ok");
  });

  it("a NON-destructive mutating act THEN a destructive act on the SAME connector → the DESTRUCTIVE is rejected (order-symmetric: create-new → delete-old reverse-replace, Codex P1)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());

    // 1st: a create-class (non-destructive) mutation — fulfils.
    const create = await gw.dispatch(
      actFrame("test-connector", "make_thing"),
      mkPack(),
      TURN,
    );
    expect(create.outcome).toBe("ok");

    // 2nd: the destructive op — REJECTED, because a mutation already happened for
    // this connector this turn (the reverse-replace ordering must not slip through
    // the way delete→create is blocked).
    const destroy = await gw.dispatch(
      actFrame("test-connector", "destroy_thing"),
      mkPack(),
      TURN,
    );
    expect(destroy.outcome).toBe("gateway_rejected");
    expect(destroy.reason).toBe("CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED");
  });

  it("a non-destructive mutating act on connector A then a destructive act on connector B → B fulfils (symmetric lock still per-connector)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const a = await gw.dispatch(
      actFrame("test-connector", "make_thing"),
      mkPack(),
      TURN,
    );
    expect(a.outcome).toBe("ok");
    const b = await gw.dispatch(
      actFrame("other-connector", "destroy_thing"),
      mkPack(),
      TURN,
    );
    expect(b.outcome).toBe("ok");
  });

  it("destructive act on connector A then a mutating act on connector B → B fulfils (lock scoped per connector)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const a = await gw.dispatch(
      actFrame("test-connector", "destroy_thing"),
      mkPack(),
      TURN,
    );
    expect(a.outcome).toBe("ok");
    const b = await gw.dispatch(
      actFrame("other-connector", "make_thing"),
      mkPack(),
      TURN,
    );
    expect(b.outcome).toBe("ok");
  });

  it("destructive act in turn T1 then a mutating act in turn T2 → T2 fulfils (turn-scoped)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const t1 = await gw.dispatch(
      actFrame("test-connector", "destroy_thing"),
      mkPack(),
      "turn_A",
    );
    expect(t1.outcome).toBe("ok");
    const t2 = await gw.dispatch(
      actFrame("test-connector", "make_thing"),
      mkPack(),
      "turn_B",
    );
    expect(t2.outcome).toBe("ok");
  });

  it("connector.read after a destructive act → fulfils (guard only gates connector.act)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const destroy = await gw.dispatch(
      actFrame("test-connector", "destroy_thing"),
      mkPack(),
      TURN,
    );
    expect(destroy.outcome).toBe("ok");
    const read = await gw.dispatch(
      readFrame("test-connector", "peek_thing"),
      mkPack(),
      TURN,
    );
    expect(read.outcome).toBe("ok");
  });

  it("a destructive op (first op for its connector) arms EXACTLY its own connector id and persists for the turn (lock-state seam)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());

    // Nothing armed before any act.
    expect(gw.__connectorDestructiveLockForTest(TURN)).toEqual([]);

    // A NON-destructive mutating act does NOT arm the destructive lock.
    await gw.dispatch(actFrame("test-connector", "make_thing"), mkPack(), TURN);
    expect(gw.__connectorDestructiveLockForTest(TURN)).toEqual([]);

    // A destructive act as the FIRST op for its connector arms exactly its own id.
    // (Use a SEPARATE turn so the make_thing above doesn't get the destroy rejected
    // by the order-symmetric guard — create→delete is blocked, which is the point.)
    const TURN2 = "turn_2";
    await gw.dispatch(actFrame("test-connector", "destroy_thing"), mkPack(), TURN2);
    expect(gw.__connectorDestructiveLockForTest(TURN2)).toEqual(["test-connector"]);

    // A destructive act (first op) on a second connector adds only that id (sorted).
    await gw.dispatch(actFrame("other-connector", "destroy_thing"), mkPack(), TURN2);
    expect(gw.__connectorDestructiveLockForTest(TURN2)).toEqual([
      "other-connector",
      "test-connector",
    ]);

    // The lock is per-turn: an unseen turn reads empty.
    expect(gw.__connectorDestructiveLockForTest("turn_unseen")).toEqual([]);
  });
});
