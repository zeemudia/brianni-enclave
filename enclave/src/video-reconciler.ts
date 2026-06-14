/**
 * Timer-driven orphan/billing reconciler for video generation.
 *
 * A video job cancelled (or interrupted) AFTER the provider job started leaves a
 * provider job still consuming compute; the budget hold sits in
 * cancelled_pending_provider / billing_pending_provider until someone polls the
 * provider and settles it (debited if it finished, released if it failed). The
 * stateless enclave can't do that inline (the turn is over), so a recurring tick
 * sweeps the durable checkpoint store and settles by holdId.
 *
 * This wires reconcileCancelledProviderCompletions (in media-executor) with:
 *   - the service (no-user) video checkpoint client for the global list/terminal ops,
 *   - the reconciler budget client (settles holds by holdId over vsock 8105),
 *   - an operator-alert sink (structured enclave logs → host → operator), and
 *   - a provider-disable hook that records into a disabled-provider set the
 *     routing gate consults (a provider that breaches the billing-metadata SLA is
 *     dropped from video routing until an operator re-enables it).
 *
 * Each tick is fully isolated: a thrown list/poll/settle is caught + logged so a
 * degraded broker/provider never crashes the long-lived enclave.
 */
import {
  reconcileCancelledProviderCompletions,
  type RunMediaSubtaskDeps,
} from './orchestrator/media-executor';
import {
  createVideoCheckpointClient,
  createReconcilerBudgetClient,
  createReconcilerAlertSink,
} from './video-checkpoint-store.js';

type ReconcilerDeps = Parameters<typeof reconcileCancelledProviderCompletions>[0];
type OperatorAlertInput = Parameters<NonNullable<ReconcilerDeps['emitOperatorAlert']>>[0];

export type VideoReconcilerLog = (msg: string, fields: Record<string, unknown>) => void;

/**
 * Off-box alert delivery. The enclave has no egress, so this forwards the alert
 * over the vsock-8105 broker → server (which logs it durably + best-effort fans
 * out to OPERATOR_ALERT_WEBHOOK_URL). MUST reject on a delivery miss so the
 * reconciler's `safeAlert` keeps gating destructive transitions on a confirmed
 * trail. Optional: when absent, alerts are local-log-only (the legacy behaviour,
 * still used by unit tests that don't exercise the channel).
 */
export type VideoReconcilerAlertSink = (alert: OperatorAlertInput) => Promise<void>;

const defaultLog: VideoReconcilerLog = (msg, fields) =>
  console.error(`[video-reconciler] ${msg}`, JSON.stringify(fields));

export function createVideoReconcilerHooks(opts: {
  disabledVideoProviders: Set<string>;
  log?: VideoReconcilerLog;
  alertSink?: VideoReconcilerAlertSink;
}): {
  emitOperatorAlert: NonNullable<ReconcilerDeps['emitOperatorAlert']>;
  disableProviderModel: NonNullable<ReconcilerDeps['disableProviderModel']>;
} {
  const log = opts.log ?? defaultLog;
  return {
    emitOperatorAlert: async (input) => {
      // Always leave a local breadcrumb FIRST (free, survives even if the
      // off-box forward throws), THEN forward to the real channel and let any
      // delivery failure propagate so `safeAlert` records a non-delivery.
      log(`operator-alert:${input.code}`, input as unknown as Record<string, unknown>);
      if (opts.alertSink) await opts.alertSink(input);
    },
    disableProviderModel: async (input) => {
      opts.disabledVideoProviders.add(input.providerId);
      log(`provider-disabled:${input.providerId}`, input as unknown as Record<string, unknown>);
    },
  };
}

export async function runVideoReconcilerOnce(deps: {
  videoAdapters: RunMediaSubtaskDeps['videoAdapters'];
  disabledVideoProviders: Set<string>;
  checkpointClient?: RunMediaSubtaskDeps['checkpointClient'];
  budgetClient?: RunMediaSubtaskDeps['budgetClient'];
  limit?: number;
  now?: Date;
  billingMetadataSlaMs?: number;
  abortSignal?: AbortSignal;
  log?: VideoReconcilerLog;
  alertSink?: VideoReconcilerAlertSink;
}): Promise<void> {
  const log = deps.log ?? defaultLog;
  const hooks = createVideoReconcilerHooks({
    disabledVideoProviders: deps.disabledVideoProviders,
    log,
    // Default to the real off-box channel (vsock 8105 → server → webhook). Unit
    // tests inject their own sink (or omit it) to stay off the broker.
    alertSink: deps.alertSink ?? createReconcilerAlertSink(),
  });
  try {
    await reconcileCancelledProviderCompletions({
      videoAdapters: deps.videoAdapters,
      checkpointClient: deps.checkpointClient ?? createVideoCheckpointClient({}),
      budgetClient: deps.budgetClient ?? createReconcilerBudgetClient(),
      limit: deps.limit,
      now: deps.now,
      billingMetadataSlaMs: deps.billingMetadataSlaMs,
      abortSignal: deps.abortSignal,
      ...hooks,
    });
  } catch (err) {
    // Tick-level isolation: the recurring sweep must survive a degraded broker
    // (e.g. listCancelledPending throwing UNREACHABLE) — log and retry next tick.
    log('tick-failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Default sweep interval — frequent enough to bound provider cost leakage. */
export const VIDEO_RECONCILER_INTERVAL_MS = 5 * 60 * 1000;
