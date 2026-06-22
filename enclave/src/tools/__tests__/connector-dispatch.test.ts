/**
 * Task 11 — connector.* dispatch wiring (the tier-dispatch barrel).
 *
 * Drives the FULL admission → budget → ledger → fulfilment path through the
 * public ToolGateway.dispatch surface, with an initialized (signed) connector
 * registry. Each matrix row is its own `it`. The connector/op literals named
 * here are fine: this __tests__ file is excluded from the
 * connectors-no-measured-coupling gate (it skips __tests__ dirs).
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  canonicalConnectorsSigningInput,
  ConnectorResultEnvelopeSchema,
  type SkillPack,
  type ToolInvocationFrame,
  type ToolResultFrame,
} from "@calypso/chat-types";

import { ToolGateway, type ClientBridge, type ToolGatewayDeps } from "../index";
import { sanitizeToolOutputForModel } from "../../agent/tool-output-sanitizer";
import {
  initConnectorRegistry,
  __resetConnectorRegistryForTest,
} from "../../connectors/registry";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const verifyKeyPem = publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

// A small signed catalog with: a ceiling-declaring read (list_events), a
// mutating act (create_event), and a binary read (download_attachment).
function signedCatalog(version = 1) {
  const connectors = [
    {
      id: "google-calendar",
      displayName: "Google Calendar",
      provider: "google",
      platforms: ["web", "ios", "android"],
      oauthScopes: ["https://www.googleapis.com/auth/calendar.events"],
      scopeSubsumes: [
        {
          grant: "calendar",
          covers: ["calendar.readonly", "calendar.events"],
        },
      ],
      operations: [
        {
          id: "list_events",
          mutating: false,
          destructive: false,
          requiredScope: "calendar.readonly",
          maxWindowDays: 370,
          maxResults: 250,
          windowParams: { start: "timeMin", end: "timeMax" },
          maxResultsParam: "maxResults",
          paramsSchema: {},
        },
        {
          id: "create_event",
          mutating: true,
          destructive: false,
          requiredScope: ["calendar.events"],
          eventTimeRange: { start: "start", end: "end" },
          paramsSchema: {
            calendarId: { type: "string", required: true },
            summary: { type: "string", required: true },
            start: { type: "string", required: true },
            end: { type: "string", required: true },
          },
          contentFields: ["summary", "description", "location"],
        },
        {
          id: "update_event",
          mutating: true,
          destructive: false,
          concurrency: "etag",
          requiredScope: ["calendar.events"],
          eventTimeRange: { start: "start", end: "end" },
          paramsSchema: {
            calendarId: { type: "string", required: true },
            eventId: { type: "string", required: true },
            etag: { type: "string", required: true },
            // start/end are OPTIONAL on a partial update — the eventTimeRange guard
            // enforces both-or-neither + validity + ordering when present.
            start: { type: "string" },
            end: { type: "string" },
          },
        },
        {
          id: "download_attachment",
          mutating: false,
          destructive: false,
          binary: true,
          requiredScope: "calendar.readonly",
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

function loadRegistry() {
  initConnectorRegistry(signedCatalog(), verifyKeyPem);
}
const createParams = {
  calendarId: "primary",
  summary: "Lunch",
  start: "2026-07-01T09:00:00Z",
  end: "2026-07-01T09:30:00Z",
};

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
    connectorId: "google-calendar",
    displayName: "[C_1]",
    status: "connected" as const,
    grantedScopes: ["calendar.readonly", "calendar.events"],
  },
];

const modeEchoes = [
  { connectorId: "google-calendar", writePermissionMode: "auto" as const },
];

/** A clientBridge stub recording the frames it was asked to fulfil. */
function recordingBridge(
  result: (frame: ToolInvocationFrame) => ToolResultFrame,
): { bridge: ClientBridge; calls: ToolInvocationFrame[] } {
  const calls: ToolInvocationFrame[] = [];
  const bridge: ClientBridge = {
    invokeClient: (frame) => {
      calls.push(frame);
      return Promise.resolve(result(frame));
    },
  };
  return { bridge, calls };
}

function mkDeps(over: Partial<ToolGatewayDeps> = {}): ToolGatewayDeps {
  const { bridge } = recordingBridge((frame) => ({
    invocationId: frame.invocationId,
    outcome: "ok",
    resultJson: { ok: true, data: { fulfilled: true } },
  }));
  return {
    clientBridge: bridge,
    connectedConnectors,
    connectorModeEchoes: modeEchoes,
    ...over,
  };
}

function readFrame(
  args: Record<string, unknown>,
  toolName = "connector.read",
): ToolInvocationFrame {
  return {
    invocationId: "inv_1",
    agentTurnId: "turn_1",
    toolName: toolName as ToolInvocationFrame["toolName"],
    args,
  };
}

const TURN = "turn_1";

afterEach(() => {
  __resetConnectorRegistryForTest();
});

describe("connector.* dispatch (Task 11)", () => {
  // 1 ────────────────────────────────────────────────────────────────────
  it("fails closed when the registry is NOT loaded (Finding #6)", async () => {
    __resetConnectorRegistryForTest();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      readFrame(
        {
          connectorId: "google-calendar",
          operation: "list_events",
          params: {},
        },
        "connector.read",
      ),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_CATALOG_NOT_LOADED");
    expect(res.ledgerEntry.outcome).toBe("gateway_rejected");
    expect(res.ledgerEntry.reason).toBe("CONNECTOR_CATALOG_NOT_LOADED");
    expect(res.ledgerEntry.toolName).toBe("connector.read");
  });

  // 2 ────────────────────────────────────────────────────────────────────
  it("connector.list builds the runtime view, envelope-wrapped, no egress, not metered (R2-3)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      readFrame({}, "connector.list"),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("ok");
    // Envelope-wrapped { ok: true, data: { connectors: [...] } }
    const env = res.resultJson as { ok: boolean; data: { connectors: unknown[] } };
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.data.connectors)).toBe(true);
    expect(env.data.connectors).toHaveLength(1);
    const connector = env.data.connectors[0] as {
      operations: Array<{
        id: string;
        paramsSchema: Record<string, unknown>;
      }>;
    };
    const create = connector.operations.find((op) => op.id === "create_event");
    expect(create?.paramsSchema).toMatchObject({
      calendarId: { type: "string", required: true },
      summary: { type: "string", required: true },
      start: { type: "string", required: true },
      end: { type: "string", required: true },
      description: { type: "string" },
      location: { type: "string" },
    });
    // Parses as a ConnectorResultEnvelope
    const parsed = ConnectorResultEnvelopeSchema.safeParse(res.resultJson);
    expect(parsed.success).toBe(true);
    expect(res.ledgerEntry.outcome).toBe("ok");
    // list is NOT metered — the read counter stays at 0
    const state = gw.__connectorTurnStateForTest(TURN);
    expect(state.reads).toBe(0);
    expect(state.mutations).toBe(0);
  });

  it("connector.list hides write operations when the connected grant is read-only", async () => {
    loadRegistry();
    const gw = new ToolGateway(
      mkDeps({
        connectedConnectors: [
          {
            connectorId: "google-calendar",
            displayName: "[C_1]",
            status: "connected",
            grantedScopes: ["calendar.readonly"],
          },
        ],
      }),
    );
    const res = await gw.dispatch(readFrame({}, "connector.list"), mkPack(), TURN);

    expect(res.outcome).toBe("ok");
    const env = res.resultJson as {
      ok: true;
      data: { connectors: Array<{ operations: Array<{ id: string }> }> };
    };
    const operationIds = env.data.connectors[0]?.operations.map((op) => op.id);
    expect(operationIds).toContain("list_events");
    expect(operationIds).not.toContain("create_event");
  });

  it("rejects a DIRECT connector.act write op under a read-only grant BEFORE the bridge/budget (scope not granted)", async () => {
    // The write op is hidden from this read-only grant's connector.list view, but
    // a direct (or alias-normalized) connector.act could still target it. The
    // invocation-time scope gate must fail it closed — no client modal, no
    // mutation-budget consumption — instead of "confirm then provider 403".
    loadRegistry();
    const { bridge, calls } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: { id: "evt" } },
    }));
    const gw = new ToolGateway(
      mkDeps({
        clientBridge: bridge,
        connectedConnectors: [
          {
            connectorId: "google-calendar",
            displayName: "[C_1]",
            status: "connected",
            grantedScopes: ["calendar.readonly"],
          },
        ],
      }),
    );
    const res = await gw.dispatch(
      readFrame(
        { connectorId: "google-calendar", operation: "create_event", params: createParams },
        "connector.act",
      ),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_SCOPE_NOT_GRANTED");
    expect(calls).toHaveLength(0);
    expect(gw.__connectorTurnStateForTest(TURN).mutations).toBe(0);
  });

  it("rejects a present-but-NULL update event-time bound BEFORE budget (no turn poisoning)", async () => {
    // `{ start: null, end: null }` must not slip through as "neither bound" and
    // consume the mutation budget / arm the destructive lock before the client
    // adapter rejects it. A present (own-property) null is INVALID at admission.
    loadRegistry();
    const { bridge, calls } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: { id: "evt" } },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    const res = await gw.dispatch(
      readFrame(
        {
          connectorId: "google-calendar",
          operation: "update_event",
          params: {
            calendarId: "primary",
            eventId: "evt-1",
            etag: '"e1"',
            start: null,
            end: null,
          },
        },
        "connector.act",
      ),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_PARAM_DATETIME_INVALID");
    expect(calls).toHaveLength(0);
    expect(gw.__connectorTurnStateForTest(TURN).mutations).toBe(0);
  });

  it("connector.list keeps write operations when a signed scopeSubsumes rule covers them", async () => {
    loadRegistry();
    const gw = new ToolGateway(
      mkDeps({
        connectedConnectors: [
          {
            connectorId: "google-calendar",
            displayName: "[C_1]",
            status: "connected",
            grantedScopes: ["calendar"],
          },
        ],
      }),
    );
    const res = await gw.dispatch(readFrame({}, "connector.list"), mkPack(), TURN);

    expect(res.outcome).toBe("ok");
    const env = res.resultJson as {
      ok: true;
      data: { connectors: Array<{ operations: Array<{ id: string }> }> };
    };
    const operationIds = env.data.connectors[0]?.operations.map((op) => op.id);
    expect(operationIds).toContain("list_events");
    expect(operationIds).toContain("create_event");
  });

  // 2b ───────────────────────────────────────────────────────────────────
  it("connector.list runs the admission ladder — a SCOPED list of an unbound/unknown connector is REJECTED, not silently emptied", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      readFrame({ connectorId: "not-a-bound-connector" }, "connector.list"),
      mkPack(),
      TURN,
    );
    // Without the admission wiring this returned ok + an empty list; the
    // documented ladder requires a bound + connected target → NOT_IN_SCOPE.
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_NOT_IN_SCOPE");
    expect(res.ledgerEntry.reason).toBe("CONNECTOR_NOT_IN_SCOPE");
  });

  it("connector.list of a needs_reauth connector (scoped) is REJECTED CONNECTOR_NOT_CONNECTED", async () => {
    loadRegistry();
    const gw = new ToolGateway(
      mkDeps({
        connectedConnectors: [
          {
            connectorId: "google-calendar",
            displayName: "[C_1]",
            status: "needs_reauth" as const,
            grantedScopes: ["calendar.readonly", "calendar.events"],
          },
        ],
      }),
    );
    const res = await gw.dispatch(
      readFrame({ connectorId: "google-calendar" }, "connector.list"),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_NOT_CONNECTED");
  });

  it("connector.list (unscoped) does NOT advertise a needs_reauth connector — discovery view matches what is invocable", async () => {
    loadRegistry();
    const gw = new ToolGateway(
      mkDeps({
        connectedConnectors: [
          {
            connectorId: "google-calendar",
            displayName: "[C_1]",
            status: "needs_reauth" as const,
            grantedScopes: ["calendar.readonly", "calendar.events"],
          },
        ],
      }),
    );
    const res = await gw.dispatch(
      readFrame({}, "connector.list"),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("ok");
    const env = res.resultJson as { ok: boolean; data: { connectors: unknown[] } };
    // The needs_reauth connector is filtered out of the discovery view.
    expect(env.data.connectors).toHaveLength(0);
  });

  // 3 ────────────────────────────────────────────────────────────────────
  it("rejects malformed args BEFORE catalog lookup — CONNECTOR_INVOCATION_ARGS_INVALID", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    // connector.read with no operation → args parse fails
    const res = await gw.dispatch(
      readFrame({ connectorId: "google-calendar" }, "connector.read"),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_INVOCATION_ARGS_INVALID");
    expect(res.ledgerEntry.reason).toBe("CONNECTOR_INVOCATION_ARGS_INVALID");
  });

  // 4 ────────────────────────────────────────────────────────────────────
  it("admits a connector.read, hands it to the client fulfiller, and increments the read counter at admission", async () => {
    loadRegistry();
    const { bridge, calls } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: { events: [] } },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: {
          timeMin: "2026-06-01T00:00:00Z",
          timeMax: "2026-06-08T00:00:00Z",
          maxResults: 50,
        },
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("ok");
    // The op was handed to the client fulfiller.
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("connector.read");
    // The read counter is incremented at admission.
    expect(gw.__connectorTurnStateForTest(TURN).reads).toBe(1);
    expect(gw.__connectorTurnStateForTest(TURN).mutations).toBe(0);
    // Ledger records the mode-in-effect (auto) and an ok outcome.
    expect(res.ledgerEntry.outcome).toBe("ok");
    expect(res.ledgerEntry.scope).toContain("auto");
  });

  it("admits a connector.act, hands it to the fulfiller, and increments the mutation counter", async () => {
    loadRegistry();
    const { bridge, calls } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: { id: "evt" } },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    const res = await gw.dispatch(
      readFrame(
        { connectorId: "google-calendar", operation: "create_event", params: createParams },
        "connector.act",
      ),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(gw.__connectorTurnStateForTest(TURN).mutations).toBe(1);
    expect(gw.__connectorTurnStateForTest(TURN).reads).toBe(0);
  });

  it("rejects connector.act before the client bridge when signed required params are missing", async () => {
    loadRegistry();
    const { bridge, calls } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: { id: "evt" } },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    const res = await gw.dispatch(
      readFrame(
        {
          connectorId: "google-calendar",
          operation: "create_event",
          params: {
            start: "2026-07-01T09:00:00Z",
            end: "2026-07-01T09:30:00Z",
          },
        },
        "connector.act",
      ),
      mkPack(),
      TURN,
    );

    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_REQUIRED_PARAMS_MISSING");
    expect(calls).toHaveLength(0);
    expect(gw.__connectorTurnStateForTest(TURN).mutations).toBe(0);
  });

  // 5 ────────────────────────────────────────────────────────────────────
  it("rejects a failed admission (binary op) with the specific reason + ledger", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "download_attachment",
        params: {},
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_BINARY_OP_UNSUPPORTED");
    expect(res.ledgerEntry.reason).toBe("CONNECTOR_BINARY_OP_UNSUPPORTED");
    // A rejected op is never handed to the fulfiller and never metered.
    expect(gw.__connectorTurnStateForTest(TURN).reads).toBe(0);
  });

  it("rejects a read over the §12 window ceiling — CONNECTOR_READ_WINDOW_EXCEEDED", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: {
          timeMin: "2020-01-01T00:00:00Z",
          timeMax: "2026-01-01T00:00:00Z",
          maxResults: 50,
        },
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_READ_WINDOW_EXCEEDED");
  });

  it("rejects a read over the §12 results ceiling — CONNECTOR_READ_RESULTS_EXCEEDED", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: {
          timeMin: "2026-06-01T00:00:00Z",
          timeMax: "2026-06-08T00:00:00Z",
          maxResults: 5000,
        },
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_READ_RESULTS_EXCEEDED");
  });

  it("FAILS CLOSED when an explicit empty params {} omits a declared ceiling — CONNECTOR_READ_WINDOW_REQUIRED", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: {},
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_READ_WINDOW_REQUIRED");
  });

  // CRITICAL defense-in-depth: a frame with NO `params` field at all must STILL
  // fail closed, because dispatch parses with ConnectorInvocationArgsSchema
  // (which DEFAULTS params to {}) and passes the PARSED/DEFAULTED params to
  // admission. This is why dispatch must NOT pass raw frame.args.
  it("FAILS CLOSED for a ceiling-declaring op when the frame supplies NO params field (parsed-defaulted params reach admission)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      // No `params` key at all.
      readFrame({ connectorId: "google-calendar", operation: "list_events" }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("CONNECTOR_READ_WINDOW_REQUIRED");
  });

  it("rejects when the per-turn mutation budget is exhausted — CONNECTOR_TURN_MUTATION_BUDGET", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const actFrame = () =>
      readFrame(
        { connectorId: "google-calendar", operation: "create_event", params: createParams },
        "connector.act",
      );
    // Exhaust the 5-mutation baseline.
    for (let i = 0; i < 5; i += 1) {
      const ok = await gw.dispatch(actFrame(), mkPack(), TURN);
      expect(ok.outcome).toBe("ok");
    }
    const blocked = await gw.dispatch(actFrame(), mkPack(), TURN);
    expect(blocked.outcome).toBe("gateway_rejected");
    expect(blocked.reason).toBe("CONNECTOR_TURN_MUTATION_BUDGET");
    // Counter is not double-counted on the rejected attempt.
    expect(gw.__connectorTurnStateForTest(TURN).mutations).toBe(5);
  });

  // 6 ────────────────────────────────────────────────────────────────────
  it("consumes the budget per ATTEMPT (Finding #11): a rate_limited fulfilment is NOT refunded, ledgers rate_limited", async () => {
    loadRegistry();
    const { bridge } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      // The connector adapter surfaced a structured rate-limit error.
      outcome: "error",
      reason: "rate_limited",
      resultJson: { ok: false, errorCode: "rate_limited", retryable: true },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    const res = await gw.dispatch(
      readFrame(
        { connectorId: "google-calendar", operation: "create_event", params: createParams },
        "connector.act",
      ),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("error");
    // The mutation was counted at admission and NOT refunded on rate-limit.
    expect(gw.__connectorTurnStateForTest(TURN).mutations).toBe(1);
    // The ledger records the rate_limited reason distinctly.
    expect(res.ledgerEntry.reason).toBe("rate_limited");
  });

  // 7 ────────────────────────────────────────────────────────────────────
  it("ledgers an auditable :uncapped marker when an override exceeds baseline; the enclave still TRUSTS the override (R4-6)", async () => {
    loadRegistry();
    const gw = new ToolGateway(
      mkDeps({ connectorTurnBudgetOverride: { mutationsPerTurn: "unbounded" } }),
    );
    const res = await gw.dispatch(
      readFrame(
        { connectorId: "google-calendar", operation: "create_event", params: createParams },
        "connector.act",
      ),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("ok");
    expect(res.ledgerEntry.scope).toContain("uncapped");
    // Override TRUSTED: many mutations past the measured baseline succeed.
    for (let i = 0; i < 10; i += 1) {
      const ok = await gw.dispatch(
          readFrame(
          { connectorId: "google-calendar", operation: "create_event", params: createParams },
          "connector.act",
        ),
        mkPack(),
        TURN,
      );
      expect(ok.outcome).toBe("ok");
    }
    expect(gw.__connectorTurnStateForTest(TURN).mutations).toBe(11);
  });

  // Egress-taint integration (round-2 medium): a connector.read surfaces private
  // external data into the model context, so it must taint exactly like
  // folder.read / memory.read — otherwise a same-turn web.fetch could exfiltrate
  // it and the single-mode lock would never trip.
  it("harvests a connector.read result into the egress-taint ledger (single-mode lock + content match)", async () => {
    loadRegistry();
    const secret = "Project Zephyr kickoff with Acme on 2026-07-15";
    const { bridge } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: { events: [{ summary: secret }] } },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: {
          timeMin: "2026-06-01T00:00:00Z",
          timeMax: "2026-06-08T00:00:00Z",
          maxResults: 50,
        },
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("ok");
    const taint = gw.__egressTaintForTest();
    // Single-mode structural lock: a private read was observed this turn.
    expect(taint.hasObservedPrivateRead()).toBe(true);
    // Content-match guard: a web.fetch reproducing the connector datum is tainted.
    expect(taint.isEgressTainted(secret, "")).toBe(true);
  });

  it("connector.read harvest tolerates a non-serialisable (circular) payload without throwing, still harvesting reachable strings", async () => {
    loadRegistry();
    const secret = "Quarterly board deck passphrase zephyr-alpha-bravo-charlie";
    const circular: Record<string, unknown> = { note: secret };
    circular.self = circular; // a single JSON.stringify would THROW on this cycle
    const { bridge } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: circular },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: {
          timeMin: "2026-06-01T00:00:00Z",
          timeMax: "2026-06-08T00:00:00Z",
          maxResults: 50,
        },
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("ok");
    const taint = gw.__egressTaintForTest();
    expect(taint.hasObservedPrivateRead()).toBe(true);
    // The reachable string leaf is still harvested despite the cycle (no throw,
    // no silent miss of the content-match guard).
    expect(taint.isEgressTainted(secret, "")).toBe(true);
  });

  it("harvests a DEEPLY-nested connector.read string leaf (no depth-based silent miss in orchestrator mode)", async () => {
    loadRegistry();
    const secret = "Nested incident postmortem rootcause zephyr-deep-leaf-secret";
    // Nest ~14 levels deep — past any fixed recursion-depth cap.
    let deep: unknown = secret;
    for (let i = 0; i < 14; i += 1) deep = { wrap: deep };
    const { bridge } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: deep },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z", maxResults: 50 },
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("ok");
    expect(gw.__egressTaintForTest().isEgressTainted(secret, "")).toBe(true);
  });

  it("harvests connector.read object KEYS too (identifying data in keys can't bypass the content match)", async () => {
    loadRegistry();
    const emailKey = "very.specific.attendee@example-corp-domain.com";
    const { bridge } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: { rsvps: { [emailKey]: "accepted" } } },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z", maxResults: 50 },
      }),
      mkPack(),
      TURN,
    );
    expect(gw.__egressTaintForTest().isEgressTainted(emailKey, "")).toBe(true);
  });

  it("taints connector.read data even on a NON-ok outcome — data smuggled under an error envelope still reaches the model", async () => {
    loadRegistry();
    const smuggled = "Smuggled private payload under an error envelope zephyr-leak-token";
    const { bridge } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      // Non-conforming adapter: outcome=error but a data payload rides along; the
      // dispatch forwards resultJson to the model regardless of outcome.
      outcome: "error",
      reason: "rate_limited",
      resultJson: { ok: false, errorCode: "rate_limited", data: { note: smuggled } },
    }));
    const gw = new ToolGateway(mkDeps({ clientBridge: bridge }));
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z", maxResults: 50 },
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("error");
    // resultJson IS forwarded to the model on the error path...
    expect(res.resultJson).toBeDefined();
    const taint = gw.__egressTaintForTest();
    // ...so it must be tainted: single-mode lock armed + content harvested.
    expect(taint.hasObservedPrivateRead()).toBe(true);
    expect(taint.isEgressTainted(smuggled, "")).toBe(true);
  });

  it("rejects a connector.read whose model-visible result exceeds the FREE-tier readAggregateByteCap (TOOL_RESULT_TOO_LARGE)", async () => {
    loadRegistry();
    const big = "x".repeat(5000); // well over the 1 KiB cap below
    const { bridge } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { ok: true, data: { events: [{ summary: big }] } },
    }));
    const gw = new ToolGateway(
      mkDeps({ clientBridge: bridge, readAggregateByteCap: 1000 }),
    );
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z", maxResults: 50 },
      }),
      mkPack(),
      TURN,
    );
    // Parity with memory/folder/media reads, which connector.read previously
    // bypassed by returning before the generic byte-cap block.
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("TOOL_RESULT_TOO_LARGE");
  });

  it("admits a small connector.read under the readAggregateByteCap and accrues the per-turn budget cumulatively", async () => {
    loadRegistry();
    const resultJson = { ok: true, data: { events: [{ summary: "z".repeat(300) }] } };
    // Derive the EXACT model-visible size from the same sanitizer the dispatch
    // meters with, then set the cap AT that boundary: one read is admitted (it is
    // not strictly greater than the cap), a second accrues past it and is rejected.
    // Deterministic regardless of the sanitizer's exact pretty-print/wrapper bytes.
    const perRead = Buffer.byteLength(
      sanitizeToolOutputForModel({ toolName: "connector.read", outcome: "ok", payload: resultJson }),
      "utf8",
    );
    const { bridge } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson,
    }));
    const gw = new ToolGateway(
      mkDeps({ clientBridge: bridge, readAggregateByteCap: perRead }),
    );
    const frame = () =>
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z", maxResults: 50 },
      });
    const first = await gw.dispatch(frame(), mkPack(), TURN);
    expect(first.outcome).toBe("ok");
    // Cumulative accrual into the SAME per-turn counter → the second read trips.
    const second = await gw.dispatch(frame(), mkPack(), TURN);
    expect(second.outcome).toBe("gateway_rejected");
    expect(second.reason).toBe("TOOL_RESULT_TOO_LARGE");
  });

  it("meters a connector.read payload smuggled under a NON-ok outcome (reinjected → must be capped)", async () => {
    loadRegistry();
    const big = "y".repeat(5000);
    const { bridge } = recordingBridge((frame) => ({
      invocationId: frame.invocationId,
      // Non-conforming/rate-limited adapter: a large partial payload under an
      // error envelope. The dispatch forwards resultJson regardless of outcome,
      // so it is reinjected to the model and must be metered like an ok read.
      outcome: "error",
      reason: "rate_limited",
      resultJson: { ok: false, errorCode: "rate_limited", data: { events: [{ summary: big }] } },
    }));
    const gw = new ToolGateway(
      mkDeps({ clientBridge: bridge, readAggregateByteCap: 1000 }),
    );
    const res = await gw.dispatch(
      readFrame({
        connectorId: "google-calendar",
        operation: "list_events",
        params: { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z", maxResults: 50 },
      }),
      mkPack(),
      TURN,
    );
    expect(res.outcome).toBe("gateway_rejected");
    expect(res.reason).toBe("TOOL_RESULT_TOO_LARGE");
  });

  it("connector.list does NOT taint egress (catalog metadata, not private external data)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    await gw.dispatch(readFrame({}, "connector.list"), mkPack(), TURN);
    expect(gw.__egressTaintForTest().hasObservedPrivateRead()).toBe(false);
  });

  // Structural S5 boundary (R2-low-2): admission receives mode-FREE
  // connectedConnectors, never the echoes. The ledger still records the mode.
  it("the ledger records the mode echo even though admission never sees it (S5)", async () => {
    loadRegistry();
    const gw = new ToolGateway(mkDeps());
    const res = await gw.dispatch(
      readFrame(
        { connectorId: "google-calendar", operation: "create_event", params: createParams },
        "connector.act",
      ),
      mkPack(),
      TURN,
    );
    expect(res.ledgerEntry.scope).toContain("mode=auto");
  });
});
