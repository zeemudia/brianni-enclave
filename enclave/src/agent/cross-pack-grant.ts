import {
  computeGrantCommitment,
  MAX_AGENT_LINKED_FOLDERS,
  MAX_GRANT_DOCUMENTS,
  type CrossPackGrantBody,
  type CrossPackGrantEnvelope,
  type MemoryNamespace,
} from "@calypso/chat-types";

export const CLAIMS_PACK_ID = "personal-agent.claims";

export type PackView = {
  id: string;
  defaultNamespace: MemoryNamespace;
  crossPackNamespaces?: readonly MemoryNamespace[];
};

export type ResolveCrossPackGrantInput = {
  pack: PackView;
  envelope: CrossPackGrantEnvelope | undefined;
  body: CrossPackGrantBody | undefined;
  now: number;
};

export type ResolvedCrossPackGrant =
  | { ok: true; namespaces: ReadonlySet<MemoryNamespace>; folderIds: ReadonlySet<string>; documentIds: ReadonlySet<string> }
  | { ok: false; reason: GrantRejectReason };

export type GrantRejectReason =
  | "GRANT_COMMITMENT_MISMATCH"
  | "GRANT_EXPIRED"
  | "GRANT_BODY_MISSING"
  | "GRANT_TOO_MANY_FOLDERS"
  | "GRANT_TOO_MANY_DOCUMENTS";

/**
 * Decide the authorized cross-pack read scope for a request. Fail-closed:
 * with no grant (or a grant for a non-claims pack — purpose binding) the
 * authorization collapses to the pack's single defaultNamespace, i.e. exactly
 * today's behaviour. See spec §4.1, §4.2.1, §4.2.2.
 */
export function resolveCrossPackGrant(input: ResolveCrossPackGrantInput): ResolvedCrossPackGrant {
  const single = (): ResolvedCrossPackGrant => ({
    ok: true,
    namespaces: new Set([input.pack.defaultNamespace]),
    folderIds: new Set<string>(),
    documentIds: new Set<string>(),
  });

  // No grant, or purpose binding fails → single-namespace (unchanged) behaviour.
  if (!input.envelope) return single();
  if (input.pack.id !== CLAIMS_PACK_ID) return single();

  // Envelope present but body absent: do NOT fall back to single (that would
  // mask a tampering attempt). Fail closed loudly.
  if (!input.body) return { ok: false, reason: "GRANT_BODY_MISSING" };

  // Verify integrity (commitment) BEFORE freshness (expiry): never trust the
  // envelope's expiresAt until the commitment binding it has been validated.
  const expected = computeGrantCommitment(input.body, {
    mode: input.envelope.mode,
    expiresAt: input.envelope.expiresAt,
  });
  if (expected !== input.envelope.commit) return { ok: false, reason: "GRANT_COMMITMENT_MISMATCH" };

  if (input.now >= input.envelope.expiresAt) return { ok: false, reason: "GRANT_EXPIRED" };

  // Defense-in-depth: a grant referencing more folders than the transport cap
  // fails loudly rather than reading a partial set. Bound shared with
  // AgentRequestContextSchema.linkedFolders via MAX_AGENT_LINKED_FOLDERS.
  if (input.body.folderIds.length > MAX_AGENT_LINKED_FOLDERS) {
    return { ok: false, reason: "GRANT_TOO_MANY_FOLDERS" };
  }

  // Defense-in-depth: a grant referencing more documents than the hard cap
  // fails loudly. documentIds is unread in Phase 1 but is already in the
  // wire schema + the commitment; we lock the bound now so an oversize set
  // committed today cannot cause trouble when Phase 3 enforces per-document
  // access. Mirrors the GRANT_TOO_MANY_FOLDERS pattern above.
  if (input.body.documentIds.length > MAX_GRANT_DOCUMENTS) {
    return { ok: false, reason: "GRANT_TOO_MANY_DOCUMENTS" };
  }

  const allowed = new Set(input.pack.crossPackNamespaces ?? [input.pack.defaultNamespace]);
  let namespaces = input.body.namespaces.filter((n) => allowed.has(n));
  if (!input.envelope.healthVerified) namespaces = namespaces.filter((n) => n !== "health");

  // Empty after filtering → collapse to single-namespace default (still valid, just no widening).
  if (namespaces.length === 0) return single();

  return {
    ok: true,
    namespaces: new Set(namespaces),
    folderIds: new Set(input.body.folderIds),
    documentIds: new Set(input.body.documentIds),
  };
}
