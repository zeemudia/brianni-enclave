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
import type { VideoOperatorAlert } from '@calypso/chat-types';
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
// The full operator-alert union (chat-types) — wider than the per-job subset
// `reconcileCancelledProviderCompletions` declares, because the stale-delivery
// monitor below emits the aggregate VIDEO_DELIVERY_PENDING_STALE variant too. A
// function accepting the wider input is still assignable to the narrower
// `emitOperatorAlert?` slot (parameter contravariance), so the per-job sweep is
// unaffected.
type OperatorAlertInput = VideoOperatorAlert;

export type VideoReconcilerLog = (msg: string, fields: Record<string, unknown>) => void;

/**
 * Stale-delivery monitor defaults. A healthy system delivers a generated video
 * immediately, so a row still `delivery_pending` hours later is either a user who
 * has not returned (benign in isolation) or a systemic delivery regression. We
 * alert on the COUNT of such rows crossing a threshold, not on any single row —
 * the reconciler cannot deliver to an absent client, this is observability only.
 */
export const STALE_DELIVERY_PENDING_AGE_MS = 6 * 60 * 60 * 1000;
export const STALE_DELIVERY_PENDING_ALERT_THRESHOLD = 20;
export const STALE_DELIVERY_PENDING_SAMPLE_LIMIT = 10;
/**
 * Cross-tick alert suppression: a sustained backlog would otherwise re-fire the
 * stale alert every 5-min sweep, flooding the operator channel (a fresh PagerDuty
 * incident / Slack message per webhook) until the signal is tuned out — the exact
 * failure the alert exists to prevent. While the breach persists we re-alert at
 * most once per this window (≤ 24/day). The caller threads a persistent state
 * holder across ticks; a single-call (test) site that omits it always alerts.
 */
export const STALE_DELIVERY_PENDING_ALERT_SUPPRESSION_MS = 60 * 60 * 1000;

/** Persistent (across-tick) state for stale-delivery alert suppression. */
export interface StaleDeliveryAlertState {
  lastStaleAlertAt?: number;
}

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
  emitOperatorAlert: (input: OperatorAlertInput) => Promise<void>;
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
  staleDeliveryAgeMs?: number;
  staleDeliveryAlertThreshold?: number;
  staleDeliverySampleLimit?: number;
  // Persistent across-tick holder for stale-alert suppression (the index.ts timer
  // creates one and reuses it every tick). Omit it (single-call tests) to alert
  // unconditionally.
  staleAlertState?: StaleDeliveryAlertState;
  staleAlertSuppressionMs?: number;
}): Promise<void> {
  const log = deps.log ?? defaultLog;
  const hooks = createVideoReconcilerHooks({
    disabledVideoProviders: deps.disabledVideoProviders,
    log,
    // Default to the real off-box channel (vsock 8105 → server → webhook). Unit
    // tests inject their own sink (or omit it) to stay off the broker.
    alertSink: deps.alertSink ?? createReconcilerAlertSink(),
  });
  const checkpointClient = deps.checkpointClient ?? createVideoCheckpointClient({});
  try {
    await reconcileCancelledProviderCompletions({
      videoAdapters: deps.videoAdapters,
      checkpointClient,
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

  // Stale-delivery monitor (observability only): count billed-but-undelivered
  // videos stuck `delivery_pending` past the age threshold and alert when the
  // backlog crosses the count threshold. The reconciler CANNOT deliver to an
  // absent client — it just signals. Isolated in its own try/catch so a degraded
  // broker never crashes the long-lived enclave; once-per-tick = deduped to the
  // sweep interval (no per-row alert spam). Skipped when the client predates the
  // monitor (optional method).
  try {
    if (checkpointClient.listStuckDeliveryPending) {
      const threshold = deps.staleDeliveryAlertThreshold ?? STALE_DELIVERY_PENDING_ALERT_THRESHOLD;
      const { count, sample } = await checkpointClient.listStuckDeliveryPending({
        olderThanMs: deps.staleDeliveryAgeMs ?? STALE_DELIVERY_PENDING_AGE_MS,
        limit: deps.staleDeliverySampleLimit ?? STALE_DELIVERY_PENDING_SAMPLE_LIMIT,
      });
      if (count > threshold) {
        // Cross-tick suppression: while the backlog persists, re-alert at most
        // once per the suppression window so the operator channel is not flooded
        // every sweep. A single-call site (tests) omits staleAlertState → always
        // alerts.
        const nowMs = (deps.now ?? new Date()).getTime();
        const suppressionMs =
          deps.staleAlertSuppressionMs ?? STALE_DELIVERY_PENDING_ALERT_SUPPRESSION_MS;
        const lastAlertedAt = deps.staleAlertState?.lastStaleAlertAt;
        const sinceLast = lastAlertedAt === undefined ? Infinity : nowMs - lastAlertedAt;
        if (sinceLast >= suppressionMs) {
          await hooks.emitOperatorAlert({ code: 'VIDEO_DELIVERY_PENDING_STALE', count, sample });
          if (deps.staleAlertState) deps.staleAlertState.lastStaleAlertAt = nowMs;
        }
      }
    }
  } catch (err) {
    log('stale-delivery-tick-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Default sweep interval — frequent enough to bound provider cost leakage. */
export const VIDEO_RECONCILER_INTERVAL_MS = 5 * 60 * 1000;
