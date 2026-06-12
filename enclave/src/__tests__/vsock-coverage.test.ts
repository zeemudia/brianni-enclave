/**
 * Additional coverage for vsock.ts.
 * Targets uncovered branches:
 * - encodeFrame with invalid type (line 10)
 * - decodeFrame with header declaring more bytes than available (line 37)
 */
import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, MSG } from '../vsock';

describe('vsock — coverage gaps', () => {
  it('encodeFrame rejects unknown message type', () => {
    expect(() => encodeFrame(0xff, Buffer.from('test'))).toThrow(/unknown.*type/i);
  });

  it('decodeFrame rejects frame where header declares more bytes than available', () => {
    // Create a valid header that says payload is 100 bytes, but only provide 5
    const frame = Buffer.allocUnsafe(10);
    frame[0] = MSG.HEALTH_PING; // valid type
    frame.writeUInt32BE(100, 1); // declares 100 bytes payload
    // Only 5 bytes of actual payload data

    expect(() => decodeFrame(frame)).toThrow(/truncated/i);
  });
});
