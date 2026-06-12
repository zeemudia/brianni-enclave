import { describe, expect, it, vi } from "vitest";
import { GoogleVeoVideoAdapter } from "../media/adapters/google-veo";
import { ProviderError } from "../providers/errors";

describe("GoogleVeoVideoAdapter", () => {
  it("starts a video job and polls to completion without pretending Google honors local idempotency headers", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "operations/op-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            response: {
              videos: [{ bytesBase64Encoded: Buffer.from("mp4").toString("base64") }],
            },
            metadata: {
              billing: { quotaUnits: 200, receiptId: "google-op-1-bill" },
            },
          }),
          { status: 200 },
        ),
      );
    const adapter = new GoogleVeoVideoAdapter({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      fetchFn,
    });

    const started = await adapter.start({
      modelId: "veo-3.1-generate-preview",
      prompt: "sanitized product teaser",
      inputImageBytes: undefined,
      localIdempotencyKey: "calypso_key",
      durationSeconds: 8,
      aspectRatio: "9:16",
      abortSignal: undefined,
    });
    expect(started.providerJobId).toBe("operations/op-1");
    const firstCallHeaders = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(firstCallHeaders ?? {}).not.toHaveProperty("x-calypso-idempotency-key");

    const completed = await adapter.poll({
      providerJobId: started.providerJobId,
      abortSignal: undefined,
    });
    expect(completed.status).toBe("done");
    if (completed.status === "done") {
      expect(Buffer.from(completed.videoBytes).toString()).toBe("mp4");
      expect(completed.actualQuotaUnits).toBe(200);
      expect(completed.billingSource).toBe("provider_operation_metadata");
    }
  });

  it("classifies start 429 failures as Google Video ProviderError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { status: "RESOURCE_EXHAUSTED", message: "quota exhausted" },
        }),
        { status: 429, headers: { "retry-after": "3" } },
      ),
    );
    const adapter = new GoogleVeoVideoAdapter({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      fetchFn,
    });

    let thrown: unknown;
    try {
      await adapter.start({
        modelId: "veo-3.1-generate-preview",
        prompt: "sanitized product teaser",
        inputImageBytes: undefined,
        localIdempotencyKey: "calypso_key",
        durationSeconds: 8,
        aspectRatio: "9:16",
        abortSignal: undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).toMatchObject({
      providerId: "google",
      kind: "rate_limit",
      status: 429,
      retryAfterMs: 3_000,
    });
  });
});
