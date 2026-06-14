/**
 * Unit tests for the synchronous Google image adapter (gemini-2.5-flash-image),
 * mirroring openai-image-v1.test.ts — request/response MAPPING coverage with a
 * stubbed global fetch against the Gemini generateContent endpoint.
 *
 * Privacy invariant under test: the adapter NEVER throws on a provider/HTTP
 * error and NEVER echoes the provider response body into the failure reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoogleImageProcessor } from '../providers/adapters/google-image-v1';
import type { GenerateImageInput } from '../media/image-provider';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const PROVIDER_BODY_SENTINEL = 'PROVIDER_BODY_SENTINEL_img';

// 1x1 transparent PNG, base64 — a small but valid, non-empty payload.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function generateContentOkResponse(
  mimeType = 'image/png',
  b64 = PNG_B64,
): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: 'here is your image' },
              { inlineData: { mimeType, data: b64 } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function baseInput(
  overrides: Partial<GenerateImageInput> = {},
): GenerateImageInput {
  return {
    operation: 'image_generate',
    modelId: 'gemini-2.5-flash-image',
    prompt: 'a red bicycle on a beach',
    localIdempotencyKey: 'idem-123',
    ...overrides,
  };
}

function requestInit(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): {
  method?: string;
  body?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
} {
  const [, init] = fetchMock.mock.calls[index] as [
    unknown,
    {
      method?: string;
      body?: string;
      signal?: AbortSignal;
      headers?: Record<string, string>;
    }?,
  ];
  return init ?? {};
}

function jsonBody(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): Record<string, unknown> {
  return JSON.parse(String(requestInit(fetchMock, index).body ?? '{}')) as Record<
    string,
    unknown
  >;
}

describe('GoogleImageProcessor — image_generate', () => {
  it('posts to the generateContent endpoint and extracts inlineData bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(generateContentOkResponse());
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new GoogleImageProcessor(
      'https://generativelanguage.googleapis.com',
      'g-key',
    );
    const result = await processor.generate(baseInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=g-key',
    );
    const init = requestInit(fetchMock);
    expect(init.method).toBe('POST');

    const body = jsonBody(fetchMock);
    // Prompt text must ride a text part inside the single user content turn.
    expect(JSON.stringify(body)).toContain('a red bicycle on a beach');
    const contents = body.contents as Array<{ parts: Array<{ text?: string }> }>;
    expect(contents[0].parts.some((p) => p.text === 'a red bicycle on a beach')).toBe(
      true,
    );

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.mimeType).toBe('image/png');
    expect(result.imageBytes.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(result.imageBytes).toString('base64')).toBe(PNG_B64);
    expect(result.actualQuotaUnits).toBe(1);
  });

  it("threads the caller's abort signal into the fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(generateContentOkResponse());
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const controller = new AbortController();
    const processor = new GoogleImageProcessor(
      'https://generativelanguage.googleapis.com',
      'g-key',
    );
    await processor.generate(baseInput({ abortSignal: controller.signal }));

    expect(requestInit(fetchMock).signal).toBe(controller.signal);
  });
});

describe('GoogleImageProcessor — image_edit', () => {
  it('includes the source image as inline_data alongside the prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(generateContentOkResponse());
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new GoogleImageProcessor(
      'https://generativelanguage.googleapis.com',
      'g-key',
    );
    const result = await processor.generate(
      baseInput({
        operation: 'image_edit',
        prompt: 'make the sky purple',
        inputImageBytes: new Uint8Array([1, 2, 3, 4]),
        inputImageMimeType: 'image/png',
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = jsonBody(fetchMock);
    const contents = body.contents as Array<{
      parts: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    }>;
    const parts = contents[0].parts;
    expect(parts.some((p) => p.text === 'make the sky purple')).toBe(true);
    const inline = parts.find((p) => p.inlineData)?.inlineData;
    expect(inline?.mimeType).toBe('image/png');
    expect(inline?.data).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));

    expect(result.status).toBe('done');
  });

  it('returns IMAGE_EDIT_INPUT_MISSING without calling fetch when inputImageBytes is absent', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new GoogleImageProcessor(
      'https://generativelanguage.googleapis.com',
      'g-key',
    );
    const result = await processor.generate(
      baseInput({ operation: 'image_edit', prompt: 'edit me' }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'failed',
      reason: 'IMAGE_EDIT_INPUT_MISSING',
    });
  });
});

describe('GoogleImageProcessor — failure handling (never throws, body-free reasons)', () => {
  it.each([
    { status: 429, reason: 'GEMINI_IMAGE_HTTP_429' },
    { status: 500, reason: 'GEMINI_IMAGE_HTTP_500' },
  ])(
    'maps HTTP $status to a failed status with a provider-body-free reason',
    async ({ status, reason }) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(`provider detail ${PROVIDER_BODY_SENTINEL}`, { status }),
        );
      global.fetch = fetchMock as unknown as typeof global.fetch;

      const processor = new GoogleImageProcessor(
        'https://generativelanguage.googleapis.com',
        'g-key',
      );
      const result = await processor.generate(baseInput());

      expect(result.status).toBe('failed');
      if (result.status !== 'failed') throw new Error('expected failed');
      expect(result.reason).toBe(reason);
      expect(result.reason).not.toContain(PROVIDER_BODY_SENTINEL);
    },
  );

  it('maps a 200 with no inlineData part to a body-free no-image reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: PROVIDER_BODY_SENTINEL }] } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new GoogleImageProcessor(
      'https://generativelanguage.googleapis.com',
      'g-key',
    );
    const result = await processor.generate(baseInput());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toBe('GEMINI_IMAGE_NO_IMAGE_IN_RESPONSE');
    expect(result.reason).not.toContain(PROVIDER_BODY_SENTINEL);
  });

  it('maps malformed (non-JSON) 200 body to a body-free reason', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(`not json ${PROVIDER_BODY_SENTINEL}`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new GoogleImageProcessor(
      'https://generativelanguage.googleapis.com',
      'g-key',
    );
    const result = await processor.generate(baseInput());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toBe('GEMINI_IMAGE_MALFORMED_RESPONSE');
    expect(result.reason).not.toContain(PROVIDER_BODY_SENTINEL);
  });
});
