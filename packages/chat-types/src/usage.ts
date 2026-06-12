import { z } from 'zod';

export const UsageReportRouteKindSchema = z.enum([
  'chat',
  'agent_planner',
  'agent_worker',
  'agent_tool_continue',
  'agent_summary',
  'dream_extract',
  'dream_reconcile',
]);

export const UsageReportPayloadSchema = z.object({
  requestId: z.string().min(1).max(64),
  routeKind: UsageReportRouteKindSchema.default('chat'),
  providerId: z.string().min(1).max(64).nullable().default(null),
  model: z.string().min(1).max(64),
  inputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  inputTokensIncludeCachedTokens: z.boolean().default(true),
  outputTokens: z.number().int().nonnegative(),
  providerUsagePresent: z.boolean(),
});

export type UsageReportRouteKind = z.infer<typeof UsageReportRouteKindSchema>;
export type UsageReportPayload = z.infer<typeof UsageReportPayloadSchema>;

export const MAX_USAGE_REPORT_BYTES = 1024;

const USAGE_REPORT_KEYS = [
  'requestId',
  'routeKind',
  'providerId',
  'model',
  'inputTokens',
  'cacheCreationInputTokens',
  'cachedInputTokens',
  'inputTokensIncludeCachedTokens',
  'outputTokens',
  'providerUsagePresent',
] as const;

type CborValue = string | number | boolean | null | CborMap;

interface CborMap {
  [key: string]: CborValue;
}

export function encodeUsageReport(payload: UsageReportPayload): Buffer {
  const parsed = UsageReportPayloadSchema.parse(payload);
  return Buffer.from(encodeCborMap(parsed));
}

export function decodeUsageReport(bytes: Buffer | Uint8Array): UsageReportPayload {
  if (bytes.byteLength > MAX_USAGE_REPORT_BYTES) {
    throw new Error(
      `USAGE_REPORT frame too large: ${bytes.byteLength} bytes (max ${MAX_USAGE_REPORT_BYTES})`,
    );
  }

  const decoder = new CborDecoder(Buffer.from(bytes));
  const decoded = decoder.read();
  decoder.assertDone();
  return UsageReportPayloadSchema.parse(decoded);
}

function encodeCborMap(payload: UsageReportPayload): Uint8Array {
  const keys = USAGE_REPORT_KEYS.filter((key) => payload[key] !== null);
  const parts: Uint8Array[] = [encodeMajorAndValue(5, keys.length)];
  for (const key of keys) {
    parts.push(encodeText(key));
    const value = payload[key];
    if (typeof value === 'string') {
      parts.push(encodeText(value));
    } else if (typeof value === 'number') {
      parts.push(encodeUnsignedInt(value));
    } else if (typeof value === 'boolean') {
      parts.push(encodeBoolean(value));
    } else {
      parts.push(encodeNull());
    }
  }
  return concat(parts);
}

function encodeText(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat([encodeMajorAndValue(3, bytes.length), bytes]);
}

function encodeUnsignedInt(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('USAGE_REPORT CBOR encoder only accepts unsigned integers');
  }
  return encodeMajorAndValue(0, value);
}

function encodeBoolean(value: boolean): Uint8Array {
  return new Uint8Array([value ? 0xf5 : 0xf4]);
}

function encodeNull(): Uint8Array {
  return new Uint8Array([0xf6]);
}

function encodeMajorAndValue(major: number, value: number): Uint8Array {
  if (value < 24) return new Uint8Array([(major << 5) | value]);
  if (value <= 0xff) return new Uint8Array([(major << 5) | 24, value]);
  if (value <= 0xffff) {
    return new Uint8Array([(major << 5) | 25, (value >> 8) & 0xff, value & 0xff]);
  }
  if (value <= 0xffffffff) {
    return new Uint8Array([
      (major << 5) | 26,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ]);
  }
  throw new Error('USAGE_REPORT CBOR integer too large');
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

class CborDecoder {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(): CborValue {
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;

    if (major === 0) return this.readArgument(additional);
    if (major === 3) return this.readText(additional);
    if (major === 5) return this.readMap(additional);
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
    }

    throw new Error(`USAGE_REPORT unsupported CBOR major=${major} additional=${additional}`);
  }

  assertDone(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error('USAGE_REPORT CBOR payload has trailing bytes');
    }
  }

  private readMap(additional: number): Record<string, CborValue> {
    const length = this.readArgument(additional);
    const out: Record<string, CborValue> = {};
    for (let i = 0; i < length; i += 1) {
      const key = this.read();
      if (typeof key !== 'string') {
        throw new Error('USAGE_REPORT CBOR map key must be a string');
      }
      out[key] = this.read();
    }
    return out;
  }

  private readText(additional: number): string {
    const length = this.readArgument(additional);
    const end = this.offset + length;
    if (end > this.bytes.length) {
      throw new Error('USAGE_REPORT CBOR text length exceeds payload');
    }
    const value = new TextDecoder().decode(this.bytes.slice(this.offset, end));
    this.offset = end;
    return value;
  }

  private readArgument(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 24) return this.readByte();
    if (additional === 25) return (this.readByte() << 8) | this.readByte();
    if (additional === 26) {
      return (
        this.readByte() * 0x1000000 +
        (this.readByte() << 16) +
        (this.readByte() << 8) +
        this.readByte()
      );
    }
    throw new Error(`USAGE_REPORT unsupported CBOR additional info ${additional}`);
  }

  private readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error('USAGE_REPORT truncated CBOR payload');
    }
    const byte = this.bytes[this.offset];
    this.offset += 1;
    return byte;
  }
}
