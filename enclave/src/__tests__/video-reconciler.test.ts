import { describe, expect, it } from 'vitest';
import {
  createVideoReconcilerHooks,
  runVideoReconcilerOnce,
} from '../video-reconciler.js';

const noopCheckpoint = {
  load: async () => null,
  savePendingStart: async () => undefined,
  saveProviderJob: async () => undefined,
  markCancelled: async () => undefined,
  markBillingPending: async () => undefined,
  listCancelledPending: async () => [],
  listBillingPending: async () => [],
  markBillingSlaEscalated: async () => undefined,
  markTerminal: async () => undefined,
} as const;

const noopBudget = {
  reserve: async () => ({ ok: false as const, reason: 'unused' }),
  reconcile: async () => undefined,
};

describe('createVideoReconcilerHooks', () => {
  it('disableProviderModel records the provider into the disabled set and logs', async () => {
    const disabled = new Set<string>();
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const hooks = createVideoReconcilerHooks({
      disabledVideoProviders: disabled,
      log: (msg, fields) => logs.push({ msg, fields }),
    });
    await hooks.disableProviderModel({
      providerId: 'google',
      reason: 'VIDEO_BILLING_METADATA_SLA_EXCEEDED',
    });
    expect(disabled.has('google')).toBe(true);
    expect(logs.some((l) => l.msg.includes('provider-disabled'))).toBe(true);
  });

  it('emitOperatorAlert logs the alert code', async () => {
    const logs: Array<{ msg: string }> = [];
    const hooks = createVideoReconcilerHooks({
      disabledVideoProviders: new Set(),
      log: (msg) => logs.push({ msg }),
    });
    await hooks.emitOperatorAlert({
      code: 'VIDEO_RECONCILER_POLL_FAILED',
      mediaJobId: 'mj_1',
      providerId: 'google',
      providerJobId: 'op_1',
      errorMessage: 'boom',
    });
    expect(logs.some((l) => l.msg.includes('VIDEO_RECONCILER_POLL_FAILED'))).toBe(true);
  });

  it('emitOperatorAlert forwards to the alert sink (real channel) AND logs locally', async () => {
    const forwarded: unknown[] = [];
    const hooks = createVideoReconcilerHooks({
      disabledVideoProviders: new Set(),
      log: () => undefined,
      alertSink: async (alert) => {
        forwarded.push(alert);
      },
    });
    await hooks.emitOperatorAlert({
      code: 'VIDEO_RECONCILER_POLL_FAILED',
      mediaJobId: 'mj_1',
      providerId: 'google',
      providerJobId: 'op_1',
      errorMessage: 'boom',
    });
    expect(forwarded).toHaveLength(1);
  });

  it('emitOperatorAlert propagates a sink failure (so safeAlert sees a non-delivery)', async () => {
    const hooks = createVideoReconcilerHooks({
      disabledVideoProviders: new Set(),
      log: () => undefined,
      alertSink: async () => {
        throw new Error('VIDEO_CHECKPOINT_OPERATOR_ALERT_FAILED:UNREACHABLE');
      },
    });
    await expect(
      hooks.emitOperatorAlert({
        code: 'VIDEO_RECONCILER_POLL_FAILED',
        mediaJobId: 'mj_1',
        providerId: 'google',
        providerJobId: 'op_1',
        errorMessage: 'boom',
      }),
    ).rejects.toThrow(/UNREACHABLE/);
  });
});

describe('runVideoReconcilerOnce', () => {
  it('does not throw when the checkpoint list fails (broker unreachable) — logs instead', async () => {
    const logs: Array<{ msg: string }> = [];
    await expect(
      runVideoReconcilerOnce({
        videoAdapters: {},
        disabledVideoProviders: new Set(),
        checkpointClient: {
          ...noopCheckpoint,
          listCancelledPending: async () => {
            throw new Error('VIDEO_CHECKPOINT_BROKER_UNREACHABLE');
          },
        },
        budgetClient: noopBudget,
        log: (msg) => logs.push({ msg }),
      }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.msg.includes('tick-failed'))).toBe(true);
  });

  it('settles a cancelled job whose provider has since completed (debit + terminal)', async () => {
    const reconciles: any[] = [];
    const terminals: any[] = [];
    await runVideoReconcilerOnce({
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: 'op_1' }),
          poll: async () => ({
            status: 'done',
            videoBytes: new Uint8Array([1]),
            mimeType: 'video/mp4',
            actualQuotaUnits: 50,
            billingSource: 'provider_operation_metadata',
          }),
        },
      },
      disabledVideoProviders: new Set(),
      checkpointClient: {
        ...noopCheckpoint,
        listCancelledPending: async () => [
          { mediaJobId: 'mj_1', providerId: 'google', providerJobId: 'op_1', holdId: 'hold_1' },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      budgetClient: {
        reserve: async () => ({ ok: false as const, reason: 'unused' }),
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
    });
    expect(reconciles.some((r) => r.status === 'debited' && r.holdId === 'hold_1')).toBe(true);
    expect(terminals.some((t) => t.terminalState === 'debited')).toBe(true);
  });

  it('forwards an SLA-breach alert to the injected alert sink', async () => {
    const forwarded: Array<{ code: string }> = [];
    const longAgo = new Date('2026-06-13T00:00:00.000Z').toISOString();
    await runVideoReconcilerOnce({
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: 'op_1' }),
          poll: async () => ({
            status: 'billing_pending' as const,
            reason: 'PROVIDER_BILLING_METADATA_MISSING' as const,
          }),
        },
      },
      disabledVideoProviders: new Set(),
      billingMetadataSlaMs: 1, // any positive age trips the SLA
      now: new Date('2026-06-13T12:00:00.000Z'),
      checkpointClient: {
        ...noopCheckpoint,
        listBillingPending: async () => [
          {
            mediaJobId: 'mj_1',
            providerId: 'google',
            providerJobId: 'op_1',
            holdId: 'hold_1',
            firstBillingPendingAt: longAgo,
            billingPendingPollCount: 5,
          },
        ],
      },
      budgetClient: noopBudget,
      alertSink: async (alert) => {
        forwarded.push(alert);
      },
    });
    expect(forwarded.some((a) => a.code === 'VIDEO_BILLING_METADATA_SLA_EXCEEDED')).toBe(true);
  });
});
