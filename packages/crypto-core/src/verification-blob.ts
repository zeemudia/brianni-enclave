/**
 * Contract D — Verification blob envelope.
 *
 * Spec: docs/superpowers/specs/2026-04-26-otp-mnemonic-passkey-redesign.md
 *       §"Cross-platform parity & contracts" → Contract D.
 *
 * **Replaces** the deprecated `createVerificationBlob` / `verifyRoot` in
 * `./envelope.ts`. Differences from the old contract (intentional):
 *   - Plaintext literal is `BRIANNI_AI_VERIFIED_v1` (was
 *     `BRIANNI_CHAT_ROOT_VERIFIED_v1`).
 *   - No AAD (was `calypso:chat_root:verify`). The new flow encrypts
 *     directly under the chat root with a random 12-byte IV.
 *   - Wire format is sorted-JSON `{ciphertext,iv,tag,v:1}` instead of the
 *     old `WrappedRoot` struct.
 *
 * **Migration strategy: atomic-replace, NOT mixed-version.** This module
 * coexists with the deprecated `envelope.ts` only on this feature branch
 * and only for the duration of Chunks 3-9. The two contracts are NEVER
 * deployed simultaneously in the same environment:
 *
 *   - **Branch state** (current): both modules exist; `envelope.ts` is
 *     `@deprecated`-tagged at every export; web/mobile callers are
 *     scheduled for rewrite in Chunks 7 and 9 within this same branch.
 *   - **Pre-merge state** (end of Chunk 11): zero callers of
 *     `envelope.ts`'s `createVerificationBlob` / `verifyRoot` /
 *     `wrapChatRoot` / `unwrapChatRoot` remain in the codebase. The
 *     branch's final commits delete those exports + the old vector files
 *     entirely.
 *   - **Post-merge state**: only this `verification-blob.ts` contract
 *     exists. There is no time window in which both readers and writers
 *     of the old contract overlap with readers/writers of the new one.
 *
 * **Why "atomic-replace" is safe here despite normally being a rollout
 * hazard:** the project is pre-MVP per `CLAUDE.md` Locked Decisions —
 * "no users until MVP — destructive ordering acceptable". The migration
 * (Chunk 4 §Schema changes) DROPs the old `KeyEnvelope` table in the
 * same SQL transaction that creates `KeyDerivationGate` /
 * `KeyDerivationVerification`. There is no production data to migrate;
 * there is no rollout to a fleet of mixed-version clients; the entire
 * "deletion + replacement" lands as a single PR merge. A mixed-version
 * concern would apply only after MVP launch, at which point any further
 * contract changes will require explicit dual-read/dual-write code paths
 * (NOT this comment block).
 *
 * **Mechanical enforcement (Chunk 11 §Task 11.8b):** the safety property
 * stated above is enforced in code, not just in this docblock. Plan
 * §Task 11.8b deletes `envelope.ts` outright at the end of Chunk 11
 * (after Chunks 7 + 9 have rewritten the web/mobile callers) and adds
 * a CI-enforced regression test (`no-deprecated-callers.test.ts`) that
 * scans TypeScript import/export syntax only — deprecated module
 * specifiers and named bindings (`createVerificationBlob`,
 * `verifyRoot`, `wrapChatRoot`, `unwrapChatRoot`) and the legacy KDF
 * subpath. Comments/docblocks like this one are intentionally ignored
 * because they are not callers. A future PR that re-introduces
 * deprecated imports/exports fails CI before merge — the no-mixed-
 * version invariant is mechanical at that point, not advisory.
 */
import { sortedJsonStringify } from './sorted-json';

export const VERIFICATION_BLOB_PLAINTEXT = 'BRIANNI_AI_VERIFIED_v1';

export interface VerificationBlobEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
  v: 1;
}

export function serialiseVerificationBlob(env: VerificationBlobEnvelope): string {
  return sortedJsonStringify({
    ciphertext: env.ciphertext,
    iv: env.iv,
    tag: env.tag,
    v: env.v,
  });
}

export function parseVerificationBlob(json: string): VerificationBlobEnvelope {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  // L4 error-handling-audit — JSON.parse('null') (or an array) is valid
  // JSON but not an envelope; without this guard the property access below
  // crashed with a raw TypeError before the typed version error could fire.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('verification blob: expected a JSON object');
  }
  if (parsed.v !== 1) {
    throw new Error(`unsupported verification blob version: ${String(parsed.v)}`);
  }
  if (
    typeof parsed.ciphertext !== 'string' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.tag !== 'string'
  ) {
    throw new Error('verification blob: missing required fields');
  }
  return { ciphertext: parsed.ciphertext, iv: parsed.iv, tag: parsed.tag, v: 1 };
}
