import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

// The module imports @calypso/vsock-native lazily. We mock the module
// map BEFORE the client import is evaluated so lazy import resolves
// to our fake.
vi.mock('@calypso/vsock-native', () => ({
  connect: vi.fn(),
}));

import * as vsockNative from '@calypso/vsock-native';
import { fetchRegistryFromBroker } from '../registry-client.js';

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

describe('fetchRegistryFromBroker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the raw registry string on happy path', async () => {
    const payload = JSON.stringify({ version: 1, providers: [], signature: 'abc' });
    queueResponse(payload);
    await expect(fetchRegistryFromBroker()).resolves.toBe(payload);
  });

  it('throws when vsock connect errors', async () => {
    const sock = new FakeSocket();
    vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as any);
    setImmediate(() => sock.emit('error', new Error('ECONNREFUSED')));
    await expect(fetchRegistryFromBroker()).rejects.toThrow(/connection failed/);
  });

  it('throws on empty payload', async () => {
    queueResponse('');
    await expect(fetchRegistryFromBroker()).rejects.toThrow(/empty/i);
  });

  it('throws on oversized broker response (>256 KB) without buffering it', async () => {
    // Simulate a misbehaving host streaming more than MAX_BLOB_BYTES at
    // enclave boot. The 'data' handler must destroy the socket inline on
    // overflow rather than accumulate into memory until 'end' or the 5 s
    // timeout — a hostile host could otherwise OOM the enclave before the
    // signature check ever runs.
    const sock = new FakeSocket();
    vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as any);
    setImmediate(() => {
      sock.emit('data', Buffer.alloc(300 * 1024, 0x61)); // 300 KB of 'a'
      // Do NOT emit 'end' — the check must fire synchronously on 'data'.
    });
    await expect(fetchRegistryFromBroker()).rejects.toThrow(/oversized payload/);
    expect(sock.destroyed).toBe(true);
  });
});
