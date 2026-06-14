import type {
  GeneratedImage,
  GenerateImageInput,
  ImageOutputMimeType,
  ImageProviderAdapter,
} from '../../media/image-provider';

export interface OpenAICompatibleImageProviderMetadata {
  providerId?: string;
  providerName?: string;
}

/**
 * Synchronous OpenAI image adapter for gpt-image-2.
 *
 * - `image_generate` → `POST {baseUrl}/images/generations` (JSON).
 * - `image_edit`     → `POST {baseUrl}/images/edits` (multipart/form-data;
 *   the source image rides an `image` file field).
 *
 * Both endpoints return base64 PNG (`data[0].b64_json`), which we decode into
 * a Uint8Array. Per ImageProviderAdapter, `generate` NEVER throws on a
 * provider/HTTP error — it returns { status: 'failed', reason } with a SHORT,
 * provider-body-free reason code so the media executor can reconcile the
 * budget hold. Only an internal programming error (which we have none of here)
 * could throw.
 */
export class OpenAIImageProcessor implements ImageProviderAdapter {
  private readonly providerId: string;
  private readonly providerName: string;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    providerMetadata: OpenAICompatibleImageProviderMetadata = {},
  ) {
    this.providerId = providerMetadata.providerId ?? 'openai';
    this.providerName = providerMetadata.providerName ?? 'OpenAI';
    // providerId / providerName are retained for parity with the chat adapter
    // constructor signature; image failure reasons use a fixed OPENAI_IMAGE_*
    // prefix rather than the provider display name so they stay stable and
    // body-free regardless of provider metadata overrides.
    void this.providerId;
    void this.providerName;
  }

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    if (input.operation === 'image_edit' && !input.inputImageBytes) {
      return { status: 'failed', reason: 'IMAGE_EDIT_INPUT_MISSING' };
    }

    const mimeType = outputMimeType(input.outputMimeType);
    const response =
      input.operation === 'image_edit'
        ? await this.postEdit(input)
        : await this.postGenerate(input);

    if (!response.ok) {
      // Drain the body so the socket can be reused, but DO NOT surface it —
      // only the numeric status rides the (fixed-format) failure reason.
      await response.text().catch(() => '');
      return {
        status: 'failed',
        reason: `OPENAI_IMAGE_HTTP_${response.status}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { status: 'failed', reason: 'OPENAI_IMAGE_MALFORMED_RESPONSE' };
    }

    const b64 = firstImageBase64(parsed);
    if (!b64) {
      return { status: 'failed', reason: 'OPENAI_IMAGE_NO_IMAGE_IN_RESPONSE' };
    }

    return {
      status: 'done',
      imageBytes: new Uint8Array(Buffer.from(b64, 'base64')),
      mimeType,
      // gpt-image-2 returns no per-request billing metadata (unlike the video
      // job operations), so we charge a flat 1 quota unit per generated image.
      actualQuotaUnits: 1,
    };
  }

  private postGenerate(input: GenerateImageInput): Promise<Response> {
    const body: Record<string, unknown> = {
      model: input.modelId,
      prompt: input.prompt,
      n: 1,
      ...(input.size ? { size: input.size } : {}),
      ...outputFormatField(input.outputMimeType),
    };
    return fetch(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        // OpenAI supports request-level idempotency via this header, so a
        // retried generate after a transport hiccup cannot double-bill.
        'Idempotency-Key': input.localIdempotencyKey,
      },
      body: JSON.stringify(body),
      signal: input.abortSignal,
    });
  }

  private postEdit(input: GenerateImageInput): Promise<Response> {
    const form = new FormData();
    form.set('model', input.modelId);
    form.set('prompt', input.prompt);
    form.set('n', '1');
    if (input.size) form.set('size', input.size);
    const outputFormat = outputFormatField(input.outputMimeType).output_format;
    if (outputFormat) form.set('output_format', outputFormat);
    const inputMime = input.inputImageMimeType ?? 'image/png';
    // input.inputImageBytes is guaranteed present here — generate() returns
    // IMAGE_EDIT_INPUT_MISSING before reaching the edit path otherwise. Copy
    // into a fresh, non-shared ArrayBuffer so the Blob part satisfies the
    // strict Uint8Array<ArrayBuffer> BlobPart typing.
    const source = input.inputImageBytes as Uint8Array;
    const imageBuffer = new ArrayBuffer(source.byteLength);
    new Uint8Array(imageBuffer).set(source);
    form.set(
      'image',
      new Blob([imageBuffer], { type: inputMime }),
      `image.${imageExtension(inputMime)}`,
    );
    return fetch(`${this.baseUrl}/images/edits`, {
      method: 'POST',
      headers: {
        // No explicit Content-Type: fetch derives the multipart boundary from
        // the FormData body. Setting it manually would break the boundary.
        Authorization: `Bearer ${this.apiKey}`,
        'Idempotency-Key': input.localIdempotencyKey,
      },
      body: form,
      signal: input.abortSignal,
    });
  }
}

function outputMimeType(
  requested: GenerateImageInput['outputMimeType'],
): ImageOutputMimeType {
  // gpt-image-2 supports png / jpeg / webp output; default to PNG.
  return requested ?? 'image/png';
}

function outputFormatField(
  requested: GenerateImageInput['outputMimeType'],
): { output_format?: 'png' | 'jpeg' | 'webp' } {
  switch (requested) {
    case 'image/jpeg':
      return { output_format: 'jpeg' };
    case 'image/webp':
      return { output_format: 'webp' };
    case 'image/png':
      return { output_format: 'png' };
    default:
      return {};
  }
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

function firstImageBase64(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (!first || typeof first !== 'object') return undefined;
  const b64 = (first as { b64_json?: unknown }).b64_json;
  return typeof b64 === 'string' && b64.length > 0 ? b64 : undefined;
}
