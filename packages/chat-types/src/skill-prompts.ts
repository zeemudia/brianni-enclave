import { z } from "zod";

/**
 * Signed bundle of persona system prompts, served by the host skills-broker
 * over vsock (port 8103) and signature-verified inside the enclave against a
 * measured public key.
 *
 * Why this exists: `systemPromptBlock` previously shipped inside the
 * client-distributed `SkillPack` — present in the web browser bundle
 * (`.next/static`) and the mobile RN binary, even though clients never read it.
 * It is the persona-prompt IP. It now lives ONLY here, signed by the offline
 * key, removed from every client bundle AND from the measured EIF, and composed
 * onto the pack by the enclave at request time.
 *
 * Integrity: a compromised host can stream any bytes to the enclave, but only a
 * bundle signed with the offline key verifies (see ./canonical-skill-prompts,
 * which is domain-separated from the provider registry). The enclave fails
 * CLOSED in production if the broker is unreachable or the signature is invalid
 * — it never falls back to an unprompted or stale persona.
 */
export const SkillPromptBundleSchema = z.object({
  version: z.number().int().positive(),
  /** packId -> systemPromptBlock. Keys must be canonical pack ids. */
  prompts: z.record(
    z.string().regex(/^personal-agent\.[a-z0-9-]+$/),
    z.string().min(1).max(4096),
  ),
  signature: z.string().min(1),
});

export type SkillPromptBundle = z.infer<typeof SkillPromptBundleSchema>;

/**
 * Minimum acceptable bundle version, baked into the measured enclave image
 * (covered by PCR0/attestation). Advance on any rotation that must invalidate a
 * superseded prompt bundle; because the constant is measured, raising it is
 * itself an EIF rebuild + PCR0 rotation. The signed envelope binds the version
 * to the signature, so an attacker cannot relabel an old bundle with a higher
 * version to clear the floor.
 */
export const MIN_SKILL_PROMPTS_VERSION = 1;
