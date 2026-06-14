/**
 * No silent bundled-prompts downgrade in production (mirrors
 * registry-fallback-production.test.ts).
 *
 * The skill-prompts bundle is not baked into the EIF; production fetches it from
 * the skills-broker over vsock. If the broker is unreachable, the enclave must
 * fail CLOSED — never silently boot on a stale or absent persona prompt. The
 * bundled dev fallback is gated to test / MOCK_KMS boots only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../skills-client", () => ({
  fetchSkillPromptsFromBroker: vi
    .fn()
    .mockRejectedValue(new Error("broker unreachable")),
}));

describe("loadSkillPrompts production fallback", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keys = ["NODE_ENV", "MOCK_KMS", "SKILL_PROMPTS_PATH"] as const;

  beforeEach(() => {
    for (const key of keys) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("does NOT fall back to the bundled prompts when the broker fails in production", async () => {
    // Import while NODE_ENV is still 'test' so the module-level main() guard
    // does not boot a real enclave; loadSkillPrompts reads process.env at CALL
    // time, so flipping env afterwards is sufficient.
    const { EnclaveRouter } = await import("../index");

    process.env.NODE_ENV = "production";
    delete process.env.MOCK_KMS;
    delete process.env.SKILL_PROMPTS_PATH;

    const router: any = new EnclaveRouter();
    await expect(router.loadSkillPrompts()).rejects.toThrow(
      /Skill prompts unavailable/,
    );
  });
});
