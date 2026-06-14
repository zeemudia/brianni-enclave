import { verify, createPublicKey } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  SkillPromptBundleSchema,
  MIN_SKILL_PROMPTS_VERSION,
  canonicalSkillPromptsSigningInput,
  type SkillPromptBundle,
} from "@calypso/chat-types";
import type { SkillPromptResolver } from "@calypso/chat-types/skills";

/**
 * Load and verify the signed skill-prompts bundle. Mirrors
 * providers/registry.ts → loadAndVerifyRegistry.
 *
 * Rejects on a missing/invalid signature or a version below the baked floor.
 * The signature is verified over the domain-separated canonical
 * `{ domain, version, prompts }` envelope, so a provider-registry signature
 * cannot be replayed here even under the same offline key, and an old bundle
 * cannot be relabelled with a higher version to clear the anti-rollback floor.
 */
export function loadAndVerifySkillPrompts(
  raw: unknown,
  verifyKeyPem: string,
): SkillPromptBundle {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid skill-prompts bundle format");
  }
  const bundle = raw as Record<string, unknown>;

  if (!bundle.signature || typeof bundle.signature !== "string") {
    throw new Error("MISSING_SKILL_PROMPTS_SIGNATURE");
  }
  if (!bundle.prompts || typeof bundle.prompts !== "object") {
    throw new Error("Invalid skill-prompts bundle: missing prompts");
  }
  if (typeof bundle.version !== "number" || !Number.isInteger(bundle.version)) {
    throw new Error("INVALID_SKILL_PROMPTS_VERSION");
  }
  if (bundle.version < MIN_SKILL_PROMPTS_VERSION) {
    throw new Error("SKILL_PROMPTS_VERSION_BELOW_MINIMUM");
  }

  const keyObject = createPublicKey({
    key: verifyKeyPem,
    format: "pem",
    type: "spki",
  });
  const valid = verify(
    null,
    canonicalSkillPromptsSigningInput(bundle.version, bundle.prompts),
    keyObject,
    Buffer.from(bundle.signature, "base64"),
  );
  if (!valid) {
    throw new Error("INVALID_SKILL_PROMPTS_SIGNATURE");
  }

  // Schema-validate (pack-id key pattern + prompt length) only AFTER the
  // signature passes, so untrusted bytes never reach heavier validation.
  const parsed = SkillPromptBundleSchema.parse(bundle);
  console.info(
    `[skills] Skill-prompts bundle loaded and verified (${Object.keys(parsed.prompts).length} prompts, v${parsed.version})`,
  );
  return parsed;
}

/**
 * Build a SkillPromptResolver (packId -> systemPromptBlock) from a verified
 * bundle, for getEffectiveSkillPack(id, resolvePrompt).
 */
export function buildPromptResolver(
  bundle: SkillPromptBundle,
): SkillPromptResolver {
  return (packId: string) => bundle.prompts[packId];
}
