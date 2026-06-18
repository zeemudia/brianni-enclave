import { describe, expect, it } from "vitest";

import {
  AgentRequestContextSchema,
  ConnectedConnectorContextSchema,
  ConnectorModeEchoSchema,
  ConnectorTurnBudgetOverrideSchema,
} from "../agent-context";
import { ConnectorInvocationArgsSchema } from "../connectors";

// ===========================================================================
// Task 2b — Token-boundary structural gate (spec's load-bearing privacy
// invariant: a connector OAuth/refresh token is an ON-DEVICE secret that NEVER
// crosses the vsock boundary into the (stateless, untrusted-re-secrets)
// enclave).
//
// Today's defense is Zod object-strip: a plain `z.object({...})` drops unknown
// keys on `.parse()`, so any accidental token-shaped field on an enclave-INBOUND
// payload is structurally erased BEFORE the value is ever serialized toward the
// vsock. This test makes that defense a BLOCKING, fuzzed CONTRACT gate so a
// future Phase-2 mistake (an adapter author piping a bearer through a JSON
// field) is caught at PR time at the contract boundary — not later in a redacted
// log line.
//
// Strategy: for EVERY enclave-inbound connector channel, build a VALID base
// payload, salt it with a GENERATED set of token-shaped keys carrying a
// JWT-shaped value, `.parse()` it, deep-collect EVERY key of the parsed
// (enclave-bound) object, and assert the intersection with the token-key set is
// empty. The key set is FUZZED over base stems × case/separator variants (not a
// hardcoded list) so a novel token-shaped key is caught too. Deterministic (no
// RNG) so CI is stable.
// ===========================================================================

// --- Generated token-key fuzz set ------------------------------------------
// Base stems of the on-device-secret vocabulary. We expand each into
// camelCase / snake_case / Capitalized / lower / UPPER variants so the set is
// genuinely GENERATED, not a fixed list — a future novel casing is still caught.
const TOKEN_STEMS = [
  ["access", "token"],
  ["refresh", "token"],
  ["id", "token"],
  ["oauth", "token"],
  ["client", "secret"],
  ["api", "key"],
  ["bearer"],
  ["authorization"],
  ["token"],
  ["secret"],
] as const;

function casingVariants(words: readonly string[]): string[] {
  const lower = words.map((w) => w.toLowerCase());
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

  const camel = lower.map((w, i) => (i === 0 ? w : cap(w))).join(""); // accessToken
  const snake = lower.join("_"); // access_token
  const flatLower = lower.join(""); // accesstoken
  const capitalized = lower.map(cap).join(""); // AccessToken / Authorization
  const upperSnake = lower.map((w) => w.toUpperCase()).join("_"); // ACCESS_TOKEN
  const upperFlat = lower.join("").toUpperCase(); // ACCESSTOKEN

  return [camel, snake, flatLower, capitalized, upperSnake, upperFlat];
}

// The generated fuzz set. Sorted + de-duped for deterministic iteration.
const TOKEN_KEYS: ReadonlySet<string> = new Set(
  TOKEN_STEMS.flatMap((stem) => casingVariants(stem)).sort(),
);

// Sanity: the spec's named keys must all be present in the GENERATED set, so
// the fuzz is a true superset of the hand-named list — not weaker than it.
const SPEC_NAMED_KEYS = [
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  "bearer",
  "Bearer",
  "authorization",
  "Authorization",
  "id_token",
  "oauth_token",
  "client_secret",
  "apiKey",
  "api_key",
] as const;

// A realistic JWT-shaped value — what a real bearer/refresh token looks like on
// the wire. Used for EVERY salted token field so a value-shaped leak would also
// be visible if a key ever survived.
const JWT_VALUE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJTRUNSRVQiLCJpYXQiOjF9.SECRETSIGNATUREDONOTLEAK";

/**
 * Salt EVERY generated token key onto `base` with the JWT-shaped value. The
 * returned object is the "hostile/buggy client" payload we feed to `.parse()`.
 *
 * INVARIANT: callers must pass a `base` that uses NO token-shaped key
 * (base ∩ TOKEN_KEYS = ∅). The salt assigns over `base`, so a legit base field
 * named like a token would be overwritten by the salt — and a survivor of that
 * name could no longer be distinguished from a leak. No current channel uses a
 * token-shaped legit field; keep it that way.
 */
function saltTokens<T extends Record<string, unknown>>(
  base: T,
): T & Record<string, unknown> {
  const salted: Record<string, unknown> = { ...base };
  for (const key of TOKEN_KEYS) salted[key] = JWT_VALUE;
  return salted as T & Record<string, unknown>;
}

/**
 * Recursively collect EVERY key name appearing anywhere in `value` (walking
 * nested objects AND arrays). This is what we intersect with TOKEN_KEYS to prove
 * the parsed, enclave-bound object is structurally token-free at any depth.
 */
function deepCollectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) deepCollectKeys(item, acc);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      deepCollectKeys(v, acc);
    }
  }
  return acc;
}

function surviving(parsed: unknown): string[] {
  const present = deepCollectKeys(parsed);
  return [...TOKEN_KEYS].filter((k) => present.has(k));
}

describe("token-boundary fuzz set is genuinely generated", () => {
  it("the generated set is a superset of the spec-named token keys", () => {
    for (const named of SPEC_NAMED_KEYS) {
      expect(TOKEN_KEYS.has(named)).toBe(true);
    }
  });

  it("expands stems into multiple casing/separator variants (real fuzz, not a fixed list)", () => {
    // accessToken / access_token / accesstoken / AccessToken / ACCESS_TOKEN / ACCESSTOKEN
    expect(TOKEN_KEYS.has("accessToken")).toBe(true);
    expect(TOKEN_KEYS.has("access_token")).toBe(true);
    expect(TOKEN_KEYS.has("AccessToken")).toBe(true);
    expect(TOKEN_KEYS.has("ACCESS_TOKEN")).toBe(true);
    expect(TOKEN_KEYS.size).toBeGreaterThan(SPEC_NAMED_KEYS.length);
  });

  it("the deep key collector recurses objects AND arrays", () => {
    const keys = deepCollectKeys({
      a: 1,
      b: { c: 2, d: [{ e: 3 }, { accessToken: "x" }] },
    });
    expect(keys).toEqual(new Set(["a", "b", "c", "d", "e", "accessToken"]));
  });
});

// ===========================================================================
// CLOSED CHANNELS — every enclave-inbound connector channel below is a plain
// `z.object` (or composed of them), so Zod strips unknown keys → structurally
// token-free after parse. The fuzz proves NONE of the generated token keys
// survive at ANY depth.
// ===========================================================================
describe("closed enclave-inbound connector channels are structurally token-free", () => {
  it("ConnectedConnectorContextSchema strips every token-shaped key (S1)", () => {
    const parsed = ConnectedConnectorContextSchema.parse(
      saltTokens({
        connectorId: "google-calendar",
        displayName: "[CONNECTOR_1]",
        status: "connected",
        grantedScopes: ["calendar.events"],
      }),
    );
    // Legitimate metadata survives…
    expect(parsed.grantedScopes).toEqual(["calendar.events"]);
    // …and NO token-shaped key does.
    expect(surviving(parsed)).toEqual([]);
  });

  it("ConnectorModeEchoSchema strips every token-shaped key", () => {
    const parsed = ConnectorModeEchoSchema.parse(
      saltTokens({
        connectorId: "google-calendar",
        writePermissionMode: "auto",
      }),
    );
    expect(parsed.writePermissionMode).toBe("auto");
    expect(surviving(parsed)).toEqual([]);
  });

  it("ConnectorTurnBudgetOverrideSchema strips every token-shaped key", () => {
    const parsed = ConnectorTurnBudgetOverrideSchema.parse(
      saltTokens({ mutationsPerTurn: 50, readsPerTurn: 200 }),
    );
    expect(parsed.mutationsPerTurn).toBe(50);
    expect(surviving(parsed)).toEqual([]);
  });

  it("AgentRequestContextSchema is token-free top-level AND in every nested connector field", () => {
    // Salt the TOP-LEVEL context object, EACH connectedConnectors entry, EACH
    // connectorModeEchoes entry, AND the connectorTurnBudgetOverride object — so
    // a token salted at any of those depths must strip.
    const parsed = AgentRequestContextSchema.parse(
      saltTokens({
        connectedConnectors: [
          saltTokens({
            connectorId: "google-calendar",
            displayName: "[C_1]",
            status: "connected",
            grantedScopes: ["calendar.events"],
          }),
          saltTokens({
            connectorId: "slack",
            displayName: "[C_2]",
            status: "connected",
            grantedScopes: ["channels:read"],
          }),
        ],
        connectorModeEchoes: [
          saltTokens({
            connectorId: "google-calendar",
            writePermissionMode: "auto",
          }),
        ],
        connectorTurnBudgetOverride: saltTokens({
          mutationsPerTurn: 50,
          readsPerTurn: 200,
        }),
      }),
    );

    // Legitimate structure survives intact…
    expect(parsed.connectedConnectors).toHaveLength(2);
    expect(parsed.connectorModeEchoes[0].writePermissionMode).toBe("auto");
    expect(parsed.connectorTurnBudgetOverride).toEqual({
      mutationsPerTurn: 50,
      readsPerTurn: 200,
    });
    // …and the WHOLE parsed tree (recursing nested arrays/objects) is token-free.
    expect(surviving(parsed)).toEqual([]);
  });

  it("ConnectorInvocationArgsSchema strips token-shaped SIBLINGS of {connectorId, operation, params} (envelope is closed)", () => {
    // The TOP-LEVEL invocation-args object is a plain z.object → unknown sibling
    // keys of connectorId/operation/params strip, including token-shaped ones.
    const parsed = ConnectorInvocationArgsSchema.parse(
      saltTokens({
        connectorId: "google-calendar",
        operation: "events.list",
        params: { timeMin: "2026-01-01T00:00:00Z" },
      }),
    );
    expect(parsed.connectorId).toBe("google-calendar");
    expect(parsed.operation).toBe("events.list");
    // The legitimate op arg survives inside params…
    expect(parsed.params).toEqual({ timeMin: "2026-01-01T00:00:00Z" });
    // …but NO token-shaped sibling of the envelope does (params here carried no
    // token, so the whole parsed object is token-free).
    expect(surviving(parsed)).toEqual([]);
  });
});

// ===========================================================================
// OPEN RESIDUAL — `ConnectorInvocationArgsSchema.params` is
//   z.record(z.string(), z.unknown()).default({})
// an OPEN record BY CONTRACT, so the planner can emit arbitrary catalog-op args
// (timeMin, summary, attendees, …). Tightening it would break legitimate op
// args, so we DO NOT. A token-shaped key CAN therefore survive INSIDE `params`.
//
// CRUCIAL FRAMING (why this is acceptable at THIS boundary):
//   • `params` values are MODEL-PRODUCED — the planner emits them. The user's
//     real on-device OAuth/refresh token NEVER enters the model's context, so
//     the planner cannot put the real token here; at worst it emits a
//     token-SHAPED string it hallucinated, not the secret.
//   • The enforcement point for the fulfiller RESULT path (and for masking any
//     token-shaped value the planner emits) is the PHASE-2 CLIENT FULFILLER,
//     which masks/strips before the reverse-channel send back to the enclave.
//
// >>> PHASE-2 FUZZ OBLIGATION <<<
// When the Phase-2 client fulfiller lands, it MUST carry its OWN structural
// token-boundary fuzz over (a) the params it forwards to the external API and
// (b) the fulfiller RESULT it sends back over the reverse channel — proving the
// real on-device token is never attached and any token-shaped value is
// masked/stripped before egress. The test below PINS the current open contract
// so that obligation is explicit and un-droppable, not silently skipped.
// ===========================================================================
describe("OPEN RESIDUAL: ConnectorInvocationArgs.params (Phase-2 fulfiller is the enforcement point)", () => {
  it("pins that a token-shaped key DOES survive INSIDE params (open by contract — proves WHY Phase-2 must enforce)", () => {
    const parsed = ConnectorInvocationArgsSchema.parse({
      connectorId: "google-calendar",
      operation: "events.list",
      // A token-shaped key nested INSIDE the open params record. The planner
      // produced it; it is NOT the user's on-device token (the real token never
      // enters the model context). The Phase-2 client fulfiller is what masks
      // this before any external call / reverse-channel send.
      params: {
        timeMin: "2026-01-01T00:00:00Z",
        accessToken: JWT_VALUE,
      },
    });
    // It SURVIVES — this is the deliberate open contract, documented above.
    expect(parsed.params).toHaveProperty("accessToken", JWT_VALUE);
    // The survivor lives ONLY inside params; the envelope itself is still closed.
    expect(surviving(parsed)).toEqual(["accessToken"]);
  });

  it("but the ENVELOPE stays closed: a token-shaped key salted as a SIBLING of params is still stripped", () => {
    // Even though params is open, the {connectorId, operation, params} envelope
    // is closed — a token salted at the TOP level (sibling of params) strips,
    // while one placed INSIDE params survives. This is the exact contract line.
    const parsed = ConnectorInvocationArgsSchema.parse(
      saltTokens({
        connectorId: "google-calendar",
        operation: "events.list",
        params: { accessToken: JWT_VALUE },
      }),
    );
    // Only the in-params survivor remains; every salted sibling was stripped.
    expect(surviving(parsed)).toEqual(["accessToken"]);
    expect(parsed.params).toEqual({ accessToken: JWT_VALUE });
  });
});
