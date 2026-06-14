/**
 * Skill-prompts signature MECHANISM — self-contained (ephemeral keys, synthetic
 * bundle). No dependency on the committed bundle or baked key, so this runs
 * identically in the monorepo and in the sanitized public export (which ships a
 * placeholder-signed sample). The committed-bundle + content guards live in
 * skill-prompts-bundle.test.ts (monorepo-only; dropped by the export normalizer).
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { canonicalSkillPromptsSigningInput } from "@calypso/chat-types";
import {
  loadAndVerifySkillPrompts,
  buildPromptResolver,
} from "../skills/verify-skill-prompts";

function makeKeypair() {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function signBundle(
  version: number,
  prompts: Record<string, string>,
  privateKey: string,
) {
  const signature = sign(
    null,
    canonicalSkillPromptsSigningInput(version, prompts),
    privateKey,
  ).toString("base64");
  return { version, prompts, signature };
}

const PROMPTS = { "personal-agent.default": "You are a test assistant." };

describe("skill-prompts verify — signature mechanism", () => {
  it("accepts a correctly-signed bundle and resolves prompts", () => {
    const { publicKey, privateKey } = makeKeypair();
    const v = loadAndVerifySkillPrompts(signBundle(1, PROMPTS, privateKey), publicKey);
    expect(buildPromptResolver(v)("personal-agent.default")).toBe(
      "You are a test assistant.",
    );
  });

  it("rejects a tampered prompt", () => {
    const { publicKey, privateKey } = makeKeypair();
    const bundle = signBundle(1, PROMPTS, privateKey);
    const tampered = { ...bundle, prompts: { "personal-agent.default": "PWNED" } };
    expect(() => loadAndVerifySkillPrompts(tampered, publicKey)).toThrow(
      /INVALID_SKILL_PROMPTS_SIGNATURE/,
    );
  });

  it("rejects a missing signature", () => {
    expect(() =>
      loadAndVerifySkillPrompts(
        { version: 1, prompts: PROMPTS },
        makeKeypair().publicKey,
      ),
    ).toThrow(/MISSING_SKILL_PROMPTS_SIGNATURE/);
  });

  it("rejects a version below the anti-rollback floor", () => {
    expect(() =>
      loadAndVerifySkillPrompts(
        { version: 0, prompts: PROMPTS, signature: "x" },
        makeKeypair().publicKey,
      ),
    ).toThrow(/SKILL_PROMPTS_VERSION_BELOW_MINIMUM/);
  });

  it("rejects a signature from the wrong key", () => {
    const a = makeKeypair();
    const b = makeKeypair();
    expect(() =>
      loadAndVerifySkillPrompts(signBundle(1, PROMPTS, a.privateKey), b.publicKey),
    ).toThrow(/INVALID_SKILL_PROMPTS_SIGNATURE/);
  });

  it("rejects a non-domain-separated (registry-style) signature", () => {
    const { publicKey, privateKey } = makeKeypair();
    const wrongInput = Buffer.from(JSON.stringify({ version: 1, prompts: PROMPTS }));
    const signature = sign(null, wrongInput, privateKey).toString("base64");
    expect(() =>
      loadAndVerifySkillPrompts({ version: 1, prompts: PROMPTS, signature }, publicKey),
    ).toThrow(/INVALID_SKILL_PROMPTS_SIGNATURE/);
  });
});
