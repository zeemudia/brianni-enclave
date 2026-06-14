import type {
  GeneratedImage,
  GenerateImageInput,
  ImageOutputMimeType,
  ImageProviderAdapter,
} from '../../media/image-provider';

export interface GoogleCompatibleImageProviderMetadata {
  providerId?: string;
  providerName?: string;
}

type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } };
type GeminiTextPart = { text: string };
type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

/**
 * Synchronous Google image adapter for gemini-2.5-flash-image.
 *
 * Calls the Gemini `generateContent` endpoint
 * (`POST {baseUrl}/v1beta/models/{modelId}:generateContent?key=...`) with a
 * single user turn containing the text prompt and — for `image_edit` — the
 * source image as an `inline_data` part. The returned image rides an
 * `inlineData` part on the first candidate, which we decode to a Uint8Array.
 *
 * Auth matches the media sibling (google-veo.ts): the API key is passed as the
 * `?key=` query param (the same scheme @google/generative-ai uses under the
 * hood in google-v1.ts).
 *
 * Per ImageProviderAdapter, `generate` NEVER throws on a provider/HTTP error —
 * it returns { status: 'failed', reason } with a SHORT, provider-body-free
 * reason code.
 *
 * Note: the Gemini generateContent endpoint has no request-level idempotency
 * header, so `localIdempotencyKey` is NOT forwarded for this provider. The
 * enclave media executor's budget reconcile remains the double-bill guard.
 */
export class GoogleImageProcessor implements ImageProviderAdapter {
  private readonly providerId: string;
  private readonly providerName: string;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    providerMetadata: GoogleCompatibleImageProviderMetadata = {},
  ) {
    this.providerId = providerMetadata.providerId ?? 'google';
    this.providerName = providerMetadata.providerName ?? 'Google';
    // Retained for parity with the chat adapter constructor signature; image
    // failure reasons use a fixed GEMINI_IMAGE_* prefix rather than the
    // provider display name so they stay stable and body-free.
    void this.providerId;
    void this.providerName;
  }

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    if (input.operation === 'image_edit' && !input.inputImageBytes) {
      return { status: 'failed', reason: 'IMAGE_EDIT_INPUT_MISSING' };
    }

    const mimeType = outputMimeType(input.outputMimeType);
    const parts: GeminiPart[] = [{ text: input.prompt }];
    if (input.operation === 'image_edit' && input.inputImageBytes) {
      parts.push({
        inlineData: {
          mimeType: input.inputImageMimeType ?? 'image/png',
          data: Buffer.from(input.inputImageBytes).toString('base64'),
        },
      });
    }

    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(
      input.modelId,
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
      signal: input.abortSignal,
    });

    if (!response.ok) {
      // Drain the body so the socket can be reused, but DO NOT surface it —
      // only the numeric status rides the (fixed-format) failure reason.
      await response.text().catch(() => '');
      return {
        status: 'failed',
        reason: `GEMINI_IMAGE_HTTP_${response.status}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { status: 'failed', reason: 'GEMINI_IMAGE_MALFORMED_RESPONSE' };
    }

    const inline = firstInlineImage(parsed);
    if (!inline) {
      return { status: 'failed', reason: 'GEMINI_IMAGE_NO_IMAGE_IN_RESPONSE' };
    }

    return {
      status: 'done',
      imageBytes: new Uint8Array(Buffer.from(inline.data, 'base64')),
      // Honour the provider-reported mime when it is one we model, else fall
      // back to the requested/default output mime.
      mimeType: normaliseMimeType(inline.mimeType) ?? mimeType,
      // The generateContent endpoint returns no per-request billing metadata,
      // so we charge a flat 1 quota unit per generated image.
      actualQuotaUnits: 1,
    };
  }
}

function outputMimeType(
  requested: GenerateImageInput['outputMimeType'],
): ImageOutputMimeType {
  return requested ?? 'image/png';
}

function normaliseMimeType(value: string): ImageOutputMimeType | undefined {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
      return value;
    default:
      return undefined;
  }
}

function firstInlineImage(
  parsed: unknown,
): { mimeType: string; data: string } | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return undefined;
  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } } | undefined)
      ?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = (part as { inlineData?: unknown } | undefined)?.inlineData;
      if (!inline || typeof inline !== 'object') continue;
      const data = (inline as { data?: unknown }).data;
      const mimeType = (inline as { mimeType?: unknown }).mimeType;
      if (typeof data === 'string' && data.length > 0) {
        return {
          mimeType: typeof mimeType === 'string' ? mimeType : 'image/png',
          data,
        };
      }
    }
  }
  return undefined;
}
