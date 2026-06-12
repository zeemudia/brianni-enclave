import { describe, expect, it } from 'vitest';
import { MSG } from '../index';
import {
  UsageReportPayloadSchema,
  encodeUsageReport,
  decodeUsageReport,
  MAX_USAGE_REPORT_BYTES,
  type UsageReportPayload,
} from '../usage';

describe('USAGE_REPORT', () => {
  it('MSG.USAGE_REPORT === 0x0b', () => {
    expect(MSG.USAGE_REPORT).toBe(0x0b);
  });

  it('round-trips a typical payload', () => {
    const payload: UsageReportPayload = {
      requestId: 'req_abc123',
      routeKind: 'chat',
      providerId: 'openai',
      model: 'gpt-4o',
      inputTokens: 1234,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 5678,
      providerUsagePresent: true,
    };

    expect(decodeUsageReport(encodeUsageReport(payload))).toEqual(payload);
  });

  it('round-trips cache-aware provider usage without content fields', () => {
    const payload: UsageReportPayload = {
      requestId: 'req_cost_1',
      routeKind: 'chat',
      providerId: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 10_000,
      cacheCreationInputTokens: 2_000,
      cachedInputTokens: 8_000,
      inputTokensIncludeCachedTokens: false,
      outputTokens: 500,
      providerUsagePresent: true,
    };

    const encoded = encodeUsageReport(payload);

    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_USAGE_REPORT_BYTES);
    expect(decodeUsageReport(encoded)).toEqual(payload);
  });

  it('decodes legacy five-field reports with safe metadata defaults', () => {
    const legacy = encodeLegacyUsageReport({
      requestId: 'req_legacy',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      providerUsagePresent: true,
    });

    expect(decodeUsageReport(legacy)).toEqual({
      requestId: 'req_legacy',
      routeKind: 'chat',
      providerId: null,
      model: 'gpt-4o',
      inputTokens: 100,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 50,
      providerUsagePresent: true,
    });
  });

  it('ignores unknown fields for forward-compatible reports', () => {
    expect(
      UsageReportPayloadSchema.parse({
        requestId: 'req_future',
        routeKind: 'chat',
        providerId: 'openai',
        model: 'gpt-5.5',
        inputTokens: 1,
        outputTokens: 1,
        providerUsagePresent: true,
        schemaVersion: 3,
      }),
    ).toEqual({
      requestId: 'req_future',
      routeKind: 'chat',
      providerId: 'openai',
      model: 'gpt-5.5',
      inputTokens: 1,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 1,
      providerUsagePresent: true,
    });
  });

  it('rejects USAGE_REPORT payload missing providerUsagePresent', () => {
    const oldShape = {
      requestId: 'r',
      routeKind: 'chat',
      providerId: 'openai',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
    } as unknown;

    expect(() => UsageReportPayloadSchema.parse(oldShape)).toThrow();
  });

  it('rejects negative tokens', () => {
    expect(() =>
      UsageReportPayloadSchema.parse({
        requestId: 'r',
        routeKind: 'chat',
        providerId: 'openai',
        model: 'm',
        inputTokens: -1,
        cacheCreationInputTokens: 0,
        cachedInputTokens: 0,
        inputTokensIncludeCachedTokens: true,
        outputTokens: 0,
        providerUsagePresent: true,
      }),
    ).toThrow();
  });

  it('rejects invalid route kinds and negative cache token tiers', () => {
    const validPayload: UsageReportPayload = {
      requestId: 'r',
      routeKind: 'chat',
      providerId: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 1,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokensIncludeCachedTokens: true,
      outputTokens: 1,
      providerUsagePresent: true,
    };

    expect(() =>
      UsageReportPayloadSchema.parse({ ...validPayload, routeKind: 'private_prompt' }),
    ).toThrow();
    expect(() =>
      UsageReportPayloadSchema.parse({ ...validPayload, cacheCreationInputTokens: -1 }),
    ).toThrow();
    expect(() => UsageReportPayloadSchema.parse({ ...validPayload, cachedInputTokens: -1 })).toThrow();
  });

  it('rejects empty requestId', () => {
    expect(() =>
      UsageReportPayloadSchema.parse({
        requestId: '',
        routeKind: 'chat',
        providerId: 'openai',
        model: 'm',
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cachedInputTokens: 0,
        inputTokensIncludeCachedTokens: true,
        outputTokens: 0,
        providerUsagePresent: true,
      }),
    ).toThrow();
  });

  it('rejects requestId > 64 chars', () => {
    expect(() =>
      UsageReportPayloadSchema.parse({
        requestId: 'x'.repeat(65),
        routeKind: 'chat',
        providerId: 'openai',
        model: 'm',
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cachedInputTokens: 0,
        inputTokensIncludeCachedTokens: true,
        outputTokens: 0,
        providerUsagePresent: true,
      }),
    ).toThrow();
  });

  it('rejects payload > MAX_USAGE_REPORT_BYTES on decode', () => {
    const huge = Buffer.alloc(MAX_USAGE_REPORT_BYTES + 1);

    expect(() => decodeUsageReport(huge)).toThrow(/USAGE_REPORT.*too large/);
  });
});

function encodeLegacyUsageReport(payload: {
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  providerUsagePresent: boolean;
}): Buffer {
  const keys = [
    'requestId',
    'model',
    'inputTokens',
    'outputTokens',
    'providerUsagePresent',
  ] as const;
  const parts: Uint8Array[] = [encodeMajorAndValue(5, keys.length)];
  for (const key of keys) {
    parts.push(encodeText(key));
    const value = payload[key];
    if (typeof value === 'string') {
      parts.push(encodeText(value));
    } else if (typeof value === 'number') {
      parts.push(encodeMajorAndValue(0, value));
    } else {
      parts.push(new Uint8Array([value ? 0xf5 : 0xf4]));
    }
  }
  return Buffer.from(concat(parts));
}

function encodeText(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat([encodeMajorAndValue(3, bytes.length), bytes]);
}

function encodeMajorAndValue(major: number, value: number): Uint8Array {
  if (value < 24) return new Uint8Array([(major << 5) | value]);
  if (value <= 0xff) return new Uint8Array([(major << 5) | 24, value]);
  if (value <= 0xffff) {
    return new Uint8Array([(major << 5) | 25, (value >> 8) & 0xff, value & 0xff]);
  }
  return new Uint8Array([
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
