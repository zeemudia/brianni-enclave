/**
 * Canonical serialization of the signed skill-prompt bundle envelope.
 *
 * Single source of truth shared by the signer (scripts/sign-skill-prompts.ts)
 * and the in-enclave verifier (enclave/src/skills-client.ts → verify). Both MUST
 * produce byte-identical signing input, otherwise a valid signature fails
 * verification.
 *
 * Mirrors providers' canonical-registry.ts (recursive object-key sort; array
 * order preserved) but adds a DOMAIN tag so a provider-registry signature
 * (which signs `{ version, providers }`) can never be replayed as a
 * skill-prompts signature even under the same offline signing key. The version
 * is inside the signed bytes, defeating relabel-an-old-bundle-with-a-higher-
 * version replay.
 *
 * This module has NO heavy dependencies so the standalone signing script can
 * import it without dragging in the enclave runtime.
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => canonicalize(element));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Domain tag binding a signature to the skill-prompts protocol (v1). */
export const SKILL_PROMPTS_SIGNING_DOMAIN = "calypso.skill-prompts.v1";

/**
 * Deterministic byte serialization of the skill-prompts signing envelope.
 * Stable regardless of object key insertion order in the source JSON.
 */
export function canonicalSkillPromptsSigningInput(
  version: number,
  prompts: unknown,
): Buffer {
  return Buffer.from(
    JSON.stringify(
      canonicalize({
        domain: SKILL_PROMPTS_SIGNING_DOMAIN,
        version,
        prompts,
      }),
    ),
  );
}
