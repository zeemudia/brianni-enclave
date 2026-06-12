// Isomorphic SHA-256 (sync). @noble/hashes works in Node (server/enclave),
// the browser (web), and React Native (mobile) — this module is imported by
// the web + mobile consent clients (buildGrantFromSelection), so it must NOT
// pull in the Node-only `node:crypto`, which has no Metro/Next bundler fallback
// and would break the claims consent flow before a grant can be minted.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import { MemoryNamespaceSchema } from "./memory";

/**
 * Hard upper bound on documentIds in a cross-pack grant body. documentIds is
 * unread in Phase 1 (per-document enforcement is Phase 3) but is already in the
 * wire schema + the commitment, so we lock a bound now: the enclave rejects an
 * oversize set (GRANT_TOO_MANY_DOCUMENTS) before any grant binds it. Generous
 * relative to a realistic single-claim document count; Phase 3 may tune it.
 */
export const MAX_GRANT_DOCUMENTS = 64;

/**
 * The sensitive grant body — travels ONLY in the encrypted inner body.
 *
 * Strict (parity with the envelope below): the body always has exactly
 * namespaces/folderIds/documentIds/nonce. An unknown key causes a loud
 * parse rejection in the enclave rather than a silent strip — a smuggled
 * field must never ride along inside the encrypted body unnoticed.
 */
export const CrossPackGrantBodySchema = z
  .object({
    namespaces: z.array(MemoryNamespaceSchema).min(1),
    // folderIds is array-length-bounded by the enclave resolver
    // (GRANT_TOO_MANY_FOLDERS via MAX_AGENT_LINKED_FOLDERS).
    // documentIds is array-length-bounded by the enclave resolver
    // (GRANT_TOO_MANY_DOCUMENTS via MAX_GRANT_DOCUMENTS). Per-string length
    // caps are enforced here; the resolver enforces the array bound so that
    // an oversize set produces a clear reject reason rather than a generic
    // parse failure — mirroring the existing folderIds pattern.
    folderIds: z.array(z.string().min(1).max(256)).default([]),
    documentIds: z.array(z.string().min(1).max(256)).default([]),
    nonce: z.string().min(8).max(128),
  })
  .strict();
export type CrossPackGrantBody = z.infer<typeof CrossPackGrantBodySchema>;

export const CrossPackGrantModeSchema = z.enum(["jit", "durable"]);
export type CrossPackGrantMode = z.infer<typeof CrossPackGrantModeSchema>;

/**
 * Server-authoritative grant envelope — travels in the PLAINTEXT outer envelope.
 * Carries no namespace names: only the commitment hash + the single
 * server-decided healthVerified bit. See spec §4.2.1.
 *
 * Strict: the envelope always has exactly grantId/commit/healthVerified/mode/expiresAt.
 * An unknown key causes a loud parse rejection rather than a silent strip,
 * giving better observability against smuggled fields.
 */
export const CrossPackGrantEnvelopeSchema = z
  .object({
    grantId: z.string().min(1).max(128),
    commit: z.string().regex(/^[0-9a-f]{64}$/, "commit must be 64-char lowercase hex (sha256)"),
    healthVerified: z.boolean(),
    mode: CrossPackGrantModeSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type CrossPackGrantEnvelope = z.infer<typeof CrossPackGrantEnvelopeSchema>;

/**
 * Deterministic commitment binding the encrypted body to the server-authoritative
 * mode+expiresAt. MUST be identical on client (mint) and enclave (verify).
 * Canonicalises by sorting keys and the string arrays so order can't change the hash.
 *
 * Committed fields: documentIds, expiresAt, folderIds, mode, namespaces, nonce.
 *
 * Deliberately excluded:
 *   - healthVerified: server-decided fact set at grant-write time by
 *     hasActiveHealthConsent(); including it would require the client to
 *     predict the server's Art-9 gate outcome before the server runs it.
 *   - grantId: server-assigned bookkeeping id, unknown to the client when
 *     the commitment is computed (the client sends commit -> server returns grantId).
 *
 * See spec §4.2.1 for the full trust model.
 */
export function computeGrantCommitment(
  body: CrossPackGrantBody,
  outer: { mode: CrossPackGrantMode; expiresAt: number },
): string {
  const canonical = JSON.stringify({
    documentIds: [...body.documentIds].sort(),
    expiresAt: outer.expiresAt,
    folderIds: [...body.folderIds].sort(),
    mode: outer.mode,
    namespaces: [...body.namespaces].sort(),
    nonce: body.nonce,
  });
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}
