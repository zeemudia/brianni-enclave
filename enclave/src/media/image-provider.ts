// ImageProviderAdapter — the SYNCHRONOUS sibling of VideoProviderAdapter
// (../media/video-provider). Image generation/edit is a single request/response
// (no provider-side job, no polling, no checkpoint/resume machinery), so the
// adapter exposes one `generate` call that returns the finished bytes (or a
// clean failure) rather than the start/poll pair the long-running video jobs
// need. The orchestrator media executor drives the same trust spine around it:
// budget reserve → adapter.generate → provenance-sign the output → encrypt →
// emit artifact → binary write-ACK → budget reconcile.

export type ImageOperation = 'image_generate' | 'image_edit';

export type ImageOutputMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type ImageInputMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface GenerateImageInput {
  operation: ImageOperation;
  modelId: string;
  /** The (already on-device-masked) text prompt describing the image. */
  prompt: string;
  /**
   * For `image_edit`: the source image bytes the user authorised the model to
   * transform. Provider-visible — the consent + provenance spine treats it as
   * a provider-visible input. Absent for `image_generate` (text → image).
   */
  inputImageBytes?: Uint8Array;
  inputImageMimeType?: ImageInputMimeType;
  /** Requested output dimensions; the adapter clamps to a provider-supported size. */
  size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto';
  outputMimeType?: ImageOutputMimeType;
  /**
   * Idempotency key the enclave mints per media job. Adapters that support
   * request-level idempotency forward it so a retried generate after a transport
   * hiccup cannot double-bill.
   */
  localIdempotencyKey: string;
  abortSignal?: AbortSignal;
}

export type GeneratedImage =
  | {
      status: 'done';
      imageBytes: Uint8Array;
      mimeType: ImageOutputMimeType;
      /** Quota units actually consumed (for budget reconcile). */
      actualQuotaUnits: number;
      billingReceiptId?: string;
    }
  | { status: 'failed'; reason: string };

export interface ImageProviderAdapter {
  /**
   * Generate (or edit) an image in a single synchronous provider call. MUST NOT
   * throw on a provider/HTTP error — return { status: 'failed', reason } so the
   * media executor can reconcile the budget hold and emit a clean tool failure
   * (a throw would escape the generator and collapse the whole turn).
   */
  generate(input: GenerateImageInput): Promise<GeneratedImage>;
}
