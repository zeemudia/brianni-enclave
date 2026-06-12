import type {
  PollVideoJobInput,
  PolledVideoJob,
  RecoverPendingVideoJobInput,
  StartVideoJobInput,
  StartedVideoJob,
  VideoProviderAdapter,
} from "../video-provider";
import {
  classifyProviderHttpError,
  parseRetryAfterMs,
} from "../../providers/errors";

export class GoogleVeoVideoAdapter implements VideoProviderAdapter {
  constructor(
    private readonly deps: {
      baseUrl: string;
      apiKey: string;
      fetchFn?: typeof fetch;
    },
  ) {}

  async start(input: StartVideoJobInput): Promise<StartedVideoJob> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    const response = await fetchFn(
      `${this.deps.baseUrl}/v1beta/models/${encodeURIComponent(input.modelId)}:predictLongRunning?key=${encodeURIComponent(this.deps.apiKey)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-request-params": `model=${input.modelId}`,
        },
        body: JSON.stringify({
          instances: [
            {
              prompt: input.prompt,
              image: input.inputImageBytes
                ? { bytesBase64Encoded: Buffer.from(input.inputImageBytes).toString("base64") }
                : undefined,
            },
          ],
          parameters: {
            durationSeconds: input.durationSeconds,
            aspectRatio: input.aspectRatio,
          },
        }),
        signal: input.abortSignal,
      },
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw classifyProviderHttpError({
        providerId: "google",
        providerName: "Google Video",
        status: response.status,
        body: errText,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      });
    }
    const body = (await response.json()) as { name?: string };
    if (!body.name) throw new Error("GOOGLE_VIDEO_START_MISSING_OPERATION");
    return { providerJobId: body.name };
  }

  async poll(input: PollVideoJobInput): Promise<PolledVideoJob> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    const response = await fetchFn(
      `${this.deps.baseUrl}/v1beta/${input.providerJobId}?key=${encodeURIComponent(this.deps.apiKey)}`,
      { signal: input.abortSignal },
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw classifyProviderHttpError({
        providerId: "google",
        providerName: "Google Video",
        status: response.status,
        body: errText,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      });
    }
    const body = (await response.json()) as {
      done?: boolean;
      error?: { message?: string };
      metadata?: { progressPercent?: number; billing?: { quotaUnits?: number; receiptId?: string } };
      response?: { videos?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> };
    };
    if (body.error) return { status: "failed", reason: body.error.message ?? "PROVIDER_FAILED" };
    if (!body.done) return { status: "running", progressPercent: body.metadata?.progressPercent };
    const encoded = body.response?.videos?.[0]?.bytesBase64Encoded;
    if (!encoded) return { status: "failed", reason: "PROVIDER_RESULT_MISSING_VIDEO" };
    const actualQuotaUnits = body.metadata?.billing?.quotaUnits;
    if (typeof actualQuotaUnits !== "number" || !Number.isInteger(actualQuotaUnits) || actualQuotaUnits <= 0) {
      return { status: "billing_pending", reason: "PROVIDER_BILLING_METADATA_MISSING" };
    }
    return {
      status: "done",
      videoBytes: Buffer.from(encoded, "base64"),
      mimeType: body.response?.videos?.[0]?.mimeType === "video/webm" ? "video/webm" : "video/mp4",
      actualQuotaUnits,
      billingReceiptId: body.metadata?.billing?.receiptId,
      billingSource: "provider_operation_metadata",
    };
  }

  async cancel(input: PollVideoJobInput): Promise<void> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    await fetchFn(
      `${this.deps.baseUrl}/v1beta/${input.providerJobId}:cancel?key=${encodeURIComponent(this.deps.apiKey)}`,
      { method: "POST", signal: input.abortSignal },
    ).catch(() => undefined);
  }

  async recoverPendingStart(
    _input: RecoverPendingVideoJobInput,
  ): Promise<
    | { status: "found"; providerJobId: string }
    | { status: "not_found_verified" }
    | { status: "unavailable"; reason: string }
  > {
    return { status: "unavailable", reason: "GOOGLE_OPERATION_RECOVERY_UNAVAILABLE" };
  }
}
