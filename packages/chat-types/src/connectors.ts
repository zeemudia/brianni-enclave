import { z } from "zod";

// ---------------------------------------------------------------------------
// Connector write-permission modes (spec §6). Scoped PER-CONNECTOR, stored in
// local persisted client config — NOT an authorization input on the wire (S5).
// "auto means auto": it skips ALL confirmations incl. destructive; the other
// two modes are the safety path.
// ---------------------------------------------------------------------------
export const CONNECTOR_WRITE_PERMISSION_MODES = [
  "always_ask",
  "once_per_session",
  "auto",
] as const;

export type ConnectorWritePermissionMode =
  (typeof CONNECTOR_WRITE_PERMISSION_MODES)[number];

export const ConnectorWritePermissionModeSchema = z.enum(
  CONNECTOR_WRITE_PERMISSION_MODES,
);

// ---------------------------------------------------------------------------
// Normalized result/error envelope over the opaque ToolResultFrame.resultJson
// (spec §11 anti-drift guarantee 7 / N1). Connector adapters return this shape
// so structured provider errors (incl. rate limits) don't need a translation
// migration when v2 MCP tools arrive. `rate_limited` is modeled here as an
// errorCode, NOT by widening ToolResultOutcomeSchema.
// ---------------------------------------------------------------------------

/**
 * Pinned connector error vocabulary. Keeping rate_limited OUT of the shared
 * ToolResultOutcome enum stays hermetic to chat-types, but `errorCode` must
 * still be a closed vocabulary or it re-introduces stringly-typed wire drift
 * (typos / per-adapter forks). Well-known codes are enumerated; "unknown" is
 * the explicit escape hatch so an adapter can surface an unclassified provider
 * failure without inventing a new string.
 */
export const CONNECTOR_RESULT_ERROR_CODES = [
  "rate_limited",
  "unauthorized",
  "forbidden",
  "not_found",
  "provider_unavailable",
  "idempotency_conflict",
  "etag_mismatch",
  "validation_failed",
] as const;

export type ConnectorResultErrorCode =
  (typeof CONNECTOR_RESULT_ERROR_CODES)[number];

export const ConnectorResultErrorCodeSchema = z.union([
  z.enum(CONNECTOR_RESULT_ERROR_CODES),
  z.literal("unknown"),
]);

export const ConnectorResultEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    data: z.unknown().optional(),
    errorCode: ConnectorResultErrorCodeSchema.optional(),
    retryable: z.boolean().optional(),
  })
  // Cross-field consistency: a success carries no error fields; a failure MUST
  // name an errorCode (use "unknown" if unclassified) and carries no data. Stops
  // a buggy/hostile adapter returning a contradictory shape that still parses.
  .superRefine((env, ctx) => {
    if (env.ok) {
      if (env.errorCode !== undefined)
        ctx.addIssue({ code: "custom", message: "ok envelope must not carry errorCode" });
      if (env.retryable !== undefined)
        ctx.addIssue({ code: "custom", message: "ok envelope must not carry retryable" });
    } else {
      if (env.errorCode === undefined)
        ctx.addIssue({ code: "custom", message: "error envelope must carry errorCode (use 'unknown')" });
      if (env.data !== undefined)
        ctx.addIssue({ code: "custom", message: "error envelope must not carry data" });
    }
  });

export type ConnectorResultEnvelope = z.infer<
  typeof ConnectorResultEnvelopeSchema
>;

// ---------------------------------------------------------------------------
// Shape of ToolInvocationFrame.args for connector.READ / connector.ACT. The
// frame's `args` is z.record(z.string(), z.unknown()); both the enclave tier and
// the client fulfiller parse it with this schema so the {connectorId, operation,
// params} contract is single-sourced. `operation` is REQUIRED here.
// ---------------------------------------------------------------------------
export const ConnectorInvocationArgsSchema = z.object({
  connectorId: z.string().min(1).max(64),
  operation: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).default({}),
});

export type ConnectorInvocationArgs = z.infer<
  typeof ConnectorInvocationArgsSchema
>;

// `connector.list` is DISCOVERY — it has NO operation (Finding R2-1). It gets its
// OWN args schema so the read/act contract above stays strict (operation
// required) instead of being weakened to optional. Both are single-sourced.
export const ConnectorListArgsSchema = z.object({
  // Optional: scope the listing to one connector; absent ⇒ all connected.
  connectorId: z.string().min(1).max(64).optional(),
});

export type ConnectorListArgs = z.infer<typeof ConnectorListArgsSchema>;

// ---------------------------------------------------------------------------
// Signed connector catalog (spec §7.2). Host-served, Ed25519-signed, verified
// at enclave init exactly like providers.json. ADDING a connector entry +
// re-signing is rotation-free; per-connector knowledge lives ONLY in this data
// (+ the unmeasured skill-prompts channel), never in measured enclave code.
// ---------------------------------------------------------------------------

/**
 * Scope-satisfaction is provider-specific (Finding-3). `requiredScope` is a
 * single flat string for flat-scope providers (Google) OR an array of
 * acceptable grant strings for providers with scope dialects. The AUTHORITATIVE
 * subsumption-aware test is the per-provider client adapter; the enclave's flat
 * check is coarse-by-design and treats a non-flat match as INCONCLUSIVE, never
 * a hard reject (spec §5.2 #5).
 */
const RequiredScopeSchema = z.union([
  z.string().min(1).max(256),
  z.array(z.string().min(1).max(256)).min(1).max(32),
]);

/**
 * A serializable, planner-renderable parameter descriptor for one operation.
 * Deliberately opaque (`record<string, unknown>`) at the contract layer: the
 * catalog is signed, and the Phase-1 planner renders operation shapes from this
 * data at runtime (the C1 rotation-free property). Kept out of measured code.
 */
const OperationParamDescriptorSchema = z.record(z.string(), z.unknown());

const ConnectorPlatformSchema = z.enum(["web", "ios", "android"]);

const ConnectorHttpValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("literal"),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    kind: z.literal("param"),
    name: z.string().min(1).max(64),
    required: z.boolean().default(false),
    default: z.unknown().optional(),
  }),
  z.object({ kind: z.literal("idempotencyKey") }),
  z.object({ kind: z.literal("ifMatchEtag") }),
]);

export type ConnectorHttpValue = z.infer<typeof ConnectorHttpValueSchema>;

const ConnectorHttpResponseSchema = z.object({
  /**
   * Dot-path into the provider JSON body, e.g. "items" or "data.items".
   * Omitted means return the whole JSON body. Empty/no-content responses return
   * `{ status }` unless `dataKey` wraps another value.
   */
  dataPath: z.string().min(1).max(256).optional(),
  /** Wrap the selected data as `{ [dataKey]: value }` for planner-friendly names. */
  dataKey: z.string().min(1).max(64).optional(),
});

export type ConnectorHttpResponse = z.infer<
  typeof ConnectorHttpResponseSchema
>;

const ConnectorHttpOperationSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** Full provider URL template. Path placeholders use `{name}`. */
  url: z.string().url().max(2048),
  /**
   * Maps `{name}` placeholders in `url` to invocation params / literals. Missing
   * required values fail closed before a provider call.
   */
  pathParams: z.record(z.string(), ConnectorHttpValueSchema).default({}),
  query: z.record(z.string(), ConnectorHttpValueSchema).default({}),
  headers: z.record(z.string(), ConnectorHttpValueSchema).default({}),
  jsonBody: z.record(z.string(), ConnectorHttpValueSchema).optional(),
  response: ConnectorHttpResponseSchema.default({}),
});

export type ConnectorHttpOperation = z.infer<
  typeof ConnectorHttpOperationSchema
>;

const ConnectorOAuthClientConfigSchema = z
  .object({
    /**
     * OAuth public client id. Prefer catalog data for catalog-only connector
     * additions: browser builds cannot dynamically discover arbitrary new
     * NEXT_PUBLIC_* env names after compilation.
     */
    clientId: z.string().min(1).max(512).optional(),
    /**
     * Back-compat / local override path. New catalog-only connectors should use
     * `clientId` unless the build system also knows this env name statically.
     */
    clientIdEnv: z.string().min(1).max(128).optional(),
  })
  .refine((c) => c.clientId !== undefined || c.clientIdEnv !== undefined, {
    message: "oauth client config requires clientId or clientIdEnv",
  });

const ConnectorOAuthWebConfigSchema = ConnectorOAuthClientConfigSchema.extend({
  flow: z.enum(["google_gis", "authorization_code_pkce"]),
  redirectPath: z.string().min(1).max(256).default("/oauth/callback"),
  extraAuthorizeParams: z.record(z.string(), z.string()).default({}),
  extraTokenParams: z.record(z.string(), z.string()).default({}),
});

const ConnectorOAuthNativeConfigSchema = ConnectorOAuthClientConfigSchema.extend({
  flow: z.literal("authorization_code_pkce"),
  /**
   * Most providers can use the app-owned scheme ("calypso") for catalog-only
   * mobile additions. Google installed-app clients are the known exception and
   * use the reversed-client-id scheme already registered by the native plugin.
   */
  redirectScheme: z.string().min(1).max(256).optional(),
  redirectSchemeMode: z
    .enum(["app_scheme", "google_reversed_client_id"])
    .default("app_scheme"),
  redirectPath: z.string().min(1).max(128).default("oauthredirect"),
  requireRefreshToken: z.boolean().default(true),
  extraAuthorizeParams: z.record(z.string(), z.string()).default({}),
  extraTokenParams: z.record(z.string(), z.string()).default({}),
});

const ConnectorOAuthTokenExchangeSchema = z
  .enum(["client", "server"])
  .default("client");

const ConnectorOAuthSecretEnvSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/, {
    message: "clientSecretEnv must be an uppercase env var name",
  });

const ConnectorOAuth2AuthSchema = z
  .object({
    type: z.literal("oauth2"),
    /**
     * `client`: browser/native app exchanges the code directly with the provider
     * as a public PKCE client. `server`: app sends the code/refresh token to the
     * first-party broker, which resolves `clientSecretEnv` and performs the
     * confidential-client exchange without adding provider-specific code.
     */
    tokenExchange: ConnectorOAuthTokenExchangeSchema,
    clientSecretEnv: ConnectorOAuthSecretEnvSchema.optional(),
    authorizationEndpoint: z.string().url().max(2048).optional(),
    tokenEndpoint: z.string().url().max(2048).optional(),
    revocationEndpoint: z.string().url().max(2048).optional(),
    tokenInfoEndpoint: z.string().url().max(2048).optional(),
    defaultScopes: z.array(z.string().min(1).max(256)).min(1).max(32),
    web: ConnectorOAuthWebConfigSchema.optional(),
    ios: ConnectorOAuthNativeConfigSchema.optional(),
    android: ConnectorOAuthNativeConfigSchema.optional(),
  })
  .superRefine((auth, ctx) => {
    const pkceConfigured =
      auth.web?.flow === "authorization_code_pkce" ||
      auth.ios?.flow === "authorization_code_pkce" ||
      auth.android?.flow === "authorization_code_pkce";
    if (pkceConfigured && !auth.authorizationEndpoint) {
      ctx.addIssue({
        code: "custom",
        message: "authorization_code_pkce requires authorizationEndpoint",
      });
    }
    if (pkceConfigured && !auth.tokenEndpoint) {
      ctx.addIssue({
        code: "custom",
        message: "authorization_code_pkce requires tokenEndpoint",
      });
    }
    if (auth.tokenExchange === "server" && !auth.clientSecretEnv) {
      ctx.addIssue({
        code: "custom",
        message: "server tokenExchange requires clientSecretEnv",
      });
    }
    if (
      auth.web?.flow === "authorization_code_pkce" &&
      auth.tokenExchange !== "server"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "web authorization_code_pkce requires server tokenExchange",
      });
    }
  });

export type ConnectorOAuth2Auth = z.infer<typeof ConnectorOAuth2AuthSchema>;

export const ConnectorAuthSchema = ConnectorOAuth2AuthSchema;
export type ConnectorAuth = z.infer<typeof ConnectorAuthSchema>;

const ConnectorScopeSubsumesSchema = z.object({
  grant: z.string().min(1).max(256),
  covers: z.array(z.string().min(1).max(256)).min(1).max(32),
});

export type ConnectorScopeSubsumes = z.infer<
  typeof ConnectorScopeSubsumesSchema
>;

export const ConnectorOperationSchema = z
  .object({
    id: z.string().min(1).max(64),
    mutating: z.boolean(),
    destructive: z.boolean().default(false),
    idempotent: z.boolean().optional(),
    concurrency: z.enum(["etag"]).optional(),
    requiredScope: RequiredScopeSchema,
    // Enclave-enforced read ceilings for non-mutating ops (spec §12 read-side).
    // The ceilings are catalog data; the PARAM KEYS the enclave reads to apply
    // them are ALSO catalog data (`windowParams`/`maxResultsParam`), so the
    // enforcement stays connector-agnostic + rotation-free for connector #2..N
    // (the start/end/count param key names are NEVER hardcoded in measured
    // code). The enclave REJECTS an over-ceiling read (deterministic for adapter
    // retries) — Task 9.
    maxWindowDays: z.number().int().positive().max(3650).optional(),
    maxResults: z.number().int().positive().max(2500).optional(),
    // Names the start/end param keys for the maxWindowDays check. The actual key
    // strings ride the signed catalog at runtime, never this measured schema.
    windowParams: z
      .object({ start: z.string().min(1).max(64), end: z.string().min(1).max(64) })
      .optional(),
    // Names the count param key for the maxResults check. The actual key string
    // is catalog data supplied at runtime, never named here.
    maxResultsParam: z.string().min(1).max(64).optional(),
    // Names the start/end param keys that carry an EVENT-TIME RANGE for a
    // mutating op (e.g. a create/update start/end). At admission the enclave
    // validates each PRESENT bound — a real calendar datetime or all-day date, as
    // a string or a { dateTime } / { date } object — AND, when both are present,
    // requires end > start. An unexecutable value ("tomorrow morning", an
    // impossible date) OR an inverted/zero-length range is REJECTED BEFORE the
    // mutation budget / destructive-sequence accounting is touched, so a malformed
    // planner write cannot consume budget, poison the turn, or reach a provider
    // 400 after the user confirmed. Connector-agnostic + rotation-free: the key
    // strings are catalog data, never hardcoded in measured code (mirrors
    // windowParams for reads).
    eventTimeRange: z
      .object({ start: z.string().min(1).max(64), end: z.string().min(1).max(64) })
      .optional(),
    paramsSchema: OperationParamDescriptorSchema.default({}),
    // Finding-4: the read/write content fields whose per-field sentinel
    // survival is a blocking pre-deploy fixture gate (declared here so adding a
    // content field forces adding its survival fixture).
    contentFields: z.array(z.string().min(1).max(64)).max(64).optional(),
    /**
     * Optional catalog-declared HTTP execution recipe. When present, clients can
     * build a generic REST adapter for this operation without shipping a
     * connector-specific handler. Omitted means the operation still needs a
     * registered adapter/MCP implementation.
     */
    http: ConnectorHttpOperationSchema.optional(),
    // Finding-2 / spec §15.2: an op that moves BINARY/large-blob content (file
    // bytes, attachments) does NOT fit the measured text/JSON reverse-channel +
    // tokeniser and is THE rotation exception. v1 forbids it: the field exists
    // (default false) so a future catalog CANNOT silently smuggle a binary op
    // past the gateway — the enclave hard-rejects `binary: true` at admission
    // (Task 9) until a measured-primitive expansion lands. Declaring it here
    // makes the exception a structural schema fact, not a convention.
    binary: z.boolean().default(false),
  })
  .refine((op) => !(op.mutating === false && op.destructive === true), {
    message: "a non-mutating operation cannot be destructive",
  })
  // A read ceiling is enforced (Task 9) by reading the catalog-NAMED param key
  // (windowParams/maxResultsParam) off the invocation params. Declaring the
  // ceiling WITHOUT its key makes the ceiling silently inert — the enclave check
  // only fires when BOTH are present. Reject at parse so the signer fails loudly
  // on a signed-but-unenforceable ceiling (same signed-but-broken-catalog class
  // as the duplicate-id refines).
  .refine((op) => op.maxWindowDays === undefined || op.windowParams !== undefined, {
    message: "maxWindowDays requires windowParams (start/end key names) to be enforceable",
  })
  .refine((op) => op.maxResults === undefined || op.maxResultsParam !== undefined, {
    message: "maxResults requires maxResultsParam (count key name) to be enforceable",
  });

export type ConnectorOperation = z.infer<typeof ConnectorOperationSchema>;

export const ConnectorDescriptorSchema = z
  .object({
    id: z.string().min(1).max(64),
    displayName: z.string().min(1).max(64),
    provider: z.string().min(1).max(64),
    platforms: z.array(ConnectorPlatformSchema).min(1),
    oauthScopes: z.array(z.string().min(1).max(256)).min(1).max(32),
    auth: ConnectorAuthSchema.optional(),
    scopeSubsumes: z.array(ConnectorScopeSubsumesSchema).max(128).optional(),
    operations: z.array(ConnectorOperationSchema).min(1).max(64),
    // v2 forward-compat slot (spec §11). v1 MUST be null — any MCP descriptor is
    // fail-closed rejected until v2 widens this to a pinned-tool descriptor.
    mcp: z.null(),
  })
  // Duplicate operation ids would make `operations.find(...)` first-match-wins,
  // silently shadowing an op the catalog author published — a signed-but-broken
  // catalog. Reject at parse so the signer (Task 12) fails loudly (Finding R1-4).
  .refine(
    (c) => new Set(c.operations.map((o) => o.id)).size === c.operations.length,
    { message: "operation ids must be unique within a connector" },
  )
  .refine(
    (c) =>
      !(
        c.auth?.type === "oauth2" &&
        c.auth.web?.flow === "google_gis" &&
        c.provider !== "google"
      ),
    { message: "google_gis web flow requires provider google" },
  );

export type ConnectorDescriptor = z.infer<typeof ConnectorDescriptorSchema>;

/**
 * Minimum acceptable catalog version, baked into the measured enclave image by
 * being imported into enclave code (mirrors MIN_SKILL_PROMPTS_VERSION). Advance
 * on any rotation that must invalidate a superseded catalog; raising it is
 * itself an EIF rebuild + PCR0 rotation. The signed envelope binds version to
 * signature, so an old catalog cannot be relabelled to clear the floor.
 */
export const MIN_CONNECTOR_CATALOG_VERSION = 1;

export const ConnectorCatalogSchema = z
  .object({
    version: z.number().int().positive(),
    connectors: z.array(ConnectorDescriptorSchema).max(128),
    signature: z.string().min(1),
  })
  // Duplicate connector ids would make the registry's `new Map(...)` last-write-
  // wins, silently dropping a connector. Reject at parse (Finding R1-4).
  .refine(
    (cat) => new Set(cat.connectors.map((c) => c.id)).size === cat.connectors.length,
    { message: "connector ids must be unique in the catalog" },
  );

export type ConnectorCatalog = z.infer<typeof ConnectorCatalogSchema>;
