/**
 * Durable video-checkpoint store + reconciler budget client for the orchestrator.
 *
 * `buildProductionMedia` wires a boot-time checkpointClient; the AGENT_REQUEST
 * handler binds THIS factory to the authenticated userId and overrides it per
 * request (mirroring the per-request media budget client) so concurrent turns
 * never cross-read a checkpoint. The timer-driven orphan/billing reconciler uses
 * its own no-user client (global list/terminal ops) plus a reconciler budget
 * client that settles holds by holdId alone over the same broker.
 *
 * FAIL CLOSED: user-scoped ops (load / save*) THROW on any broker failure so the
 * media-executor aborts the subtask (its catch releases the quota hold) rather
 * than risk a duplicate provider job. The reconciler's per-job try/catch handles
 * list/terminal/settle failures (emitting operator alerts), so those throw too.
 */
import {
  sendVideoCheckpointRpc,
} from './video-checkpoint-client.js';
import {
  decodeVideoCheckpointLoadResult,
  decodeVideoCheckpointWriteResult,
  decodeVideoCheckpointCancelledListResult,
  decodeVideoCheckpointBillingListResult,
  type VideoCheckpointRequest,
  type VideoOperatorAlert,
} from '@calypso/chat-types';
import type { RunMediaSubtaskDeps } from './orchestrator/media-executor';

type CheckpointClient = RunMediaSubtaskDeps['checkpointClient'];
type BudgetClient = RunMediaSubtaskDeps['budgetClient'];

export interface VideoCheckpointUserContext {
  userId?: string;
}

function requireUser(ctx: VideoCheckpointUserContext): string {
  if (!ctx.userId) {
    // Fail closed: a user-scoped checkpoint op without a bound user cannot be
    // attributed; throwing aborts the subtask instead of writing an orphan row.
    throw new Error('VIDEO_CHECKPOINT_USER_CONTEXT_MISSING');
  }
  return ctx.userId;
}

export function createVideoCheckpointClient(ctx: VideoCheckpointUserContext): CheckpointClient {
  return {
    load: async ({ mediaJobId }) => {
      const userId = requireUser(ctx);
      const bytes = await sendVideoCheckpointRpc({ op: 'load', userId, mediaJobId });
      const result = decodeVideoCheckpointLoadResult(bytes);
      if (!result.ok) throw new Error(`VIDEO_CHECKPOINT_LOAD_FAILED:${result.reason}`);
      return result.checkpoint;
    },

    savePendingStart: async ({
      mediaJobId,
      localIdempotencyKey,
      providerId,
      modelId,
      provenanceSnapshotHash,
    }) => {
      const userId = requireUser(ctx);
      await writeOrThrow(
        {
          op: 'save_pending_start',
          userId,
          mediaJobId,
          localIdempotencyKey,
          providerId,
          modelId,
          provenanceSnapshotHash,
        },
        'SAVE_PENDING_START',
      );
    },

    saveProviderJob: async ({
      mediaJobId,
      providerId,
      modelId,
      providerJobId,
      provenanceSnapshotHash,
    }) => {
      const userId = requireUser(ctx);
      await writeOrThrow(
        {
          op: 'save_provider_job',
          userId,
          mediaJobId,
          providerId,
          modelId,
          providerJobId,
          ...(provenanceSnapshotHash !== undefined ? { provenanceSnapshotHash } : {}),
        },
        'SAVE_PROVIDER_JOB',
      );
    },

    markCancelled: async ({ mediaJobId, providerJobId }) => {
      const userId = requireUser(ctx);
      await writeOrThrow(
        {
          op: 'mark_cancelled',
          userId,
          mediaJobId,
          ...(providerJobId !== undefined ? { providerJobId } : {}),
        },
        'MARK_CANCELLED',
      );
    },

    markBillingPending: async ({ mediaJobId, providerJobId, observedAt }) => {
      const userId = requireUser(ctx);
      await writeOrThrow(
        { op: 'mark_billing_pending', userId, mediaJobId, providerJobId, observedAt },
        'MARK_BILLING_PENDING',
      );
    },

    listCancelledPending: async ({ limit }) => {
      const bytes = await sendVideoCheckpointRpc({ op: 'list_cancelled_pending', limit });
      const result = decodeVideoCheckpointCancelledListResult(bytes);
      if (!result.ok) throw new Error(`VIDEO_CHECKPOINT_LIST_CANCELLED_FAILED:${result.reason}`);
      return result.jobs;
    },

    listBillingPending: async ({ limit }) => {
      const bytes = await sendVideoCheckpointRpc({ op: 'list_billing_pending', limit });
      const result = decodeVideoCheckpointBillingListResult(bytes);
      if (!result.ok) throw new Error(`VIDEO_CHECKPOINT_LIST_BILLING_FAILED:${result.reason}`);
      return result.jobs;
    },

    markBillingSlaEscalated: async ({ mediaJobId, alertedAt, providerDisabledAt }) => {
      await writeOrThrow(
        { op: 'mark_billing_sla_escalated', mediaJobId, alertedAt, providerDisabledAt },
        'MARK_BILLING_SLA_ESCALATED',
      );
    },

    markTerminal: async ({ mediaJobId, terminalState }) => {
      await writeOrThrow({ op: 'mark_terminal', mediaJobId, terminalState }, 'MARK_TERMINAL');
    },
  };
}

/**
 * Budget client for the timer-driven reconciler. It NEVER reserves (reserve is
 * unsupported) — it only settles holds by holdId over the video-checkpoint
 * broker's reconcile_hold op. Throws on a settle failure so the reconciler's
 * per-job catch keeps the row for the next sweep instead of marking it terminal.
 */
export function createReconcilerBudgetClient(): BudgetClient {
  return {
    reserve: async () => ({
      ok: false as const,
      reason: 'RECONCILER_BUDGET_RESERVE_UNSUPPORTED',
    }),
    reconcile: async ({ holdId, status, actualQuotaUnits, billingReceiptId }) => {
      await writeOrThrow(
        {
          op: 'reconcile_hold',
          holdId,
          status,
          ...(actualQuotaUnits !== undefined ? { actualQuotaUnits } : {}),
          ...(billingReceiptId ? { billingReceiptId } : {}),
        },
        'RECONCILE_HOLD',
      );
    },
  };
}

/**
 * Operator-alert sink for the timer-driven reconciler. The stateless enclave
 * has NO egress, so an alert can't reach Slack/PagerDuty/Sentry directly — it
 * forwards over the SAME video-checkpoint broker (vsock 8105) as a global
 * `operator_alert` op; the server logs it durably and best-effort fans it out
 * to OPERATOR_ALERT_WEBHOOK_URL. THROWS on a broker/server miss so the
 * reconciler's `safeAlert` helper sees a non-delivery and keeps gating its
 * destructive transitions (sentinel retire / missing-adapter release) on a
 * confirmed, durable trail — the same contract the old stderr sink upheld, only
 * now the trail lands off-box instead of in ephemeral enclave console output.
 */
export function createReconcilerAlertSink(): (alert: VideoOperatorAlert) => Promise<void> {
  return async (alert) => {
    await writeOrThrow({ op: 'operator_alert', alert }, 'OPERATOR_ALERT');
  };
}

async function writeOrThrow(req: VideoCheckpointRequest, label: string): Promise<void> {
  const bytes = await sendVideoCheckpointRpc(req);
  const result = decodeVideoCheckpointWriteResult(bytes);
  if (!result.ok) throw new Error(`VIDEO_CHECKPOINT_${label}_FAILED:${result.reason}`);
}
