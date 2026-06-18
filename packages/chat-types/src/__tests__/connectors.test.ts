import { describe, expect, it } from "vitest";

import {
  CONNECTOR_WRITE_PERMISSION_MODES,
  ConnectorWritePermissionModeSchema,
  CONNECTOR_RESULT_ERROR_CODES,
  ConnectorResultEnvelopeSchema,
  ConnectorInvocationArgsSchema,
  ConnectorListArgsSchema,
  ConnectorOperationSchema,
  ConnectorCatalogSchema,
  MIN_CONNECTOR_CATALOG_VERSION,
} from "../connectors";

describe("connector write-permission modes", () => {
  it("are exactly the three documented modes, default always_ask first", () => {
    expect(CONNECTOR_WRITE_PERMISSION_MODES).toEqual([
      "always_ask",
      "once_per_session",
      "auto",
    ]);
  });

  it("schema accepts the three modes and rejects anything else", () => {
    for (const m of CONNECTOR_WRITE_PERMISSION_MODES) {
      expect(ConnectorWritePermissionModeSchema.parse(m)).toBe(m);
    }
    expect(() => ConnectorWritePermissionModeSchema.parse("silent")).toThrow();
  });
});

describe("normalized connector result envelope (N1)", () => {
  it("accepts an ok envelope with data", () => {
    expect(
      ConnectorResultEnvelopeSchema.parse({ ok: true, data: { events: [] } }),
    ).toEqual({ ok: true, data: { events: [] } });
  });

  it("accepts a retryable rate-limit error envelope", () => {
    expect(
      ConnectorResultEnvelopeSchema.parse({
        ok: false,
        errorCode: "rate_limited",
        retryable: true,
      }),
    ).toMatchObject({ ok: false, errorCode: "rate_limited", retryable: true });
  });

  it("pins the well-known error vocabulary (rate_limited included)", () => {
    expect(CONNECTOR_RESULT_ERROR_CODES).toContain("rate_limited");
  });

  it("accepts the 'unknown' escape hatch but rejects an off-vocabulary code", () => {
    expect(
      ConnectorResultEnvelopeSchema.parse({ ok: false, errorCode: "unknown" })
        .errorCode,
    ).toBe("unknown");
    expect(() =>
      ConnectorResultEnvelopeSchema.parse({ ok: false, errorCode: "rateLimited" }),
    ).toThrow();
  });

  it("rejects a non-boolean ok", () => {
    expect(() =>
      ConnectorResultEnvelopeSchema.parse({ ok: "yes" }),
    ).toThrow();
  });

  it("rejects contradictory shapes (ok:true with errorCode; ok:false with no errorCode)", () => {
    expect(() =>
      ConnectorResultEnvelopeSchema.parse({ ok: true, errorCode: "rate_limited" }),
    ).toThrow();
    expect(() => ConnectorResultEnvelopeSchema.parse({ ok: false })).toThrow();
  });

  it("rejects an error envelope that smuggles data (ok:false with data)", () => {
    expect(() =>
      ConnectorResultEnvelopeSchema.parse({
        ok: false,
        errorCode: "unknown",
        data: { events: [] },
      }),
    ).toThrow();
  });
});

describe("connector invocation args ({connectorId, operation, params})", () => {
  it("accepts a well-formed args object", () => {
    expect(
      ConnectorInvocationArgsSchema.parse({
        connectorId: "google-calendar",
        operation: "list_events",
        params: { timeMin: "[DATE_1]" },
      }),
    ).toMatchObject({ connectorId: "google-calendar", operation: "list_events" });
  });

  it("rejects missing operation", () => {
    expect(() =>
      ConnectorInvocationArgsSchema.parse({
        connectorId: "google-calendar",
        params: {},
      }),
    ).toThrow();
  });
});

describe("connector.list args (discovery — no operation, Finding R2-1)", () => {
  it("accepts an empty args object (list all connected)", () => {
    expect(ConnectorListArgsSchema.parse({})).toEqual({});
  });

  it("accepts an optional connectorId scope", () => {
    expect(
      ConnectorListArgsSchema.parse({ connectorId: "google-calendar" }),
    ).toEqual({ connectorId: "google-calendar" });
  });

  it("does NOT require operation (unlike read/act)", () => {
    expect(() => ConnectorListArgsSchema.parse({})).not.toThrow();
  });
});

const validReadOp = {
  id: "list_events",
  mutating: false,
  requiredScope: "calendar.readonly",
  maxWindowDays: 370,
  maxResults: 250,
  windowParams: { start: "timeMin", end: "timeMax" },
  maxResultsParam: "maxResults",
  paramsSchema: { timeMin: { type: "string" } },
};

const validDeleteOp = {
  id: "delete_event",
  mutating: true,
  destructive: true,
  concurrency: "etag",
  requiredScope: ["calendar.events"],
  paramsSchema: { eventId: { type: "string" } },
};

const validCatalog = {
  version: 1,
  connectors: [
    {
      id: "google-calendar",
      displayName: "Google Calendar",
      provider: "google",
      platforms: ["web", "ios", "android"],
      oauthScopes: ["https://www.googleapis.com/auth/calendar.events"],
      operations: [validReadOp, validDeleteOp],
      mcp: null,
    },
  ],
  signature: "AAAA",
};

describe("connector operation schema", () => {
  it("accepts a non-mutating read op with read ceilings", () => {
    expect(ConnectorOperationSchema.parse(validReadOp)).toMatchObject({
      id: "list_events",
      mutating: false,
    });
  });

  it("accepts requiredScope as an array of acceptable grants (Finding-3)", () => {
    expect(ConnectorOperationSchema.parse(validDeleteOp).requiredScope).toEqual([
      "calendar.events",
    ]);
  });

  it("rejects a destructive op that is not mutating", () => {
    expect(() =>
      ConnectorOperationSchema.parse({
        id: "bad",
        mutating: false,
        destructive: true,
        requiredScope: "x",
      }),
    ).toThrow();
  });

  it("defaults destructive to false", () => {
    expect(ConnectorOperationSchema.parse(validReadOp).destructive).toBe(false);
  });

  it("defaults binary to false (text/JSON op); a binary op is admitted-rejected in Phase 1", () => {
    expect(ConnectorOperationSchema.parse(validReadOp).binary).toBe(false);
    expect(
      ConnectorOperationSchema.parse({ ...validReadOp, binary: true }).binary,
    ).toBe(true);
  });

  // A declared ceiling without the catalog-named param key the enclave reads to
  // apply it (windowParams / maxResultsParam) is SILENTLY INERT — the Task-9
  // enforcement only fires when BOTH are declared. Reject at parse so the signer
  // (Task 12) fails loudly on a signed-but-unenforceable ceiling, exactly like
  // the duplicate-id refines (same signed-but-broken-catalog class).
  it("rejects maxWindowDays declared without windowParams (unenforceable ceiling)", () => {
    const { windowParams: _omit, ...noKeys } = validReadOp;
    expect(() => ConnectorOperationSchema.parse(noKeys)).toThrow(/windowParams/);
  });

  it("rejects maxResults declared without maxResultsParam (unenforceable ceiling)", () => {
    const { maxResultsParam: _omit, ...noKey } = validReadOp;
    expect(() => ConnectorOperationSchema.parse(noKey)).toThrow(/maxResultsParam/);
  });

  it("accepts an op that declares neither ceiling nor its key (ceilings are optional)", () => {
    expect(
      ConnectorOperationSchema.parse({
        id: "get_event",
        mutating: false,
        requiredScope: "calendar.readonly",
        paramsSchema: {},
      }),
    ).toMatchObject({ id: "get_event" });
  });
});

describe("connector catalog schema", () => {
  it("accepts the Google Calendar reference catalog", () => {
    expect(ConnectorCatalogSchema.parse(validCatalog)).toMatchObject({
      version: 1,
    });
  });

  it("rejects a non-null mcp slot in v1 (fail-closed)", () => {
    expect(() =>
      ConnectorCatalogSchema.parse({
        ...validCatalog,
        connectors: [{ ...validCatalog.connectors[0], mcp: { server: "x" } }],
      }),
    ).toThrow();
  });

  it("requires a signature", () => {
    const { signature: _omit, ...unsigned } = validCatalog;
    expect(() => ConnectorCatalogSchema.parse(unsigned)).toThrow();
  });

  it("exposes the anti-rollback floor constant", () => {
    expect(MIN_CONNECTOR_CATALOG_VERSION).toBe(1);
  });

  it("rejects duplicate connector ids (Finding R1-4 — no silent last-write-wins)", () => {
    expect(() =>
      ConnectorCatalogSchema.parse({
        ...validCatalog,
        connectors: [validCatalog.connectors[0], validCatalog.connectors[0]],
      }),
    ).toThrow();
  });

  it("rejects duplicate operation ids within a connector (Finding R1-4)", () => {
    expect(() =>
      ConnectorCatalogSchema.parse({
        ...validCatalog,
        connectors: [
          { ...validCatalog.connectors[0], operations: [validReadOp, validReadOp] },
        ],
      }),
    ).toThrow();
  });
});

import * as chatTypes from "../index";

describe("package root re-exports the connector surface", () => {
  it("exports the connector schemas, constants, and builders", () => {
    for (const name of [
      "CONNECTOR_WRITE_PERMISSION_MODES",
      "ConnectorWritePermissionModeSchema",
      "CONNECTOR_RESULT_ERROR_CODES",
      "ConnectorResultErrorCodeSchema",
      "ConnectorResultEnvelopeSchema",
      "ConnectorInvocationArgsSchema",
      "ConnectorListArgsSchema",
      "ConnectorOperationSchema",
      "ConnectorDescriptorSchema",
      "ConnectorCatalogSchema",
      "MIN_CONNECTOR_CATALOG_VERSION",
      "canonicalConnectorsSigningInput",
      "CONNECTORS_SIGNING_DOMAIN",
      "ConnectedConnectorContextSchema",
      "ConnectorModeEchoSchema",
      "ConnectorTurnBudgetOverrideSchema",
      "MAX_AGENT_CONNECTORS",
      "buildConnectedConnectorContext",
    ]) {
      expect(chatTypes).toHaveProperty(name);
    }
  });
});
