/**
 * Tests for the canonical padded-frame encoder + decoder.
 *
 * The wire format is: [4-byte big-endian length prefix][payload][random
 * padding to canonical frame size]. Request frames pad to one of four
 * buckets (4 / 16 / 64 / 256 KB) — bucket chosen strictly from
 * (4 + payload.length). SSE response chunks pad to the next 1 KB boundary
 * above `(4 + chunk.length)` (always at least 1 byte of padding, so exact
 * multiples of 1 KB promote to the next 1 KB).
 *
 * Source of truth: `docs/superpowers/specs/2026-04-13-phase3-backend-design.md`
 * §3. Both the server middleware and both clients (mobile + web) import
 * from this module — do NOT duplicate the bucket math anywhere else.
 */

import { describe, it, expect } from 'vitest';
import {
  PADDING_BUCKETS,
  MAX_PADDED_PAYLOAD,
  PADDING_HEADER,
  PADDING_HEADER_V1,
  PaddedFrameEncoder,
  PaddedFrameDecoder,
} from '../padding';

// Helpers used in decoder tests. Mirror the plan's `frame()` / `requestFrame()`
// — any change to the canonical size formula here means the encoder's formula
// is wrong, and vice versa. Both the encoder and decoder read these formulas
// from the same source in the implementation module.
function canonicalResponseSize(payloadLen: number): number {
  return (Math.floor((4 + payloadLen) / 1024) + 1) * 1024;
}

function buildResponseFrame(payload: Uint8Array): Uint8Array {
  const total = canonicalResponseSize(payload.length);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  globalThis.crypto.getRandomValues(out.subarray(4 + payload.length));
  return out;
}

function buildRequestFrame(payload: Uint8Array): Uint8Array {
  const total = PADDING_BUCKETS.find((b) => b >= 4 + payload.length);
  if (total === undefined) {
    throw new Error(`payload too big: ${payload.length}`);
  }
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  globalThis.crypto.getRandomValues(out.subarray(4 + payload.length));
  return out;
}

const A = new TextEncoder().encode('data: {"chunk":"a"}\n\n');
const B = new TextEncoder().encode('data: {"chunk":"b"}\n\n');
const LONG = new TextEncoder().encode('data: ' + 'x'.repeat(1500) + '\n\n');

describe('PaddedFrameEncoder — encodeRequest (bucket padding)', () => {
  it('pads a 100-byte payload to the 4 KB bucket and writes the length prefix', () => {
    const payload = new Uint8Array(100).fill(0x61);
    const padded = PaddedFrameEncoder.encodeRequest(payload);
    expect(padded.length).toBe(4096);
    expect(new DataView(padded.buffer, padded.byteOffset).getUint32(0, false)).toBe(100);
  });

  it('roundtrips through PaddedFrameDecoder for several sizes', () => {
    for (const size of [10, 1000, 4092, 4093, 16384, 17000, 65536, 100000, 250000]) {
      const payload = new Uint8Array(size).fill(size & 0xff);
      const padded = PaddedFrameEncoder.encodeRequest(payload);
      const d = new PaddedFrameDecoder({ mode: 'request' });
      const out = d.push(padded);
      d.endOfStream();
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual(payload);
    }
  });

  it('rejects oversize input (payload.length + 4 > 256 KB) with a RangeError', () => {
    // 4 + 262145 > 262144 — truncating ciphertext would break AES-GCM
    // decrypt inside the enclave, so the encoder MUST throw fast.
    expect(() => PaddedFrameEncoder.encodeRequest(new Uint8Array(262145))).toThrow(RangeError);
    expect(() => PaddedFrameEncoder.encodeRequest(new Uint8Array(262145))).toThrow(
      /exceeds maximum/i,
    );
    expect(() => PaddedFrameEncoder.encodeRequest(new Uint8Array(300_000))).toThrow(RangeError);
  });

  it('exact bucket boundary still leaves room for the 4-byte length prefix', () => {
    // 4 + 4092 = 4096 fits in the 4 KB bucket; 4 + 4093 must promote to 16 KB.
    expect(PaddedFrameEncoder.encodeRequest(new Uint8Array(4092)).length).toBe(4096);
    expect(PaddedFrameEncoder.encodeRequest(new Uint8Array(4093)).length).toBe(16384);
  });

  it('fills the padding region with non-zero bytes (entropy sanity check)', () => {
    // Not a cryptographic assertion — the encoder uses crypto.getRandomValues
    // which is CSPRNG-grade. This is a smoke test that SOMETHING is being
    // written into the padding region (not left as the zero-init).
    const padded = PaddedFrameEncoder.encodeRequest(new Uint8Array(8).fill(0xaa));
    const paddingRegion = padded.subarray(4 + 8);
    // Probability of 16+ bytes of randomness being all-zero is negligible.
    const hasNonZero = paddingRegion.some((b) => b !== 0);
    expect(hasNonZero).toBe(true);
  });

  it('accepts MAX_PADDED_PAYLOAD as the largest valid input', () => {
    const payload = new Uint8Array(MAX_PADDED_PAYLOAD);
    const padded = PaddedFrameEncoder.encodeRequest(payload);
    expect(padded.length).toBe(262144);
  });
});

describe('PaddedFrameEncoder — encodeResponseChunk (1 KB alignment)', () => {
  it('pads a 1020-byte chunk to 2 KB (4+1020=1024 → next is 2048)', () => {
    const chunk = new Uint8Array(1020).fill(0x62);
    const padded = PaddedFrameEncoder.encodeResponseChunk(chunk);
    expect(padded.length).toBe(2048);
    expect(new DataView(padded.buffer, padded.byteOffset).getUint32(0, false)).toBe(1020);
  });

  it('pads a small chunk (A) to 1 KB', () => {
    const padded = PaddedFrameEncoder.encodeResponseChunk(A);
    expect(padded.length).toBe(1024);
  });

  it('pads a 1500-byte chunk to 2 KB (LONG)', () => {
    const padded = PaddedFrameEncoder.encodeResponseChunk(LONG);
    expect(padded.length).toBe(2048);
  });

  it('rejects a chunk that would exceed the maximum frame', () => {
    expect(() =>
      PaddedFrameEncoder.encodeResponseChunk(new Uint8Array(MAX_PADDED_PAYLOAD + 1)),
    ).toThrow(RangeError);
  });
});

describe('PaddedFrameDecoder — response framing', () => {
  it('decodes a whole frame in one push', () => {
    const d = new PaddedFrameDecoder({ mode: 'response' });
    const out = d.push(buildResponseFrame(A));
    expect(out).toEqual([A]);
    expect(d.carrySize()).toBe(0);
    d.endOfStream();
  });

  it('handles split prefix across two reads (1 byte + 3 bytes)', () => {
    const f = buildResponseFrame(A);
    const d = new PaddedFrameDecoder({ mode: 'response' });
    expect(d.push(f.subarray(0, 1))).toEqual([]);
    expect(d.push(f.subarray(1))).toEqual([A]);
    expect(d.carrySize()).toBe(0);
  });

  it('handles split payload across three reads', () => {
    const f = buildResponseFrame(A);
    const d = new PaddedFrameDecoder({ mode: 'response' });
    expect(d.push(f.subarray(0, 5))).toEqual([]);
    expect(d.push(f.subarray(5, 10))).toEqual([]);
    expect(d.push(f.subarray(10))).toEqual([A]);
    expect(d.carrySize()).toBe(0);
  });

  it('defers emission until padding is fully consumed (correctness over streaming latency)', () => {
    // This was previously "emits as soon as payload completes". The
    // contract was tightened: emission is deferred until the full
    // padded frame (prefix + payload + padding) has been consumed.
    // Rationale: a consumer that short-circuits on a payload marker
    // (e.g. `data: [DONE]`) and subsequently closes the stream
    // should not see the marker until its enclosing padded frame
    // has been fully read — otherwise endOfStream() in a caller's
    // finally block cannot tell "clean early exit" from "server
    // truncated mid-padding". See
    // apps/{web,mobile}/lib/{chat,streaming}/padded-fetch.ts.
    const f = buildResponseFrame(A);
    const splitPoint = 4 + A.length + 5; // mid-padding
    const d = new PaddedFrameDecoder({ mode: 'response' });
    expect(d.push(f.subarray(0, splitPoint))).toEqual([]); // still draining padding
    expect(d.push(f.subarray(splitPoint))).toEqual([A]); // NOW emits — padding fully read
    expect(d.carrySize()).toBe(0);
    d.endOfStream();
  });

  it('emits two coalesced 1 KB frames from one push', () => {
    const combined = new Uint8Array([...buildResponseFrame(A), ...buildResponseFrame(B)]);
    const d = new PaddedFrameDecoder({ mode: 'response' });
    expect(d.push(combined)).toEqual([A, B]);
    expect(d.carrySize()).toBe(0);
  });

  it('emits three coalesced frames split awkwardly across reads (prime-offset slicer)', () => {
    const combined = new Uint8Array([
      ...buildResponseFrame(A),
      ...buildResponseFrame(B),
      ...buildResponseFrame(LONG),
    ]);
    const d = new PaddedFrameDecoder({ mode: 'response' });
    const out: Uint8Array[] = [];
    for (let i = 0; i < combined.length; i += 137) {
      out.push(...d.push(combined.subarray(i, Math.min(i + 137, combined.length))));
    }
    expect(out).toEqual([A, B, LONG]);
    expect(d.carrySize()).toBe(0);
    d.endOfStream();
  });

  it('rejects a frame whose declared length exceeds the largest bucket (prefix push)', () => {
    const evilPrefix = new Uint8Array(4);
    new DataView(evilPrefix.buffer).setUint32(0, 300_000, false);
    const d = new PaddedFrameDecoder({ mode: 'response' });
    expect(() => d.push(evilPrefix)).toThrow(/frame length exceeds maximum/i);
  });

  it('rejects an oversized prefix buried in trailing bytes (push throws at second prefix)', () => {
    // Canonical first frame, then an oversize second prefix. Decoder must
    // consume the first frame cleanly, then throw when it reads the next
    // prefix and finds an out-of-range payload length.
    const first = buildResponseFrame(A);
    const evilNextPrefix = new Uint8Array(8);
    new DataView(evilNextPrefix.buffer).setUint32(0, 300_000, false);
    const combined = new Uint8Array([...first, ...evilNextPrefix]);
    const d = new PaddedFrameDecoder({ mode: 'response' });
    expect(() => d.push(combined)).toThrow(/frame length exceeds maximum/i);
  });

  it('throws at endOfStream when a second prefix has arrived but the payload is truncated', () => {
    const first = buildResponseFrame(A);
    const partialSecond = new Uint8Array(4 + 30);
    new DataView(partialSecond.buffer).setUint32(0, 50, false);
    partialSecond.set(new TextEncoder().encode('x'.repeat(30)), 4);
    const d = new PaddedFrameDecoder({ mode: 'response' });
    expect(d.push(new Uint8Array([...first, ...partialSecond]))).toEqual([A]);
    expect(() => d.endOfStream()).toThrow(/truncated|incomplete/i);
  });

  it('throws at endOfStream when stream is truncated mid-payload of the first frame', () => {
    const f = buildResponseFrame(A);
    const d = new PaddedFrameDecoder({ mode: 'response' });
    d.push(f.subarray(0, 10)); // prefix + 6 bytes of payload
    expect(() => d.endOfStream()).toThrow(/truncated|incomplete/i);
  });

  it('tolerates empty pushes between chunks', () => {
    const f = buildResponseFrame(A);
    const d = new PaddedFrameDecoder({ mode: 'response' });
    expect(d.push(f.subarray(0, 3))).toEqual([]);
    expect(d.push(new Uint8Array(0))).toEqual([]);
    expect(d.push(f.subarray(3))).toEqual([A]);
  });
});

describe('PaddedFrameDecoder — request framing (bucket mode)', () => {
  it('decodes a 4 KB-bucket request frame', () => {
    const payload = new Uint8Array(100).fill(0x61);
    const frame = buildRequestFrame(payload);
    expect(frame.length).toBe(4096);
    const d = new PaddedFrameDecoder({ mode: 'request' });
    expect(d.push(frame)).toEqual([payload]);
    expect(d.carrySize()).toBe(0);
    d.endOfStream();
  });

  it('decodes at the 16 KB boundary (payload=4093 → 16 KB)', () => {
    const payload = new Uint8Array(4093).fill(0x63);
    const frame = buildRequestFrame(payload);
    expect(frame.length).toBe(16384);
    const d = new PaddedFrameDecoder({ mode: 'request' });
    const out = d.push(frame);
    expect(out).toEqual([payload]);
    d.endOfStream();
  });

  it('rejects a request frame whose declared length is larger than 256 KB (bucket table cap)', () => {
    const evilPrefix = new Uint8Array(4);
    new DataView(evilPrefix.buffer).setUint32(0, 300_000, false);
    const d = new PaddedFrameDecoder({ mode: 'request' });
    expect(() => d.push(evilPrefix)).toThrow(/frame length exceeds maximum/i);
  });
});

describe('PaddedFrameDecoder — zero-arg constructor default', () => {
  it('defaults to response mode (1 KB alignment) when constructed with no options', () => {
    // Covers the constructor default parameter `{ mode: 'response' }`
    // (padding.ts), which every other test bypasses by passing explicit
    // options — leaving the default an UNTESTED path. A response frame is
    // 1 KB-aligned; a request-mode decoder would compute a 4 KB-bucket padding
    // length for this 21-byte payload and never emit (it would still be
    // draining padding). So a clean single-push emit through a no-arg decoder
    // pins that the documented client-side default is 'response'.
    const d = new PaddedFrameDecoder();
    const out = d.push(buildResponseFrame(A));
    expect(out).toEqual([A]);
    expect(d.carrySize()).toBe(0);
    d.endOfStream();
  });
});

describe('PaddedFrameDecoder — carrySize diagnostic', () => {
  it('reports non-zero while waiting for a partial prefix', () => {
    const d = new PaddedFrameDecoder({ mode: 'response' });
    d.push(new Uint8Array([0, 0]));
    expect(d.carrySize()).toBe(2);
  });

  it('reports zero after a full frame (prefix state, no pending bytes)', () => {
    const d = new PaddedFrameDecoder({ mode: 'response' });
    d.push(buildResponseFrame(A));
    expect(d.carrySize()).toBe(0);
  });
});

describe('PaddedFrameDecoder — mutation hardening (boundaries)', () => {
  it('decoder ACCEPTS a frame whose declared length equals MAX_PADDED_PAYLOAD', () => {
    // Kills the prefix guard `payloadLen > MAX` -> `>=`: the exact maximum is
    // a VALID frame and must emit, not throw.
    const payload = new Uint8Array(MAX_PADDED_PAYLOAD);
    payload[0] = 0x7a;
    const d = new PaddedFrameDecoder({ mode: 'request' });
    const out = d.push(buildRequestFrame(payload));
    d.endOfStream();
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(MAX_PADDED_PAYLOAD);
    expect(out[0]![0]).toBe(0x7a);
  });

  it('endOfStream throws when only a partial prefix has been buffered', () => {
    // Kills endOfStream's `kind !== 'prefix' || carry.length > 0` -> `&&`: in
    // prefix state with leftover carry, the OR must still fail closed.
    const d = new PaddedFrameDecoder({ mode: 'response' });
    d.push(new Uint8Array([0, 0])); // 2 of 4 prefix bytes
    expect(() => d.endOfStream()).toThrow(/truncated|incomplete/i);
  });

  it('encodeResponseChunk ACCEPTS a chunk whose canonical frame is exactly the 256 KB ceiling', () => {
    // target === 262144 (the largest bucket) is valid; kills the response
    // ceiling check `target > BUCKETS[last]` -> `>=`. len 261116 -> target
    // (floor(261120/1024)+1)*1024 == 262144.
    const chunk = new Uint8Array(261116);
    const frame = PaddedFrameEncoder.encodeResponseChunk(chunk);
    expect(frame).toHaveLength(262144);
  });

  it('pins the padded-SSE protocol header + version (transport contract)', () => {
    expect(PADDING_HEADER).toBe('X-Calypso-Padding');
    expect(PADDING_HEADER_V1).toBe('v1');
  });

  it('endOfStream throws when only a length-prefix arrived and the payload never did', () => {
    // Kills endOfStream's `this.state.kind !== 'prefix' || carry.length > 0`
    // -> dropping the `kind !== 'prefix'` operand. Here the prefix is fully
    // consumed (carry.length === 0) but the decoder is mid-frame in 'payload'
    // state awaiting a declared 21-byte payload that the stream never sent.
    // With only the `carry.length > 0` half left, the guard would WRONGLY
    // accept this truncation as a clean end of stream. The full fail-closed
    // guard must still throw.
    const prefixOnly = new Uint8Array(4);
    new DataView(prefixOnly.buffer).setUint32(0, 21, false); // declares 21-byte payload
    const d = new PaddedFrameDecoder({ mode: 'response' });
    expect(d.push(prefixOnly)).toEqual([]); // prefix consumed, now mid-payload, carry empty
    expect(d.carrySize()).toBe(0);
    expect(() => d.endOfStream()).toThrow(/truncated|incomplete/i);
  });
});
