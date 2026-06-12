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
  | { status: "billing_pending"; reason: "PROVIDER_BILLING_METADATA_MISSING" }
  | {
      status: "done";
      videoBytes: Uint8Array;
      mimeType: "video/mp4" | "video/webm";
      actualQuotaUnits: number;
      billingReceiptId?: string;
      billingSource: "provider_final" | "provider_operation_metadata";
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
