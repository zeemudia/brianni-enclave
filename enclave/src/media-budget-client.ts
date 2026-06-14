/**
 * Request-scoped media budget client for the orchestrator.
 *
 * `buildProductionMedia` wires a single media gateway at boot, but the media
 * quota is per-user — so the AGENT_REQUEST handler binds THIS factory to the
 * authenticated userId/planId from the (plaintext, server-set) request envelope
 * and overrides the gateway's budgetClient per request. Each call closes over
 * its own user context, so concurrent agent turns never cross-charge.
 *
 * reserve → broker reserve (FAIL CLOSED on no user context or broker error, so
 * generation cannot proceed unmetered). reconcile → broker reconcile,
 * best-effort (settlement failures are bounded by the server-side hold TTL; the
 * media-executor already treats reconcile as best-effort).
 */
import {
  reserveMediaBudget,
  reconcileMediaBudget,
} from './media-quota-client.js';
import type { RunMediaSubtaskDeps } from './orchestrator/media-executor';

type BudgetClient = RunMediaSubtaskDeps['budgetClient'];

export interface MediaBudgetUserContext {
  userId: string;
  planId: string;
}

export function createMediaBudgetClient(
  ctx: MediaBudgetUserContext,
): BudgetClient {
  return {
    reserve: async ({ mediaJobId, quotaUnits, providerId, modelId, routeKind }) => {
      // No authenticated user ⇒ cannot meter ⇒ fail closed without a broker
      // round-trip. (Authed AGENT_REQUESTs always carry a userId; this guards
      // the degenerate path.)
      if (!ctx.userId) {
        return { ok: false, reason: 'MEDIA_BUDGET_USER_CONTEXT_MISSING' };
      }
      return reserveMediaBudget({
        op: 'reserve',
        userId: ctx.userId,
        planId: ctx.planId,
        mediaJobId,
        quotaUnits,
        providerId,
        modelId,
        // The caller (media-executor) sets this per operation so the server
        // picks the right per-kind cap: image_generate → image caps,
        // video_generate/video_render → video caps. Forwarding the hardcoded
        // image kind would (mis)charge video jobs against the image budget.
        routeKind,
      });
    },
    reconcile: async ({ holdId, status, actualQuotaUnits, billingReceiptId }) => {
      if (!ctx.userId) return;
      await reconcileMediaBudget({
        op: 'reconcile',
        userId: ctx.userId,
        holdId,
        status,
        ...(actualQuotaUnits !== undefined ? { actualQuotaUnits } : {}),
        ...(billingReceiptId ? { billingReceiptId } : {}),
      });
    },
  };
}
