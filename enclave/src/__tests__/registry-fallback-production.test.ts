/**
 * Error-handling audit L4 — no silent bundled-registry downgrade in
 * production.
 *
 * Today providers.json is not baked into the EIF (Dockerfile.enclave bakes
 * only the verify key), so the bundled fallback after a registry-broker
 * failure happens to fail anyway. But if anyone ever DID bake the file in,
 * a broker outage would silently boot the enclave on a stale provider set.
 * The production path must skip the bundled fallback explicitly and fail
 * loudly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../registry-client", () => ({
  fetchRegistryFromBroker: vi
    .fn()
    .mockRejectedValue(new Error("broker unreachable")),
}));

describe("loadProviderRegistry production fallback (L4)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keys = ["NODE_ENV", "MOCK_KMS", "REGISTRY_PATH"] as const;

  beforeEach(() => {
    for (const key of keys) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("does NOT fall back to the bundled registry when the broker fails in production", async () => {
    // Import while NODE_ENV is still 'test' so the module-level main()
    // guard does not boot a real enclave; loadProviderRegistry reads
    // process.env at CALL time, so flipping env afterwards is sufficient.
    const { EnclaveRouter } = await import("../index");

    process.env.NODE_ENV = "production";
    delete process.env.MOCK_KMS;
    delete process.env.REGISTRY_PATH;

    const router: any = new EnclaveRouter();
    await expect(router.loadProviderRegistry()).rejects.toThrow(
      /Provider registry unavailable/,
    );
  });
});
