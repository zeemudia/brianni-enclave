import { createHash, randomUUID } from "node:crypto";
import type {
  AgentSubtask,
  MediaArtifactKind,
  MediaProvenanceRecord,
  ProviderVisibleInputConsent,
  ModelRouteDecision,
  VideoCompositionSpec,
} from "@calypso/chat-types";
import {
  createMediaJobIds,
  estimateVideoQuotaUnits,
  evaluateRenderCustody,
  prepareProviderVisibleInput,
  reserveVideoBudget,
  validateVideoCompositionAgainstProvenance,
  verifyProviderVisibleInputConsent,
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
import type { OrchestratorExecutorEvent } from "./events";

export interface RunMediaSubtaskDeps {
  agentTurnId: string;
  planId: string;
  subtask: AgentSubtask;
  route: ModelRouteDecision;
  videoAdapters: Record<string, VideoProviderAdapter>;
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

export async function* runMediaSubtask(
  deps: RunMediaSubtaskDeps,
): AsyncGenerator<OrchestratorExecutorEvent> {
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
    (existingCheckpoint.providerId !== deps.route.providerId ||
      existingCheckpoint.modelId !== deps.route.modelId)
  ) {
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
    await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
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
    await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
    return;
  }
  const existingProviderJobId =
    existingCheckpoint?.state === "provider_started" ? existingCheckpoint.providerJobId : null;
  const reservedHoldId = hold.holdId;
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
    if (existingCheckpoint?.state === "provider_started") {
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
        if (checkpointMarked) {
          await deps.budgetClient.reconcile({
            holdId: hold.holdId,
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
      if (result?.status === "billing_pending") {
        await deps.budgetClient.reconcile({
          holdId: hold.holdId,
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
        await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
      }
      return;
    }
    const artifact = await deps.encryptArtifact({
      bytes: result.videoBytes,
      mimeType: result.mimeType,
      title: deps.subtask.title,
    });
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
    await deps.budgetClient.reconcile({
      holdId: hold.holdId,
      status: "debited",
      actualQuotaUnits: result.actualQuotaUnits,
      billingReceiptId: result.billingReceiptId,
    });
    yield {
      kind: "orchestrator-media-job-progress",
      planId: deps.planId,
      subtaskId: deps.subtask.id,
      mediaJobId: ids.mediaJobId,
      status: "done",
      label: deps.subtask.title,
    };
  } catch (error) {
    let detail = error instanceof Error ? error.message : "VIDEO_PROVIDER_EXCEPTION";
    if (providerJobId) {
      try {
        await deps.budgetClient.reconcile({
          holdId: hold.holdId,
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
        await deps.budgetClient.reconcile({ holdId: hold.holdId, status: "released" });
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
