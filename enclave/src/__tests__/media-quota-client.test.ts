import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

vi.mock('@calypso/vsock-native', () => ({
  connect: vi.fn(),
}));

import * as vsockNative from '@calypso/vsock-native';
import {
  reserveMediaBudget,
  reconcileMediaBudget,
} from '../media-quota-client.js';

class FakeSocket extends EventEmitter {
  destroyed = false;
  written: Buffer[] = [];
  write(b: Buffer | string) {
    this.written.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
    return true;
  }
  end(b?: Buffer | string) {
    if (b) this.write(b);
  }
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit('error', err);
  }
}

/** Connect → on the enclave's write, reply with `responseBytes` then EOF. */
function queueRpc(responseBytes: Buffer | string) {
  const sock = new FakeSocket();
  vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as never);
  // Reply once the client has written its request.
  const origWrite = sock.write.bind(sock);
  sock.write = (b: Buffer | string) => {
    const r = origWrite(b);
    setImmediate(() => {
      sock.emit(
        'data',
        Buffer.isBuffer(responseBytes) ? responseBytes : Buffer.from(responseBytes),
      );
      sock.emit('end');
    });
    return r;
  };
  return sock;
}

describe('reserveMediaBudget', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('sends a reserve request and returns the broker holdId', async () => {
    const sock = queueRpc(JSON.stringify({ ok: true, holdId: 'hold_42' }));
    const result = await reserveMediaBudget({
      op: 'reserve',
      userId: 'user_1',
      planId: 'PRO',
      mediaJobId: 'mj_1',
      quotaUnits: 4,
      providerId: 'openai',
      modelId: 'gpt-image-2',
      routeKind: 'image_generate',
    });
    expect(result).toEqual({ ok: true, holdId: 'hold_42' });
    // The request the enclave wrote must be the canonical encoded reserve.
    const sent = JSON.parse(Buffer.concat(sock.written).toString('utf8').trim());
    expect(sent.op).toBe('reserve');
    expect(sent.userId).toBe('user_1');
    expect(sent.quotaUnits).toBe(4);
  });

  it('returns the broker failure reason verbatim (over-quota)', async () => {
    queueRpc(JSON.stringify({ ok: false, reason: 'USER_BUDGET_EXCEEDED' }));
    const result = await reserveMediaBudget({
      op: 'reserve',
      userId: 'user_1',
      planId: 'PRO',
      mediaJobId: 'mj_1',
      quotaUnits: 4,
      providerId: 'openai',
      modelId: 'gpt-image-2',
      routeKind: 'image_generate',
    });
    expect(result).toEqual({ ok: false, reason: 'USER_BUDGET_EXCEEDED' });
  });

  it('FAILS CLOSED when the broker is unreachable (no unmetered generation)', async () => {
    const sock = new FakeSocket();
    vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as never);
    setImmediate(() => sock.emit('error', new Error('ECONNREFUSED')));
    const result = await reserveMediaBudget({
      op: 'reserve',
      userId: 'user_1',
      planId: 'PRO',
      mediaJobId: 'mj_1',
      quotaUnits: 4,
      providerId: 'openai',
      modelId: 'gpt-image-2',
      routeKind: 'image_generate',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/UNREACHABLE/);
  });
});

describe('reconcileMediaBudget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends a reconcile request and returns ok', async () => {
    const sock = queueRpc(JSON.stringify({ ok: true }));
    const result = await reconcileMediaBudget({
      op: 'reconcile',
      userId: 'user_1',
      holdId: 'hold_42',
      status: 'debited',
      actualQuotaUnits: 4,
    });
    expect(result).toEqual({ ok: true });
    const sent = JSON.parse(Buffer.concat(sock.written).toString('utf8').trim());
    expect(sent.op).toBe('reconcile');
    expect(sent.status).toBe('debited');
    expect(sent.holdId).toBe('hold_42');
  });

  it('returns ok:false with reason when the broker is unreachable', async () => {
    const sock = new FakeSocket();
    vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as never);
    setImmediate(() => sock.emit('error', new Error('ECONNREFUSED')));
    const result = await reconcileMediaBudget({
      op: 'reconcile',
      userId: 'user_1',
      holdId: 'hold_42',
      status: 'released',
    });
    expect(result.ok).toBe(false);
  });
});
