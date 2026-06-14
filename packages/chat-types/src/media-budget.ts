import { z } from 'zod';

/**
 * Enclave↔host media-budget RPC contract (hard metering).
 *
 * The enclave cannot present a user session, so it cannot call the server's
 * session-authed /media-quota route directly. Instead the orchestrator's media
 * budgetClient issues this RPC to a host-local media-quota broker (vsock), which
 * forwards it to the server's service-authed internal media-quota endpoints
 * carrying the explicit userId/planId the enclave received in the (authenticated)
 * AGENT_REQUEST envelope. The broker speaks line-framed JSON (like the keys /
 * cred / registry brokers), so this contract is JSON, not the CBOR vsock frame
 * protocol — chat-types remains the single source of truth for the shape.
 *
 * No plaintext / prompt / content ever crosses this boundary — only opaque ids,
 * the plan tier, and integer quota units.
 */

export const MediaBudgetRouteKindSchema = z.enum([
  'image_generate',
  'video_generate',
  'video_render',
]);
export type MediaBudgetRouteKind = z.infer<typeof MediaBudgetRouteKindSchema>;

export const MediaBudgetReconcileStatusSchema = z.enum([
  'released',
  'debited',
  'cancelled_pending_provider',
  'cancelled_unbilled',
  'billing_pending_provider',
]);
export type MediaBudgetReconcileStatus = z.infer<
  typeof MediaBudgetReconcileStatusSchema
>;

export const MediaBudgetReserveRequestSchema = z
  .object({
    op: z.literal('reserve'),
    userId: z.string().min(1).max(128),
    planId: z.string().min(1).max(64),
    mediaJobId: z.string().min(1).max(128),
    quotaUnits: z.number().int().positive().max(1_000_000),
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128),
    routeKind: MediaBudgetRouteKindSchema.default('image_generate'),
  })
  .strict();
export type MediaBudgetReserveRequest = z.infer<
  typeof MediaBudgetReserveRequestSchema
>;

export const MediaBudgetReconcileRequestSchema = z
  .object({
    op: z.literal('reconcile'),
    userId: z.string().min(1).max(128),
    holdId: z.string().min(1).max(128),
    status: MediaBudgetReconcileStatusSchema,
    actualQuotaUnits: z.number().int().nonnegative().max(1_000_000).optional(),
    billingReceiptId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type MediaBudgetReconcileRequest = z.infer<
  typeof MediaBudgetReconcileRequestSchema
>;

export const MediaBudgetRequestSchema = z.discriminatedUnion('op', [
  MediaBudgetReserveRequestSchema,
  MediaBudgetReconcileRequestSchema,
]);
export type MediaBudgetRequest = z.infer<typeof MediaBudgetRequestSchema>;
/** Encoder input: `routeKind` may be omitted (defaults to image_generate). */
export type MediaBudgetRequestInput = z.input<typeof MediaBudgetRequestSchema>;

export const MediaBudgetReserveResultSchema = z.union([
  z.object({ ok: z.literal(true), holdId: z.string().min(1).max(128) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1).max(128) }).strict(),
]);
export type MediaBudgetReserveResult = z.infer<
  typeof MediaBudgetReserveResultSchema
>;

export const MediaBudgetReconcileResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1).max(128) }).strict(),
]);
export type MediaBudgetReconcileResult = z.infer<
  typeof MediaBudgetReconcileResultSchema
>;

/** Generous JSON-envelope cap; the payload is only ids + integers. */
export const MAX_MEDIA_BUDGET_RPC_BYTES = 2048;

function assertSize(bytes: Buffer | Uint8Array): void {
  if (bytes.byteLength > MAX_MEDIA_BUDGET_RPC_BYTES) {
    throw new Error(
      `MEDIA_BUDGET RPC too large: ${bytes.byteLength} bytes (max ${MAX_MEDIA_BUDGET_RPC_BYTES})`,
    );
  }
}

export function encodeMediaBudgetRequest(req: MediaBudgetRequestInput): Buffer {
  const parsed = MediaBudgetRequestSchema.parse(req);
  const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
  assertSize(bytes);
  return bytes;
}

export function decodeMediaBudgetRequest(
  bytes: Buffer | Uint8Array,
): MediaBudgetRequest {
  assertSize(bytes);
  return MediaBudgetRequestSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
}

export function encodeMediaBudgetReserveResult(
  result: MediaBudgetReserveResult,
): Buffer {
  const parsed = MediaBudgetReserveResultSchema.parse(result);
  const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
  assertSize(bytes);
  return bytes;
}

export function decodeMediaBudgetReserveResult(
  bytes: Buffer | Uint8Array,
): MediaBudgetReserveResult {
  assertSize(bytes);
  return MediaBudgetReserveResultSchema.parse(
    JSON.parse(Buffer.from(bytes).toString('utf8')),
  );
}

export function encodeMediaBudgetReconcileResult(
  result: MediaBudgetReconcileResult,
): Buffer {
  const parsed = MediaBudgetReconcileResultSchema.parse(result);
  const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
  assertSize(bytes);
  return bytes;
}

export function decodeMediaBudgetReconcileResult(
  bytes: Buffer | Uint8Array,
): MediaBudgetReconcileResult {
  assertSize(bytes);
  return MediaBudgetReconcileResultSchema.parse(
    JSON.parse(Buffer.from(bytes).toString('utf8')),
  );
}
