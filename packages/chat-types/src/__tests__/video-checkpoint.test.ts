import { describe, expect, it } from 'vitest';
import {
  encodeVideoCheckpointRequest,
  decodeVideoCheckpointRequest,
  encodeVideoCheckpointLoadResult,
  decodeVideoCheckpointLoadResult,
  encodeVideoCheckpointWriteResult,
  decodeVideoCheckpointWriteResult,
  encodeVideoCheckpointCancelledListResult,
  decodeVideoCheckpointCancelledListResult,
  encodeVideoCheckpointBillingListResult,
  decodeVideoCheckpointBillingListResult,
  encodeVideoCheckpointUserDeliveryPendingListResult,
  decodeVideoCheckpointUserDeliveryPendingListResult,
  encodeVideoCheckpointStuckDeliveryPendingListResult,
  decodeVideoCheckpointStuckDeliveryPendingListResult,
  MAX_VIDEO_CHECKPOINT_RPC_BYTES,
} from '../video-checkpoint';

describe('video-checkpoint RPC contract', () => {
  it('round-trips a load request', () => {
    const req = { op: 'load' as const, userId: 'u1', mediaJobId: 'mj_1' };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('round-trips a save_pending_start request', () => {
    const req = {
      op: 'save_pending_start' as const,
      userId: 'u1',
      mediaJobId: 'mj_1',
      localIdempotencyKey: 'idem_1',
      providerId: 'google',
      modelId: 'veo-3.1-generate-preview',
      provenanceSnapshotHash: 'a'.repeat(64),
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('round-trips a save_provider_job request (with + without provenanceSnapshotHash)', () => {
    const withHash = {
      op: 'save_provider_job' as const,
      userId: 'u1',
      mediaJobId: 'mj_1',
      providerId: 'google',
      modelId: 'veo-3.1-generate-preview',
      providerJobId: 'models/veo/operations/xyz',
      provenanceSnapshotHash: 'b'.repeat(64),
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(withHash))).toEqual(withHash);
    const noHash = {
      op: 'save_provider_job' as const,
      userId: 'u1',
      mediaJobId: 'mj_1',
      providerId: 'google',
      modelId: 'veo-3.1-generate-preview',
      providerJobId: 'models/veo/operations/xyz',
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(noHash))).toEqual(noHash);
  });

  it('round-trips mark_cancelled with and without providerJobId', () => {
    const withJob = {
      op: 'mark_cancelled' as const,
      userId: 'u1',
      mediaJobId: 'mj_1',
      providerJobId: 'models/veo/operations/xyz',
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(withJob))).toEqual(withJob);
    const noJob = { op: 'mark_cancelled' as const, userId: 'u1', mediaJobId: 'mj_1' };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(noJob))).toEqual(noJob);
  });

  it('round-trips mark_billing_pending', () => {
    const req = {
      op: 'mark_billing_pending' as const,
      userId: 'u1',
      mediaJobId: 'mj_1',
      providerJobId: 'models/veo/operations/xyz',
      observedAt: '2026-06-13T10:00:00.000Z',
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('round-trips list_cancelled_pending and list_billing_pending requests', () => {
    const cancelled = { op: 'list_cancelled_pending' as const, limit: 50 };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(cancelled))).toEqual(cancelled);
    const billing = { op: 'list_billing_pending' as const, limit: 25 };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(billing))).toEqual(billing);
  });

  it('round-trips mark_billing_sla_escalated (no userId — reconciler global op)', () => {
    const req = {
      op: 'mark_billing_sla_escalated' as const,
      mediaJobId: 'mj_1',
      alertedAt: '2026-06-13T10:00:00.000Z',
      providerDisabledAt: '2026-06-13T10:00:00.000Z',
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('round-trips mark_terminal', () => {
    const debited = { op: 'mark_terminal' as const, mediaJobId: 'mj_1', terminalState: 'debited' as const };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(debited))).toEqual(debited);
    const released = { op: 'mark_terminal' as const, mediaJobId: 'mj_1', terminalState: 'released' as const };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(released))).toEqual(released);
  });

  it('round-trips mark_delivery_pending (provider done + billed, awaiting client receipt)', () => {
    const req = {
      op: 'mark_delivery_pending' as const,
      userId: 'u1',
      mediaJobId: 'mj_1',
      providerJobId: 'models/veo/operations/xyz',
      deliveredPendingAt: '2026-06-15T10:00:00.000Z',
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('round-trips list_user_delivery_pending (user-scoped re-delivery list)', () => {
    const req = { op: 'list_user_delivery_pending' as const, userId: 'u1', limit: 5 };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('round-trips list_stuck_delivery_pending (global reconciler observability op — age threshold)', () => {
    const req = {
      op: 'list_stuck_delivery_pending' as const,
      olderThanMs: 6 * 60 * 60 * 1000,
      limit: 25,
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('caps list_stuck_delivery_pending.limit at the sample cap (50) so the result never overflows', () => {
    // The result `sample` is bounded at 50; the request limit must agree, or a
    // limit above 50 with that many stuck rows would overflow the result schema
    // and fail the monitor RPC instead of alerting.
    expect(() =>
      encodeVideoCheckpointRequest({
        op: 'list_stuck_delivery_pending',
        olderThanMs: 6 * 60 * 60 * 1000,
        limit: 51,
      } as never),
    ).toThrow();
    const atCap = {
      op: 'list_stuck_delivery_pending' as const,
      olderThanMs: 6 * 60 * 60 * 1000,
      limit: 50,
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(atCap))).toEqual(atCap);
  });

  it('round-trips a stuck delivery-pending list result (count + bounded sample)', () => {
    const result = {
      ok: true as const,
      count: 137,
      sample: [
        {
          mediaJobId: 'mj_1',
          providerId: 'google',
          deliveredPendingAt: '2026-06-14T10:00:00.000Z',
        },
        {
          mediaJobId: 'mj_2',
          providerId: 'google',
          deliveredPendingAt: '2026-06-14T11:00:00.000Z',
        },
      ],
    };
    expect(
      decodeVideoCheckpointStuckDeliveryPendingListResult(
        encodeVideoCheckpointStuckDeliveryPendingListResult(result),
      ),
    ).toEqual(result);
  });

  it('round-trips a stuck delivery-pending list failure result', () => {
    const result = { ok: false as const, reason: 'BROKER_UNREACHABLE' };
    expect(
      decodeVideoCheckpointStuckDeliveryPendingListResult(
        encodeVideoCheckpointStuckDeliveryPendingListResult(result),
      ),
    ).toEqual(result);
  });

  it('round-trips an operator_alert request (delivery-pending-stale variant — aggregate count + sample)', () => {
    const req = {
      op: 'operator_alert' as const,
      alert: {
        code: 'VIDEO_DELIVERY_PENDING_STALE' as const,
        count: 42,
        sample: [
          {
            mediaJobId: 'mj_1',
            providerId: 'google',
            deliveredPendingAt: '2026-06-14T10:00:00.000Z',
          },
        ],
      },
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('rejects a VIDEO_DELIVERY_PENDING_STALE alert that smuggles a prompt key (strict — no plaintext leak)', () => {
    expect(() =>
      encodeVideoCheckpointRequest({
        op: 'operator_alert',
        alert: {
          code: 'VIDEO_DELIVERY_PENDING_STALE',
          count: 1,
          sample: [],
          prompt: 'leak me',
        },
      } as never),
    ).toThrow();
  });

  it('round-trips reconcile_hold', () => {
    const req = {
      op: 'reconcile_hold' as const,
      holdId: 'hold_1',
      status: 'debited' as const,
      actualQuotaUnits: 12,
      billingReceiptId: 'rcpt_1',
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('round-trips an operator_alert request (SLA-breach variant)', () => {
    const req = {
      op: 'operator_alert' as const,
      alert: {
        code: 'VIDEO_BILLING_METADATA_SLA_EXCEEDED' as const,
        mediaJobId: 'mj_1',
        providerId: 'google',
        providerJobId: 'models/veo/operations/xyz',
        firstBillingPendingAt: '2026-06-13T10:00:00.000Z',
        billingPendingPollCount: 12,
      },
    };
    expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
  });

  it('round-trips an operator_alert request (reconciler-failure variant)', () => {
    for (const code of [
      'VIDEO_RECONCILER_POLL_FAILED',
      'VIDEO_RECONCILER_SETTLEMENT_FAILED',
      'VIDEO_RECONCILER_ADAPTER_MISSING',
      'VIDEO_RECONCILER_SENTINEL_RETIRED',
    ] as const) {
      const req = {
        op: 'operator_alert' as const,
        alert: {
          code,
          mediaJobId: 'mj_1',
          providerId: 'google',
          providerJobId: 'op_1',
          errorMessage: 'boom',
        },
      };
      expect(decodeVideoCheckpointRequest(encodeVideoCheckpointRequest(req))).toEqual(req);
    }
  });

  it('rejects an operator_alert with an unknown code', () => {
    expect(() =>
      encodeVideoCheckpointRequest({
        op: 'operator_alert',
        alert: {
          code: 'VIDEO_NOT_A_REAL_CODE',
          mediaJobId: 'mj_1',
          providerId: 'google',
          providerJobId: 'op_1',
          errorMessage: 'boom',
        },
      } as never),
    ).toThrow();
  });

  it('rejects an operator_alert that smuggles a prompt key (strict — no plaintext leak)', () => {
    expect(() =>
      encodeVideoCheckpointRequest({
        op: 'operator_alert',
        alert: {
          code: 'VIDEO_RECONCILER_POLL_FAILED',
          mediaJobId: 'mj_1',
          providerId: 'google',
          providerJobId: 'op_1',
          errorMessage: 'boom',
          prompt: 'leak me',
        },
      } as never),
    ).toThrow();
  });

  it('round-trips a load result (pending_start state)', () => {
    const result = {
      ok: true as const,
      checkpoint: {
        state: 'pending_start' as const,
        providerId: 'google',
        modelId: 'veo-3.1-generate-preview',
        localIdempotencyKey: 'idem_1',
        provenanceSnapshotHash: 'c'.repeat(64),
      },
    };
    expect(decodeVideoCheckpointLoadResult(encodeVideoCheckpointLoadResult(result))).toEqual(result);
  });

  it('round-trips a load result (provider_started state)', () => {
    const result = {
      ok: true as const,
      checkpoint: {
        state: 'provider_started' as const,
        providerId: 'google',
        modelId: 'veo-3.1-generate-preview',
        providerJobId: 'models/veo/operations/xyz',
        provenanceSnapshotHash: 'd'.repeat(64),
      },
    };
    expect(decodeVideoCheckpointLoadResult(encodeVideoCheckpointLoadResult(result))).toEqual(result);
  });

  it('round-trips a load result (delivery_pending state — billed, awaiting/needing re-delivery)', () => {
    const result = {
      ok: true as const,
      checkpoint: {
        state: 'delivery_pending' as const,
        providerId: 'google',
        modelId: 'veo-3.1-generate-preview',
        providerJobId: 'models/veo/operations/xyz',
        provenanceSnapshotHash: 'e'.repeat(64),
      },
    };
    expect(decodeVideoCheckpointLoadResult(encodeVideoCheckpointLoadResult(result))).toEqual(result);
  });

  it('round-trips a load result (null checkpoint)', () => {
    const result = { ok: true as const, checkpoint: null };
    expect(decodeVideoCheckpointLoadResult(encodeVideoCheckpointLoadResult(result))).toEqual(result);
  });

  it('round-trips write results (ok + failure)', () => {
    expect(
      decodeVideoCheckpointWriteResult(encodeVideoCheckpointWriteResult({ ok: true })),
    ).toEqual({ ok: true });
    expect(
      decodeVideoCheckpointWriteResult(
        encodeVideoCheckpointWriteResult({ ok: false, reason: 'CHECKPOINT_NOT_FOUND' }),
      ),
    ).toEqual({ ok: false, reason: 'CHECKPOINT_NOT_FOUND' });
  });

  it('round-trips a cancelled-pending list result', () => {
    const result = {
      ok: true as const,
      jobs: [
        { mediaJobId: 'mj_1', providerId: 'google', providerJobId: 'op_1', holdId: 'hold_1' },
        { mediaJobId: 'mj_2', providerId: 'google', providerJobId: 'op_2', holdId: 'hold_2' },
      ],
    };
    expect(
      decodeVideoCheckpointCancelledListResult(encodeVideoCheckpointCancelledListResult(result)),
    ).toEqual(result);
  });

  it('round-trips a billing-pending list result (optional slaAlertedAt)', () => {
    const result = {
      ok: true as const,
      jobs: [
        {
          mediaJobId: 'mj_1',
          providerId: 'google',
          providerJobId: 'op_1',
          holdId: 'hold_1',
          firstBillingPendingAt: '2026-06-13T10:00:00.000Z',
          billingPendingPollCount: 3,
          slaAlertedAt: '2026-06-13T11:00:00.000Z',
        },
        {
          mediaJobId: 'mj_2',
          providerId: 'google',
          providerJobId: 'op_2',
          holdId: 'hold_2',
          firstBillingPendingAt: '2026-06-13T10:00:00.000Z',
          billingPendingPollCount: 1,
        },
      ],
    };
    expect(
      decodeVideoCheckpointBillingListResult(encodeVideoCheckpointBillingListResult(result)),
    ).toEqual(result);
  });

  it('round-trips a user delivery-pending list result (re-deliverable jobs)', () => {
    const result = {
      ok: true as const,
      jobs: [
        {
          mediaJobId: 'mj_1',
          providerId: 'google',
          modelId: 'veo-3.1-generate-preview',
          providerJobId: 'op_1',
          provenanceSnapshotHash: 'a'.repeat(64),
        },
      ],
    };
    expect(
      decodeVideoCheckpointUserDeliveryPendingListResult(
        encodeVideoCheckpointUserDeliveryPendingListResult(result),
      ),
    ).toEqual(result);
  });

  it('rejects an unknown op', () => {
    expect(() =>
      decodeVideoCheckpointRequest(Buffer.from(JSON.stringify({ op: 'nope' }))),
    ).toThrow();
  });

  it('rejects extra/unknown keys (strict — no plaintext leak)', () => {
    expect(() =>
      encodeVideoCheckpointRequest({
        op: 'save_pending_start',
        userId: 'u1',
        mediaJobId: 'mj_1',
        localIdempotencyKey: 'idem_1',
        providerId: 'google',
        modelId: 'veo-3.1-generate-preview',
        provenanceSnapshotHash: 'a'.repeat(64),
        prompt: 'leak me',
      } as never),
    ).toThrow();
  });

  it('enforces the size cap on decode', () => {
    const huge = Buffer.alloc(MAX_VIDEO_CHECKPOINT_RPC_BYTES + 1, 0x20);
    expect(() => decodeVideoCheckpointRequest(huge)).toThrow(/too large/i);
  });
});
