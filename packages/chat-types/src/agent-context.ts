import { z } from "zod";

import { ConnectorWritePermissionModeSchema } from "./connectors";

/**
 * Hard upper bound on linked folders attached to ONE agent request. Raised from
 * 16 to 32 so a cross-pack claims union can reference folders spanning several
 * packs. This is the SINGLE source of truth for the bound — the enclave's
 * cross-pack grant folder limit (resolveCrossPackGrant, a later task) imports and
 * reuses this constant so the transport cap, the wire-schema reject, and the
 * grant-folder reject can never drift apart. See spec §7.
 */
export const MAX_AGENT_LINKED_FOLDERS = 32;

export const AGENT_WRITE_PERMISSION_MODES = [
  "always_ask",
  "auto_review",
  "full_access",
] as const;

export type AgentWritePermissionMode =
  (typeof AGENT_WRITE_PERMISSION_MODES)[number];

export const AgentWritePermissionModeSchema = z.enum(
  AGENT_WRITE_PERMISSION_MODES,
);

export const AgentLinkedFolderContextSchema = z.object({
  folderId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(128),
  status: z.enum(["granted", "needs_regrant"]),
});

export type AgentLinkedFolderContext = z.infer<
  typeof AgentLinkedFolderContextSchema
>;

/**
 * Hard upper bound on connectors attached to ONE agent request (spec §7.3, N5).
 * SINGLE source of truth: imported by both the wire-schema `.max()` (the enclave
 * hard-rejects an oversize context at the trust boundary — no silent truncation)
 * and the client-side defensive cap below. Mirrors MAX_AGENT_LINKED_FOLDERS.
 */
export const MAX_AGENT_CONNECTORS = 8;

// The admission INPUT type. Deliberately has NO mode field — the mode echo rides
// a SEPARATE channel (ConnectorModeEchoSchema) so admission is type-incapable of
// reading it (S5 made STRUCTURAL, not convention — R4-3/R4-A).
export const ConnectedConnectorContextSchema = z.object({
  connectorId: z.string().min(1).max(64),
  // Masked with the per-turn tokeniser by the client BEFORE the request is
  // sent — the enclave only ever sees a token, never a real account label.
  displayName: z.string().min(1).max(128),
  status: z.enum(["connected", "needs_reauth"]),
  // (S1) The OAuth scopes the user actually granted — METADATA, not the token.
  // The token NEVER leaves the device. Zod strips unknown keys, so an
  // accidental accessToken/refreshToken in the payload is dropped here.
  grantedScopes: z.array(z.string().min(1).max(256)).max(64),
});

/**
 * (spec §6 invariant 2 — S5, STRUCTURAL) The per-connector ledger-only mode echo,
 * carried on a SEPARATE request-context field from `connectedConnectors`. The
 * AUTHORITATIVE mode is the client's local config at fulfilment; this exists
 * SOLELY so the enclave's intent ledger can record the mode in effect (§6
 * invariant 3). The dispatch passes `connectedConnectors` (mode-free) to
 * admission and these echoes ONLY to `buildConnectorLedgerEntry` — so a future
 * refactor CANNOT add a mode-aware gate check (the admission input type has no
 * mode field). A compromised client echoing "auto" changes no gate decision.
 */
export const ConnectorModeEchoSchema = z.object({
  connectorId: z.string().min(1).max(64),
  writePermissionMode: ConnectorWritePermissionModeSchema,
});

export type ConnectorModeEcho = z.infer<typeof ConnectorModeEchoSchema>;

export type ConnectedConnectorContext = z.infer<
  typeof ConnectedConnectorContextSchema
>;

interface ConnectorMetadataLike {
  id: string;
  displayName: string;
  status: "connected" | "needs_reauth" | "revoked";
  grantedScopes: string[];
}

/**
 * Shape the client-held connector set into the bounded request context: keep
 * only connectors bound to the active pack that are not revoked, drop any extra
 * fields (e.g. tokens), and defensively cap at MAX_AGENT_CONNECTORS. The loud
 * no-silent-truncation guarantee is the wire-schema reject in the enclave; this
 * slice just bounds an honest client. displayName is expected pre-masked.
 */
export function buildConnectedConnectorContext(
  connectors: readonly ConnectorMetadataLike[],
  boundConnectorIds: readonly string[],
): ConnectedConnectorContext[] {
  const bound = new Set(boundConnectorIds);
  return connectors
    .filter(
      (
        c,
      ): c is ConnectorMetadataLike & {
        status: "connected" | "needs_reauth";
      } => bound.has(c.id) && c.status !== "revoked",
    )
    .slice(0, MAX_AGENT_CONNECTORS)
    .map((c) => ({
      connectorId: c.id,
      displayName: c.displayName,
      status: c.status,
      grantedScopes: c.grantedScopes,
    }));
}

/**
 * (spec §6 invariant 4 — NORMATIVE) The owner-raised per-turn connector budget,
 * carried to the stateless enclave ONLY via request context. The enclave's
 * MEASURED baseline (MAX_CONNECTOR_*_PER_TURN, Phase 1) bounds a hijacked model
 * by default; when the OWNER raises a per-turn cap via the typed/passkey-fresh
 * settings action (§10), that raised value rides here. This is a hijacked-MODEL
 * guard, NOT a hijacked-client guard (a compromised client already holds the
 * user's token — §10's separate residual), and §17 #2 permits raising to
 * unbounded (an explicit "unbounded" sentinel; see PerTurnCapSchema). The MODE
 * is never carried (S5); only these two per-turn caps are.
 * Per-session/day caps are client-side (the stateless enclave cannot track
 * across turns) and are NOT in this field. Optional + absent by default
 * (back-compat): absent ⇒ the enclave uses its measured baseline.
 */
// §17 #2 (owner decision): caps are owner-raisable INCLUDING TO UNBOUNDED. An
// integer cannot express "no limit", so the wire accepts an explicit "unbounded"
// sentinel (the enclave maps it to Infinity / cap-disabled in Task 10). This
// honors the owner decision literally rather than silently saturating at a magic
// finite bound.
const PerTurnCapSchema = z.union([
  z.number().int().nonnegative(),
  z.literal("unbounded"),
]);

export const ConnectorTurnBudgetOverrideSchema = z.object({
  mutationsPerTurn: PerTurnCapSchema.optional(),
  readsPerTurn: PerTurnCapSchema.optional(),
});

export type ConnectorTurnBudgetOverride = z.infer<
  typeof ConnectorTurnBudgetOverrideSchema
>;

export const AgentRequestContextSchema = z.object({
  // Authoritative WIRE bound: the enclave hard-REJECTS an inbound request
  // context carrying more than MAX_AGENT_LINKED_FOLDERS folders (no silent
  // truncation at the trust boundary). The client-side
  // buildAgentLinkedFolderContext defensively caps at the SAME bound below. For
  // the cross-pack claims path the authoritative read allowlist is the grant's
  // folderIds, separately bounded + hard-rejected in the enclave (later task).
  linkedFolders: z
    .array(AgentLinkedFolderContextSchema)
    .max(MAX_AGENT_LINKED_FOLDERS)
    .default([]),
  writePermissionMode: AgentWritePermissionModeSchema.default("always_ask"),
  // Per-request connector connection set (spec §7.3). Token is NEVER included.
  // The per-connector write-permission MODE rides ONLY as a ledger-only echo on
  // each entry (spec §6 invariant 2): the AUTHORITATIVE mode is the client's
  // local config at fulfilment, and the echo is structurally excluded from the
  // enclave gate decision (S5). It is NOT an authorization input.
  connectedConnectors: z
    .array(ConnectedConnectorContextSchema)
    .max(MAX_AGENT_CONNECTORS)
    // A connectorId appears at most once. Admission resolves a connector via
    // `.find()` (first match), so a duplicate id with conflicting status/scopes
    // would let whichever entry sorts first silently win. Reject loudly at the
    // trust boundary (no silent first-match) — mirrors the catalog's unique-id
    // refines.
    .refine(
      (arr) => new Set(arr.map((c) => c.connectorId)).size === arr.length,
      { message: "connectedConnectors must have a unique connectorId per entry" },
    )
    .default([]),
  // (spec §6 invariant 2 — STRUCTURAL S5) Ledger-only per-connector mode echoes,
  // on a SEPARATE field from connectedConnectors. The dispatch routes these ONLY
  // to buildConnectorLedgerEntry, never to admission — which receives the
  // mode-free connectedConnectors. Admission is type-incapable of reading a mode.
  connectorModeEchoes: z
    .array(ConnectorModeEchoSchema)
    .max(MAX_AGENT_CONNECTORS)
    // A connectorId appears at most once. connectorModeInEffect resolves the mode
    // via `.find()` (first match), so two echoes for the same connector with
    // contradictory modes would silently record the first and drop the rest —
    // corrupting the audit ledger this channel exists for (the mode is S5
    // ledger-only, so this is an audit-integrity guard, not an authz one). Reject
    // a duplicate-id echo loudly at the trust boundary rather than first-matching.
    .refine(
      (arr) => new Set(arr.map((e) => e.connectorId)).size === arr.length,
      { message: "connectorModeEchoes must have a unique connectorId per entry" },
    )
    .default([]),
  // (spec §6 invariant 4) Optional owner-raised per-turn budget. Absent ⇒ the
  // enclave uses its MEASURED baseline. Present ⇒ the owner raised it via the
  // typed/passkey-fresh settings action; the enclave consumes it in Phase 1
  // (Task 10). Carries NO mode (S5) and no connector id.
  connectorTurnBudgetOverride: ConnectorTurnBudgetOverrideSchema.optional(),
});

export type AgentRequestContext = z.infer<typeof AgentRequestContextSchema>;

interface FolderMetadataLike {
  id: string;
  displayName: string;
  status: "granted" | "needs_regrant" | "revoked";
  handleRefKey?: unknown;
}

export function buildAgentLinkedFolderContext(
  folders: readonly FolderMetadataLike[],
  boundFolderIds: readonly string[],
): AgentLinkedFolderContext[] {
  const bound = new Set(boundFolderIds);
  return folders
    .filter(
      (
        folder,
      ): folder is FolderMetadataLike & {
        status: "granted" | "needs_regrant";
      } => bound.has(folder.id) && folder.status !== "revoked",
    )
    // Defensive client cap at the same bound as the wire schema. Oversize sets
    // fail loudly at the trust boundary (enclave schema reject); this slice just
    // bounds an honest client's context. See MAX_AGENT_LINKED_FOLDERS.
    .slice(0, MAX_AGENT_LINKED_FOLDERS)
    .map((folder) => ({
      folderId: folder.id,
      displayName: folder.displayName,
      status: folder.status,
    }));
}
