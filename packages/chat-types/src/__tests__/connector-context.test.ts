import { describe, expect, it } from "vitest";

import {
  AgentRequestContextSchema,
  ConnectedConnectorContextSchema,
  ConnectorModeEchoSchema,
  ConnectorTurnBudgetOverrideSchema,
  MAX_AGENT_CONNECTORS,
  buildConnectedConnectorContext,
} from "../agent-context";

function connectors(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    connectorId: `c${i}`,
    displayName: `C${i}`,
    status: "connected" as const,
    grantedScopes: ["calendar.readonly"],
  }));
}

describe("connected-connector request context", () => {
  it("accepts up to MAX_AGENT_CONNECTORS", () => {
    expect(() =>
      AgentRequestContextSchema.parse({
        connectedConnectors: connectors(MAX_AGENT_CONNECTORS),
      }),
    ).not.toThrow();
  });

  it("rejects more than MAX_AGENT_CONNECTORS (hard error, no silent truncation)", () => {
    expect(() =>
      AgentRequestContextSchema.parse({
        connectedConnectors: connectors(MAX_AGENT_CONNECTORS + 1),
      }),
    ).toThrow();
  });

  it("defaults connectedConnectors to an empty array (back-compat)", () => {
    expect(
      AgentRequestContextSchema.parse({}).connectedConnectors,
    ).toEqual([]);
  });

  it("rejects a duplicate connectorId in connectedConnectors (no silent first-match)", () => {
    expect(() =>
      AgentRequestContextSchema.parse({
        connectedConnectors: [
          { connectorId: "google-calendar", displayName: "[C_1]", status: "connected", grantedScopes: ["calendar.readonly"] },
          { connectorId: "google-calendar", displayName: "[C_2]", status: "needs_reauth", grantedScopes: [] },
        ],
      }),
    ).toThrow();
  });

  it("rejects a duplicate connectorId in connectorModeEchoes (audit-ledger integrity)", () => {
    // Two contradictory echoes for one connector would silently first-match in
    // connectorModeInEffect, corrupting the ledger. Reject at the boundary.
    expect(() =>
      AgentRequestContextSchema.parse({
        connectorModeEchoes: [
          { connectorId: "google-calendar", writePermissionMode: "auto" },
          { connectorId: "google-calendar", writePermissionMode: "always_ask" },
        ],
      }),
    ).toThrow();
  });

  it("carries grantedScopes but STRIPS any token-like field", () => {
    const parsed = ConnectedConnectorContextSchema.parse({
      connectorId: "google-calendar",
      displayName: "[CONNECTOR_1]",
      status: "connected",
      grantedScopes: ["calendar.events"],
      accessToken: "ya29.SECRET",
      refreshToken: "1//SECRET",
    });
    expect(parsed.grantedScopes).toEqual(["calendar.events"]);
    expect(parsed).not.toHaveProperty("accessToken");
    expect(parsed).not.toHaveProperty("refreshToken");
  });

  it("connectedConnectors entry is MODE-FREE — the mode is stripped (S5 structural, R4-3)", () => {
    const parsed = ConnectedConnectorContextSchema.parse({
      connectorId: "google-calendar",
      displayName: "[C_1]",
      status: "connected",
      grantedScopes: ["calendar.events"],
      writePermissionMode: "auto", // NOT part of the admission input → stripped by Zod
    });
    expect(parsed).not.toHaveProperty("writePermissionMode");
  });

  it("the ledger-only mode echo rides the SEPARATE connectorModeEchoes channel (§6 invariant 2)", () => {
    expect(
      ConnectorModeEchoSchema.parse({ connectorId: "google-calendar", writePermissionMode: "auto" }),
    ).toEqual({ connectorId: "google-calendar", writePermissionMode: "auto" });
    const ctx = AgentRequestContextSchema.parse({
      connectorModeEchoes: [{ connectorId: "google-calendar", writePermissionMode: "auto" }],
    });
    expect(ctx.connectorModeEchoes).toHaveLength(1);
    expect(AgentRequestContextSchema.parse({}).connectorModeEchoes).toEqual([]);
  });
});

describe("buildConnectedConnectorContext", () => {
  it("filters to bound + connected connectors and shapes the context", () => {
    const result = buildConnectedConnectorContext(
      [
        {
          id: "google-calendar",
          displayName: "Google Calendar",
          status: "connected",
          grantedScopes: ["calendar.events"],
        },
        {
          id: "slack",
          displayName: "Slack",
          status: "connected",
          grantedScopes: ["channels:read"],
        },
        {
          id: "revoked-one",
          displayName: "Old",
          status: "revoked",
          grantedScopes: [],
        },
      ],
      ["google-calendar", "revoked-one"],
    );

    expect(result).toEqual([
      {
        connectorId: "google-calendar",
        displayName: "Google Calendar",
        status: "connected",
        grantedScopes: ["calendar.events"],
      },
    ]);
  });

  it("defensively caps at MAX_AGENT_CONNECTORS", () => {
    const raw = Array.from({ length: MAX_AGENT_CONNECTORS + 3 }, (_, i) => ({
      id: `c${i}`,
      displayName: `C${i}`,
      status: "connected" as const,
      grantedScopes: [],
    }));
    const result = buildConnectedConnectorContext(
      raw,
      raw.map((c) => c.id),
    );
    expect(result).toHaveLength(MAX_AGENT_CONNECTORS);
  });
});

describe("owner cap-raise contract (spec §6 invariant 4)", () => {
  it("is absent by default (back-compat) — enclave then uses its measured baseline", () => {
    expect(
      AgentRequestContextSchema.parse({}).connectorTurnBudgetOverride,
    ).toBeUndefined();
  });

  it("carries an owner-raised per-turn budget when present", () => {
    const ctx = AgentRequestContextSchema.parse({
      connectorTurnBudgetOverride: { mutationsPerTurn: 50, readsPerTurn: 200 },
    });
    expect(ctx.connectorTurnBudgetOverride).toEqual({
      mutationsPerTurn: 50,
      readsPerTurn: 200,
    });
  });

  it("accepts a partial override (one cap raised, the other inherits baseline)", () => {
    expect(
      ConnectorTurnBudgetOverrideSchema.parse({ mutationsPerTurn: 25 }),
    ).toEqual({ mutationsPerTurn: 25 });
  });

  it("honors §17 #2 'owner-raisable to unbounded' via an explicit sentinel", () => {
    expect(
      ConnectorTurnBudgetOverrideSchema.parse({ mutationsPerTurn: "unbounded" }),
    ).toEqual({ mutationsPerTurn: "unbounded" });
  });

  it("rejects a negative/non-integer cap or an arbitrary string (only the sentinel)", () => {
    expect(() =>
      ConnectorTurnBudgetOverrideSchema.parse({ mutationsPerTurn: -1 }),
    ).toThrow();
    expect(() =>
      ConnectorTurnBudgetOverrideSchema.parse({ readsPerTurn: 1.5 }),
    ).toThrow();
    expect(() =>
      ConnectorTurnBudgetOverrideSchema.parse({ mutationsPerTurn: "lots" }),
    ).toThrow();
  });
});
