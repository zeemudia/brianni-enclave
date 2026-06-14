import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

vi.mock('@calypso/vsock-native', () => ({
  connect: vi.fn(),
}));

import * as vsockNative from '@calypso/vsock-native';
import {
  createVideoCheckpointClient,
  createReconcilerBudgetClient,
  createReconcilerAlertSink,
} from '../video-checkpoint-store.js';

class FakeSocket extends EventEmitter {
  destroyed = false;
  written: Buffer[] = [];
  write(b: Buffer | string) {
    this.written.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
    return true;
  }
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit('error', err);
  }
}

/** Reply with `responseBytes` then EOF once the client writes its request. */
function queueRpc(responseBytes: Buffer | string) {
  const sock = new FakeSocket();
  vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as never);
  const origWrite = sock.write.bind(sock);
  sock.write = (b: Buffer | string) => {
    const r = origWrite(b);
    setImmediate(() => {
      sock.emit('data', Buffer.isBuffer(responseBytes) ? responseBytes : Buffer.from(responseBytes));
      sock.emit('end');
    });
    return r;
  };
  return sock;
}

function queueUnreachable() {
  const sock = new FakeSocket();
  vi.mocked(vsockNative.connect).mockReturnValueOnce(sock as never);
  setImmediate(() => sock.emit('error', new Error('ECONNREFUSED')));
  return sock;
}

function lastSent(sock: FakeSocket): Record<string, unknown> {
  return JSON.parse(Buffer.concat(sock.written).toString('utf8').trim());
}

describe('createVideoCheckpointClient — user-scoped ops', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('load returns the decoded pending_start checkpoint', async () => {
    queueRpc(
      JSON.stringify({
        ok: true,
        checkpoint: {
          state: 'pending_start',
          providerId: 'google',
          modelId: 'veo-3.1-generate-preview',
          localIdempotencyKey: 'idem_1',
          provenanceSnapshotHash: 'a'.repeat(64),
        },
      }),
    );
    const client = createVideoCheckpointClient({ userId: 'u1' });
    const result = await client.load({ mediaJobId: 'mj_1' });
    expect(result).toEqual({
      state: 'pending_start',
      providerId: 'google',
      modelId: 'veo-3.1-generate-preview',
      localIdempotencyKey: 'idem_1',
      provenanceSnapshotHash: 'a'.repeat(64),
    });
  });

  it('load returns null when there is no resumable checkpoint', async () => {
    queueRpc(JSON.stringify({ ok: true, checkpoint: null }));
    const client = createVideoCheckpointClient({ userId: 'u1' });
    expect(await client.load({ mediaJobId: 'mj_1' })).toBeNull();
  });

  it('load FAILS CLOSED (throws) on a broker failure', async () => {
    queueRpc(JSON.stringify({ ok: false, reason: 'X' }));
    const client = createVideoCheckpointClient({ userId: 'u1' });
    await expect(client.load({ mediaJobId: 'mj_1' })).rejects.toThrow();
  });

  it('load FAILS CLOSED (throws) when the broker is unreachable', async () => {
    queueUnreachable();
    const client = createVideoCheckpointClient({ userId: 'u1' });
    await expect(client.load({ mediaJobId: 'mj_1' })).rejects.toThrow(/UNREACHABLE/);
  });

  it('savePendingStart sends the userId + op and resolves on ok', async () => {
    const sock = queueRpc(JSON.stringify({ ok: true }));
    const client = createVideoCheckpointClient({ userId: 'u1' });
    await client.savePendingStart({
      mediaJobId: 'mj_1',
      localIdempotencyKey: 'idem_1',
      providerId: 'google',
      modelId: 'veo-3.1-generate-preview',
      provenanceSnapshotHash: 'a'.repeat(64),
    });
    const sent = lastSent(sock);
    expect(sent.op).toBe('save_pending_start');
    expect(sent.userId).toBe('u1');
    expect(sent.mediaJobId).toBe('mj_1');
  });

  it('savePendingStart FAILS CLOSED (throws) on a broker failure', async () => {
    queueRpc(JSON.stringify({ ok: false, reason: 'WRITE_FAILED' }));
    const client = createVideoCheckpointClient({ userId: 'u1' });
    await expect(
      client.savePendingStart({
        mediaJobId: 'mj_1',
        localIdempotencyKey: 'idem_1',
        providerId: 'google',
        modelId: 'veo-3.1-generate-preview',
        provenanceSnapshotHash: 'a'.repeat(64),
      }),
    ).rejects.toThrow();
  });

  it('saveProviderJob sends provider_started fields', async () => {
    const sock = queueRpc(JSON.stringify({ ok: true }));
    const client = createVideoCheckpointClient({ userId: 'u1' });
    await client.saveProviderJob({
      mediaJobId: 'mj_1',
      providerId: 'google',
      modelId: 'veo-3.1-generate-preview',
      providerJobId: 'op_1',
      provenanceSnapshotHash: 'b'.repeat(64),
    });
    const sent = lastSent(sock);
    expect(sent.op).toBe('save_provider_job');
    expect(sent.providerJobId).toBe('op_1');
  });

  it('markBillingPending sends observedAt as an ISO datetime', async () => {
    const sock = queueRpc(JSON.stringify({ ok: true }));
    const client = createVideoCheckpointClient({ userId: 'u1' });
    await client.markBillingPending({
      mediaJobId: 'mj_1',
      providerJobId: 'op_1',
      observedAt: '2026-06-13T10:00:00.000Z',
    });
    const sent = lastSent(sock);
    expect(sent.op).toBe('mark_billing_pending');
    expect(sent.observedAt).toBe('2026-06-13T10:00:00.000Z');
  });

  it('user-scoped ops fail closed when no userId is bound', async () => {
    const client = createVideoCheckpointClient({});
    await expect(client.load({ mediaJobId: 'mj_1' })).rejects.toThrow();
  });
});

describe('createVideoCheckpointClient — reconciler (global) ops', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listCancelledPending returns the decoded jobs', async () => {
    queueRpc(
      JSON.stringify({
        ok: true,
        jobs: [
          { mediaJobId: 'mj_1', providerId: 'google', providerJobId: 'op_1', holdId: 'hold_1' },
        ],
      }),
    );
    const client = createVideoCheckpointClient({});
    const jobs = await client.listCancelledPending({ limit: 50 });
    expect(jobs).toEqual([
      { mediaJobId: 'mj_1', providerId: 'google', providerJobId: 'op_1', holdId: 'hold_1' },
    ]);
  });

  it('listBillingPending returns jobs with billing bookkeeping (no userId in request)', async () => {
    const sock = queueRpc(
      JSON.stringify({
        ok: true,
        jobs: [
          {
            mediaJobId: 'mj_1',
            providerId: 'google',
            providerJobId: 'op_1',
            holdId: 'hold_1',
            firstBillingPendingAt: '2026-06-13T10:00:00.000Z',
            billingPendingPollCount: 3,
          },
        ],
      }),
    );
    const client = createVideoCheckpointClient({});
    const jobs = await client.listBillingPending({ limit: 50 });
    expect(jobs[0]).toMatchObject({ holdId: 'hold_1', billingPendingPollCount: 3 });
    expect(lastSent(sock)).not.toHaveProperty('userId');
  });

  it('markTerminal sends the terminalState without a userId', async () => {
    const sock = queueRpc(JSON.stringify({ ok: true }));
    const client = createVideoCheckpointClient({});
    await client.markTerminal({ mediaJobId: 'mj_1', terminalState: 'released' });
    const sent = lastSent(sock);
    expect(sent.op).toBe('mark_terminal');
    expect(sent.terminalState).toBe('released');
    expect(sent).not.toHaveProperty('userId');
  });

  it('markBillingSlaEscalated sends both timestamps', async () => {
    const sock = queueRpc(JSON.stringify({ ok: true }));
    const client = createVideoCheckpointClient({});
    await client.markBillingSlaEscalated({
      mediaJobId: 'mj_1',
      alertedAt: '2026-06-13T11:00:00.000Z',
      providerDisabledAt: '2026-06-13T11:00:00.000Z',
    });
    expect(lastSent(sock).op).toBe('mark_billing_sla_escalated');
  });
});

describe('createReconcilerBudgetClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reconcile settles the hold via reconcile_hold (holdId only, no userId)', async () => {
    const sock = queueRpc(JSON.stringify({ ok: true }));
    const client = createReconcilerBudgetClient();
    await client.reconcile({ holdId: 'hold_1', status: 'debited', actualQuotaUnits: 7 });
    const sent = lastSent(sock);
    expect(sent.op).toBe('reconcile_hold');
    expect(sent.holdId).toBe('hold_1');
    expect(sent).not.toHaveProperty('userId');
  });

  it('reconcile throws on a settle failure so the reconciler does not mark terminal', async () => {
    queueRpc(JSON.stringify({ ok: false, reason: 'HOLD_NOT_FOUND' }));
    const client = createReconcilerBudgetClient();
    await expect(
      client.reconcile({ holdId: 'missing', status: 'released' }),
    ).rejects.toThrow();
  });

  it('reserve is unsupported (reconciler never reserves)', async () => {
    const client = createReconcilerBudgetClient();
    const result = await client.reserve({
      mediaJobId: 'mj_1',
      quotaUnits: 1,
      providerId: 'google',
      modelId: 'veo-3.1-generate-preview',
      routeKind: 'video_generate',
    });
    expect(result.ok).toBe(false);
  });
});

describe('createReconcilerAlertSink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards an alert as a global operator_alert op (no userId)', async () => {
    const sock = queueRpc(JSON.stringify({ ok: true }));
    const sink = createReconcilerAlertSink();
    await sink({
      code: 'VIDEO_RECONCILER_POLL_FAILED',
      mediaJobId: 'mj_1',
      providerId: 'google',
      providerJobId: 'op_1',
      errorMessage: 'boom',
    });
    const sent = lastSent(sock);
    expect(sent.op).toBe('operator_alert');
    expect((sent.alert as Record<string, unknown>).code).toBe('VIDEO_RECONCILER_POLL_FAILED');
    expect(sent).not.toHaveProperty('userId');
  });

  it('throws when the broker reports failure (so safeAlert gating sees a miss)', async () => {
    queueRpc(JSON.stringify({ ok: false, reason: 'X' }));
    const sink = createReconcilerAlertSink();
    await expect(
      sink({
        code: 'VIDEO_RECONCILER_SENTINEL_RETIRED',
        mediaJobId: 'mj_1',
        providerId: 'google',
        providerJobId: 'op_1',
        errorMessage: 'SENTINEL_RETIRED',
      }),
    ).rejects.toThrow();
  });

  it('throws when the broker is unreachable', async () => {
    queueUnreachable();
    const sink = createReconcilerAlertSink();
    await expect(
      sink({
        code: 'VIDEO_BILLING_METADATA_SLA_EXCEEDED',
        mediaJobId: 'mj_1',
        providerId: 'google',
        providerJobId: 'op_1',
        firstBillingPendingAt: '2026-06-13T10:00:00.000Z',
        billingPendingPollCount: 3,
      }),
    ).rejects.toThrow(/UNREACHABLE/);
  });
});
