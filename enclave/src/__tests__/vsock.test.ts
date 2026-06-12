import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, MSG } from '../vsock';

describe('vsock framing', () => {
  it('encodes a frame with type byte, 4-byte length, and payload', () => {
    const payload = Buffer.from('{"nonce":"abc123"}');
    const frame = encodeFrame(MSG.ATTESTATION_REQUEST, payload);

    expect(frame[0]).toBe(0x01); // type byte
    expect(frame.readUInt32BE(1)).toBe(payload.length); // 4-byte big-endian length
    expect(frame.subarray(5).toString()).toBe('{"nonce":"abc123"}');
    expect(frame.length).toBe(1 + 4 + payload.length);
  });

  it('decodes a frame back to type and payload', () => {
    const payload = Buffer.from('{"status":"ok"}');
    const frame = encodeFrame(MSG.KEY_EXCHANGE_ACK, payload);
    const decoded = decodeFrame(frame);

    expect(decoded.type).toBe(MSG.KEY_EXCHANGE_ACK);
    expect(decoded.payload.toString()).toBe('{"status":"ok"}');
  });

  it('encodes empty payload for HEALTH_PING', () => {
    const frame = encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0));
    expect(frame.length).toBe(5); // 1 type + 4 length (0)
    expect(frame.readUInt32BE(1)).toBe(0);
  });

  it('rejects payload exceeding MAX_VSOCK_PAYLOAD', () => {
    const oversized = Buffer.alloc(512 * 1024 + 1);
    expect(() => encodeFrame(MSG.CHAT_REQUEST, oversized)).toThrow(/exceeds maximum/);
  });

  it('rejects unknown message type', () => {
    const frame = Buffer.from([0xff, 0, 0, 0, 0]);
    expect(() => decodeFrame(frame)).toThrow(/unknown.*type/i);
  });

  it('rejects truncated frame', () => {
    const frame = Buffer.from([0x01, 0, 0]); // too short for header
    expect(() => decodeFrame(frame)).toThrow(/truncated/i);
  });

  it('round-trips all message types', () => {
    for (const [name, type] of Object.entries(MSG)) {
      const payload = Buffer.from(`test-${name}`);
      const frame = encodeFrame(type as number, payload);
      const decoded = decodeFrame(frame);
      expect(decoded.type).toBe(type);
      expect(decoded.payload.toString()).toBe(`test-${name}`);
    }
  });
});
