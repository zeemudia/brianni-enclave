import { MSG, MAX_VSOCK_PAYLOAD } from '@calypso/chat-types';

export { MSG };

const VALID_TYPES: Set<number> = new Set(Object.values(MSG));
const HEADER_SIZE = 5; // 1 byte type + 4 bytes length

export function encodeFrame(type: number, payload: Buffer): Buffer {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Unknown message type: 0x${type.toString(16)}`);
  }
  if (payload.length > MAX_VSOCK_PAYLOAD) {
    throw new Error(
      `Payload (${payload.length} bytes) exceeds maximum (${MAX_VSOCK_PAYLOAD} bytes)`,
    );
  }

  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  frame[0] = type;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

export function decodeFrame(frame: Buffer): { type: number; payload: Buffer } {
  if (frame.length < HEADER_SIZE) {
    throw new Error(`Truncated frame: expected at least ${HEADER_SIZE} bytes, got ${frame.length}`);
  }

  const type = frame[0];
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Unknown message type: 0x${type.toString(16)}`);
  }

  const length = frame.readUInt32BE(1);
  if (frame.length < HEADER_SIZE + length) {
    throw new Error(
      `Truncated frame: header declares ${length} bytes but only ${frame.length - HEADER_SIZE} available`,
    );
  }

  const payload = frame.subarray(HEADER_SIZE, HEADER_SIZE + length);
  return { type, payload };
}
