import { z } from 'zod';
import { MediaBudgetReconcileStatusSchema } from './media-budget';

/**
 * Enclave↔host video-checkpoint RPC contract (durable checkpoint store).
 *
 * The Nitro enclave is stateless — TEE memory is zeroed after every request — so
 * the long-running video-generation checkpoint (pending_start → provider_started
 * → cancelled / billing_pending → terminal) MUST be server-backed. The enclave
 * cannot present a user session, so the orchestrator's checkpointClient issues
 * this RPC to a host-local video-checkpoint broker (vsock 8105), which forwards
 * it to the server's service-authed internal /internal/video-checkpoint endpoints.
 * The broker speaks line-framed JSON (like the keys / cred / registry / skills /
 * media-quota brokers), so this contract is JSON — chat-types remains the single
 * source of truth for the shape.
 *
 * ONLY job-control metadata crosses this boundary — opaque ids, the provider /
 * model id, the local idempotency key, a provenance snapshot hash, and billing
 * bookkeeping timestamps. NO prompt / image bytes / user content ever crosses it
 * (those stay in the enclave handle store), so this is the same metadata class
 * as the plaintext MediaQuotaHold row.
 *
 * User-scoped ops (load / save_pending_start / save_provider_job / mark_cancelled
 * / mark_billing_pending) carry the explicit userId the enclave received in the
 * authenticated AGENT_REQUEST envelope. Reconciler ops (list_* / mark_terminal /
 * mark_billing_sla_escalated / reconcile_hold) are global — they run on a timer
 * with no user context and enumerate by checkpoint state across jobs.
 */

// ── checkpoint state (the load() return shape) ──────────────────────────────

export const VideoCheckpointStateSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('pending_start'),
      providerId: z.string().min(1).max(64),
      modelId: z.string().min(1).max(128),
      localIdempotencyKey: z.string().min(1).max(128),
      provenanceSnapshotHash: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      state: z.literal('provider_started'),
      providerId: z.string().min(1).max(64),
      modelId: z.string().min(1).max(128),
      providerJobId: z.string().min(1).max(512),
      provenanceSnapshotHash: z.string().min(1).max(128),
    })
    .strict(),
]);
export type VideoCheckpointState = z.infer<typeof VideoCheckpointStateSchema>;

export const VideoCheckpointTerminalStateSchema = z.enum(['debited', 'released']);
export type VideoCheckpointTerminalState = z.infer<typeof VideoCheckpointTerminalStateSchema>;

// ── request ops ─────────────────────────────────────────────────────────────

const LoadRequestSchema = z
  .object({
    op: z.literal('load'),
    userId: z.string().min(1).max(128),
    mediaJobId: z.string().min(1).max(128),
  })
  .strict();

const SavePendingStartRequestSchema = z
  .object({
    op: z.literal('save_pending_start'),
    userId: z.string().min(1).max(128),
    mediaJobId: z.string().min(1).max(128),
    localIdempotencyKey: z.string().min(1).max(128),
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128),
    provenanceSnapshotHash: z.string().min(1).max(128),
  })
  .strict();

const SaveProviderJobRequestSchema = z
  .object({
    op: z.literal('save_provider_job'),
    userId: z.string().min(1).max(128),
    mediaJobId: z.string().min(1).max(128),
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128),
    providerJobId: z.string().min(1).max(512),
    provenanceSnapshotHash: z.string().min(1).max(128).optional(),
  })
  .strict();

const MarkCancelledRequestSchema = z
  .object({
    op: z.literal('mark_cancelled'),
    userId: z.string().min(1).max(128),
    mediaJobId: z.string().min(1).max(128),
    providerJobId: z.string().min(1).max(512).optional(),
  })
  .strict();

const MarkBillingPendingRequestSchema = z
  .object({
    op: z.literal('mark_billing_pending'),
    userId: z.string().min(1).max(128),
    mediaJobId: z.string().min(1).max(128),
    providerJobId: z.string().min(1).max(512),
    observedAt: z.string().datetime(),
  })
  .strict();

const ListCancelledPendingRequestSchema = z
  .object({
    op: z.literal('list_cancelled_pending'),
    limit: z.number().int().positive().max(200),
  })
  .strict();

const ListBillingPendingRequestSchema = z
  .object({
    op: z.literal('list_billing_pending'),
    limit: z.number().int().positive().max(200),
  })
  .strict();

const MarkBillingSlaEscalatedRequestSchema = z
  .object({
    op: z.literal('mark_billing_sla_escalated'),
    mediaJobId: z.string().min(1).max(128),
    alertedAt: z.string().datetime(),
    providerDisabledAt: z.string().datetime(),
  })
  .strict();

const MarkTerminalRequestSchema = z
  .object({
    op: z.literal('mark_terminal'),
    mediaJobId: z.string().min(1).max(128),
    terminalState: VideoCheckpointTerminalStateSchema,
  })
  .strict();

const ReconcileHoldRequestSchema = z
  .object({
    op: z.literal('reconcile_hold'),
    holdId: z.string().min(1).max(128),
    status: MediaBudgetReconcileStatusSchema,
    actualQuotaUnits: z.number().int().nonnegative().max(1_000_000).optional(),
    billingReceiptId: z.string().min(1).max(256).optional(),
  })
  .strict();

/**
 * Operator-alert payload — the SINGLE SOURCE OF TRUTH for the reconciler's
 * `emitOperatorAlert` wire shape. MUST stay in lockstep with the inline union
 * in `reconcileCancelledProviderCompletions` (enclave/src/orchestrator/
 * media-executor.ts): the enclave reconciler can't reach an operator channel
 * directly (no egress), so it forwards each alert over the same vsock-8105
 * broker as a global `operator_alert` op; the server logs it durably and
 * best-effort fans it out to an operator webhook (Slack / PagerDuty / Sentry).
 *
 * Only operational metadata crosses this boundary — opaque ids, the provider /
 * model id, timestamps, integer counts, and a bounded enclave-internal error
 * string. NO prompt / asset / user content (the strict objects reject any
 * smuggled key, same as every other op).
 */
const VideoOperatorAlertSchema = z.union([
  z
    .object({
      code: z.literal('VIDEO_BILLING_METADATA_SLA_EXCEEDED'),
      mediaJobId: z.string().min(1).max(128),
      providerId: z.string().min(1).max(64),
      providerJobId: z.string().min(1).max(512),
      firstBillingPendingAt: z.string().datetime(),
      billingPendingPollCount: z.number().int().nonnegative().max(1_000_000),
    })
    .strict(),
  z
    .object({
      code: z.enum([
        'VIDEO_RECONCILER_POLL_FAILED',
        'VIDEO_RECONCILER_SETTLEMENT_FAILED',
        'VIDEO_RECONCILER_ADAPTER_MISSING',
        'VIDEO_RECONCILER_SENTINEL_RETIRED',
      ]),
      mediaJobId: z.string().min(1).max(128),
      providerId: z.string().min(1).max(64),
      providerJobId: z.string().min(1).max(512),
      errorMessage: z.string().min(1).max(512),
    })
    .strict(),
]);
export type VideoOperatorAlert = z.infer<typeof VideoOperatorAlertSchema>;

const OperatorAlertRequestSchema = z
  .object({
    op: z.literal('operator_alert'),
    alert: VideoOperatorAlertSchema,
  })
  .strict();

export const VideoCheckpointRequestSchema = z.discriminatedUnion('op', [
  LoadRequestSchema,
  SavePendingStartRequestSchema,
  SaveProviderJobRequestSchema,
  MarkCancelledRequestSchema,
  MarkBillingPendingRequestSchema,
  ListCancelledPendingRequestSchema,
  ListBillingPendingRequestSchema,
  MarkBillingSlaEscalatedRequestSchema,
  MarkTerminalRequestSchema,
  ReconcileHoldRequestSchema,
  OperatorAlertRequestSchema,
]);
export type VideoCheckpointRequest = z.infer<typeof VideoCheckpointRequestSchema>;

// ── result shapes ─────────────────────────────────────────────────────────────

export const VideoCheckpointLoadResultSchema = z.union([
  z.object({ ok: z.literal(true), checkpoint: VideoCheckpointStateSchema.nullable() }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1).max(128) }).strict(),
]);
export type VideoCheckpointLoadResult = z.infer<typeof VideoCheckpointLoadResultSchema>;

export const VideoCheckpointWriteResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1).max(128) }).strict(),
]);
export type VideoCheckpointWriteResult = z.infer<typeof VideoCheckpointWriteResultSchema>;

const CancelledPendingJobSchema = z
  .object({
    mediaJobId: z.string().min(1).max(128),
    providerId: z.string().min(1).max(64),
    providerJobId: z.string().min(1).max(512),
    holdId: z.string().min(1).max(128),
  })
  .strict();

const BillingPendingJobSchema = z
  .object({
    mediaJobId: z.string().min(1).max(128),
    providerId: z.string().min(1).max(64),
    providerJobId: z.string().min(1).max(512),
    holdId: z.string().min(1).max(128),
    firstBillingPendingAt: z.string().datetime(),
    billingPendingPollCount: z.number().int().nonnegative().max(1_000_000),
    slaAlertedAt: z.string().datetime().optional(),
  })
  .strict();

export const VideoCheckpointCancelledListResultSchema = z.union([
  z.object({ ok: z.literal(true), jobs: z.array(CancelledPendingJobSchema).max(200) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1).max(128) }).strict(),
]);
export type VideoCheckpointCancelledListResult = z.infer<
  typeof VideoCheckpointCancelledListResultSchema
>;

export const VideoCheckpointBillingListResultSchema = z.union([
  z.object({ ok: z.literal(true), jobs: z.array(BillingPendingJobSchema).max(200) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1).max(128) }).strict(),
]);
export type VideoCheckpointBillingListResult = z.infer<
  typeof VideoCheckpointBillingListResultSchema
>;

// ── codecs ─────────────────────────────────────────────────────────────────────

/**
 * Generous JSON-envelope cap. Requests are tiny (ids + integers), but list
 * RESPONSES carry up to 200 jobs of metadata — sized to hold the worst case.
 */
export const MAX_VIDEO_CHECKPOINT_RPC_BYTES = 256 * 1024;

function assertSize(bytes: Buffer | Uint8Array): void {
  if (bytes.byteLength > MAX_VIDEO_CHECKPOINT_RPC_BYTES) {
    throw new Error(
      `VIDEO_CHECKPOINT RPC too large: ${bytes.byteLength} bytes (max ${MAX_VIDEO_CHECKPOINT_RPC_BYTES})`,
    );
  }
}

function encodeWith<T>(schema: z.ZodType<T>, value: T): Buffer {
  const parsed = schema.parse(value);
  const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
  assertSize(bytes);
  return bytes;
}

function decodeWith<T>(schema: z.ZodType<T>, bytes: Buffer | Uint8Array): T {
  assertSize(bytes);
  return schema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
}

export function encodeVideoCheckpointRequest(req: VideoCheckpointRequest): Buffer {
  return encodeWith(VideoCheckpointRequestSchema, req);
}
export function decodeVideoCheckpointRequest(bytes: Buffer | Uint8Array): VideoCheckpointRequest {
  return decodeWith(VideoCheckpointRequestSchema, bytes);
}

export function encodeVideoCheckpointLoadResult(result: VideoCheckpointLoadResult): Buffer {
  return encodeWith(VideoCheckpointLoadResultSchema, result);
}
export function decodeVideoCheckpointLoadResult(
  bytes: Buffer | Uint8Array,
): VideoCheckpointLoadResult {
  return decodeWith(VideoCheckpointLoadResultSchema, bytes);
}

export function encodeVideoCheckpointWriteResult(result: VideoCheckpointWriteResult): Buffer {
  return encodeWith(VideoCheckpointWriteResultSchema, result);
}
export function decodeVideoCheckpointWriteResult(
  bytes: Buffer | Uint8Array,
): VideoCheckpointWriteResult {
  return decodeWith(VideoCheckpointWriteResultSchema, bytes);
}

export function encodeVideoCheckpointCancelledListResult(
  result: VideoCheckpointCancelledListResult,
): Buffer {
  return encodeWith(VideoCheckpointCancelledListResultSchema, result);
}
export function decodeVideoCheckpointCancelledListResult(
  bytes: Buffer | Uint8Array,
): VideoCheckpointCancelledListResult {
  return decodeWith(VideoCheckpointCancelledListResultSchema, bytes);
}

export function encodeVideoCheckpointBillingListResult(
  result: VideoCheckpointBillingListResult,
): Buffer {
  return encodeWith(VideoCheckpointBillingListResultSchema, result);
}
export function decodeVideoCheckpointBillingListResult(
  bytes: Buffer | Uint8Array,
): VideoCheckpointBillingListResult {
  return decodeWith(VideoCheckpointBillingListResultSchema, bytes);
}
