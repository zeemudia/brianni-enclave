/**
 * Canonical padded-frame wire format.
 *
 * Shared source of truth for the server middleware, mobile transport, and
 * web transport. The bucket math and 1 KB alignment live here and ONLY here —
 * duplicating the formulas downstream would let one side drift and the other
 * would silently corrupt frames.
 *
 * Wire format:
 *   [4-byte big-endian length prefix N][N bytes of payload][random padding]
 *
 * Request frames ("mode: 'request'") pad to one of four buckets:
 *   4 KB / 16 KB / 64 KB / 256 KB. Oversize payloads throw a RangeError —
 *   truncating ciphertext would break AES-GCM downstream.
 *
 * Response chunk frames ("mode: 'response'") pad to the next 1 KB boundary
 * strictly above `(4 + payload.length)`. Exact multiples of 1 KB promote to
 * the next 1 KB (always at least one byte of padding — the `+1` in the
 * formula guarantees this).
 *
 * Source: docs/superpowers/specs/2026-04-13-phase3-backend-design.md §3.
 */

export const PADDING_BUCKETS = [4096, 16384, 65536, 262144] as const;

const PREFIX_SIZE = 4;
const SSE_CHUNK_ALIGNMENT = 1024;

/** Largest payload the wire format can carry (256 KB - 4-byte prefix). */
export const MAX_PADDED_PAYLOAD = 262144 - PREFIX_SIZE;

/** Header that declares the padded-SSE protocol version in both directions. */
export const PADDING_HEADER = 'X-Calypso-Padding';
export const PADDING_HEADER_V1 = 'v1';

export type PaddedFrameMode = 'request' | 'response';

export interface PaddedFrameDecoderOptions {
  mode: PaddedFrameMode;
}

function canonicalFrameSize(payloadLen: number, mode: PaddedFrameMode): number {
  const totalBeforePad = PREFIX_SIZE + payloadLen;
  if (mode === 'request') {
    const bucket = PADDING_BUCKETS.find((b) => b >= totalBeforePad);
    if (bucket === undefined) {
      // 4 + MAX_PADDED_PAYLOAD == 262144 (the largest bucket). Anything
      // larger is a protocol violation — truncation would corrupt ciphertext.
      throw new RangeError(
        `padded payload exceeds maximum bucket (${MAX_PADDED_PAYLOAD} bytes)`,
      );
    }
    return bucket;
  }
  // Response mode: next 1 KB strictly above (4 + payloadLen).
  const target = (Math.floor(totalBeforePad / SSE_CHUNK_ALIGNMENT) + 1) * SSE_CHUNK_ALIGNMENT;
  if (target > PADDING_BUCKETS[PADDING_BUCKETS.length - 1]) {
    throw new RangeError(
      `padded response chunk exceeds maximum frame (${MAX_PADDED_PAYLOAD} bytes)`,
    );
  }
  return target;
}

function wrapFrame(payload: Uint8Array, targetSize: number): Uint8Array {
  const out = new Uint8Array(targetSize);
  // Prefix is big-endian (network byte order) so peer languages parse it
  // without endianness rules leaking into the protocol.
  new DataView(out.buffer, out.byteOffset).setUint32(0, payload.length, false);
  out.set(payload, PREFIX_SIZE);
  // Random padding is not cryptographically meaningful for privacy on its
  // own (TLS already encrypts the wire). It is CSPRNG to avoid any pattern
  // that a future TLS-compression attack or layered adversary could exploit.
  // Web Crypto's getRandomValues has a 65 536-byte per-call cap, so we
  // iterate in chunks — a 256 KB bucket needs up to 4 fills.
  const paddingRegion = out.subarray(PREFIX_SIZE + payload.length);
  const MAX_CHUNK = 65536;
  for (let offset = 0; offset < paddingRegion.length; offset += MAX_CHUNK) {
    globalThis.crypto.getRandomValues(
      paddingRegion.subarray(offset, Math.min(offset + MAX_CHUNK, paddingRegion.length)),
    );
  }
  return out;
}

export class PaddedFrameEncoder {
  /**
   * Wrap a ciphertext payload in a request-side padded frame (4 / 16 / 64 /
   * 256 KB bucket). Used by both transports (mobile + web) before POSTing
   * to `/v1/chat`, and by the server's `padToNextBucket` helper so the
   * bucket table only lives in one place.
   */
  static encodeRequest(payload: Uint8Array): Uint8Array {
    const target = canonicalFrameSize(payload.length, 'request');
    return wrapFrame(payload, target);
  }

  /**
   * Wrap an SSE chunk in a response-side padded frame (next 1 KB boundary).
   * Used by the server's `writePaddedSSEChunk` helper — clients unwrap with
   * `PaddedFrameDecoder({ mode: 'response' })`.
   */
  static encodeResponseChunk(chunk: Uint8Array): Uint8Array {
    const target = canonicalFrameSize(chunk.length, 'response');
    return wrapFrame(chunk, target);
  }
}

type DecoderState =
  | { kind: 'prefix' }
  | { kind: 'payload'; payloadLen: number; paddingLen: number }
  | { kind: 'padding'; paddingLen: number; pendingPayload: Uint8Array };

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Incremental decoder for padded frames. HTTP/fetch does not preserve server
 * write boundaries — a 4-byte prefix can be split across two reads, a payload
 * can span many reads, multiple frames can coalesce into one read. This
 * decoder owns a carry buffer and emits whole payloads as they complete.
 *
 * Modes:
 *   - 'request': bucket-aligned (4 / 16 / 64 / 256 KB). Server-side.
 *   - 'response': next-1-KB-aligned. Client-side.
 *
 * Call `endOfStream()` when the response body finishes; it throws if the
 * stream was truncated mid-frame or non-canonical bytes remain.
 */
export class PaddedFrameDecoder {
  private readonly mode: PaddedFrameMode;
  private carry: Uint8Array = new Uint8Array(0);
  private state: DecoderState = { kind: 'prefix' };

  constructor(options: PaddedFrameDecoderOptions = { mode: 'response' }) {
    this.mode = options.mode;
  }

  push(bytes: Uint8Array): Uint8Array[] {
    if (bytes.length > 0) {
      this.carry = concatBytes(this.carry, bytes);
    }
    const out: Uint8Array[] = [];
    while (true) {
      if (this.state.kind === 'prefix') {
        if (this.carry.length < PREFIX_SIZE) break;
        const payloadLen = new DataView(this.carry.buffer, this.carry.byteOffset).getUint32(
          0,
          false,
        );
        // Validate BEFORE committing to the frame — a garbage prefix must
        // surface as a push-throw so upstream maps it to HTTP 400 without
        // ever reaching the enclave.
        if (payloadLen > MAX_PADDED_PAYLOAD) {
          throw new RangeError(
            `padded frame length exceeds maximum (${MAX_PADDED_PAYLOAD} bytes), got ${payloadLen}`,
          );
        }
        const target = canonicalFrameSize(payloadLen, this.mode);
        this.carry = this.carry.slice(PREFIX_SIZE);
        this.state = {
          kind: 'payload',
          payloadLen,
          paddingLen: target - PREFIX_SIZE - payloadLen,
        };
      }
      if (this.state.kind === 'payload') {
        if (this.carry.length < this.state.payloadLen) break;
        const payload = this.carry.slice(0, this.state.payloadLen);
        this.carry = this.carry.slice(this.state.payloadLen);
        // Stash the payload and move to padding state — emission is
        // DEFERRED until the full padding region has been consumed.
        // This is a correctness requirement: callers that short-
        // circuit on a payload marker (e.g. `data: [DONE]`) would
        // otherwise skip reading the trailing padding bytes, and an
        // end-of-stream check from a `finally` block couldn't tell
        // "consumer returned early on a complete frame whose padding
        // hasn't been read" from "server truncated mid-padding". By
        // gating emission on padding completion, a payload is only
        // yielded once its enclosing padded frame has been fully
        // consumed, so consumer short-circuits post-emission are
        // always clean.
        this.state = {
          kind: 'padding',
          paddingLen: this.state.paddingLen,
          pendingPayload: payload,
        };
      }
      if (this.state.kind === 'padding') {
        const consume = Math.min(this.state.paddingLen, this.carry.length);
        if (consume > 0) {
          this.carry = this.carry.slice(consume);
        }
        const remaining = this.state.paddingLen - consume;
        if (remaining === 0) {
          // Full frame (prefix + payload + padding) consumed — emit
          // the stashed payload now and reset to prefix state.
          out.push(this.state.pendingPayload);
          this.state = { kind: 'prefix' };
          // Loop re-enters to try to consume a next frame from the same push.
        } else {
          this.state = {
            kind: 'padding',
            paddingLen: remaining,
            pendingPayload: this.state.pendingPayload,
          };
          break;
        }
      }
    }
    return out;
  }

  endOfStream(): void {
    if (this.state.kind !== 'prefix' || this.carry.length > 0) {
      throw new Error('padded-frame stream truncated — incomplete frame at end of stream');
    }
  }

  /**
   * Test / diagnostic only. Returns the number of raw bytes still buffered
   * in the decoder (prefix bytes not yet assembled + any leftover
   * between-frames bytes). Does NOT include frame state (mid-payload or
   * mid-padding), so a test wanting to verify "frame fully emitted + all
   * padding consumed" should pair `carrySize() === 0` with `endOfStream()`
   * succeeding.
   */
  carrySize(): number {
    return this.carry.length;
  }
}
