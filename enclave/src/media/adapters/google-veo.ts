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

// A single generated clip, normalised across the response shapes Veo returns.
interface VeoVideoSample {
  bytesBase64Encoded?: string;
  uri?: string;
  mimeType?: string;
}

// The `response` object of a DONE predictLongRunning operation. Veo has shipped
// at least three shapes across model/API revisions; the adapter reads whichever
// is present rather than pinning one (the bare `response.videos[0]` assumption
// returned a clip-less `done` operation as MISSING_VIDEO on the live API).
interface VeoOperationResponse {
  videos?: VeoVideoSample[];
  generatedVideos?: Array<{ video?: VeoVideoSample }>;
  generateVideoResponse?: {
    generatedSamples?: Array<{ video?: VeoVideoSample }>;
    // Present when Veo's responsible-AI filter dropped samples — the ONLY
    // billing-adjacent/usage-adjacent fields the response carries are these RAI
    // counters; there is no quota/usage/cost field anywhere in the operation.
    raiMediaFilteredCount?: number;
    raiMediaFilteredReasons?: string[];
  };
}

// Pull the first generated clip from any known Veo response shape, or null when
// none carries a usable byte source (inline base64 or a downloadable URI).
function extractVideoSample(response: VeoOperationResponse | undefined): VeoVideoSample | null {
  if (!response) return null;
  const candidates: Array<VeoVideoSample | undefined> = [
    // Shape A: the originally-assumed flat array (kept for back-compat).
    response.videos?.[0],
    // Shape B: the REST predictLongRunning shape observed on the live Gemini API.
    response.generateVideoResponse?.generatedSamples?.[0]?.video,
    // Shape C: the @google/genai SDK-style wrapper.
    response.generatedVideos?.[0]?.video,
  ];
  for (const c of candidates) {
    if (c && (c.bytesBase64Encoded || c.uri)) return c;
  }
  return null;
}

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
      response?: VeoOperationResponse;
    };
    if (body.error) return { status: "failed", reason: body.error.message ?? "PROVIDER_FAILED" };
    if (!body.done) return { status: "running", progressPercent: body.metadata?.progressPercent };

    // The done operation's `response` shape is NOT documented inline and differs
    // across Veo model/API revisions, so we accept every known shape rather than
    // a single field. Veo delivers the clip EITHER inline (bytesBase64Encoded) OR
    // as a Files API URI that must be downloaded with the API key (large clips).
    const sample = extractVideoSample(body.response);
    if (!sample) {
      // Veo's responsible-AI filter can drop every sample and explain why in
      // `raiMediaFilteredReasons` (a common Veo 3.1 false-positive). Surface that
      // as an honest, specific failure rather than a generic missing-video so the
      // user sees WHY the clip was blocked and the turn degrades cleanly.
      const raiReasons = body.response?.generateVideoResponse?.raiMediaFilteredReasons;
      if (Array.isArray(raiReasons) && raiReasons.length > 0) {
        return {
          status: "failed",
          reason: `PROVIDER_VIDEO_SAFETY_FILTERED:${raiReasons.join("; ").slice(0, 200)}`,
        };
      }
      // Surface the observed top-level keys (NOT any bytes/uri) in the reason so a
      // live shape-miss is debuggable from the orchestrator media-job detail
      // without enclave logs — the prior bare code hid which shape arrived.
      const observed = Object.keys(body.response ?? {}).join(",").slice(0, 80);
      return { status: "failed", reason: `PROVIDER_RESULT_MISSING_VIDEO:${observed}` };
    }

    let videoBytes: Uint8Array;
    if (sample.bytesBase64Encoded) {
      videoBytes = Buffer.from(sample.bytesBase64Encoded, "base64");
    } else if (sample.uri) {
      videoBytes = await this.downloadVideoFile(sample.uri, input.abortSignal);
    } else {
      const observed = Object.keys(body.response ?? {}).join(",").slice(0, 80);
      return { status: "failed", reason: `PROVIDER_RESULT_MISSING_VIDEO:${observed}` };
    }

    // The Google Veo operation response carries NO billing/quota field — billing
    // is metered separately on Google's side, never echoed in the operation.
    // (Confirmed against the live API + the google-genai GenerateVideosResponse
    // type.) So we DELIVER the generated clip unconditionally and only attach a
    // provider quota figure on the off chance a future provider revision ever
    // returns one; otherwise the enclave bills its own duration estimate, exactly
    // as image generation bills a fixed estimate. The clip is NEVER withheld
    // waiting for a field that does not exist.
    const mimeType = sample.mimeType === "video/webm" ? "video/webm" : "video/mp4";
    const providerQuotaUnits = body.metadata?.billing?.quotaUnits;
    if (
      typeof providerQuotaUnits === "number" &&
      Number.isInteger(providerQuotaUnits) &&
      providerQuotaUnits > 0
    ) {
      return {
        status: "done",
        videoBytes,
        mimeType,
        actualQuotaUnits: providerQuotaUnits,
        billingReceiptId: body.metadata?.billing?.receiptId,
        billingSource: "provider_operation_metadata",
      };
    }
    return {
      status: "done",
      videoBytes,
      mimeType,
      billingSource: "enclave_duration_estimate",
    };
  }

  // Download a Veo clip delivered as a Gemini Files API URI. The download is
  // authenticated with the API key (appended only when the URI doesn't already
  // carry one). A non-2xx download is a provider failure, classified like the
  // poll/start calls so the orchestrator reconciles the hold consistently.
  private async downloadVideoFile(
    uri: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    // Google's Veo REST docs authenticate the generated-clip download with the
    // `x-goog-api-key` header (not a `?key=` query param). Send the header and
    // pass the Files-API URI through unchanged — a URI that already carries a
    // `?key=` still works (the redundant header is harmless), so this tolerates
    // both delivery conventions without leaking the key into the URL/logs.
    const response = await fetchFn(uri, {
      headers: { "x-goog-api-key": this.deps.apiKey },
      signal: abortSignal,
    });
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
    return new Uint8Array(await response.arrayBuffer());
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
