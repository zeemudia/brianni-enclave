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
