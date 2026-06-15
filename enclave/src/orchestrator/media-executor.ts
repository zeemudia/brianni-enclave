import { createHash, randomUUID } from "node:crypto";
import type {
  AgentLinkedFolderContext,
  AgentSubtask,
  BinaryWorkItemToolName,
  MediaArtifactKind,
  MediaBudgetRouteKind,
  MediaProvenanceRecord,
  ProviderVisibleInputConsent,
  ModelRouteDecision,
  ToolResultFrame,
  VideoCompositionSpec,
} from "@calypso/chat-types";
import {
  createMediaJobIds,
  createProvenanceRecord,
  estimateVideoQuotaUnits,
  evaluateRenderCustody,
  prepareProviderVisibleInput,
  reserveVideoBudget,
  validateVideoCompositionAgainstProvenance,
  verifyProviderVisibleInputConsent,
  verifyProvenanceRecord,
  type ConsentVerifier,
  type MediaHandleStore,
  type ProvenanceSigner,
} from "../media";
import {
  verifyRenderAttestation,
  verifySignedRenderManifest,
  type RenderAttestationPolicy,
} from "../media/render-attestation";
import type { RenderBackend } from "../media/render-backend";
import type { VideoProviderAdapter } from "../media/video-provider";
import type {
  ImageInputMimeType,
  ImageOutputMimeType,
  ImageProviderAdapter,
} from "../media/image-provider";
import type { BinaryWorkItemManager } from "../tools/binary-work-items";
import type { AgentLoopEvent } from "../agent/loop";
import type { OrchestratorExecutorEvent } from "./events";

// The image delivery path yields a `binary-write-request` AgentLoopEvent (so the
// index.ts wire pump emits the write_request + chunk frames to the client) and
// then awaits the client write ACK — exactly how a worker's image.transform
// binary output is delivered. The media generator therefore yields this AgentLoopEvent
// variant alongside its OrchestratorExecutorEvents.
type BinaryWriteRequestEvent = Extract<
  AgentLoopEvent,
  { kind: "binary-write-request" }
>;
type ClientOnlyBinaryWrite = BinaryWriteRequestEvent["payload"];

export type RunMediaSubtaskEvent =
  | OrchestratorExecutorEvent
  | BinaryWriteRequestEvent;

export interface RunMediaSubtaskDeps {
  agentTurnId: string;
  planId: string;
  subtask: AgentSubtask;
  route: ModelRouteDecision;
  videoAdapters: Record<string, VideoProviderAdapter>;
  // Synchronous image generation/edit adapters, keyed by providerId. Mirrors
  // videoAdapters; an image subtask routes to imageAdapters[route.providerId].
  imageAdapters?: Record<string, ImageProviderAdapter>;
  // ── Image-generate binary delivery (mirrors how image.transform delivers) ──
  // A generated image is a file: it is delivered through the SAME binary
  // write-ACK path a media worker uses — write to the linked folder behind the
  // client's "Ask before saving" confirmation. `binaryWorkItems` mints the
  // write request + chunks; `awaitBinaryWriteAck` registers the per-invocation
  // resolver and blocks until the client ACKs (matches AgentLoopDeps's field).
  // `linkedFolders` is the destination context (the first `granted` folder is
  // the target). `sessionId` keys the binary work item so the ACK round-trips.
  binaryWorkItems?: BinaryWorkItemManager;
  awaitBinaryWriteAck?: (
    payload: ClientOnlyBinaryWrite,
  ) => Promise<ToolResultFrame>;
  linkedFolders?: readonly AgentLinkedFolderContext[];
  sessionId?: string;
  abortSignal?: AbortSignal;
  now?: Date;
  createJobNonce?: (mediaJobId: string) => string;
  maxProviderPolls?: number;
  providerPollDelayMs?: number;
  providerInput?: {
    promptHandleId: string;
    inputHandleIds: string[];
    enclaveNonce: string;
    pinnedSignerKeyId: string;
    revokedSignerKeyIds: ReadonlySet<string>;
    consent?: ProviderVisibleInputConsent;
    seenConsentIds: Set<string>;
  };
  handleStore?: MediaHandleStore;
  provenanceSigner?: ProvenanceSigner;
  consentVerifier?: ConsentVerifier;
  budgetClient: {
    reserve(input: {
      mediaJobId: string;
      quotaUnits: number;
      providerId: string;
      modelId: string;
      // Per-operation media kind so the server applies the correct per-kind
      // quota cap (image_generate → image caps; video_* → video caps). The
      // image branch passes image_generate; the video branch passes a video
      // kind via reserveVideoBudget. Omitting it would charge video jobs
      // against the image budget.
      routeKind: MediaBudgetRouteKind;
    }): Promise<{ ok: true; holdId: string } | { ok: false; reason: string }>;
    reconcile(input: {
      holdId: string;
      status:
        | "released"
        | "debited"
        | "cancelled_pending_provider"
        | "cancelled_unbilled"
        | "billing_pending_provider";
      actualQuotaUnits?: number;
      billingReceiptId?: string;
    }): Promise<void>;
  };
  checkpointClient: {
    load(input: { mediaJobId: string }): Promise<
      | {
          state: "pending_start";
          providerId: string;
          modelId: string;
          localIdempotencyKey: string;
          provenanceSnapshotHash: string;
        }
      | {
          state: "provider_started";
          providerId: string;
          modelId: string;
          providerJobId: string;
          provenanceSnapshotHash: string;
        }
      | {
          // Provider finished + hold ALREADY debited (we bill on the irreversible
          // generation, not the client's delivery ACK), but the bytes were not
          // confirmed delivered. Resuming this re-polls the provider job and
          // re-delivers the already-paid asset WITHOUT reserving or debiting
          // again.
          state: "delivery_pending";
          providerId: string;
          modelId: string;
          providerJobId: string;
          provenanceSnapshotHash: string;
        }
      | null
    >;
    savePendingStart(input: {
      mediaJobId: string;
      localIdempotencyKey: string;
      providerId: string;
      modelId: string;
      provenanceSnapshotHash: string;
    }): Promise<void>;
    saveProviderJob(input: {
      mediaJobId: string;
      providerId: string;
      modelId: string;
      providerJobId: string;
      provenanceSnapshotHash?: string;
    }): Promise<void>;
    markCancelled(input: { mediaJobId: string; providerJobId?: string }): Promise<void>;
    markBillingPending(input: {
      mediaJobId: string;
      providerJobId: string;
      observedAt: string;
    }): Promise<void>;
    // Transition provider_started → delivery_pending: the provider produced the
    // asset and the hold is debited, but delivery to the client is unconfirmed.
    // `deliveredPendingAt` stamps the server-side re-delivery TTL; an expired row
    // is GC'd with no refund (already billed). Optional so existing fakes/clients
    // that predate re-delivery still satisfy the type.
    markDeliveryPending?(input: {
      mediaJobId: string;
      providerJobId: string;
      deliveredPendingAt: string;
    }): Promise<void>;
    // User-scoped list of the caller's billed-but-undelivered video jobs, for the
    // honest-user re-delivery path (see orchestrator/media-redeliver.ts). Optional
    // so fakes/clients that predate re-delivery still satisfy the type.
    listUserDeliveryPending?(input: { limit: number }): Promise<
      Array<{
        mediaJobId: string;
        providerId: string;
        modelId: string;
        providerJobId: string;
        provenanceSnapshotHash: string;
      }>
    >;
    listCancelledPending(input: { limit: number }): Promise<
      Array<{ mediaJobId: string; providerId: string; providerJobId: string; holdId: string }>
    >;
    listBillingPending(input: { limit: number }): Promise<
      Array<{
        mediaJobId: string;
        providerId: string;
        providerJobId: string;
        holdId: string;
        firstBillingPendingAt: string;
        billingPendingPollCount: number;
        slaAlertedAt?: string;
      }>
    >;
    // GLOBAL observability list (no userId) for the reconciler's stale-delivery
    // monitor: the total count of billed-but-undelivered video jobs that have been
    // delivery_pending longer than `olderThanMs`, plus a bounded exemplar sample.
    // Optional so fakes/clients that predate the monitor still satisfy the type.
    listStuckDeliveryPending?(input: { olderThanMs: number; limit: number }): Promise<{
      count: number;
      sample: Array<{ mediaJobId: string; providerId: string; deliveredPendingAt: string }>;
    }>;
    markBillingSlaEscalated(input: {
      mediaJobId: string;
      alertedAt: string;
      providerDisabledAt: string;
    }): Promise<void>;
    markTerminal(input: {
      mediaJobId: string;
      terminalState: "debited" | "released";
    }): Promise<void>;
  };
  compositionSpec?: VideoCompositionSpec;
  recordsByHandleId?: Map<string, MediaProvenanceRecord>;
  renderBackend?: RenderBackend;
  renderAttestationPolicy?: RenderAttestationPolicy;
  verifyRenderManifestSignature?: (
    payload: Uint8Array,
    signature: string,
    signerKeyId: string,
  ) => boolean;
  encryptArtifact(input: {
    bytes: Uint8Array;
    mimeType: MediaArtifactKind;
    title: string;
  }): Promise<{ artifactId: string; ciphertextRef: string; sha256: string; byteSize: number }>;
}

// Sentinel providerJobId written into the cancelled checkpoint when an
// unrecoverable pending_start route-mismatch GCs the row. The reconciler
// recognises this prefix and transitions the row to `released` without
// calling the (typically missing) adapter, so the worklist cannot grow
// monotonically.
export const PENDING_START_UNRECOVERABLE_SENTINEL = "unknown:pending_start_unrecoverable";

// Sentinel prefix written when a `provider_started` route mismatch
// discovers the checkpoint's adapter is no longer registered. The real
// provider job id is preserved inside the sentinel for operator forensics,
// but the reconciler recognises the prefix and short-circuits to terminal
// without trying to poll an adapter that does not exist.
export const PROVIDER_STARTED_UNREACHABLE_SENTINEL_PREFIX = "unreachable:provider_started:";

// Fixed quota estimate per generated image (no per-request billing metadata
// like video operations expose). The adapter returns the actual units for the
// reconcile; this is the up-front hold.
const IMAGE_GENERATE_QUOTA_UNITS = 4;
// Output artifacts (generated images) live in the same short-lived custody
// window as other generated media.
const GENERATED_MEDIA_TTL_SECONDS = 3600;

export async function* runMediaSubtask(
  deps: RunMediaSubtaskDeps,
): AsyncGenerator<RunMediaSubtaskEvent> {
  // Image generation/edit is synchronous (single provider call, no job/poll/
  // checkpoint machinery) so it takes a dedicated branch BEFORE the
  // video-only guard below.
  if (deps.subtask.kind === "image") {
    yield* runGenerateImageSubtask(deps);
    return;
  }
  if (deps.subtask.kind !== "video") {
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: "MEDIA_OPERATION_UNSUPPORTED",
    };
    return;
  }
  if (deps.subtask.media?.operation === "video_render") {
    yield* runRenderVideoSubtask(deps);
    return;
  }
  if (deps.subtask.media?.operation !== "video_generate") {
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: "MEDIA_OPERATION_UNSUPPORTED",
    };
    return;
  }
  const ids = createMediaJobIds({
    agentTurnId: deps.agentTurnId,
    planId: deps.planId,
    subtaskId: deps.subtask.id,
  });
  let existingCheckpoint = await deps.checkpointClient.load({
    mediaJobId: ids.mediaJobId,
  });
  // The checkpoint is the source of truth for which provider/model a resumed
  // job belongs to. The route's providerId reflects whatever the router
  // picked on the resumed turn, which may have changed (registry update,
  // fallback model). Polling provider B with provider A's job id either
  // discards the in-flight job (best case) or returns a colliding result
  // (worst case). When a checkpoint exists, pin the adapter to it and
  // refuse if it disagrees with the current route.
  const effectiveProviderId = existingCheckpoint?.providerId ?? deps.route.providerId;
  const effectiveModelId = existingCheckpoint?.modelId ?? deps.route.modelId;
  if (
    existingCheckpoint &&
    existingCheckpoint.state !== "delivery_pending" &&
    (existingCheckpoint.providerId !== deps.route.providerId ||
      existingCheckpoint.modelId !== deps.route.modelId)
  ) {
    // A delivery_pending resume is exempt: there is no in-flight provider job to
    // clean up (it already finished + was billed), and the re-delivery re-polls
    // the SAME job via the checkpoint-pinned adapter (effectiveProviderId), so a
    // changed route is irrelevant.
    // If a provider job is already running upstream we MUST clean it up
    // using the CHECKPOINT'S adapter — the new route's adapter cannot poll
    // or cancel a job that belongs to a different provider. Without this,
    // the upstream compute + its (already-reserved) budget hold leak. The
    // reconciler keys off `markCancelled` rows, so persist that BEFORE
    // attempting provider-side cancel; if `markCancelled` throws we cannot
    // safely confirm the cleanup either way and we still raise the
    // route-mismatch alarm.
    const checkpointAdapter = deps.videoAdapters[existingCheckpoint.providerId];
    let mismatchDetail = "PROVIDER_RESUME_ROUTE_MISMATCH";
    let providerJobIdToCancel: string | null = null;
    if (existingCheckpoint.state === "provider_started") {
      if (!checkpointAdapter) {
        // Without a checkpoint adapter we cannot cancel upstream and the
        // reconciler also cannot poll the row. Encode the real provider
        // job id inside a sentinel so the reconciler short-circuits the
        // row to terminal `released` on its next sweep without an adapter.
        // The upstream provider job is orphaned and is recoverable only
        // via operator forensics on the original providerJobId encoded in
        // the sentinel suffix; the user's quota hold is released as soon
        // as the reconciler sees the sentinel row, not on TTL expiry.
        providerJobIdToCancel = `${PROVIDER_STARTED_UNREACHABLE_SENTINEL_PREFIX}${existingCheckpoint.providerJobId}`;
        mismatchDetail = "PROVIDER_RESUME_ROUTE_MISMATCH_PROVIDER_STARTED_UNREACHABLE";
      } else {
        providerJobIdToCancel = existingCheckpoint.providerJobId;
      }
    } else if (existingCheckpoint.state === "pending_start") {
      // pending_start can still have a live provider-side job: the original
      // turn wrote savePendingStart, called adapter.start (which may have
      // succeeded server-side), and then crashed before saveProviderJob.
      // Probe the checkpoint adapter for the lost operation; if found, clean
      // it up the same way provider_started is cleaned up.
      if (!checkpointAdapter || !checkpointAdapter.recoverPendingStart) {
        // Structurally unrecoverable — the adapter is gone or does not
        // implement recoverPendingStart. This is precisely the case where
        // an orphan upstream job is most likely permanent; surface it so
        // operators see the irreducible leak window.
        mismatchDetail = "PROVIDER_RESUME_ROUTE_MISMATCH_PENDING_START_UNRECOVERABLE";
      } else {
        try {
          const recovered = await checkpointAdapter.recoverPendingStart({
            mediaJobId: ids.mediaJobId,
            localIdempotencyKey: existingCheckpoint.localIdempotencyKey,
            modelId: existingCheckpoint.modelId,
            abortSignal: deps.abortSignal,
          });
          if (recovered.status === "found") {
            providerJobIdToCancel = recovered.providerJobId;
          } else {
            // Treat anything other than `found` — `unavailable`,
            // `not_found_verified`, or any future status the contract
            // grows — as unrecoverable for GC purposes. Without this
            // the pending_start row would loop forever blocked on the
            // same route mismatch.
            mismatchDetail = "PROVIDER_RESUME_ROUTE_MISMATCH_PENDING_START_UNRECOVERABLE";
          }
        } catch {
          mismatchDetail = "PROVIDER_RESUME_ROUTE_MISMATCH_PENDING_START_UNRECOVERABLE";
        }
      }
    }
    if (providerJobIdToCancel) {
      // Track whether markCancelled actually persisted so the emitted detail
      // tells operators whether the reconciler will be able to re-attach
      // the hold. Without this, the polling-loop abort path raises
      // PROVIDER_CANCEL_CHECKPOINT_UNAVAILABLE on the same failure mode but
      // the route-mismatch path stays silent.
      let checkpointMarked = false;
      try {
        await deps.checkpointClient.markCancelled({
          mediaJobId: ids.mediaJobId,
          providerJobId: providerJobIdToCancel,
        });
        checkpointMarked = true;
      } catch {
        // Reconciler may not see this job until markCancelled can be re-saved.
      }
      if (checkpointAdapter) {
        try {
          await checkpointAdapter.cancel?.({
            providerJobId: providerJobIdToCancel,
            abortSignal: deps.abortSignal,
          });
        } catch {
          // Provider may be unreachable; reconciler polls and settles
          // once markCancelled is durable.
        }
      }
      if (!checkpointMarked) {
        // Preserve the upstream-unreachable signal alongside the new
        // checkpoint-unavailable signal — operators paging on the route
        // mismatch alarm need to see the harder-to-recover orphan even
        // when a transient DB outage trips at the same time.
        mismatchDetail =
          mismatchDetail === "PROVIDER_RESUME_ROUTE_MISMATCH"
            ? "PROVIDER_RESUME_ROUTE_MISMATCH_CHECKPOINT_UNAVAILABLE"
            : `${mismatchDetail}+CHECKPOINT_UNAVAILABLE`;
      }
    }
    // Garbage-collect the checkpoint on the unrecoverable pending_start path
    // so the same row doesn't re-block every subsequent resume turn. Use a
    // sentinel providerJobId so `listCancelledPending` rows still bind to a
    // real string field — operators can filter on the sentinel.
    if (
      existingCheckpoint.state === "pending_start" &&
      mismatchDetail.includes("PENDING_START_UNRECOVERABLE") &&
      !providerJobIdToCancel
    ) {
      let gcWritten = false;
      try {
        await deps.checkpointClient.markCancelled({
          mediaJobId: ids.mediaJobId,
          providerJobId: PENDING_START_UNRECOVERABLE_SENTINEL,
        });
        gcWritten = true;
      } catch {
        // Failed write means the row will re-block every subsequent
        // resume. Compose the detail so operators can tell this case
        // apart from a clean GC in telemetry.
      }
      if (!gcWritten) {
        mismatchDetail = `${mismatchDetail}+CHECKPOINT_UNAVAILABLE`;
      }
    }
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "blocked",
      label: deps.subtask.title,
      detail: mismatchDetail,
    };
    return;
  }
  const adapter = deps.videoAdapters[effectiveProviderId];
  if (!adapter) {
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: "VIDEO_PROVIDER_ADAPTER_UNAVAILABLE",
    };
    return;
  }
  if (existingCheckpoint?.state === "pending_start") {
    const recovered =
      (await adapter.recoverPendingStart?.({
        mediaJobId: ids.mediaJobId,
        localIdempotencyKey: existingCheckpoint.localIdempotencyKey,
        modelId: effectiveModelId,
        abortSignal: deps.abortSignal,
      })) ?? { status: "unavailable" as const, reason: "PROVIDER_PENDING_START_RECOVERY_UNAVAILABLE" };
    if (recovered.status === "found") {
      await deps.checkpointClient.saveProviderJob({
        mediaJobId: ids.mediaJobId,
        providerId: effectiveProviderId,
        modelId: effectiveModelId,
        providerJobId: recovered.providerJobId,
        provenanceSnapshotHash: existingCheckpoint.provenanceSnapshotHash,
      });
      existingCheckpoint = {
        state: "provider_started",
        providerId: effectiveProviderId,
        modelId: effectiveModelId,
        providerJobId: recovered.providerJobId,
        provenanceSnapshotHash: existingCheckpoint.provenanceSnapshotHash,
      };
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "running",
        label: deps.subtask.title,
        detail: "PROVIDER_JOB_RECOVERED_FROM_PENDING_START",
      };
    } else if (recovered.status !== "not_found_verified") {
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "blocked",
        label: deps.subtask.title,
        detail: "PROVIDER_ORPHAN_RECONCILIATION_REQUIRED",
      };
      return;
    } else {
      existingCheckpoint = null;
    }
  }
  yield {
    kind: "orchestrator-media-job-progress",
    planId: deps.planId,
    subtaskId: deps.subtask.id,
    mediaJobId: ids.mediaJobId,
    status: "starting",
    label: deps.subtask.title,
  };

  // Billing follows the irreversible provider GENERATION, not the client's
  // delivery ACK. A resume whose checkpoint is already `delivery_pending` was
  // therefore billed on a prior attempt: it must NOT reserve or debit again — it
  // only re-polls the provider job and re-delivers the already-paid asset. In
  // that case `holdId` stays null and every hold settle below is a no-op.
  const alreadyBilled = existingCheckpoint?.state === "delivery_pending";
  let holdId: string | null = null;
  if (!alreadyBilled) {
    const estimate = estimateVideoQuotaUnits({
      providerId: effectiveProviderId,
      modelId: effectiveModelId,
      durationSeconds: deps.subtask.media.maxDurationSeconds ?? 8,
      width: 1080,
      height: 1920,
      audio: true,
      safetyMarginPercent: 30,
    });
    const hold = await reserveVideoBudget({
      mediaJobId: ids.mediaJobId,
      estimate,
      client: deps.budgetClient,
      routeKind: "video_generate",
    });
    if (!hold.ok) {
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "blocked",
        label: deps.subtask.title,
        detail: hold.reason,
      };
      return;
    }
    holdId = hold.holdId;
  }
  // Release the reserved hold iff one is held — a no-op on an already-billed
  // delivery_pending resume (nothing to refund; the asset is already paid).
  const releaseHold = async (): Promise<void> => {
    if (!holdId) return;
    await deps.budgetClient.reconcile({ holdId, status: "released" });
  };
  // Bill-on-generation state flags. Order is DEBIT FIRST, then markDeliveryPending,
  // so the invariant holds by construction: a `delivery_pending` row ALWAYS
  // corresponds to a settled (debited) hold. The retrieve/resume path treats
  // `delivery_pending` as already-paid and never re-debits, so this ordering is
  // what guarantees it can never re-deliver an UNPAID asset for free.
  //  • `debited` — the hold has been settled (debited). Set right after the
  //    reconcile succeeds. A throw after this point must never release or
  //    re-reconcile the hold, and never markBillingPending (which would strand
  //    the paid asset outside the recovery path).
  //  • `markedDeliveryPending` — the row is committed `delivery_pending`. Implies
  //    `debited` (it is set only after the debit).
  //  • `enteredBillingStage` — we entered the section but may not have finished
  //    the debit. If the DEBIT itself throws, `debited` stays false and NO
  //    delivery_pending row was created (it is written after the debit), so there
  //    is nothing to strand and no free-asset path — the catch just releases the
  //    still-held hold (no bill; the bytes have not shipped). Distinguishes this
  //    stage from an earlier poll-stage throw.
  let debited = false;
  let markedDeliveryPending = false;
  let enteredBillingStage = false;

  if (!deps.providerInput || !deps.handleStore || !deps.provenanceSigner || !deps.consentVerifier) {
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "error",
      label: deps.subtask.title,
      detail: "PROVIDER_VISIBLE_INPUTS_MISSING",
    };
    await releaseHold();
    return;
  }
  const providerInput = await prepareProviderVisibleInput({
    promptHandleId: deps.providerInput.promptHandleId,
    inputHandleIds: deps.providerInput.inputHandleIds,
    handleStore: deps.handleStore,
    recordsByHandleId: deps.recordsByHandleId ?? new Map(),
    signer: deps.provenanceSigner,
    now: deps.now ?? new Date(),
  });
  if (!providerInput.ok) {
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "blocked",
      label: deps.subtask.title,
      detail: providerInput.reason,
    };
    await releaseHold();
    return;
  }
  const existingProviderJobId =
    existingCheckpoint?.state === "provider_started" ||
    existingCheckpoint?.state === "delivery_pending"
      ? existingCheckpoint.providerJobId
      : null;
  const reservedHoldId = holdId;
  // Helper: when we have to short-circuit AFTER a provider job is already
  // running upstream, we cannot simply release the hold — the provider job
  // is still consuming compute and will eventually be billed. Mark the
  // checkpoint cancelled so the reconciler reattaches the hold once the
  // provider settles, attempt provider-side cancel, and report the hold as
  // cancelled_pending_provider rather than released.
  // Returns the outcome of the cleanup so callers can compose a precise
  // `+CHECKPOINT_UNAVAILABLE` suffix on their emitted detail when the
  // markCancelled write failed. The variant names are deliberately not
  // booleans — a future caller using these to decide whether to skip
  // follow-up work needs to distinguish "no upstream job existed" from
  // "checkpoint write succeeded" from "checkpoint write failed".
  type CleanupResult =
    | { result: "released" }
    | { result: "cancelled_pending_provider" }
    | { result: "checkpoint_unavailable" };
  async function detachUpstreamAndRelease(): Promise<CleanupResult> {
    if (!reservedHoldId) {
      // No hold to settle — an already-billed delivery_pending resume has
      // nothing to release or cancel (the prior attempt already debited).
      return { result: "released" };
    }
    if (!existingProviderJobId) {
      await deps.budgetClient.reconcile({ holdId: reservedHoldId, status: "released" });
      return { result: "released" };
    }
    // Resolve the cancel adapter from the checkpoint directly, not from the
    // closure's `adapter` variable. Today they are equal — the route-mismatch
    // guard above short-circuits any case where `effectiveProviderId` differs
    // from `existingCheckpoint.providerId` — but binding to the checkpoint
    // here means a future resume path that calls this helper after a route
    // change cannot silently cancel against the wrong provider's adapter.
    const cancelAdapter =
      existingCheckpoint && existingCheckpoint.state === "provider_started"
        ? deps.videoAdapters[existingCheckpoint.providerId]
        : adapter;
    // Record the cancelled checkpoint BEFORE attempting provider cancel, so
    // a thrown cancel call cannot orphan the job from the reconciler's view.
    // The reconciler keys off rows transitioned by `markCancelled`; if that
    // write fails the row stays in `provider_started` and the reconciler
    // cannot see it. In that case we MUST leave the hold as-is (held) so
    // its TTL still bounds the leak — flipping to `cancelled_pending_provider`
    // without a checkpoint row would strand the hold permanently.
    let checkpointWritten = false;
    try {
      await deps.checkpointClient.markCancelled({
        mediaJobId: ids.mediaJobId,
        providerJobId: existingProviderJobId,
      });
      checkpointWritten = true;
    } catch {
      checkpointWritten = false;
    }
    try {
      await cancelAdapter?.cancel?.({
        providerJobId: existingProviderJobId,
        abortSignal: deps.abortSignal,
      });
    } catch {
      // Provider may be unreachable. The cancelled checkpoint is already
      // persisted (best effort); the reconciler will poll the job and
      // settle the hold (debited or released) once the provider responds.
    }
    if (checkpointWritten) {
      await deps.budgetClient.reconcile({
        holdId: reservedHoldId,
        status: "cancelled_pending_provider",
      });
      return { result: "cancelled_pending_provider" };
    }
    // Hold remains `held`; its TTL expiry recovers quota and the
    // checkpoint can be rewritten on the next attempt.
    return { result: "checkpoint_unavailable" };
  }

  if (
    existingCheckpoint?.state === "provider_started" &&
    existingCheckpoint.provenanceSnapshotHash !== providerInput.provenanceSnapshotHash
  ) {
    const cleanup = await detachUpstreamAndRelease();
    const detail =
      cleanup.result === "checkpoint_unavailable"
        ? "PROVIDER_INPUT_PROVENANCE_SNAPSHOT_MISMATCH+CHECKPOINT_UNAVAILABLE"
        : "PROVIDER_INPUT_PROVENANCE_SNAPSHOT_MISMATCH";
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "blocked",
      label: deps.subtask.title,
      detail,
    };
    return;
  }
  if (providerInput.privateTainted) {
    const consent = deps.providerInput.consent;
    if (!consent) {
      const cleanup = await detachUpstreamAndRelease();
      const detail =
        cleanup.result === "checkpoint_unavailable"
          ? "PROVIDER_VISIBLE_INPUT_CONSENT_REQUIRED+CHECKPOINT_UNAVAILABLE"
          : "PROVIDER_VISIBLE_INPUT_CONSENT_REQUIRED";
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "waiting_for_consent",
        label: deps.subtask.title,
        detail,
      };
      return;
    }
    const consentResult = await verifyProviderVisibleInputConsent({
      consent,
      expected: {
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        providerId: effectiveProviderId,
        modelId: effectiveModelId,
        inputHandleSetHash: providerInput.inputHandleSetHash,
        enclaveNonce: deps.providerInput.enclaveNonce,
        pinnedSignerKeyId: deps.providerInput.pinnedSignerKeyId,
        revokedSignerKeyIds: deps.providerInput.revokedSignerKeyIds,
      },
      verifier: deps.consentVerifier,
      now: deps.now ?? new Date(),
      seenConsentIds: deps.providerInput.seenConsentIds,
    });
    if (!consentResult.ok) {
      const cleanup = await detachUpstreamAndRelease();
      const detail =
        cleanup.result === "checkpoint_unavailable"
          ? `${consentResult.reason}+CHECKPOINT_UNAVAILABLE`
          : consentResult.reason;
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "blocked",
        label: deps.subtask.title,
        detail,
      };
      return;
    }
  }

  let providerJobId: string | null = existingProviderJobId;
  let pendingStartSaved = false;
  try {
    if (
      existingCheckpoint?.state === "provider_started" ||
      existingCheckpoint?.state === "delivery_pending"
    ) {
      // Resume: the provider job already exists (a delivery_pending resume
      // re-polls the finished, already-paid job to re-download + re-deliver).
      // Never start a new job — that would double-generate and orphan the old.
      providerJobId = existingCheckpoint.providerJobId;
    } else {
      await deps.checkpointClient.savePendingStart({
        mediaJobId: ids.mediaJobId,
        localIdempotencyKey: ids.providerIdempotencyKey,
        providerId: effectiveProviderId,
        modelId: effectiveModelId,
        provenanceSnapshotHash: providerInput.provenanceSnapshotHash,
      });
      pendingStartSaved = true;
      const started = await adapter.start({
        modelId: effectiveModelId,
        prompt: providerInput.promptText,
        inputImageBytes: providerInput.inputImageBytes,
        localIdempotencyKey: ids.providerIdempotencyKey,
        durationSeconds: deps.subtask.media.maxDurationSeconds ?? 8,
        aspectRatio: "9:16",
        abortSignal: deps.abortSignal,
      });
      providerJobId = started.providerJobId;
      await deps.checkpointClient.saveProviderJob({
        mediaJobId: ids.mediaJobId,
        providerId: effectiveProviderId,
        modelId: effectiveModelId,
        providerJobId,
        provenanceSnapshotHash: providerInput.provenanceSnapshotHash,
      });
    }
    if (!providerJobId) {
      throw new Error("VIDEO_PROVIDER_JOB_ID_MISSING");
    }
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "running",
      label: deps.subtask.title,
    };
    const maxPolls = deps.maxProviderPolls ?? 120;
    let result: Awaited<ReturnType<VideoProviderAdapter["poll"]>> | null = null;
    for (let pollIndex = 0; pollIndex < maxPolls; pollIndex += 1) {
      if (deps.abortSignal?.aborted) {
        // Persist the cancelled checkpoint FIRST so a thrown adapter.cancel
        // cannot orphan the provider job from the reconciler's view. If
        // markCancelled itself throws we still attempt the provider-side
        // cancel and a `cancelled_pending_provider` budget reconcile so the
        // next reconciler sweep can recover.
        let checkpointMarked = false;
        try {
          await deps.checkpointClient.markCancelled({
            mediaJobId: ids.mediaJobId,
            providerJobId,
          });
          checkpointMarked = true;
        } catch {
          // Cannot persist; reconciler may not see this job until the
          // checkpoint can be re-saved.
        }
        try {
          await adapter.cancel?.({ providerJobId, abortSignal: deps.abortSignal });
        } catch {
          // Provider may be unreachable; reconciler will poll and settle
          // once `markCancelled` is durable.
        }
        // Only reconcile the hold as cancelled_pending_provider when the
        // checkpoint write succeeded — otherwise the reconciler cannot list
        // the row and the hold would strand forever. With `markCancelled`
        // failed we leave the hold `held` so its TTL bounds the leak and
        // the next retry of this turn can re-attempt the checkpoint write.
        if (checkpointMarked && holdId) {
          await deps.budgetClient.reconcile({
            holdId,
            status: "cancelled_pending_provider",
          });
        }
        if (!checkpointMarked) {
          yield {
            kind: "orchestrator-media-job-progress",
            planId: deps.planId,
            subtaskId: deps.subtask.id,
            mediaJobId: ids.mediaJobId,
            status: "cancelled",
            label: deps.subtask.title,
            detail: "PROVIDER_CANCEL_CHECKPOINT_UNAVAILABLE",
          };
        } else {
          yield {
            kind: "orchestrator-media-job-progress",
            planId: deps.planId,
            subtaskId: deps.subtask.id,
            mediaJobId: ids.mediaJobId,
            status: "cancelled",
            label: deps.subtask.title,
          };
        }
        return;
      }
      result = await adapter.poll({ providerJobId, abortSignal: deps.abortSignal });
      if (result.status !== "running") break;
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "running",
        label: deps.subtask.title,
        progressPercent: result.progressPercent,
      };
      await delay(deps.providerPollDelayMs ?? 5_000, deps.abortSignal);
    }
    if (!result || result.status !== "done") {
      if (result?.status === "billing_pending" && holdId) {
        await deps.budgetClient.reconcile({
          holdId,
          status: "billing_pending_provider",
        });
        await deps.checkpointClient.markBillingPending({
          mediaJobId: ids.mediaJobId,
          providerJobId,
          observedAt: (deps.now ?? new Date()).toISOString(),
        });
      }
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: result?.status === "failed" ? "error" : "running",
        label: deps.subtask.title,
        detail:
          result?.status === "failed" || result?.status === "billing_pending"
            ? result.reason
            : "PROVIDER_STILL_RUNNING_RESUME_SCHEDULED",
        progressPercent: result?.status === "running" ? result.progressPercent : undefined,
      };
      if (result?.status === "failed") {
        await releaseHold();
      }
      return;
    }
    const artifact = await deps.encryptArtifact({
      bytes: result.videoBytes,
      mimeType: result.mimeType,
      title: deps.subtask.title,
    });
    // encryptArtifact only feeds the metadata trail event (sha/ref); the binary
    // write-ACK below is the real delivery (ciphertextRef is empty).
    yield {
      kind: "orchestrator-artifact",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      artifactId: artifact.artifactId,
      artifactKind: result.mimeType,
      title: deps.subtask.title,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      ciphertextRef: artifact.ciphertextRef,
    };

    // Delivery rides the SAME encrypted binary write-ACK path image generation
    // uses. With a GRANTED folder the bytes are saved to it behind the client's
    // "ask before saving" confirmation; with NO granted folder we deliver a
    // PREVIEW-ONLY write — the client reassembles + sha-verifies + renders the
    // in-app preview, performing no folder write. The bytes stream over the
    // already-attested encrypted session channel in frame-safe chunks; the
    // client writes them straight to disk (no full-video buffer in JS heap).
    const videoSizeCap = videoMaxOutputBytes();
    if (result.videoBytes.byteLength > videoSizeCap) {
      // Undeliverable by OUR cap → release (no bill). This is not a bypass: the
      // client receives nothing. The debit happens only AFTER this guard, so an
      // oversized asset is never billed; a delivery_pending resume can never
      // reach here (its asset already passed the cap on the billed attempt).
      await releaseHold();
      try {
        await deps.checkpointClient.markTerminal({
          mediaJobId: ids.mediaJobId,
          terminalState: "released",
        });
      } catch {
        /* best-effort terminal hygiene; the checkpoint row simply expires */
      }
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "error",
        label: deps.subtask.title,
        detail: `VIDEO_OUTPUT_TOO_LARGE:${result.videoBytes.byteLength}`,
      };
      return;
    }
    const targetFolder = deps.linkedFolders?.find(
      (folder) => folder.status === "granted",
    );
    const previewOnly = !targetFolder;
    if (!deps.awaitBinaryWriteAck || !deps.binaryWorkItems) {
      await releaseHold();
      try {
        await deps.checkpointClient.markTerminal({
          mediaJobId: ids.mediaJobId,
          terminalState: "released",
        });
      } catch {
        /* best-effort */
      }
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "error",
        label: deps.subtask.title,
        detail: "VIDEO_GENERATE_DELIVERY_UNAVAILABLE",
      };
      return;
    }
    const invocationId = randomUUID();
    const outputId = randomUUID();
    const outputPath = deriveVideoOutputFilename(deps.subtask, result.mimeType);
    const { request, chunks } = deps.binaryWorkItems.createOutputWriteRequest({
      sessionId: deps.sessionId ?? "",
      agentTurnId: deps.agentTurnId,
      invocationId,
      toolName: "video.generate" as BinaryWorkItemToolName,
      operationId: `video.generate:${invocationId}`,
      outputId,
      outputPath,
      outputBytes: result.videoBytes,
      maxOutputBytes: videoSizeCap,
    });
    const writePayload: ClientOnlyBinaryWrite = previewOnly
      ? {
          folderId: "",
          displayName: "",
          request,
          chunks,
          previewOnly: true,
        }
      : {
          folderId: targetFolder!.folderId,
          displayName: targetFolder!.displayName,
          request,
          chunks,
        };
    // ── Bill on GENERATION, not on the client ACK ─────────────────────────────
    // The provider has produced the asset — the irreversible cost is already
    // spent and the bytes are about to leave the enclave. DEBIT FIRST, THEN record
    // the job re-deliverable (`delivery_pending`). This order is the bypass close:
    //  • A client that receives the bytes (below) then withholds/denies the ACK is
    //    STILL billed — the debit already happened.
    //  • A `delivery_pending` row therefore ALWAYS implies a settled debit, so the
    //    retrieve/resume path (which never re-debits) can never re-deliver an
    //    UNPAID asset for free — even under a partial-failure in this section.
    // If the DEBIT throws, no delivery_pending row is created and the catch
    // releases the still-held hold (no bill; nothing shipped). If the debit
    // succeeds but markDeliveryPending throws, the catch best-effort re-records the
    // (already-paid) row so it stays recoverable, and never releases or re-bills.
    // The optional `?.` lets legacy clients/tests that predate re-delivery keep
    // working (bill-on-generation, minus the re-deliverable row).
    if (!alreadyBilled) {
      enteredBillingStage = true;
      await deps.budgetClient.reconcile({
        holdId: holdId!,
        status: "debited",
        actualQuotaUnits: result.actualQuotaUnits,
        billingReceiptId: result.billingReceiptId,
      });
      debited = true;
      await deps.checkpointClient.markDeliveryPending?.({
        mediaJobId: ids.mediaJobId,
        providerJobId,
        deliveredPendingAt: (deps.now ?? new Date()).toISOString(),
      });
      markedDeliveryPending = true;
    }
    yield { kind: "binary-write-request", payload: writePayload };
    const ack = await deps.awaitBinaryWriteAck(writePayload);
    if (ack.outcome === "ok") {
      // Delivered. Already debited above — just finalise terminal so a later
      // resume cannot re-poll + re-deliver an already-delivered job.
      try {
        await deps.checkpointClient.markTerminal({
          mediaJobId: ids.mediaJobId,
          terminalState: "debited",
        });
      } catch {
        /* best-effort terminal hygiene */
      }
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "done",
        label: deps.subtask.title,
      };
      return;
    }
    // Non-ok ACK. The asset is already billed (bill-on-generation), so there is
    // NO refund. Two cases:
    //  • denied_by_user — the user saw the preview and explicitly declined the
    //    FOLDER save. They received + viewed the asset, so finalise terminal
    //    (no re-delivery owed); they are billed for the generation they used.
    //  • write failed / timed out — the client may genuinely have missed the
    //    bytes, so LEAVE the job `delivery_pending` (recorded above) so it can be
    //    re-delivered to an honest client; never release.
    const denied = ack.outcome === "denied_by_user";
    if (denied) {
      try {
        await deps.checkpointClient.markTerminal({
          mediaJobId: ids.mediaJobId,
          terminalState: "debited",
        });
      } catch {
        /* best-effort */
      }
    }
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: denied ? "blocked" : "error",
      label: deps.subtask.title,
      // The recoverable (non-denied) case MUST carry the exact recovery sentinel:
      // an alive client that reports an error/timeout ACK returns outcome:"error"
      // WITH a reason (e.g. BINARY_WRITE_ACK_TIMEOUT) — the main recovery case — and
      // the web/mobile workspaces flip the "Retrieve your video" banner only on
      // this exact detail. Preferring `ack.reason` here would hide the billed,
      // re-deliverable job from the user. (Denied is terminal — no recovery owed —
      // so its more specific reason is fine to surface.)
      detail: denied
        ? (ack.reason ?? "VIDEO_GENERATE_SAVE_DECLINED")
        : "VIDEO_GENERATE_DELIVERY_UNCONFIRMED_BILLED",
    };
    return;
  } catch (error) {
    let detail = error instanceof Error ? error.message : "VIDEO_PROVIDER_EXCEPTION";
    if (alreadyBilled || debited) {
      // The hold is settled (a re-delivery of an already-paid job `alreadyBilled`,
      // or this turn's in-turn `debited`). Never reconcile/release the hold again
      // and never markBillingPending — that would double-settle the hold and/or
      // stomp the delivery_pending row to a state outside the recovery path. Leave
      // the row `delivery_pending` so a resume / user-scoped retrieve re-delivers
      // the already-paid asset.
      //
      // Debit-first means the happy path already marked the row; but if the debit
      // SUCCEEDED and markDeliveryPending then threw, the paid row was never
      // recorded re-deliverable. Best-effort record it now so the paid asset stays
      // recoverable (and a resume still sees `delivery_pending` → never re-debits).
      // If this also fails the row stays `provider_started` + debited — a rare
      // paid-but-unrecoverable edge that favours revenue, NOT a free asset.
      if (debited && !markedDeliveryPending && providerJobId) {
        try {
          await deps.checkpointClient.markDeliveryPending?.({
            mediaJobId: ids.mediaJobId,
            providerJobId,
            deliveredPendingAt: (deps.now ?? new Date()).toISOString(),
          });
        } catch {
          detail = `${detail}+DELIVERY_PENDING_RECORD_FAILED`;
        }
      }
      detail = `${detail}+REDELIVERY_PENDING`;
    } else if (enteredBillingStage) {
      // We entered the billing section but the DEBIT itself threw (`debited` is
      // false). markDeliveryPending runs AFTER the debit, so NO delivery_pending
      // row was created — there is nothing stranded and no free-asset path (the
      // retrieve path only lists delivery_pending rows). The bytes have not shipped
      // (the binary-write yield is after the debit), so nothing is owed: release
      // the still-held hold. Must NOT fall through to the billing_pending_provider
      // branch (that would bill the user via the reconciler for an asset that was
      // never delivered). The row stays `provider_started` and simply TTL-expires.
      try {
        await releaseHold();
      } catch {
        detail = `${detail}+QUOTA_RELEASE_RECONCILIATION_FAILED`;
      }
      detail = `${detail}+DELIVERY_BILLING_INCOMPLETE_RELEASED`;
    } else if (providerJobId) {
      try {
        await deps.budgetClient.reconcile({
          holdId: holdId!,
          status: "billing_pending_provider",
        });
        await deps.checkpointClient.markBillingPending({
          mediaJobId: ids.mediaJobId,
          providerJobId,
          observedAt: (deps.now ?? new Date()).toISOString(),
        });
        detail = `${detail}+PROVIDER_RECONCILIATION_PENDING`;
      } catch {
        detail = `${detail}+PROVIDER_RECONCILIATION_CHECKPOINT_UNAVAILABLE`;
      }
    } else if (pendingStartSaved) {
      detail = `${detail}+PENDING_START_RECONCILIATION_REQUIRED`;
    } else {
      // M6: this error-path reconcile was the one unguarded await in the
      // catch — a throw here escaped the generator entirely instead of
      // ending in the error progress event below.
      try {
        await releaseHold();
      } catch {
        detail = `${detail}+QUOTA_RELEASE_RECONCILIATION_FAILED`;
      }
    }
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "error",
      label: deps.subtask.title,
      detail,
    };
    return;
  }
}

// ─── Image generation/edit (synchronous) ──────────────────────────────────
//
// The image sibling of the video job flow. Image generation is a single
// provider request/response — no provider-side job, polling, checkpoint, or
// resume — so it runs the trust spine SYNCHRONOUSLY: budget reserve →
// (image_edit only) consent-gate the provider-visible input image →
// adapter.generate → provenance-sign the OUTPUT (bound to its sha256, attesting
// TEE origin) → encrypt (metadata trail only) → DELIVER the bytes via the
// binary write-ACK path (write to the linked folder behind the client's "Ask
// before saving" confirmation — the SAME path image.transform uses) → budget
// reconcile on the ACK outcome (debited on save, released on decline/fail). On
// ANY failure it reconciles the hold and emits a clean error — never throws out
// of the generator.

function deriveImagePrompt(subtask: AgentSubtask): string {
  // The (already on-device-masked) subtask objective is the image instruction;
  // fall back to the title. Bounded to a sane provider prompt length.
  const text = (subtask.objective || subtask.title || "").trim();
  return text.slice(0, 4000);
}

// File extension for the generated output's mime type. The client/binary-write
// path treats the path as opaque (it resolves collisions like the transform
// path), but a correct extension makes the saved file open in the right viewer.
function imageOutputExtension(mimeType: ImageOutputMimeType): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/png":
    default:
      return "png";
  }
}

// Slugified, bounded filename from the subtask title (e.g. "Generate bake-sale
// poster" → "generate-bake-sale-poster.png"); falls back to a stable default
// when the title has no usable characters. The client resolves collisions, so
// this need only be a sane, deterministic base name.
function deriveImageOutputFilename(
  subtask: AgentSubtask,
  mimeType: ImageOutputMimeType,
): string {
  const ext = imageOutputExtension(mimeType);
  const slug = (subtask.title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return `${slug || "calypso-image"}.${ext}`;
}

function videoOutputExtension(mimeType: "video/mp4" | "video/webm"): string {
  return mimeType === "video/webm" ? "webm" : "mp4";
}

// Slugified, bounded filename from the subtask title — the video analogue of
// deriveImageOutputFilename. The client resolves collisions, so this need only
// be a sane, deterministic base name.
function deriveVideoOutputFilename(
  subtask: AgentSubtask,
  mimeType: "video/mp4" | "video/webm",
): string {
  const ext = videoOutputExtension(mimeType);
  const slug = (subtask.title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return `${slug || "calypso-video"}.${ext}`;
}

// Operator-configurable per-video delivery ceiling (default 100 MB). A generated
// clip routinely exceeds the 5 MB image/linked-folder write budget. NOTE: the
// enclave inherently holds the whole clip in memory (the provider returns it
// base64-in-JSON), so the practical large-video ceiling is bounded by the
// provider response shape, not this cap — this guards against pathologically
// large outputs and is the value the client mirrors (defense in depth).
export function videoMaxOutputBytes(): number {
  const raw = Number(process.env.MEDIA_VIDEO_MAX_OUTPUT_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100 * 1024 * 1024;
}

// Sniff the input image's real format from magic bytes so an image_edit source
// is labelled correctly to the provider (defaulting everything to PNG made a
// JPEG/WebP source mis-typed). Returns undefined for an unrecognised header,
// which lets the adapter fall back to its default.
function sniffImageInputMimeType(
  bytes: Uint8Array,
): ImageInputMimeType | undefined {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export async function* runGenerateImageSubtask(
  deps: RunMediaSubtaskDeps,
): AsyncGenerator<RunMediaSubtaskEvent> {
  const operation = deps.subtask.media?.operation;
  if (operation !== "image_generate" && operation !== "image_edit") {
    yield imageProgress(deps, "error", "MEDIA_OPERATION_UNSUPPORTED");
    return;
  }
  const adapter = deps.imageAdapters?.[deps.route.providerId];
  if (!adapter) {
    yield imageProgress(deps, "error", "IMAGE_ADAPTER_UNAVAILABLE");
    return;
  }
  if (!deps.provenanceSigner) {
    // Provenance signing is part of the trust story — never emit a generated
    // image artifact the enclave cannot attest to.
    yield imageProgress(deps, "error", "IMAGE_PROVENANCE_SIGNER_MISSING");
    return;
  }
  const ids = createMediaJobIds({
    agentTurnId: deps.agentTurnId,
    planId: deps.planId,
    subtaskId: deps.subtask.id,
  });
  const now = deps.now ?? new Date();

  yield {
    kind: "orchestrator-media-job-progress",
    planId: deps.planId,
    subtaskId: deps.subtask.id,
    mediaJobId: ids.mediaJobId,
    status: "starting",
    label: deps.subtask.title,
  };

  const hold = await deps.budgetClient.reserve({
    mediaJobId: ids.mediaJobId,
    quotaUnits: IMAGE_GENERATE_QUOTA_UNITS,
    providerId: deps.route.providerId,
    modelId: deps.route.modelId,
    routeKind: "image_generate",
  });
  if (!hold.ok) {
    yield imageJobProgress(deps, ids.mediaJobId, "blocked", hold.reason);
    return;
  }

  try {
    // image_edit sends a user-authorised source image to the provider — a
    // provider-visible input that must clear the same custody + consent gate
    // the video flow uses. image_generate is text → image (no user file): the
    // prompt is provider-visible by nature, like a chat message.
    let inputImageBytes: Uint8Array | undefined;
    let inputImageMimeType: ImageInputMimeType | undefined;
    // image_generate: the masked subtask objective is the instruction.
    // image_edit overrides this below with the CONSENTED prompt-handle text.
    let imagePrompt = deriveImagePrompt(deps.subtask);
    if (operation === "image_edit") {
      if (
        !deps.providerInput ||
        !deps.handleStore ||
        !deps.consentVerifier
      ) {
        await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
        yield imageJobProgress(deps, ids.mediaJobId, "error", "IMAGE_EDIT_PROVIDER_INPUT_MISSING");
        return;
      }
      const prepared = await prepareProviderVisibleInput({
        promptHandleId: deps.providerInput.promptHandleId,
        inputHandleIds: deps.providerInput.inputHandleIds,
        handleStore: deps.handleStore,
        recordsByHandleId: deps.recordsByHandleId ?? new Map(),
        signer: deps.provenanceSigner,
        now,
      });
      if (!prepared.ok) {
        await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
        yield imageJobProgress(deps, ids.mediaJobId, "blocked", prepared.reason);
        return;
      }
      const consent = deps.providerInput.consent;
      if (!consent) {
        await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
        yield imageJobProgress(deps, ids.mediaJobId, "waiting_for_consent", "PROVIDER_VISIBLE_INPUT_CONSENT_REQUIRED");
        return;
      }
      const consentResult = await verifyProviderVisibleInputConsent({
        consent,
        expected: {
          planId: deps.planId,
          subtaskId: deps.subtask.id,
          providerId: deps.route.providerId,
          modelId: deps.route.modelId,
          inputHandleSetHash: prepared.inputHandleSetHash,
          enclaveNonce: deps.providerInput.enclaveNonce,
          pinnedSignerKeyId: deps.providerInput.pinnedSignerKeyId,
          revokedSignerKeyIds: deps.providerInput.revokedSignerKeyIds,
        },
        verifier: deps.consentVerifier,
        now,
        seenConsentIds: deps.providerInput.seenConsentIds,
      });
      if (!consentResult.ok) {
        await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
        yield imageJobProgress(deps, ids.mediaJobId, "blocked", consentResult.reason);
        return;
      }
      if (!prepared.inputImageBytes) {
        await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
        yield imageJobProgress(deps, ids.mediaJobId, "error", "IMAGE_EDIT_INPUT_IMAGE_MISSING");
        return;
      }
      inputImageBytes = prepared.inputImageBytes;
      // Label the source image by its real format (not always PNG) so the
      // provider accepts it; sniff from magic bytes.
      inputImageMimeType = sniffImageInputMimeType(prepared.inputImageBytes);
      // Transmit the CONSENTED prompt-handle text alongside the user's private
      // image, not the post-hoc subtask objective, so the instruction matches
      // what the provider-visible-input consent covered.
      if (prepared.promptText) imagePrompt = prepared.promptText;
    }

    const outputMimeType: ImageOutputMimeType = "image/png";
    const generated = await adapter.generate({
      operation,
      modelId: deps.route.modelId,
      prompt: imagePrompt,
      inputImageBytes,
      inputImageMimeType,
      size: "auto",
      outputMimeType,
      localIdempotencyKey: ids.providerIdempotencyKey,
      abortSignal: deps.abortSignal,
    });
    if (generated.status === "failed") {
      await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
      yield imageJobProgress(deps, ids.mediaJobId, "error", generated.reason);
      return;
    }

    // Provenance: sign a record attesting the TEE produced this image, bound to
    // the output sha256. `generated_from_private` distinguishes an edit of a
    // (provider-visible) user image from a pure text→image generation.
    const provenance = createProvenanceRecord(
      {
        handleId: `mh_${ids.mediaJobId.slice(3)}`,
        kind: "image",
        origin: operation === "image_edit" ? "generated_from_private" : "generated",
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: deps.route.modelId,
        createdAt: now,
        ttlSeconds: GENERATED_MEDIA_TTL_SECONDS,
        byteSize: generated.imageBytes.byteLength,
        bytes: generated.imageBytes,
      },
      deps.provenanceSigner,
    );
    // Surface that provenance was signed — observable in the decrypted
    // orchestrator trail, and a defence-in-depth self-check that the signed
    // record verifies against the exact output bytes (signature + sha256 + ttl)
    // before the artifact is emitted.
    if (!verifyProvenanceRecord(provenance, generated.imageBytes, deps.provenanceSigner, now)) {
      await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
      yield imageJobProgress(deps, ids.mediaJobId, "error", "IMAGE_PROVENANCE_SELF_VERIFY_FAILED");
      return;
    }
    yield imageJobProgress(
      deps,
      ids.mediaJobId,
      "running",
      `IMAGE_PROVENANCE_SIGNED:${provenance.handleId}`,
    );

    // Delivery rides the binary write-ACK path — the SAME path image.transform
    // uses. With a GRANTED folder the bytes are saved to it behind the client's
    // "Ask before saving" confirmation. With NO granted folder we no longer fail
    // closed: a generated image is the result, so we deliver a PREVIEW-ONLY write
    // (previewOnly: true, empty folderId) — the client reassembles + sha-verifies
    // the bytes and renders the in-app preview, performing no folder write. The
    // binary delivery deps are still REQUIRED in both cases (no deps ⇒ we cannot
    // hand the bytes to the client at all, so fail closed + release the hold).
    const targetFolder = deps.linkedFolders?.find(
      (folder) => folder.status === "granted",
    );
    const previewOnly = !targetFolder;
    if (!deps.awaitBinaryWriteAck || !deps.binaryWorkItems) {
      await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
      yield imageJobProgress(deps, ids.mediaJobId, "error", "IMAGE_GENERATE_DELIVERY_UNAVAILABLE");
      return;
    }

    // encryptArtifact only feeds the metadata trail event below (sha/ref); the
    // binary write-ACK is the real delivery. KEEP emitting orchestrator-artifact
    // for the receipt/trail, but it is NO LONGER how the bytes reach the device.
    const artifact = await deps.encryptArtifact({
      bytes: generated.imageBytes,
      mimeType: generated.mimeType,
      title: deps.subtask.title,
    });
    yield {
      kind: "orchestrator-artifact",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      artifactId: artifact.artifactId,
      artifactKind: generated.mimeType,
      title: deps.subtask.title,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      ciphertextRef: artifact.ciphertextRef,
    };

    const invocationId = randomUUID();
    const outputId = randomUUID();
    const outputPath = deriveImageOutputFilename(deps.subtask, generated.mimeType);
    const { request, chunks } = deps.binaryWorkItems.createOutputWriteRequest({
      sessionId: deps.sessionId ?? "",
      agentTurnId: deps.agentTurnId,
      invocationId,
      // Label the binary output with the generating tool so the client Activity
      // trail and telemetry are honest. The client routes the bytes by outputId,
      // not toolName, so this is purely a label. image_edit (image→image) is
      // tagged image.edit; pure text→image is image.generate.
      toolName: (operation === "image_edit"
        ? "image.edit"
        : "image.generate") as BinaryWorkItemToolName,
      operationId: `image.generate:${invocationId}`,
      outputId,
      outputPath,
      outputBytes: generated.imageBytes,
    });
    const writePayload: ClientOnlyBinaryWrite = previewOnly
      ? {
          // No destination folder: deliver for in-app preview only. The client
          // renders the bytes and skips the folder write (folderId is empty).
          folderId: "",
          displayName: "",
          request,
          chunks,
          previewOnly: true,
          // #1: deliver the in-TEE-signed provenance record alongside the bytes
          // so the client verifies the image against the attestation-published
          // key (pairs with the bytes by request.outputId). Metadata only.
          provenance,
        }
      : {
          folderId: targetFolder!.folderId,
          displayName: targetFolder!.displayName,
          request,
          chunks,
          provenance,
        };
    // Emit the write_request + chunk frames to the client (the index.ts wire
    // pump's `binary-write-request` case relays them), then block on the ACK —
    // exactly the worker image.transform sequence.
    yield { kind: "binary-write-request", payload: writePayload };
    const ack = await deps.awaitBinaryWriteAck(writePayload);
    if (ack.outcome === "ok") {
      await deps.budgetClient.reconcile({
        holdId: hold.holdId,
        status: "debited",
        actualQuotaUnits: generated.actualQuotaUnits,
        billingReceiptId: generated.billingReceiptId,
      });
      yield imageJobProgress(deps, ids.mediaJobId, "done", undefined);
      return;
    }
    // Client declined the save, or the write failed / timed out. Nothing landed,
    // so release the hold and report honestly. A user-declined save is a
    // `blocked` terminal (an explicit choice, not an error); any other outcome
    // is a genuine `error`.
    await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
    const denied = ack.outcome === "denied_by_user";
    yield imageJobProgress(
      deps,
      ids.mediaJobId,
      denied ? "blocked" : "error",
      ack.reason ?? (denied ? "IMAGE_GENERATE_SAVE_DECLINED" : "IMAGE_GENERATE_WRITE_FAILED"),
    );
  } catch {
    try {
      await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
    } catch {
      // best-effort release; the budget reaper reclaims an orphaned hold.
    }
    // Body-free fixed code only. encryptArtifact / prepareProviderVisibleInput /
    // createProvenanceRecord can throw with internal/provider context; forwarding
    // error.message into the host-relayed progress detail would leak it (the
    // adapters themselves never throw — they return body-free failure reasons).
    yield imageJobProgress(deps, ids.mediaJobId, "error", "IMAGE_PROVIDER_EXCEPTION");
    return;
  }
}

function imageProgress(
  deps: RunMediaSubtaskDeps,
  status: "error",
  detail: string,
): OrchestratorExecutorEvent {
  return {
    kind: "orchestrator-progress",
    planId: deps.planId,
    subtaskId: deps.subtask.id,
    status,
    label: deps.subtask.title,
    detail,
  };
}

function imageJobProgress(
  deps: RunMediaSubtaskDeps,
  mediaJobId: string,
  status: "starting" | "running" | "blocked" | "waiting_for_consent" | "done" | "error",
  detail: string | undefined,
): OrchestratorExecutorEvent {
  return {
    kind: "orchestrator-media-job-progress",
    planId: deps.planId,
    subtaskId: deps.subtask.id,
    mediaJobId,
    status,
    label: deps.subtask.title,
    ...(detail !== undefined ? { detail } : {}),
  };
}

export async function reconcileCancelledProviderCompletions(deps: {
  videoAdapters: RunMediaSubtaskDeps["videoAdapters"];
  checkpointClient: RunMediaSubtaskDeps["checkpointClient"];
  budgetClient: RunMediaSubtaskDeps["budgetClient"];
  limit?: number;
  now?: Date;
  billingMetadataSlaMs?: number;
  abortSignal?: AbortSignal;
  emitOperatorAlert?(
    input:
      | {
          code: "VIDEO_BILLING_METADATA_SLA_EXCEEDED";
          mediaJobId: string;
          providerId: string;
          providerJobId: string;
          firstBillingPendingAt: string;
          billingPendingPollCount: number;
        }
      | {
          code:
            | "VIDEO_RECONCILER_POLL_FAILED"
            | "VIDEO_RECONCILER_SETTLEMENT_FAILED"
            | "VIDEO_RECONCILER_ADAPTER_MISSING"
            | "VIDEO_RECONCILER_SENTINEL_RETIRED";
          mediaJobId: string;
          providerId: string;
          providerJobId: string;
          errorMessage: string;
        },
  ): Promise<void>;
  disableProviderModel?(input: {
    providerId: string;
    reason: "VIDEO_BILLING_METADATA_SLA_EXCEEDED";
  }): Promise<void>;
}): Promise<void> {
  const cancelledJobs = await deps.checkpointClient.listCancelledPending({ limit: deps.limit ?? 50 });
  const billingPendingJobs = await deps.checkpointClient.listBillingPending({ limit: deps.limit ?? 50 });
  const jobs: Array<
    | (Awaited<ReturnType<typeof deps.checkpointClient.listCancelledPending>>[number] & { kind: "cancelled" })
    | (Awaited<ReturnType<typeof deps.checkpointClient.listBillingPending>>[number] & { kind: "billing_pending" })
  > = [
    ...cancelledJobs.map((job) => ({ ...job, kind: "cancelled" as const })),
    ...billingPendingJobs.map((job) => ({ ...job, kind: "billing_pending" as const })),
  ];
  const now = deps.now ?? new Date();
  const billingMetadataSlaMs = deps.billingMetadataSlaMs ?? 60 * 60 * 1000;
  // Helper: alert emission must never throw out of the per-job try/catch.
  // A degraded alert sink would otherwise tear down the sweep on the same
  // iteration it was meant to protect. Returns `true` only when the alert
  // was confirmed delivered (sink present AND emit did not throw); callers
  // gate destructive transitions on this so a swallowed alert cannot lead
  // to silent data loss.
  async function safeAlert(
    input: Parameters<NonNullable<typeof deps.emitOperatorAlert>>[0],
  ): Promise<boolean> {
    if (!deps.emitOperatorAlert) return false;
    try {
      await deps.emitOperatorAlert(input);
      return true;
    } catch {
      return false;
    }
  }
  for (const job of jobs) {
    // Sentinel rows (pending_start unrecoverable GC, or provider_started
    // route mismatch with missing adapter) carry an opaque string no real
    // adapter can poll. Transition them straight to terminal so they exit
    // `listCancelledPending` instead of spamming the alert sink on every
    // sweep.
    const isSentinel =
      job.providerJobId === PENDING_START_UNRECOVERABLE_SENTINEL ||
      job.providerJobId.startsWith(PROVIDER_STARTED_UNREACHABLE_SENTINEL_PREFIX);
    if (isSentinel) {
      // Sentinel retirement is destructive: the upstream provider job
      // (encoded inside PROVIDER_STARTED_UNREACHABLE sentinel suffixes)
      // is orphaned and may keep accruing provider-side cost. Gate the
      // destructive transition on confirmed alert delivery so operators
      // always have an observable trail, matching the missing-adapter
      // branch's contract.
      const alertCallbackResolved = await safeAlert({
        code: "VIDEO_RECONCILER_SENTINEL_RETIRED",
        mediaJobId: job.mediaJobId,
        providerId: job.providerId,
        providerJobId: job.providerJobId,
        errorMessage: "SENTINEL_RETIRED",
      });
      if (!alertCallbackResolved) {
        // Alert sink unavailable; do not retire the sentinel without an
        // observable signal. The next sweep will retry.
        continue;
      }
      try {
        await deps.budgetClient.reconcile({ holdId: job.holdId, status: "released" });
        await deps.checkpointClient.markTerminal({
          mediaJobId: job.mediaJobId,
          terminalState: "released",
        });
      } catch (error) {
        await safeAlert({
          code: "VIDEO_RECONCILER_SETTLEMENT_FAILED",
          mediaJobId: job.mediaJobId,
          providerId: job.providerId,
          providerJobId: job.providerJobId,
          errorMessage: error instanceof Error ? error.message : "SENTINEL_SETTLEMENT_FAILED",
        });
      }
      continue;
    }
    const adapter = deps.videoAdapters[job.providerId];
    if (!adapter) {
      // RUNBOOK: A non-sentinel cancelled-pending row whose adapter is
      // absent from `deps.videoAdapters` is destructively retired ONLY
      // when the operator alert is confirmed delivered. If the alert
      // sink is missing or throws, the row is skipped and re-tried on
      // the next sweep — a transient registry miss (bootstrap order,
      // partial-deploy window, alert outage) must not silently release
      // the user's quota hold or tombstone the cancelled-pending row.
      // The destructive transition (release + markTerminal) is gated on
      // a successfully delivered alert so operators always have an
      // observable signal for the irreversible cleanup. To intentionally
      // drain rows for a deregistered adapter, gate the registry change
      // behind a drained `listCancelledPending` first.
      const alertCallbackResolved = await safeAlert({
        code: "VIDEO_RECONCILER_ADAPTER_MISSING",
        mediaJobId: job.mediaJobId,
        providerId: job.providerId,
        providerJobId: job.providerJobId,
        errorMessage: "ADAPTER_MISSING",
      });
      if (!alertCallbackResolved) {
        // Alert sink unavailable; do not retire the row destructively
        // without an observable signal. The next sweep will retry.
        continue;
      }
      try {
        await deps.budgetClient.reconcile({ holdId: job.holdId, status: "released" });
        await deps.checkpointClient.markTerminal({
          mediaJobId: job.mediaJobId,
          terminalState: "released",
        });
      } catch (error) {
        await safeAlert({
          code: "VIDEO_RECONCILER_SETTLEMENT_FAILED",
          mediaJobId: job.mediaJobId,
          providerId: job.providerId,
          providerJobId: job.providerJobId,
          errorMessage:
            error instanceof Error ? error.message : "ADAPTER_MISSING_TERMINAL_FAILED",
        });
      }
      continue;
    }
    // Per-job error isolation: one degraded provider must not stall the
    // sweep for every other provider's jobs. Wrap each job's poll +
    // settlement in its own try/catch so a thrown poll falls back to the
    // next job rather than aborting the whole reconciliation.
    let result: Awaited<ReturnType<VideoProviderAdapter["poll"]>>;
    try {
      result = await adapter.poll({ providerJobId: job.providerJobId, abortSignal: deps.abortSignal });
    } catch (error) {
      // Per-job poll failures are isolated, but they must remain
      // observable so a persistently degraded provider does not silently
      // accumulate stuck rows.
      await safeAlert({
        code: "VIDEO_RECONCILER_POLL_FAILED",
        mediaJobId: job.mediaJobId,
        providerId: job.providerId,
        providerJobId: job.providerJobId,
        errorMessage: error instanceof Error ? error.message : "POLL_FAILED",
      });
      continue;
    }
    try {
      if (result.status === "running" || result.status === "billing_pending") {
        if (
          job.kind === "billing_pending" &&
          !job.slaAlertedAt &&
          now.getTime() - new Date(job.firstBillingPendingAt).getTime() >= billingMetadataSlaMs
        ) {
          await safeAlert({
            code: "VIDEO_BILLING_METADATA_SLA_EXCEEDED",
            mediaJobId: job.mediaJobId,
            providerId: job.providerId,
            providerJobId: job.providerJobId,
            firstBillingPendingAt: job.firstBillingPendingAt,
            billingPendingPollCount: job.billingPendingPollCount,
          });
          await deps.disableProviderModel?.({
            providerId: job.providerId,
            reason: "VIDEO_BILLING_METADATA_SLA_EXCEEDED",
          });
          await deps.checkpointClient.markBillingSlaEscalated({
            mediaJobId: job.mediaJobId,
            alertedAt: now.toISOString(),
            providerDisabledAt: now.toISOString(),
          });
        }
        continue;
      }
      if (result.status === "done") {
        await deps.budgetClient.reconcile({
          holdId: job.holdId,
          status: "debited",
          actualQuotaUnits: result.actualQuotaUnits,
          billingReceiptId: result.billingReceiptId,
        });
        await deps.checkpointClient.markTerminal({ mediaJobId: job.mediaJobId, terminalState: "debited" });
      } else {
        await deps.budgetClient.reconcile({ holdId: job.holdId, status: "released" });
        await deps.checkpointClient.markTerminal({ mediaJobId: job.mediaJobId, terminalState: "released" });
      }
    } catch (error) {
      // Per-job error isolation: settlement errors for this row should not
      // abort the sweep. Emit an alert so a persistently failing settlement
      // path is observable instead of silently looping.
      await safeAlert({
        code: "VIDEO_RECONCILER_SETTLEMENT_FAILED",
        mediaJobId: job.mediaJobId,
        providerId: job.providerId,
        providerJobId: job.providerJobId,
        errorMessage: error instanceof Error ? error.message : "SETTLEMENT_FAILED",
      });
      continue;
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function* runRenderVideoSubtask(
  deps: RunMediaSubtaskDeps,
): AsyncGenerator<OrchestratorExecutorEvent> {
  if (
    !deps.compositionSpec ||
    !deps.recordsByHandleId ||
    !deps.renderBackend ||
    !deps.handleStore ||
    !deps.provenanceSigner
  ) {
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: "VIDEO_RENDER_INPUTS_MISSING",
    };
    return;
  }
  const validated = await validateVideoCompositionAgainstProvenance({
    spec: deps.compositionSpec,
    recordsByHandleId: deps.recordsByHandleId,
    handleStore: deps.handleStore,
    signer: deps.provenanceSigner,
    now: deps.now ?? new Date(),
  });
  if (!validated.ok) {
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: validated.reason,
    };
    return;
  }
  const ids = createMediaJobIds({
    agentTurnId: deps.agentTurnId,
    planId: deps.planId,
    subtaskId: deps.subtask.id,
  });
  const custody = evaluateRenderCustody({
    records: validated.records,
    rendererTrustLevel: deps.renderBackend.trustLevel,
  });
  if (!custody.allowed) {
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "blocked",
      label: deps.subtask.title,
      detail: custody.reason,
    };
    return;
  }
  const provenanceSnapshotHash = sha256Canonical(
    validated.records
      .map((record) => ({
        handleId: record.handleId,
        sha256: record.sha256,
        signature: record.signature,
      }))
      .sort((a, b) => a.handleId.localeCompare(b.handleId)),
  );
  const jobNonce = deps.createJobNonce?.(ids.mediaJobId) ?? `${ids.mediaJobId}:${randomUUID()}`;
  if (!deps.renderAttestationPolicy || !deps.verifyRenderManifestSignature) {
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: "RENDER_ATTESTATION_INPUTS_MISSING",
    };
    return;
  }
  if (deps.abortSignal?.aborted) {
    await deps.renderBackend.cancel?.({ mediaJobId: ids.mediaJobId, jobNonce });
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "cancelled",
      label: deps.subtask.title,
    };
    return;
  }
  const attestation = await deps.renderBackend.requestAttestation({
    mediaJobId: ids.mediaJobId,
    nonce: jobNonce,
  });
  const attestationResult = verifyRenderAttestation({
    document: attestation,
    expectedNonce: jobNonce,
    policy: deps.renderAttestationPolicy,
    now: deps.now ?? new Date(),
  });
  if (!attestationResult.ok) {
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "blocked",
      label: deps.subtask.title,
      detail: attestationResult.reason,
    };
    return;
  }
  let rendered: Awaited<ReturnType<RenderBackend["render"]>>;
  try {
    rendered = await deps.renderBackend.render(
      {
        mediaJobId: ids.mediaJobId,
        jobNonce,
        spec: validated.spec,
        provenanceSnapshotHash,
        encryptedAssetsRef: `bundle:${ids.mediaJobId}`,
        sealedAssetKeyRef: `sealed:${attestationResult.publicKeyId}:${ids.mediaJobId}`,
      },
      deps.abortSignal,
    );
  } catch (error) {
    if (deps.abortSignal?.aborted) {
      await deps.renderBackend.cancel?.({ mediaJobId: ids.mediaJobId, jobNonce });
      yield {
        kind: "orchestrator-media-job-progress",
        planId: deps.planId,
        subtaskId: deps.subtask.id,
        mediaJobId: ids.mediaJobId,
        status: "cancelled",
        label: deps.subtask.title,
      };
      return;
    }
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: error instanceof Error ? error.message : "VIDEO_RENDER_EXCEPTION",
    };
    return;
  }
  if (deps.abortSignal?.aborted) {
    await deps.renderBackend.cancel?.({ mediaJobId: ids.mediaJobId, jobNonce });
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "cancelled",
      label: deps.subtask.title,
    };
    return;
  }
  const expectedInputHandles = validated.records.map((record) => record.handleId).sort();
  const manifestInputHandles = [...rendered.manifest.inputHandleIds].sort();
  if (
    rendered.manifest.templateId !== validated.spec.templateId ||
    JSON.stringify(manifestInputHandles) !== JSON.stringify(expectedInputHandles) ||
    rendered.manifest.durationFrames !== validated.spec.format.durationFrames
  ) {
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: "RENDER_MANIFEST_MISMATCH",
    };
    return;
  }
  const manifestResult = verifySignedRenderManifest({
    manifest: rendered.manifest,
    expectedNonce: jobNonce,
    expectedProvenanceSnapshotHash: provenanceSnapshotHash,
    expectedSignerKeyId: attestationResult.publicKeyId,
    outputBytes: rendered.videoBytes,
    verifySignature: deps.verifyRenderManifestSignature,
  });
  if (!manifestResult.ok) {
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: manifestResult.reason,
    };
    return;
  }
  const artifact = await deps.encryptArtifact({
    bytes: rendered.videoBytes,
    mimeType: rendered.mimeType,
    title: deps.subtask.title,
  });
  if (artifact.sha256 !== rendered.manifest.outputHash) {
    yield {
      kind: "orchestrator-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      status: "error",
      label: deps.subtask.title,
      detail: "RENDER_OUTPUT_HASH_MISMATCH",
    };
    return;
  }
  yield {
    kind: "orchestrator-artifact",
    planId: deps.planId,
    subtaskId: deps.subtask.id,
    artifactId: artifact.artifactId,
    artifactKind: rendered.mimeType,
    title: deps.subtask.title,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    ciphertextRef: artifact.ciphertextRef,
  };
}
