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

  it('emits a VIDEO_DELIVERY_PENDING_STALE alert when stuck delivery_pending rows exceed the threshold', async () => {
    const forwarded: Array<{ code: string; count?: number; sample?: unknown[] }> = [];
    await runVideoReconcilerOnce({
      videoAdapters: {},
      disabledVideoProviders: new Set(),
      checkpointClient: {
        ...noopCheckpoint,
        listStuckDeliveryPending: async () => ({
          count: 30,
          sample: [
            { mediaJobId: 'mj_1', providerId: 'google', deliveredPendingAt: '2026-06-14T10:00:00.000Z' },
          ],
        }),
      },
      budgetClient: noopBudget,
      staleDeliveryAlertThreshold: 20,
      alertSink: async (alert) => {
        forwarded.push(alert as { code: string; count?: number });
      },
    });
    const stale = forwarded.find((a) => a.code === 'VIDEO_DELIVERY_PENDING_STALE');
    expect(stale).toBeTruthy();
    expect(stale?.count).toBe(30);
    expect(stale?.sample).toHaveLength(1);
  });

  it('suppresses repeat VIDEO_DELIVERY_PENDING_STALE alerts within the window, re-alerts after it (cross-tick dedup)', async () => {
    const forwarded: Array<{ code: string }> = [];
    const staleAlertState: { lastStaleAlertAt?: number } = {};
    const base = {
      videoAdapters: {},
      disabledVideoProviders: new Set<string>(),
      checkpointClient: {
        ...noopCheckpoint,
        listStuckDeliveryPending: async () => ({ count: 30, sample: [] }),
      },
      budgetClient: noopBudget,
      staleDeliveryAlertThreshold: 20,
      staleAlertSuppressionMs: 60 * 60 * 1000,
      staleAlertState,
      alertSink: async (alert: { code: string }) => {
        forwarded.push(alert);
      },
    };
    const staleCount = () =>
      forwarded.filter((a) => a.code === 'VIDEO_DELIVERY_PENDING_STALE').length;

    // Tick 1 → alert. Tick 2 five minutes later (within window) → suppressed.
    await runVideoReconcilerOnce({ ...base, now: new Date('2026-06-15T00:00:00.000Z') });
    await runVideoReconcilerOnce({ ...base, now: new Date('2026-06-15T00:05:00.000Z') });
    expect(staleCount()).toBe(1);
    // Tick 3 two hours later (past window) → re-alert.
    await runVideoReconcilerOnce({ ...base, now: new Date('2026-06-15T02:00:00.000Z') });
    expect(staleCount()).toBe(2);
  });

  it('does NOT alert when the stuck delivery_pending count is at or below the threshold', async () => {
    const forwarded: Array<{ code: string }> = [];
    await runVideoReconcilerOnce({
      videoAdapters: {},
      disabledVideoProviders: new Set(),
      checkpointClient: {
        ...noopCheckpoint,
        listStuckDeliveryPending: async () => ({ count: 20, sample: [] }),
      },
      budgetClient: noopBudget,
      staleDeliveryAlertThreshold: 20,
      alertSink: async (alert) => {
        forwarded.push(alert as { code: string });
      },
    });
    expect(forwarded.some((a) => a.code === 'VIDEO_DELIVERY_PENDING_STALE')).toBe(false);
  });

  it('isolates a stale-delivery list failure (does not throw, does not block the sweep)', async () => {
    const logs: Array<{ msg: string }> = [];
    await expect(
      runVideoReconcilerOnce({
        videoAdapters: {},
        disabledVideoProviders: new Set(),
        checkpointClient: {
          ...noopCheckpoint,
          listStuckDeliveryPending: async () => {
            throw new Error('VIDEO_CHECKPOINT_BROKER_UNREACHABLE');
          },
        },
        budgetClient: noopBudget,
        log: (msg) => logs.push({ msg }),
      }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.msg.includes('stale-delivery'))).toBe(true);
  });
});
