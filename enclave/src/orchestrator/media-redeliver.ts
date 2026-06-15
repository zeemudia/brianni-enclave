import { randomUUID } from "node:crypto";
import type {
  BinaryWorkItemToolName,
  MediaArtifactKind,
  ToolResultFrame,
} from "@calypso/chat-types";
import type { BinaryWorkItemManager } from "../tools/binary-work-items";
import type { AgentLoopEvent } from "../agent/loop";
import type { VideoProviderAdapter } from "../media/video-provider";
import { videoMaxOutputBytes, type RunMediaSubtaskEvent } from "./media-executor";

// Honest-user re-delivery: re-send a video the user already PAID for but never
// received (a `delivery_pending` checkpoint). This is the recovery counterpart to
// bill-on-generation — the security fix bills the moment the provider returns the
// asset, so a failed delivery must not silently strand a paying user.
//
// The enclave is stateless, so the bytes are gone after the original turn; we
// re-poll the still-live provider job, re-encrypt, and re-deliver over the SAME
// attested binary write-ACK channel a normal media turn uses. It NEVER reserves
// or debits (the job is already billed) and re-delivers PREVIEW-ONLY — recovery
// surfaces the asset in-app; the user can re-save it. On a confirmed delivery the
// job is marked terminal so it stops being re-deliverable; any other outcome
// leaves it `delivery_pending` for a later retry (never refunds — the bytes were
// already produced and billed).
//
// It yields the SAME event kinds as `runMediaSubtask` (orchestrator-media-job-
// progress / orchestrator-artifact / binary-write-request), so the index.ts wire
// pump relays it with zero new plumbing.

type ClientOnlyBinaryWrite = Extract<
  AgentLoopEvent,
  { kind: "binary-write-request" }
>["payload"];

export interface RedeliverPendingMediaDeps {
  /** The CURRENT (retrieve) turn's ids — the binary ACK round-trips on these. */
  agentTurnId: string;
  sessionId: string;
  videoAdapters: Record<string, Pick<VideoProviderAdapter, "poll">>;
  binaryWorkItems: Pick<BinaryWorkItemManager, "createOutputWriteRequest">;
  awaitBinaryWriteAck: (payload: ClientOnlyBinaryWrite) => Promise<ToolResultFrame>;
  checkpointClient: {
    listUserDeliveryPending(input: { limit: number }): Promise<
      Array<{
        mediaJobId: string;
        providerId: string;
        modelId: string;
        providerJobId: string;
        provenanceSnapshotHash: string;
      }>
    >;
    markTerminal(input: {
      mediaJobId: string;
      terminalState: "debited" | "released";
    }): Promise<void>;
  };
  encryptArtifact(input: {
    bytes: Uint8Array;
    mimeType: MediaArtifactKind;
    title: string;
  }): Promise<{ artifactId: string; ciphertextRef: string; sha256: string; byteSize: number }>;
  /** Cap on how many pending jobs to re-deliver in one pass. */
  maxJobs?: number;
  maxProviderPolls?: number;
  providerPollDelayMs?: number;
  abortSignal?: AbortSignal;
  now?: Date;
  // "deliver" (default): re-poll + re-deliver each pending asset. "list": a quiet
  // probe (#1b) that ONLY reports how many pending jobs exist (one
  // VIDEO_DELIVERY_PENDING_AVAILABLE signal per job) without polling, delivering,
  // or marking terminal — so the client can surface the recovery banner on mount
  // even when the user never saw the live billed-but-undelivered event.
  mode?: "deliver" | "list";
}

const REDELIVER_AVAILABLE_DETAIL = "VIDEO_DELIVERY_PENDING_AVAILABLE";

const REDELIVER_PLAN_ID = "media-redeliver";
const REDELIVER_TITLE = "Retrieve your video";

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function redeliverFilename(mimeType: "video/mp4" | "video/webm"): string {
  return mimeType === "video/webm" ? "calypso-video.webm" : "calypso-video.mp4";
}

export async function* redeliverPendingMedia(
  deps: RedeliverPendingMediaDeps,
): AsyncGenerator<RunMediaSubtaskEvent | { kind: "done" }> {
  const jobs = await deps.checkpointClient.listUserDeliveryPending({
    limit: deps.maxJobs ?? 5,
  });
  if (deps.mode === "list") {
    // List-only probe: report each pending job WITHOUT polling/delivering. Uses
    // status "blocked" (not "error") so the quiet probe turn is not flagged as a
    // failed turn; the client maps VIDEO_DELIVERY_PENDING_AVAILABLE to the
    // recovery banner.
    for (const job of jobs) {
      if (deps.abortSignal?.aborted) return;
      yield {
        kind: "orchestrator-media-job-progress",
        planId: REDELIVER_PLAN_ID,
        subtaskId: job.mediaJobId,
        mediaJobId: job.mediaJobId,
        status: "blocked",
        label: REDELIVER_TITLE,
        detail: REDELIVER_AVAILABLE_DETAIL,
      };
    }
    yield { kind: "done" };
    return;
  }
  for (const job of jobs) {
    if (deps.abortSignal?.aborted) return;
    try {
      yield* redeliverOne(job, deps);
    } catch {
      // Per-job error boundary: a transient throw (provider 500, RPC blip,
      // connection reset while awaiting the ACK) in one job must not abort the
      // whole pass and swallow the terminal `done` below — every other pending
      // job would then be silently skipped. Report this job as errored (it stays
      // delivery_pending → re-deliverable on a later retrieve; never billed/
      // refunded here) and continue to the next.
      yield {
        kind: "orchestrator-media-job-progress",
        planId: REDELIVER_PLAN_ID,
        subtaskId: job.mediaJobId,
        mediaJobId: job.mediaJobId,
        status: "error",
        label: REDELIVER_TITLE,
        detail: "VIDEO_REDELIVER_EXCEPTION",
      };
    }
  }
  // Terminal event so the AGENT_REQUEST pump emits AGENT_DONE and the client
  // ends the turn cleanly — exactly how runOrchestrator finishes. (Emitted even
  // with no pending jobs: the retrieve turn simply completes with nothing to do.)
  yield { kind: "done" };
}

async function* redeliverOne(
  job: {
    mediaJobId: string;
    providerId: string;
    modelId: string;
    providerJobId: string;
    provenanceSnapshotHash: string;
  },
  deps: RedeliverPendingMediaDeps,
): AsyncGenerator<RunMediaSubtaskEvent> {
  const progress = (
    status: "running" | "done" | "error" | "cancelled",
    detail?: string,
  ): RunMediaSubtaskEvent => ({
    kind: "orchestrator-media-job-progress",
    planId: REDELIVER_PLAN_ID,
    subtaskId: job.mediaJobId,
    mediaJobId: job.mediaJobId,
    status,
    label: REDELIVER_TITLE,
    ...(detail !== undefined ? { detail } : {}),
  });

  const adapter = deps.videoAdapters[job.providerId];
  if (!adapter) {
    // Can't re-poll without the provider's adapter — leave it delivery_pending
    // (it may become recoverable if the provider is re-registered) and report.
    yield progress("error", "VIDEO_REDELIVER_ADAPTER_UNAVAILABLE");
    return;
  }

  yield progress("running");

  let result: Awaited<ReturnType<VideoProviderAdapter["poll"]>> | null = null;
  const maxPolls = deps.maxProviderPolls ?? 60;
  for (let i = 0; i < maxPolls; i += 1) {
    if (deps.abortSignal?.aborted) {
      yield progress("cancelled");
      return;
    }
    result = await adapter.poll({
      providerJobId: job.providerJobId,
      abortSignal: deps.abortSignal,
    });
    if (result.status !== "running") break;
    await delay(deps.providerPollDelayMs ?? 5_000, deps.abortSignal);
  }

  if (!result || result.status !== "done") {
    // Not ready / failed / billing_pending — keep it delivery_pending so a later
    // retrieve can try again (the provider asset may settle). Never released.
    const detail =
      result?.status === "failed" ? result.reason : "VIDEO_REDELIVER_PROVIDER_NOT_READY";
    yield progress("error", detail);
    return;
  }

  const videoSizeCap = videoMaxOutputBytes();
  if (result.videoBytes.byteLength > videoSizeCap) {
    // Should not happen (the original attempt passed the same cap before billing),
    // but never deliver past the cap. Leave delivery_pending.
    yield progress("error", `VIDEO_OUTPUT_TOO_LARGE:${result.videoBytes.byteLength}`);
    return;
  }

  const artifact = await deps.encryptArtifact({
    bytes: result.videoBytes,
    mimeType: result.mimeType,
    title: REDELIVER_TITLE,
  });
  yield {
    kind: "orchestrator-artifact",
    planId: REDELIVER_PLAN_ID,
    subtaskId: job.mediaJobId,
    artifactId: artifact.artifactId,
    artifactKind: result.mimeType,
    title: REDELIVER_TITLE,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    ciphertextRef: artifact.ciphertextRef,
  };

  const invocationId = randomUUID();
  const outputId = randomUUID();
  const { request, chunks } = deps.binaryWorkItems.createOutputWriteRequest({
    sessionId: deps.sessionId,
    agentTurnId: deps.agentTurnId,
    invocationId,
    toolName: "video.generate" as BinaryWorkItemToolName,
    operationId: `video.redeliver:${invocationId}`,
    outputId,
    outputPath: redeliverFilename(result.mimeType),
    outputBytes: result.videoBytes,
    maxOutputBytes: videoSizeCap,
  });
  // Recovery is preview-only: surface the bytes in-app. The original folder
  // target is not recorded on the checkpoint, and the priority is getting the
  // paid asset back to the user; they can re-save it.
  const writePayload: ClientOnlyBinaryWrite = {
    folderId: "",
    displayName: "",
    request,
    chunks,
    previewOnly: true,
  };
  yield { kind: "binary-write-request", payload: writePayload };
  const ack = await deps.awaitBinaryWriteAck(writePayload);
  if (ack.outcome === "ok" || ack.outcome === "denied_by_user") {
    // Delivered (preview rendered). Finalise terminal so it is no longer
    // re-deliverable. The job was already debited on generation — no billing here.
    try {
      await deps.checkpointClient.markTerminal({
        mediaJobId: job.mediaJobId,
        terminalState: "debited",
      });
    } catch {
      /* best-effort: the row otherwise TTL-expires (already billed) */
    }
    yield progress("done");
    return;
  }
  // Write failed / timed out again — keep it delivery_pending for a later retry.
  yield progress("error", ack.reason ?? "VIDEO_REDELIVER_DELIVERY_UNCONFIRMED");
}
