import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

// The module imports @calypso/vsock-native lazily. We mock the module
// map BEFORE the client import is evaluated so lazy import resolves
// to our fake.
vi.mock('@calypso/vsock-native', () => ({
  connect: vi.fn(),
}));

import * as vsockNative from '@calypso/vsock-native';
import { fetchKeysBlobFromBroker, KEYS_BROKER_UNREACHABLE, KEYS_BROKER_MALFORMED } from '../keys-client.js';

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit('error', err);
  }
}

function queueResponse(bytes: Buffer | string) {
  const sock = new FakeSocket();
  vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as any);
  setImmediate(() => {
    sock.emit('data', Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    sock.emit('end');
  });
  return sock;
}

describe('fetchKeysBlobFromBroker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Ensure fake timers never leak between tests
    vi.useRealTimers();
  });

  it('resolves the parsed blob on happy path', async () => {
    const payload = {
      kmsKeyArn: 'arn:aws:kms:eu-west-2:123456789012:key/abc',
      providers: { openai: 'AQIC...', anthropic: 'AQIC...' },
    };
    queueResponse(JSON.stringify(payload));
    const blob = await fetchKeysBlobFromBroker();
    expect(blob).toEqual(payload);
  });

  it('throws KEYS_BROKER_UNREACHABLE when vsock connect errors', async () => {
    const sock = new FakeSocket();
    vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as any);
    setImmediate(() => sock.emit('error', new Error('ECONNREFUSED')));
    await expect(fetchKeysBlobFromBroker()).rejects.toThrow(KEYS_BROKER_UNREACHABLE);
  });

  it('throws KEYS_BROKER_UNREACHABLE when vsock connect throws synchronously', async () => {
    vi.mocked(vsockNative.connect).mockImplementationOnce(() => {
      throw new Error('Connection reset by peer');
    });

    await expect(fetchKeysBlobFromBroker()).rejects.toThrow(
      `${KEYS_BROKER_UNREACHABLE}: Connection reset by peer`,
    );
  });

  it('throws with timeout message after 5s', async () => {
    vi.useFakeTimers();
    const sock = new FakeSocket();
    vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as any);
    const promise = fetchKeysBlobFromBroker();
    // Attach a noop .catch immediately so the rejection is never "unhandled"
    // before our assertion runs (vitest fake-timer + async-rejection ordering).
    promise.catch(() => undefined);
    // Flush microtasks (the lazy import + connect) so setTimeout is registered
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(promise).rejects.toThrow(/timed out/i);
  }, 10_000);

  it('throws on empty payload', async () => {
    queueResponse('');
    await expect(fetchKeysBlobFromBroker()).rejects.toThrow(/empty/i);
  });

  it('throws KEYS_BROKER_MALFORMED on non-JSON', async () => {
    queueResponse('not json at all');
    await expect(fetchKeysBlobFromBroker()).rejects.toThrow(KEYS_BROKER_MALFORMED);
  });

  it('throws KEYS_BROKER_MALFORMED on JSON missing providers key', async () => {
    queueResponse(JSON.stringify({ kmsKeyArn: 'arn:abc' }));
    await expect(fetchKeysBlobFromBroker()).rejects.toThrow(KEYS_BROKER_MALFORMED);
  });

  it('throws on empty providers object', async () => {
    queueResponse(JSON.stringify({ kmsKeyArn: 'arn:abc', providers: {} }));
    await expect(fetchKeysBlobFromBroker()).rejects.toThrow(/at least one provider/i);
  });

  it('throws when a provider value is not a string', async () => {
    queueResponse(JSON.stringify({ kmsKeyArn: 'arn:abc', providers: { openai: 42 } }));
    await expect(fetchKeysBlobFromBroker()).rejects.toThrow(KEYS_BROKER_MALFORMED);
  });

  it('throws KEYS_BROKER_MALFORMED on oversized broker response (>64 KB)', async () => {
    // Simulate a misbehaving host streaming more than MAX_BLOB_BYTES. The
    // 'data' handler should destroy the socket inline on overflow rather
    // than accumulate into memory until 'end' or the 5 s timeout.
    // Chunks are ~100 KB, well above the 64 KB cap.
    const sock = new FakeSocket();
    vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as any);
    setImmediate(() => {
      sock.emit('data', Buffer.alloc(100 * 1024, 0x61)); // 100 KB of 'a'
      // Do NOT emit 'end' — the check must fire synchronously on 'data'.
    });
    await expect(fetchKeysBlobFromBroker()).rejects.toThrow(/oversized payload/);
    expect(sock.destroyed).toBe(true);
  });
});
