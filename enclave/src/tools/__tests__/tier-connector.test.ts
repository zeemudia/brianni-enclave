import { describe, expect, it } from "vitest";
import { ToolCallLedgerEntrySchema } from "@calypso/chat-types";
import {
  admitConnectorInvocation,
  MAX_CONNECTOR_MUTATIONS_PER_TURN,
  MAX_CONNECTOR_READS_PER_TURN,
  checkConnectorTurnBudget,
  buildConnectorLedgerEntry,
} from "../tier-connector";

const catalog = [
  {
    id: "google-calendar",
    displayName: "Google Calendar",
    provider: "google",
    platforms: ["web"],
    oauthScopes: ["https://www.googleapis.com/auth/calendar.events"],
    operations: [
      { id: "list_events", mutating: false, destructive: false, binary: false, requiredScope: "calendar.readonly", maxWindowDays: 370, maxResults: 250, windowParams: { start: "timeMin", end: "timeMax" }, maxResultsParam: "maxResults", paramsSchema: {} },
      {
        id: "create_event",
        mutating: true,
        destructive: false,
        binary: false,
        requiredScope: "calendar.events",
        eventTimeRange: { start: "start", end: "end" },
        paramsSchema: {
          calendarId: { type: "string", required: true },
          summary: { type: "string", required: true },
          start: { type: "string", required: true },
          end: { type: "string", required: true },
        },
      },
      { id: "download_attachment", mutating: false, destructive: false, binary: true, requiredScope: "calendar.readonly", paramsSchema: {} },
    ],
    mcp: null,
  },
];

const baseCtx = {
  catalog,
  pack: { toolScopes: ["connector.list", "connector.read", "connector.act"] },
  connectedConnectors: [
    { connectorId: "google-calendar", displayName: "[C_1]", status: "connected", grantedScopes: ["calendar.readonly", "calendar.events"] },
  ],
  boundConnectorIds: ["google-calendar"],
};
const createParams = {
  calendarId: "primary",
  summary: "Lunch",
  start: "2026-07-01T09:00:00Z",
  end: "2026-07-01T09:30:00Z",
};

describe("connector admission (spec §5.2)", () => {
  it("admits a valid read (a ceiling-declaring op needs in-ceiling params supplied)", () => {
    // list_events declares window + results ceilings, so a genuine admit must
    // carry valid params. A read with NO params no longer admits (that was the
    // fail-open the §12 contract forbids — see the OMITTED-params reject below).
    expect(admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z", maxResults: 50 },
    }).ok).toBe(true);
  });

  it("rejects an unknown connector or operation (check 1)", () => {
    expect(admitConnectorInvocation({ ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "nope" }).ok).toBe(false);
    expect(admitConnectorInvocation({ ...baseCtx, tool: "connector.read", connectorId: "nope", operation: "list_events" }).ok).toBe(false);
  });

  it("rejects a mutating op via connector.read and a non-mutating via connector.act (check 2)", () => {
    expect(admitConnectorInvocation({ ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "create_event" }).ok).toBe(false);
    expect(admitConnectorInvocation({ ...baseCtx, tool: "connector.act", connectorId: "google-calendar", operation: "list_events" }).ok).toBe(false);
  });

  it("rejects a connector not in connectedConnectors / not connected (check 3)", () => {
    const ctx = { ...baseCtx, connectedConnectors: [{ ...baseCtx.connectedConnectors[0], status: "needs_reauth" }] };
    expect(admitConnectorInvocation({ ...ctx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events" }).ok).toBe(false);
  });

  it("rejects when connector.* not in pack.toolScopes or connector not bound (check 4)", () => {
    const noScope = { ...baseCtx, pack: { toolScopes: ["memory.read"] } };
    expect(admitConnectorInvocation({ ...noScope, tool: "connector.read", connectorId: "google-calendar", operation: "list_events" }).ok).toBe(false);
    const notBound = { ...baseCtx, boundConnectorIds: [] };
    expect(admitConnectorInvocation({ ...notBound, tool: "connector.read", connectorId: "google-calendar", operation: "list_events" }).ok).toBe(false);
  });

  it("treats a non-flat-matching grant as INCONCLUSIVE, never a hard reject (check 5, Finding-3)", () => {
    const dialect = { ...baseCtx, connectedConnectors: [{ ...baseCtx.connectedConnectors[0], grantedScopes: ["Calendars.ReadWrite"] }] };
    const result = admitConnectorInvocation({
      ...dialect,
      tool: "connector.act",
      connectorId: "google-calendar",
      operation: "create_event",
      params: createParams,
    });
    expect(result.ok).toBe(true);
    expect(result.scopeCheck).toBe("inconclusive");
  });

  it("rejects a mutating invocation missing signed-catalog required params", () => {
    const result = admitConnectorInvocation({
      ...baseCtx,
      tool: "connector.act",
      connectorId: "google-calendar",
      operation: "create_event",
      params: {
        start: "2026-07-01T09:00:00Z",
        end: "2026-07-01T09:30:00Z",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_REQUIRED_PARAMS_MISSING");
  });

  it("rejects a mutating write whose eventTimeParams value is unexecutable, BEFORE budget (CONNECTOR_PARAM_DATETIME_INVALID)", () => {
    for (const badStart of [
      "tomorrow morning", // natural language
      "2026-02-31T09:00:00Z", // impossible date
      "2026-07-01T25:00:00Z", // impossible time
    ]) {
      const result = admitConnectorInvocation({
        ...baseCtx,
        tool: "connector.act",
        connectorId: "google-calendar",
        operation: "create_event",
        params: { ...createParams, start: badStart },
      });
      expect(result.ok, `start=${badStart}`).toBe(false);
      expect(result.reason).toBe("CONNECTOR_PARAM_DATETIME_INVALID");
    }
  });

  it("admits a write whose eventTimeRange bounds are valid (offset-less local accepted; client binds the zone)", () => {
    const result = admitConnectorInvocation({
      ...baseCtx,
      tool: "connector.act",
      connectorId: "google-calendar",
      operation: "create_event",
      // Offset-less local datetime — valid at the gate; the client adapter binds
      // the user's IANA zone before the provider call.
      params: { ...createParams, start: "2026-07-01T09:00:00", end: "2026-07-01T10:00:00" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an inverted / zero-length write range BEFORE budget (end ≤ start → CONNECTOR_PARAM_DATETIME_INVALID)", () => {
    for (const [start, end] of [
      ["2026-07-01T15:00:00Z", "2026-07-01T14:00:00Z"], // inverted
      ["2026-07-01T09:00:00Z", "2026-07-01T09:00:00Z"], // zero-length
      ["2026-07-01T15:00:00", "2026-07-01T14:00:00"], // inverted offset-less local
    ]) {
      const result = admitConnectorInvocation({
        ...baseCtx,
        tool: "connector.act",
        connectorId: "google-calendar",
        operation: "create_event",
        params: { ...createParams, start, end },
      });
      expect(result.ok, `${start}..${end}`).toBe(false);
      expect(result.reason).toBe("CONNECTOR_PARAM_DATETIME_INVALID");
    }
  });

  it("admits connector.list — read-only discovery, no operation lookup (Finding-8)", () => {
    const result = admitConnectorInvocation({ ...baseCtx, tool: "connector.list", connectorId: "google-calendar" });
    expect(result.ok).toBe(true);
  });

  it("rejects a binary/large-blob content op at admission in v1 (§15.2, Finding-2/-9)", () => {
    const result = admitConnectorInvocation({ ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "download_attachment" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_BINARY_OP_UNSUPPORTED");
  });

  const readCeilParams = (over: Record<string, unknown>) => ({
    timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z", maxResults: 50, ...over,
  });

  it("rejects a read whose window exceeds maxWindowDays (§12 read-ceiling, R5-A)", () => {
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: readCeilParams({ timeMin: "2020-01-01T00:00:00Z", timeMax: "2026-01-01T00:00:00Z" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_READ_WINDOW_EXCEEDED");
  });

  it("rejects a read whose maxResults exceeds the catalog ceiling (§12, R5-A)", () => {
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: readCeilParams({ maxResults: 5000 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_READ_RESULTS_EXCEEDED");
  });

  it("FAILS CLOSED on absent window/results params when the op declares ceilings (R6-A)", () => {
    const empty = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events", params: {},
    });
    expect(empty.ok).toBe(false);
    expect(empty.reason).toBe("CONNECTOR_READ_WINDOW_REQUIRED");
    const noResults = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z" },
    });
    expect(noResults.ok).toBe(false);
    expect(noResults.reason).toBe("CONNECTOR_READ_RESULTS_REQUIRED");
  });

  it("FAILS CLOSED when params is OMITTED entirely on a ceiling op — fail-closed lives in the function, not the caller", () => {
    // Adversarial / defense-in-depth: a direct caller that omits `params`
    // altogether (ctx.params === undefined) must NOT bypass the §12 ceiling.
    // The function coalesces an absent params to {} so a ceiling-declaring op
    // REJECTS rather than admitting an unbounded pull. (The production dispatch
    // always passes a schema-defaulted {}, but this guarantee must not depend on
    // every caller remembering to pre-parse.)
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      // no `params` key at all
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_READ_WINDOW_REQUIRED");
  });

  it("FAILS CLOSED on a malformed (NaN) date as INVALID (present-but-bad, distinct from missing) — no silent admit (R6-A)", () => {
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: readCeilParams({ timeMin: "not-a-date" }),
    });
    expect(result.ok).toBe(false);
    // Present-but-unparseable is INVALID, NOT REQUIRED — so a retry loop fixes the
    // value rather than re-issuing the same already-present-but-bad params.
    expect(result.reason).toBe("CONNECTOR_READ_WINDOW_INVALID");
  });

  it("FAILS CLOSED on an inverted window (end < start) as INVALID — negative span must not slip under the ceiling", () => {
    // Adversarial: timeMin > timeMax makes (endMs - startMs) negative, which would
    // pass `windowDays > maxWindowDays` and admit — a §12 bypass. Must reject, and
    // as INVALID (the window IS present, it's just malformed).
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: readCeilParams({ timeMin: "2026-06-08T00:00:00Z", timeMax: "2026-06-01T00:00:00Z" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_READ_WINDOW_INVALID");
  });

  it("FAILS CLOSED on a zero-length window (end == start) as INVALID — a read window must be a forward range", () => {
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: readCeilParams({ timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-01T00:00:00Z" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_READ_WINDOW_INVALID");
  });

  it("classifies a present-but-WRONG-TYPE window value as INVALID (symmetric with results), not REQUIRED", () => {
    // A non-string window bound (epoch-ms number here) is PRESENT but malformed —
    // it must read as INVALID (fix the value) exactly like a wrong-type count, not
    // REQUIRED (add a missing param). Guards the window/results symmetry.
    const numeric = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: { timeMin: 1780000000000, timeMax: 1780600000000, maxResults: 50 } as unknown as Record<string, unknown>,
    });
    expect(numeric.ok).toBe(false);
    expect(numeric.reason).toBe("CONNECTOR_READ_WINDOW_INVALID");
    // And an actually-absent window stays REQUIRED.
    const absent = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: { maxResults: 50 },
    });
    expect(absent.reason).toBe("CONNECTOR_READ_WINDOW_REQUIRED");
  });

  it("rejects a non-ISO but loosely-parseable window string as INVALID (deterministic across V8 versions)", () => {
    // "June 1, 2026" parses on V8's Date.parse but is NOT ISO-8601; accepting it
    // would make §12 enforcement implementation-defined (clamp today, NaN
    // tomorrow). It must reject deterministically as present-but-malformed.
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: { timeMin: "June 1, 2026", timeMax: "June 8, 2026", maxResults: 50 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_READ_WINDOW_INVALID");
  });

  it("rejects an IMPOSSIBLE read-window date (strict components, not a Date.parse rollover) as INVALID", () => {
    // "2026-02-31T..." is shape-valid but not a real date; Node's Date.parse
    // silently rolls it over to Mar 3 — so without strict component validation it
    // would reach Google as a provider-invalid window. Must fail closed here.
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: { timeMin: "2026-02-31T10:00:00Z", timeMax: "2026-03-05T10:00:00Z", maxResults: 50 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_READ_WINDOW_INVALID");
  });

  it("rejects a bare date-only (YYYY-MM-DD) window bound as INVALID (must be a date-time)", () => {
    // A date-only bound is rejected by Google Calendar timeMin/timeMax/freeBusy
    // AND cannot be bound to an unambiguous instant — it must fail closed at the
    // gate, not reach the provider as an unbound/over-broad window.
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: { timeMin: "2026-07-01", timeMax: "2026-07-02", maxResults: 50 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CONNECTOR_READ_WINDOW_INVALID");
  });

  it("distinguishes a present-but-malformed maxResults (INVALID) from an absent one (REQUIRED)", () => {
    // Absent count → REQUIRED (must be supplied).
    const absent = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-08T00:00:00Z" },
    });
    expect(absent.reason).toBe("CONNECTOR_READ_RESULTS_REQUIRED");
    // Present but negative → INVALID (fix the value, don't re-supply the same).
    const negative = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: readCeilParams({ maxResults: -5 }),
    });
    expect(negative.reason).toBe("CONNECTOR_READ_RESULTS_INVALID");
  });

  it("admits a read within the catalog ceilings (valid bounded window + count)", () => {
    const result = admitConnectorInvocation({
      ...baseCtx, tool: "connector.read", connectorId: "google-calendar", operation: "list_events",
      params: readCeilParams({}),
    });
    expect(result.ok).toBe(true);
  });

  it("admission input is MODE-FREE by construction — the echo is a separate channel (S5 structural, R4-3)", () => {
    expect(baseCtx.connectedConnectors[0]).not.toHaveProperty("writePermissionMode");
    expect("connectorModeEchoes" in baseCtx).toBe(false);
  });
});

describe("per-turn connector budgets (anti-compromise, §6)", () => {
  it("exposes the measured baseline constants", () => {
    expect(MAX_CONNECTOR_MUTATIONS_PER_TURN).toBe(5);
    expect(MAX_CONNECTOR_READS_PER_TURN).toBe(20);
  });

  it("rejects the (N+1)th mutation in a turn, even with mode auto", () => {
    const state = { mutations: MAX_CONNECTOR_MUTATIONS_PER_TURN, reads: 0 };
    expect(checkConnectorTurnBudget(state, "connector.act").ok).toBe(false);
  });

  it("rejects the (N+1)th read in a turn", () => {
    const state = { mutations: 0, reads: MAX_CONNECTOR_READS_PER_TURN };
    expect(checkConnectorTurnBudget(state, "connector.read").ok).toBe(false);
  });

  it("admits within budget and is independent of the tool-call budget", () => {
    expect(checkConnectorTurnBudget({ mutations: 1, reads: 1 }, "connector.act").ok).toBe(true);
  });

  it("an owner override raises the effective per-turn cap (§6 invariant 4)", () => {
    const atBaseline = { mutations: MAX_CONNECTOR_MUTATIONS_PER_TURN, reads: 0 };
    expect(checkConnectorTurnBudget(atBaseline, "connector.act").ok).toBe(false);
    expect(
      checkConnectorTurnBudget(atBaseline, "connector.act", { mutationsPerTurn: 50 }).ok,
    ).toBe(true);
  });

  it("absent/partial override falls back to the measured baseline per cap", () => {
    const state = { mutations: MAX_CONNECTOR_MUTATIONS_PER_TURN, reads: 0 };
    expect(
      checkConnectorTurnBudget(state, "connector.act", { readsPerTurn: 999 }).ok,
    ).toBe(false);
  });

  it("an 'unbounded' override disables the per-turn cap (§17 #2)", () => {
    expect(
      checkConnectorTurnBudget({ mutations: 10_000, reads: 0 }, "connector.act", {
        mutationsPerTurn: "unbounded",
      }).ok,
    ).toBe(true);
  });

  it("a BELOW-baseline override cannot LOWER the cap — the baseline is the floor", () => {
    // The override may only RAISE (a hijacked-MODEL guard); a small/zero value
    // must NOT brick the turn. At 3 mutations with a bogus override of 2, the
    // effective cap stays the baseline of 5 → still admitted.
    expect(
      checkConnectorTurnBudget({ mutations: 3, reads: 0 }, "connector.act", {
        mutationsPerTurn: 2,
      }).ok,
    ).toBe(true);
    // And a zero override is likewise clamped to the baseline (not a hard brick).
    expect(
      checkConnectorTurnBudget({ mutations: 4, reads: 0 }, "connector.act", {
        mutationsPerTurn: 0,
      }).ok,
    ).toBe(true);
    // Below baseline does not RAISE either: at the baseline the (N+1)th still rejects.
    expect(
      checkConnectorTurnBudget(
        { mutations: MAX_CONNECTOR_MUTATIONS_PER_TURN, reads: 0 },
        "connector.act",
        { mutationsPerTurn: 2 },
      ).ok,
    ).toBe(false);
  });
});

describe("connector ledger (S5 — mode is ledger-only, always recorded)", () => {
  it("records the connector op with the mode in effect, never using it for authorization", () => {
    const entry = buildConnectorLedgerEntry({
      tool: "connector.act",
      connectorId: "google-calendar",
      operation: "create_event",
      outcome: "ok",
      modeInEffect: "auto",
      skillPackId: "personal-agent.default",
      turnId: "turn_1",
    });
    expect(entry.toolName).toBe("connector.act");
    expect(entry.outcome).toBe("ok");
    expect(entry.scope).toContain("auto");
    expect(entry).not.toHaveProperty("id");
    expect(() => ToolCallLedgerEntrySchema.parse({ ...entry, id: 1 })).not.toThrow();
  });

  it("records a rate_limited outcome distinctly (Finding #11)", () => {
    const entry = buildConnectorLedgerEntry({
      tool: "connector.act",
      connectorId: "google-calendar",
      operation: "create_event",
      outcome: "error",
      reason: "rate_limited",
      modeInEffect: "auto",
      skillPackId: "personal-agent.default",
      turnId: "turn_1",
    });
    expect(entry.reason).toBe("rate_limited");
  });

  it("appends an auditable :uncapped marker to scope when the override exceeds baseline (R4-6)", () => {
    const entry = buildConnectorLedgerEntry({
      tool: "connector.act",
      connectorId: "google-calendar",
      operation: "create_event",
      outcome: "ok",
      modeInEffect: "auto",
      skillPackId: "personal-agent.default",
      turnId: "turn_1",
      uncapped: true,
    });
    expect(entry.scope).toContain("uncapped");
    expect(() => ToolCallLedgerEntrySchema.parse({ ...entry, id: 1 })).not.toThrow();
  });

  it("handles connector.list (no operation) gracefully and defaults reason to null", () => {
    const entry = buildConnectorLedgerEntry({
      tool: "connector.list",
      connectorId: "google-calendar",
      outcome: "ok",
      modeInEffect: "unknown",
      skillPackId: "personal-agent.default",
      turnId: "turn_1",
    });
    expect(entry.toolName).toBe("connector.list");
    expect(entry.reason).toBeNull();
    expect(entry.approvedPath).toBeNull();
    expect(() => ToolCallLedgerEntrySchema.parse({ ...entry, id: 1 })).not.toThrow();
  });
});
