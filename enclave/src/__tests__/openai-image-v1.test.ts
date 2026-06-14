/**
 * Unit tests for the synchronous OpenAI image adapter (gpt-image-2),
 * mirroring openai-v1.test.ts — request/response MAPPING coverage with a
 * stubbed global fetch.
 *
 * Privacy invariant under test: the adapter NEVER throws on a provider/HTTP
 * error (a throw would escape the media generator and collapse the whole
 * turn) and NEVER echoes the provider response body into the failure reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIImageProcessor } from '../providers/adapters/openai-image-v1';
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

function generationOkResponse(b64 = PNG_B64): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function baseInput(
  overrides: Partial<GenerateImageInput> = {},
): GenerateImageInput {
  return {
    operation: 'image_generate',
    modelId: 'gpt-image-2',
    prompt: 'a red bicycle on a beach',
    size: '1024x1024',
    localIdempotencyKey: 'idem-123',
    ...overrides,
  };
}

function requestInit(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
} {
  const [, init] = fetchMock.mock.calls[index] as [
    unknown,
    {
      method?: string;
      body?: unknown;
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

describe('OpenAIImageProcessor — image_generate', () => {
  it('posts to /images/generations and returns decoded PNG bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(generationOkResponse());
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIImageProcessor(
      'https://api.openai.com/v1',
      'sk-test',
    );
    const result = await processor.generate(baseInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/images/generations',
    );
    const init = requestInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBe('Bearer sk-test');
    expect(init.headers?.['Idempotency-Key']).toBe('idem-123');

    const body = jsonBody(fetchMock);
    expect(body.model).toBe('gpt-image-2');
    expect(body.prompt).toBe('a red bicycle on a beach');
    expect(body.size).toBe('1024x1024');

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.mimeType).toBe('image/png');
    expect(result.imageBytes.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(result.imageBytes).toString('base64')).toBe(PNG_B64);
    expect(result.actualQuotaUnits).toBe(1);
  });

  it("threads the caller's abort signal into the fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(generationOkResponse());
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const controller = new AbortController();
    const processor = new OpenAIImageProcessor(
      'https://api.openai.com/v1',
      'sk-test',
    );
    await processor.generate(baseInput({ abortSignal: controller.signal }));

    expect(requestInit(fetchMock).signal).toBe(controller.signal);
  });
});

describe('OpenAIImageProcessor — image_edit', () => {
  it('posts multipart to /images/edits with the source image and prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(generationOkResponse());
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIImageProcessor(
      'https://api.openai.com/v1',
      'sk-test',
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
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/images/edits',
    );
    const init = requestInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBe('Bearer sk-test');
    // Multipart form-data must NOT set an explicit JSON content-type; fetch
    // derives the multipart boundary from the FormData body itself.
    expect(init.headers?.['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);

    const form = init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2');
    expect(form.get('prompt')).toBe('make the sky purple');
    expect(form.get('image')).toBeInstanceOf(Blob);

    expect(result.status).toBe('done');
  });

  it('returns IMAGE_EDIT_INPUT_MISSING without calling fetch when inputImageBytes is absent', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIImageProcessor(
      'https://api.openai.com/v1',
      'sk-test',
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

describe('OpenAIImageProcessor — failure handling (never throws, body-free reasons)', () => {
  it.each([
    { status: 429, reason: 'OPENAI_IMAGE_HTTP_429' },
    { status: 500, reason: 'OPENAI_IMAGE_HTTP_500' },
  ])(
    'maps HTTP $status to a failed status with a provider-body-free reason',
    async ({ status, reason }) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(`provider detail ${PROVIDER_BODY_SENTINEL}`, { status }),
        );
      global.fetch = fetchMock as unknown as typeof global.fetch;

      const processor = new OpenAIImageProcessor(
        'https://api.openai.com/v1',
        'sk-test',
      );
      const result = await processor.generate(baseInput());

      expect(result.status).toBe('failed');
      if (result.status !== 'failed') throw new Error('expected failed');
      expect(result.reason).toBe(reason);
      expect(result.reason).not.toContain(PROVIDER_BODY_SENTINEL);
    },
  );

  it('maps a 200 with no image data to a body-free no-image reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], note: PROVIDER_BODY_SENTINEL }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const processor = new OpenAIImageProcessor(
      'https://api.openai.com/v1',
      'sk-test',
    );
    const result = await processor.generate(baseInput());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toBe('OPENAI_IMAGE_NO_IMAGE_IN_RESPONSE');
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

    const processor = new OpenAIImageProcessor(
      'https://api.openai.com/v1',
      'sk-test',
    );
    const result = await processor.generate(baseInput());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.reason).toBe('OPENAI_IMAGE_MALFORMED_RESPONSE');
    expect(result.reason).not.toContain(PROVIDER_BODY_SENTINEL);
  });
});
