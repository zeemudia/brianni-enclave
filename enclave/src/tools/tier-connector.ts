/**
 * Connector tier admission checks (spec §5.2).
 *
 * Pure function — no I/O, no registry singleton, no per-connector literals.
 * All connector/operation knowledge is injected via `catalog` (catalog-data
 * path, rotation-free per the C1 guarantee). The measured code names ONLY the
 * three generic tool families: connector.list / connector.read / connector.act.
 */

import type {
  ConnectorModeEcho,
  ToolCallLedgerEntry,
  ToolResultOutcome,
} from "@calypso/chat-types";

// ---------------------------------------------------------------------------
// Per-turn connector budget constants (§6 invariant 4 measured baseline).
// These are the HARD defaults enforced by checkConnectorTurnBudget.
// An owner-supplied connectorTurnBudgetOverride may RAISE (never lower) them.
// ---------------------------------------------------------------------------

/** Maximum connector.act (mutating) invocations per agent turn. */
export const MAX_CONNECTOR_MUTATIONS_PER_TURN = 5;

/** Maximum connector.read invocations per agent turn. */
export const MAX_CONNECTOR_READS_PER_TURN = 20;

// ---------------------------------------------------------------------------
// Per-turn budget override type (Phase-0 request-context field).
// A number raises the effective cap; "unbounded" disables it (§17 #2).
// The override can ONLY raise caps — a hijacked-MODEL guard.
// ---------------------------------------------------------------------------

export interface ConnectorTurnBudgetOverride {
  mutationsPerTurn?: number | "unbounded";
  readsPerTurn?: number | "unbounded";
}

/** Accumulated per-turn connector invocation state. */
export interface ConnectorTurnState {
  mutations: number;
  reads: number;
  /**
   * §12 #2 turn-scoped destructive lock — the set of connector ids for which a
   * `destructive` connector.act has been ADMITTED earlier in THIS turn. Once a
   * connector id is in this set, ANY further mutating connector.act on that same
   * connector for the rest of the turn is rejected
   * (CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED), so a hijacked/prompt-injected model
   * cannot launder a delete→recreate as two free-standing frames.
   *
   * The lock is resource-BLIND and content-INDEPENDENT, mirroring the
   * strictEgressLock: the enclave sees only MASKED params and (per the S5
   * invariant) cannot trust client confirm-state, so it cannot resource-match.
   * Over-rejection (a destructive op + an UNRELATED mutation on the same
   * connector in the same turn) is the SAFE direction and is accepted.
   *
   * GENERIC: keyed ONLY off the catalog `destructive`/`mutating` flags — it names
   * no connector id and no operation id, keeping the
   * connectors-no-measured-coupling tripwire green.
   */
  destructiveConnectors: Set<string>;
  /**
   * §12 #2 (symmetric half) — the set of connector ids for which ANY mutating
   * connector.act has been ADMITTED earlier in THIS turn. Paired with
   * `destructiveConnectors` so the destructive-sequence guard is ORDER-SYMMETRIC:
   * a destructive op is rejected when a mutation already occurred for that
   * connector this turn (the `create new → delete old` reverse-replace flow), just
   * as a mutation is rejected after a prior destructive op (`delete → recreate`).
   * Without this, a hijacked model evades the guard merely by emitting the
   * replace create-first. Same resource-BLIND, generic, catalog-flag-only design.
   */
  mutatedConnectors: Set<string>;
}

/** Result returned by checkConnectorTurnBudget. */
export type ConnectorTurnBudgetResult =
  | { ok: true }
  | { ok: false; reason: "CONNECTOR_TURN_MUTATION_BUDGET" | "CONNECTOR_TURN_READ_BUDGET" };

// ---------------------------------------------------------------------------
// Local structural types — mirrors the chat-types Zod shapes without importing
// them so this file stays a lightweight, test-friendly pure module.
// ---------------------------------------------------------------------------

export interface ConnectorOperationShape {
  id: string;
  mutating: boolean;
  destructive?: boolean;
  binary?: boolean;
  requiredScope: string | string[];
  maxWindowDays?: number;
  maxResults?: number;
  windowParams?: { start: string; end: string };
  maxResultsParam?: string;
  eventTimeRange?: { start: string; end: string };
  paramsSchema?: Record<string, unknown>;
}

interface ConnectorDescriptorShape {
  id: string;
  displayName?: string;
  operations: ConnectorOperationShape[];
  mcp: null;
}

interface ConnectedConnectorShape {
  connectorId: string;
  displayName?: string;
  status: string;
  grantedScopes?: string[];
}

interface PackShape {
  toolScopes: string[];
}

// ---------------------------------------------------------------------------
// Public input type
// ---------------------------------------------------------------------------

export interface ConnectorAdmissionCtx {
  /** Injected signed catalog (deserialized ConnectorDescriptor[]). */
  catalog: ConnectorDescriptorShape[];
  /** Active skill pack — provides toolScopes for scope+binding check. */
  pack: PackShape;
  /** Connected-connector list from the mode-free request context. */
  connectedConnectors: ConnectedConnectorShape[];
  /** Connector ids the user has bound to this session. */
  boundConnectorIds: string[];
  /** One of: "connector.list" | "connector.read" | "connector.act". */
  tool: string;
  /** Required for connector.read / connector.act; absent for connector.list. */
  connectorId?: string;
  /** Required for connector.read / connector.act. */
  operation?: string;
  /** Caller-supplied invocation params (for read-ceiling enforcement). */
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public return type
// ---------------------------------------------------------------------------

export type ConnectorAdmissionResult =
  | { ok: true; scopeCheck?: "satisfied" | "inconclusive"; reason?: undefined }
  | { ok: false; reason: string; scopeCheck?: undefined };

// ---------------------------------------------------------------------------
// Admission entry point
// ---------------------------------------------------------------------------

/**
 * Security gateway for connector.* tools (spec §5.2).
 *
 * Checks (in order for connector.read / connector.act):
 *  1. Unknown connector or operation → CONNECTOR_UNKNOWN_OPERATION
 *  2. Binary op reject → CONNECTOR_BINARY_OP_UNSUPPORTED
 *  3. Mutating-vs-tool mismatch → CONNECTOR_TOOL_MUTATING_MISMATCH
 *  4. connector.* not in pack.toolScopes OR connector not bound
 *     → CONNECTOR_NOT_IN_SCOPE
 *  5. Connector not in connectedConnectors with status === "connected"
 *     → CONNECTOR_NOT_CONNECTED
 *  6. Signed-catalog required params → CONNECTOR_REQUIRED_PARAMS_MISSING
 *  7. §12 read ceilings (connector.read only, fail-closed)
 *  8. §5.2 #5 scope check — coarse flat-match; non-matching ≡ inconclusive
 *     (NEVER a hard reject)
 */
export function admitConnectorInvocation(
  ctx: ConnectorAdmissionCtx,
): ConnectorAdmissionResult {
  const { tool, connectorId, catalog, pack, connectedConnectors, boundConnectorIds } = ctx;

  // -------------------------------------------------------------------
  // connector.list path — read-only discovery, no operation lookup
  // (Finding-8: list has no operation, so check 1 does not apply)
  // -------------------------------------------------------------------
  if (tool === "connector.list") {
    // Pack must expose at least one connector.* scope
    if (!hasConnectorScope(pack)) {
      return { ok: false, reason: "CONNECTOR_NOT_IN_SCOPE" };
    }
    // If a connectorId is given, it must be bound + connected
    if (connectorId !== undefined) {
      if (!boundConnectorIds.includes(connectorId)) {
        return { ok: false, reason: "CONNECTOR_NOT_IN_SCOPE" };
      }
      if (!isConnected(connectorId, connectedConnectors)) {
        return { ok: false, reason: "CONNECTOR_NOT_CONNECTED" };
      }
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // connector.read / connector.act path
  // -------------------------------------------------------------------
  const operation = ctx.operation;

  // Check 1: resolve op from catalog — unknown connector or operation
  const descriptor = catalog.find((c) => c.id === connectorId);
  if (!descriptor) {
    return { ok: false, reason: "CONNECTOR_UNKNOWN_OPERATION" };
  }
  const op = descriptor.operations.find((o) => o.id === operation);
  if (!op) {
    return { ok: false, reason: "CONNECTOR_UNKNOWN_OPERATION" };
  }

  // Check 2: binary op — not supported in v1 (§15.2, Finding-2/-9)
  if (op.binary === true) {
    return { ok: false, reason: "CONNECTOR_BINARY_OP_UNSUPPORTED" };
  }

  // Check 3: mutating-vs-tool mismatch
  if (tool === "connector.read" && op.mutating !== false) {
    return { ok: false, reason: "CONNECTOR_TOOL_MUTATING_MISMATCH" };
  }
  if (tool === "connector.act" && op.mutating !== true) {
    return { ok: false, reason: "CONNECTOR_TOOL_MUTATING_MISMATCH" };
  }

  // Check 4: scope + binding
  if (!hasConnectorScope(pack) || !boundConnectorIds.includes(connectorId!)) {
    return { ok: false, reason: "CONNECTOR_NOT_IN_SCOPE" };
  }

  // Check 5: connection status
  if (!isConnected(connectorId!, connectedConnectors)) {
    return { ok: false, reason: "CONNECTOR_NOT_CONNECTED" };
  }

  const params = ctx.params ?? {};
  const requiredResult = enforceRequiredParams(op, params);
  if (!requiredResult.ok) {
    return requiredResult;
  }

  // §12 read ceilings — fail-closed at THIS function, connector.read only.
  // Fail-closed is enforced HERE, not pushed onto every caller: an absent
  // `params` is treated as the empty object `{}`, so a ceiling-declaring op
  // invoked with no window/maxResults still REJECTS (CONNECTOR_READ_*_REQUIRED)
  // rather than admitting an unbounded pull. The production dispatch already
  // passes a schema-defaulted `{}`; coalescing here closes the gap for any
  // future direct caller (a refactored orchestrator path, a new admin tool, a
  // dispatch tier that forgets to pre-parse) that omits params entirely. An op
  // that declares NO ceiling still admits — enforceReadCeilings is a no-op then.
  if (tool === "connector.read") {
    const ceilResult = enforceReadCeilings(op, params);
    if (!ceilResult.ok) {
      return ceilResult;
    }
  }

  // §12 write-time validation — for a mutating op, an unexecutable event-time
  // (e.g. "tomorrow morning" or an impossible date) is rejected HERE, before the
  // caller (dispatch) touches the per-turn mutation budget or the destructive-
  // sequence lock — so a malformed planner write neither consumes a turn attempt
  // nor poisons a later valid write. Connector.act only; reads use the window
  // ceiling above.
  if (tool === "connector.act") {
    const timeResult = enforceEventTimeRange(op, params);
    if (!timeResult.ok) {
      return timeResult;
    }
  }

  // Check 5 (scope): coarse flat-match — inconclusive is NEVER a reject
  const scopeCheck = checkGrantedScopes(op.requiredScope, connectorId!, connectedConnectors);

  return { ok: true, scopeCheck };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasConnectorScope(pack: PackShape): boolean {
  return pack.toolScopes.some((s) => s.startsWith("connector."));
}

function isConnected(
  connectorId: string,
  connectedConnectors: ConnectedConnectorShape[],
): boolean {
  const entry = connectedConnectors.find((c) => c.connectorId === connectorId);
  return entry?.status === "connected";
}

// Read WINDOW bounds (timeMin/timeMax) and write event-times are validated with
// the STRICT date-time checker (isStrictIsoDateTime, below): the `T` time
// component is REQUIRED (a bare YYYY-MM-DD window is unbindable / provider-
// invalid) and the calendar components must be REAL — so an impossible value
// ("2026-02-31T10:00:00Z") fails closed at the gate rather than being silently
// rolled over by Date.parse and forwarded to the provider. Generic over the
// catalog-NAMED keys; names no connector/param (C1).

function enforceRequiredParams(
  op: ConnectorOperationShape,
  params: Record<string, unknown>,
): ConnectorAdmissionResult {
  const schema = op.paramsSchema ?? {};
  for (const [key, descriptor] of Object.entries(schema)) {
    if (!isRequiredParamDescriptor(descriptor)) continue;
    const value = params[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return { ok: false, reason: "CONNECTOR_REQUIRED_PARAMS_MISSING" };
    }
  }
  return { ok: true };
}

function isRequiredParamDescriptor(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { required?: unknown }).required === true
  );
}

/**
 * §12 read-ceiling enforcement. Fail-closed, with a REQUIRED-vs-INVALID split so
 * the caller can tell a MISSING param from a MALFORMED one (distinct ledger
 * triage; no same-params retry loop):
 *  - absent param            → CONNECTOR_READ_{WINDOW,RESULTS}_REQUIRED
 *  - present but malformed    → CONNECTOR_READ_{WINDOW,RESULTS}_INVALID
 *    (unparseable/inverted/zero-length window; non-int/negative count)
 *  - present but over ceiling → CONNECTOR_READ_{WINDOW,RESULTS}_EXCEEDED
 * Never a pass-through admit when a declared ceiling can't be enforced.
 */
function enforceReadCeilings(
  op: ConnectorOperationShape,
  params: Record<string, unknown>,
): ConnectorAdmissionResult {
  // Window ceiling
  if (op.maxWindowDays !== undefined && op.windowParams !== undefined) {
    const startKey = op.windowParams.start;
    const endKey = op.windowParams.end;
    const startRaw = params[startKey];
    const endRaw = params[endKey];

    // Absent (either bound undefined/null) → REQUIRED: the param is genuinely
    // MISSING and the planner must SUPPLY it. Distinct from INVALID below so a
    // retry loop ADDs the param rather than re-issuing the same already-present
    // value. Symmetric with the results branch (absent → REQUIRED).
    if (
      startRaw === undefined ||
      startRaw === null ||
      endRaw === undefined ||
      endRaw === null
    ) {
      return { ok: false, reason: "CONNECTOR_READ_WINDOW_REQUIRED" };
    }
    // Present but WRONG TYPE (not an ISO string — e.g. epoch-ms number, boolean,
    // object) → INVALID, NOT REQUIRED. Symmetric with the results branch's
    // present-but-malformed → INVALID: a present-but-bad value tells the planner
    // to FIX it, not to add a parameter it already supplied.
    if (typeof startRaw !== "string" || typeof endRaw !== "string") {
      return { ok: false, reason: "CONNECTOR_READ_WINDOW_INVALID" };
    }
    // Present but NOT a STRICT date-time → INVALID, deterministically. Requires
    // the `T` time component (rejects a bare YYYY-MM-DD, which is unbindable /
    // provider-invalid) AND real calendar components — so an impossible date like
    // "2026-02-31T10:00:00Z" is rejected here rather than silently rolled over by
    // Date.parse (Node clamps it to Mar 3) and forwarded to the provider. Also
    // rejects anything outside the ISO grammar before Date.parse, so a non-ISO-
    // but-V8-parseable string ("June 1, 2026") can't be leniently clamped on one
    // Node version and NaN-rejected on another.
    if (!isStrictIsoDateTime(startRaw) || !isStrictIsoDateTime(endRaw)) {
      return { ok: false, reason: "CONNECTOR_READ_WINDOW_INVALID" };
    }
    const startMs = Date.parse(startRaw);
    const endMs = Date.parse(endRaw);
    // Present but unparseable → INVALID (the param is there, just malformed).
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return { ok: false, reason: "CONNECTOR_READ_WINDOW_INVALID" };
    }
    // Present but non-forward (inverted/zero-length) → INVALID. An inverted
    // (end < start) window makes (endMs - startMs) negative, which would slip
    // UNDER the maxWindowDays ceiling and admit — a §12 bypass. A zero-length
    // window is degenerate. A bounded read ceiling requires a real forward range;
    // reject deterministically rather than delegating to the provider. This is a
    // model bug (supplied a bad range), distinct from the planner-contract bug of
    // omitting the window entirely — hence the INVALID vs REQUIRED split (audit
    // triage + no same-params retry loop).
    if (endMs <= startMs) {
      return { ok: false, reason: "CONNECTOR_READ_WINDOW_INVALID" };
    }
    const windowDays = (endMs - startMs) / (1000 * 60 * 60 * 24);
    if (windowDays > op.maxWindowDays) {
      return { ok: false, reason: "CONNECTOR_READ_WINDOW_EXCEEDED" };
    }
  }

  // Results ceiling
  if (op.maxResults !== undefined && op.maxResultsParam !== undefined) {
    const countKey = op.maxResultsParam;
    const countRaw = params[countKey];

    // Absent → REQUIRED (the count param is genuinely missing).
    if (countRaw === undefined || countRaw === null) {
      return { ok: false, reason: "CONNECTOR_READ_RESULTS_REQUIRED" };
    }
    // Present but malformed (non-number / non-integer / negative) → INVALID, so a
    // retry loop fixes the value rather than re-supplying the same bad one.
    if (
      typeof countRaw !== "number" ||
      !Number.isInteger(countRaw) ||
      countRaw < 0
    ) {
      return { ok: false, reason: "CONNECTOR_READ_RESULTS_INVALID" };
    }
    if (countRaw > op.maxResults) {
      return { ok: false, reason: "CONNECTOR_READ_RESULTS_EXCEEDED" };
    }
  }

  return { ok: true };
}

/**
 * BUG-B — default an ABSENT results-count to the catalog ceiling for a
 * connector.read op, returning a NEW params object (the input is never mutated).
 *
 * The model intermittently omits the technical `maxResults` cap on a read whose
 * catalog op declares a results ceiling. `enforceReadCeilings`
 * then hard-rejects with `CONNECTOR_READ_RESULTS_REQUIRED` — the confirmed
 * intermittent "calendar wasn't available" / "rejected by the gateway" read
 * failure. An absent cap means "no explicit limit", for which the CEILING is the
 * correct BOUNDED default (the read stays capped — it can never exceed
 * `op.maxResults`), so defaulting it turns a brittle reject into a reliable read
 * without weakening the §12 bound.
 *
 * The WINDOW is deliberately NOT defaulted: a time range is semantically
 * load-bearing (a 370-day default would silently return the wrong events), so an
 * absent window stays REQUIRED — the planner must supply the range it means.
 *
 * A present cap (even one over the ceiling) is left untouched, so
 * `enforceReadCeilings` still rejects an over-ceiling value as EXCEEDED — this
 * helper only fills a genuinely-absent cap, never lowers a supplied one.
 *
 * Applied at dispatch BEFORE admission so the defaulted cap reaches BOTH the gate
 * and the client/provider call. `admitConnectorInvocation` / `enforceReadCeilings`
 * are left unchanged (still REQUIRED on a truly-absent cap) as defense-in-depth
 * for any direct caller that bypasses this helper.
 */
export function applyConnectorReadDefaults(
  op: ConnectorOperationShape,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (op.maxResults === undefined || op.maxResultsParam === undefined) {
    return params;
  }
  const key = op.maxResultsParam;
  const current = params[key];
  if (current === undefined || current === null) {
    return { ...params, [key]: op.maxResults };
  }
  return params;
}

// ── Event-time (write) param validation ───────────────────────────────────────
// STRICT (real calendar components, not just shape) so an unexecutable write
// value — "tomorrow morning", an impossible date like 2026-02-31 — is rejected at
// admission BEFORE the mutation budget / destructive-sequence accounting, rather
// than consuming a turn attempt and only failing in the client adapter / at the
// provider after the user already confirmed. Generic over the catalog-NAMED
// `eventTimeParams` keys; names no connector/operation (C1).

function isRealCalendarYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isStrictIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m !== null && isRealCalendarYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

function isStrictIsoDateTime(value: string): boolean {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2}))?$/.exec(
      value,
    );
  if (m === null) return false;
  const [, y, mo, d, h, mi, se, , , offH, offM] = m;
  if (!isRealCalendarYmd(Number(y), Number(mo), Number(d))) return false;
  if (Number(h) > 23 || Number(mi) > 59) return false;
  if (se !== undefined && Number(se) > 59) return false;
  if (offH !== undefined && (Number(offH) > 23 || Number(offM) > 59)) return false;
  return true;
}

/** A calendar event-time value: a timed datetime or an all-day date, as a string
 * or a `{ dateTime }` / `{ date }` object. STRICT components. */
function isValidEventTimeValue(value: unknown): boolean {
  if (typeof value === "string") {
    return isStrictIsoDate(value) || isStrictIsoDateTime(value);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.dateTime === "string") return isStrictIsoDateTime(o.dateTime);
    if (typeof o.date === "string") return isStrictIsoDate(o.date);
    return false;
  }
  return false;
}

/**
 * Map an event-time value to a comparable epoch-ms for ORDER checks. Offset-less
 * local values are compared as if UTC — both bounds of one event share the user's
 * zone, so the SAME offset cancels and the relative order is preserved. Returns
 * NaN for an unparseable value (its validity is gated separately).
 */
function eventTimeComparableMs(value: unknown): number {
  let s: string | undefined;
  if (typeof value === "string") s = value;
  else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.dateTime === "string") s = o.dateTime;
    else if (typeof o.date === "string") s = o.date;
  }
  if (s === undefined) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00Z`);
  // Offset-less local → compare as UTC (same-zone offset cancels in the order).
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(s)) return Date.parse(`${s}Z`);
  return Date.parse(s);
}

/**
 * Reject a mutating op whose catalog-declared `eventTimeRange` carries a present-
 * but-unexecutable bound, OR an inverted/zero-length range, BEFORE budget/
 * destructive accounting. Absent bounds are left to the required-param gate; the
 * order check fires only when BOTH bounds are present (a partial update may set
 * just one).
 */
function enforceEventTimeRange(
  op: ConnectorOperationShape,
  params: Record<string, unknown>,
): ConnectorAdmissionResult {
  const range = op.eventTimeRange;
  if (!range) return { ok: true };
  // PRESENCE is own-property presence, NOT non-null: a key explicitly PRESENT with
  // a null (or otherwise garbage) value is present-but-INVALID, not "absent". A
  // bare `{ start: null, end: null }` must therefore be REJECTED here — not slip
  // through as "neither bound" and consume mutation budget / arm the destructive
  // lock before the client adapter rejects it.
  const startPresent = Object.prototype.hasOwnProperty.call(params, range.start);
  const endPresent = Object.prototype.hasOwnProperty.call(params, range.end);
  const startVal = params[range.start];
  const endVal = params[range.end];
  if (startPresent && !isValidEventTimeValue(startVal)) {
    return { ok: false, reason: "CONNECTOR_PARAM_DATETIME_INVALID" };
  }
  if (endPresent && !isValidEventTimeValue(endVal)) {
    return { ok: false, reason: "CONNECTOR_PARAM_DATETIME_INVALID" };
  }
  // BOTH-or-NEITHER: changing exactly one bound is rejected. A PATCH combines the
  // supplied bound with the event's EXISTING other bound (which we cannot see at
  // admission without a fetch), so a single-bound move could silently invert the
  // effective range. Requiring the pair makes end>start verifiable up front —
  // the planner read the event, so it has both bounds.
  if (startPresent !== endPresent) {
    return { ok: false, reason: "CONNECTOR_PARAM_DATETIME_INVALID" };
  }
  // Order: end MUST be strictly after start when both are present.
  if (startPresent && endPresent) {
    const startMs = eventTimeComparableMs(startVal);
    const endMs = eventTimeComparableMs(endVal);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) {
      return { ok: false, reason: "CONNECTOR_PARAM_DATETIME_INVALID" };
    }
  }
  return { ok: true };
}

/**
 * Coarse flat-match scope check (spec §5.2 #5, Finding-3).
 *
 * Returns "satisfied" if ANY granted scope flat-matches or ends-with the
 * required scope token. Returns "inconclusive" if no flat match is found.
 * NEVER returns a hard reject — non-flat grants (e.g. a broader OAuth
 * permission that subsumes the required one but has a different string) are
 * a per-provider-client concern, not an enclave gate.
 */
function checkGrantedScopes(
  requiredScope: string | string[],
  connectorId: string,
  connectedConnectors: ConnectedConnectorShape[],
): "satisfied" | "inconclusive" {
  const entry = connectedConnectors.find((c) => c.connectorId === connectorId);
  const granted = entry?.grantedScopes ?? [];

  const requiredTokens = Array.isArray(requiredScope)
    ? requiredScope
    : [requiredScope];

  for (const required of requiredTokens) {
    for (const grant of granted) {
      if (grant === required || grant.endsWith(required)) {
        return "satisfied";
      }
    }
  }

  return "inconclusive";
}

// ---------------------------------------------------------------------------
// Per-turn budget gate (§6 invariant 4)
// ---------------------------------------------------------------------------

/**
 * Checks whether a connector invocation is within the per-turn budget.
 *
 * Pure function — does NOT increment counters; the dispatch layer (Task 11)
 * owns state mutation.
 *
 * - connector.act → checks turnState.mutations against the effective mutation cap.
 * - connector.read → checks turnState.reads against the effective read cap.
 * - connector.list → NOT metered; always returns { ok: true }.
 *
 * The effective cap is resolved from the override (§17 #2):
 *   "unbounded" → Infinity (never reject)
 *   number      → max(number, baseline) — the override may only RAISE the cap
 *   absent      → the measured baseline constant
 *
 * An owner override (`connectorTurnBudgetOverride`) may RAISE the effective cap
 * but NEVER lower it below the measured baseline (a hijacked-MODEL guard). The
 * `Math.max` clamp enforces that contract structurally, so a settings UI (or a
 * compromised client) passing a small/zero value cannot brick connector ops for
 * the turn — it just leaves the baseline in force. Lowering caps is a deliberate
 * non-feature (the baseline IS the floor).
 */
function effectiveCap(
  raw: number | "unbounded" | undefined,
  baseline: number,
): number {
  if (raw === "unbounded") return Infinity;
  if (typeof raw === "number") return Math.max(raw, baseline);
  return baseline;
}

export function checkConnectorTurnBudget(
  // The budget gate is PURE over the two counters — it never reads the §12 #2
  // destructive lock — so it accepts the counter subset of ConnectorTurnState.
  // The live dispatch passes the full state (a structural superset); keeping the
  // param narrow lets pure budget call-sites construct a {mutations,reads} fixture
  // without also having to seed an unused destructiveConnectors set.
  turnState: Pick<ConnectorTurnState, "mutations" | "reads">,
  tool: string,
  override?: ConnectorTurnBudgetOverride,
): ConnectorTurnBudgetResult {
  if (tool === "connector.list") {
    return { ok: true };
  }

  if (tool === "connector.act") {
    const cap = effectiveCap(override?.mutationsPerTurn, MAX_CONNECTOR_MUTATIONS_PER_TURN);
    if (turnState.mutations >= cap) {
      return { ok: false, reason: "CONNECTOR_TURN_MUTATION_BUDGET" };
    }
    return { ok: true };
  }

  if (tool === "connector.read") {
    const cap = effectiveCap(override?.readsPerTurn, MAX_CONNECTOR_READS_PER_TURN);
    if (turnState.reads >= cap) {
      return { ok: false, reason: "CONNECTOR_TURN_READ_BUDGET" };
    }
    return { ok: true };
  }

  // Defensive: unknown tool families are not metered here
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Connector intent ledger (spec §6 invariant 3 — S5)
// ---------------------------------------------------------------------------

/**
 * The mode-in-effect token recorded on the ledger. It is the per-connector
 * write-permission mode the client echoed for THIS connector this turn — OR the
 * sentinel "unknown" when no echo was supplied (a connector with no echo, or
 * connector.list which has no per-connector mode). It is RECORDED for the audit
 * trail and is NEVER read as an authorization input (S5): a future refactor
 * cannot turn the ledger mode into a gate because admission's input type has no
 * mode field, and this token reaches ONLY buildConnectorLedgerEntry.
 */
export type ConnectorLedgerModeInEffect = ConnectorModeEcho["writePermissionMode"] | "unknown";

export interface ConnectorLedgerInput {
  /** One of: "connector.list" | "connector.read" | "connector.act". */
  tool: ToolCallLedgerEntry["toolName"];
  /** The connector id the op targeted. Present for read/act; may be absent for list. */
  connectorId?: string;
  /** The operation id. Absent for connector.list (discovery has no operation). */
  operation?: string;
  /** Terminal outcome of the dispatch/fulfilment for this op. */
  outcome: ToolResultOutcome;
  /**
   * The mode in effect at dispatch time — RECORDED for audit, NEVER an authz
   * input (S5). Defaults are caller-resolved from connectorModeEchoes; "unknown"
   * when no echo matched.
   */
  modeInEffect: ConnectorLedgerModeInEffect;
  /**
   * Optional human/audit reason (e.g. a gateway rejection code, or a connector
   * errorCode like "rate_limited" — Finding #11). Null on a clean ok path.
   */
  reason?: string | null;
  /** Active skill pack id. */
  skillPackId: string;
  /** Server-minted agent turn id. */
  turnId: string;
  /**
   * R4-6 observability: set when the dispatch detected an owner override ABOVE
   * the measured baseline (esp. "unbounded"). Appends an auditable ":uncapped"
   * token to `scope` so a post-hoc audit can see the turn ran without the
   * default per-turn ceiling. Does NOT change any gate decision.
   */
  uncapped?: boolean;
}

/**
 * Build the connector intent-ledger entry (spec §6 invariant 3 — S5).
 *
 * The mode in effect is RECORDED in `scope` for the audit trail and is NEVER
 * used for authorization — the dispatch routes the mode echoes ONLY here, never
 * to admission, so a compromised client echoing a permissive mode changes no
 * gate decision. The returned entry omits `id` (assigned downstream by the
 * loop/executor), matching every other tier's ledger build.
 *
 * `scope` is assembled from the caller's STRING ARGS (connectorId / operation /
 * mode) — no connector or operation literal is named in THIS source.
 */
export function buildConnectorLedgerEntry(
  input: ConnectorLedgerInput,
): Omit<ToolCallLedgerEntry, "id"> {
  const baseScope = `${input.connectorId ?? ""}:${input.operation ?? ""}:mode=${input.modeInEffect}`;
  const scope = input.uncapped === true ? `${baseScope}:uncapped` : baseScope;
  return {
    invokedAt: new Date().toISOString(),
    toolName: input.tool,
    scope,
    approvedPath: null,
    outcome: input.outcome,
    reason: input.reason ?? null,
    skillPackId: input.skillPackId,
    turnId: input.turnId,
  };
}
