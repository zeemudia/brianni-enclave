export interface StartVideoJobInput {
  modelId: string;
  prompt: string;
  inputImageBytes?: Uint8Array;
  localIdempotencyKey: string;
  durationSeconds: number;
  aspectRatio: "1:1" | "9:16" | "16:9";
  abortSignal?: AbortSignal;
}

export interface PollVideoJobInput {
  providerJobId: string;
  abortSignal?: AbortSignal;
}

export interface RecoverPendingVideoJobInput {
  mediaJobId: string;
  localIdempotencyKey: string;
  modelId: string;
  abortSignal?: AbortSignal;
}

export interface StartedVideoJob {
  providerJobId: string;
}

export type PolledVideoJob =
  | { status: "running"; progressPercent?: number }
  | {
      status: "done";
      videoBytes: Uint8Array;
      mimeType: "video/mp4" | "video/webm";
      // The Google Veo `predictLongRunning` operation response carries NO
      // billing/quota/usage field (confirmed against the live API and the
      // google-genai GenerateVideosResponse type). So `actualQuotaUnits` is
      // OPTIONAL: present only if a provider ever echoes a usage figure;
      // otherwise the enclave bills its own duration estimate (the same way
      // image generation bills a fixed estimate). A generated clip must NEVER be
      // withheld waiting for a provider billing field that does not exist.
      actualQuotaUnits?: number;
      billingReceiptId?: string;
      billingSource:
        | "provider_final"
        | "provider_operation_metadata"
        | "enclave_duration_estimate";
    }
  | { status: "failed"; reason: string };

export interface VideoProviderAdapter {
  start(input: StartVideoJobInput): Promise<StartedVideoJob>;
  poll(input: PollVideoJobInput): Promise<PolledVideoJob>;
  cancel?(input: PollVideoJobInput): Promise<void>;
  recoverPendingStart?(input: RecoverPendingVideoJobInput): Promise<
    | { status: "found"; providerJobId: string }
    | { status: "not_found_verified" }
    | { status: "unavailable"; reason: string }
  >;
}
