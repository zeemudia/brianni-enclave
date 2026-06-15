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

  it("parses the real Gemini predictLongRunning shape (generateVideoResponse.generatedSamples[].video.uri) and downloads the file", async () => {
    const videoBytes = Buffer.from("real-mp4-bytes");
    const fetchFn = vi
      .fn()
      // poll → operation done, video delivered as a Files API URI (not inline)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [
                  {
                    video: {
                      uri: "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media",
                      mimeType: "video/mp4",
                    },
                  },
                ],
              },
            },
            metadata: { billing: { quotaUnits: 180, receiptId: "veo-bill-1" } },
          }),
          { status: 200 },
        ),
      )
      // download of the file URI → raw video bytes
      .mockResolvedValueOnce(
        new Response(videoBytes, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
      );
    const adapter = new GoogleVeoVideoAdapter({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      fetchFn,
    });

    const completed = await adapter.poll({ providerJobId: "operations/op-9", abortSignal: undefined });
    expect(completed.status).toBe("done");
    if (completed.status === "done") {
      expect(Buffer.from(completed.videoBytes).toString()).toBe("real-mp4-bytes");
      expect(completed.actualQuotaUnits).toBe(180);
    }
    // The download must target the Files URI (unchanged) and authenticate via
    // the x-goog-api-key header per Google's Veo REST download docs.
    const downloadUrl = String(fetchFn.mock.calls[1]?.[0] ?? "");
    expect(downloadUrl).toContain("files/abc:download");
    const downloadHeaders = (fetchFn.mock.calls[1]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(downloadHeaders["x-goog-api-key"]).toBe("test-key");
  });

  it("parses the Gemini shape when the sample carries inline base64 (no download)", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [
                { video: { bytesBase64Encoded: Buffer.from("inline-webm").toString("base64"), mimeType: "video/webm" } },
              ],
            },
          },
          metadata: { billing: { quotaUnits: 90 } },
        }),
        { status: 200 },
      ),
    );
    const adapter = new GoogleVeoVideoAdapter({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      fetchFn,
    });
    const completed = await adapter.poll({ providerJobId: "operations/op-10", abortSignal: undefined });
    expect(completed.status).toBe("done");
    if (completed.status === "done") {
      expect(Buffer.from(completed.videoBytes).toString()).toBe("inline-webm");
      expect(completed.mimeType).toBe("video/webm");
    }
    // No second fetch — inline bytes need no download.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("delivers the clip even when the done operation carries NO billing metadata (the real Veo shape)", async () => {
    // Google's Veo predictLongRunning operation returns the video at
    // response.generateVideoResponse.generatedSamples[].video.uri and carries
    // NO billing/quota/usage field anywhere (confirmed against the live API and
    // the google-genai GenerateVideosResponse type). The adapter must still
    // deliver the clip and let the enclave bill the duration estimate — it must
    // NOT withhold a generated clip waiting for a field that never arrives.
    const videoBytes = Buffer.from("real-veo-clip");
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [
                  {
                    video: {
                      uri: "https://generativelanguage.googleapis.com/v1beta/files/xyz:download?alt=media",
                      mimeType: "video/mp4",
                    },
                  },
                ],
              },
            },
            // NO `metadata` at all — exactly what the real API returns.
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } }),
      );
    const adapter = new GoogleVeoVideoAdapter({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      fetchFn,
    });

    const completed = await adapter.poll({ providerJobId: "operations/op-12", abortSignal: undefined });
    expect(completed.status).toBe("done");
    if (completed.status === "done") {
      expect(Buffer.from(completed.videoBytes).toString()).toBe("real-veo-clip");
      expect(completed.mimeType).toBe("video/mp4");
      // No provider billing field → the adapter reports no provider quota and
      // flags that the enclave must bill its own duration estimate.
      expect(completed.actualQuotaUnits).toBeUndefined();
      expect(completed.billingSource).toBe("enclave_duration_estimate");
    }
  });

  it("surfaces an RAI safety-filter block as an honest failure (not a generic missing-video)", async () => {
    // When Veo's responsible-AI filter drops every sample, the done operation
    // has no generatedSamples and explains why in raiMediaFilteredReasons. This
    // is a common Veo 3.1 false-positive and must degrade honestly.
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          done: true,
          response: {
            generateVideoResponse: {
              raiMediaFilteredCount: 1,
              raiMediaFilteredReasons: [
                "Video generation blocked by safety filters (audio).",
              ],
            },
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
    const completed = await adapter.poll({ providerJobId: "operations/op-13", abortSignal: undefined });
    expect(completed.status).toBe("failed");
    if (completed.status === "failed") {
      expect(completed.reason).toContain("PROVIDER_VIDEO_SAFETY_FILTERED");
      expect(completed.reason).toContain("safety filters");
    }
  });

  it("surfaces the actual response key set when no known video shape matches", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ done: true, response: { someNewWrapper: { clips: [] } } }),
        { status: 200 },
      ),
    );
    const adapter = new GoogleVeoVideoAdapter({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      fetchFn,
    });
    const completed = await adapter.poll({ providerJobId: "operations/op-11", abortSignal: undefined });
    expect(completed.status).toBe("failed");
    if (completed.status === "failed") {
      // Reason carries the observed top-level response keys so a live miss is debuggable.
      expect(completed.reason).toContain("PROVIDER_RESULT_MISSING_VIDEO");
      expect(completed.reason).toContain("someNewWrapper");
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
