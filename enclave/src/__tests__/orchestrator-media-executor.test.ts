import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentMediaSubtask, AgentSubtask, MediaProvenanceRecord } from "@calypso/chat-types";
import { VALID_NITRO_FIXTURE, fixtureNitroDocument, fixtureNitroRootBundle } from "./fixtures/nitro-attestation";
import {
  PENDING_START_UNRECOVERABLE_SENTINEL,
  PROVIDER_STARTED_UNREACHABLE_SENTINEL_PREFIX,
  reconcileCancelledProviderCompletions,
  runMediaSubtask,
} from "../orchestrator/media-executor";
import { BinaryWorkItemManager } from "../tools/binary-work-items";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Fake awaitBinaryWriteAck: records payloads, returns a caller-supplied outcome.
function fakeBinaryWriteAck(outcome: "ok" | "denied_by_user" | "error" = "ok", reason?: string) {
  const calls: any[] = [];
  const fn = async (payload: any) => {
    calls.push(payload);
    return {
      invocationId: "inv_test",
      outcome,
      ...(reason ? { reason } : {}),
      resultJson: { status: outcome === "ok" ? "committed" : "error" },
    } as any;
  };
  return { fn, calls };
}

const promptBytes = new TextEncoder().encode("Generate an 8 second teaser");
const promptRecord: MediaProvenanceRecord = {
  handleId: "mh_prompt",
  kind: "text",
  origin: "generated",
  providerVisible: false,
  sourceHandleIds: [],
  createdBy: "test",
  createdAt: "2026-05-19T08:00:00.000Z",
  ttlSeconds: 900,
  byteSize: promptBytes.byteLength,
  sha256: sha256(promptBytes),
  signature: "sig",
};
const promptProvenanceSnapshotHash = createHash("sha256")
  .update(
    JSON.stringify(
      [{ handleId: promptRecord.handleId, sha256: promptRecord.sha256, signature: promptRecord.signature }].sort(
        (a, b) => a.handleId.localeCompare(b.handleId),
      ),
    ),
  )
  .digest("hex");

const handleStore = {
  getBytes: async (handleId: string) => (handleId === "mh_prompt" ? promptBytes : null),
  getText: async (handleId: string) => (handleId === "mh_prompt" ? "Generate an 8 second teaser" : null),
};
const provenanceSigner = { sign: () => "sig", verify: () => true };
const consentVerifier = { verify: async () => true };
const budgetClient = {
  reserve: async () => ({ ok: true, holdId: "hold_1" }) as const,
  reconcile: async () => undefined,
};
const checkpointClient = {
  load: async () => null,
  savePendingStart: async () => undefined,
  saveProviderJob: async () => undefined,
  markCancelled: async () => undefined,
  markBillingPending: async () => undefined,
  listCancelledPending: async () => [],
  listBillingPending: async () => [],
  markBillingSlaEscalated: async () => undefined,
  markTerminal: async () => undefined,
};

const baseSubtask: AgentSubtask = {
  id: "clip-1",
  title: "Generate teaser",
  objective: "Generate an 8 second teaser",
  kind: "video",
  requiredCapabilities: ["video_generation"],
  allowedTools: ["video.generate"],
  dependsOn: [],
  producesArtifact: true,
  risk: "medium",
};
const baseGenerateMedia: AgentMediaSubtask = {
  operation: "video_generate",
  expectedArtifactKind: "video/mp4",
  maxDurationSeconds: 8,
  privacyPolicy: "sanitized_only",
};
const baseRoute = {
  modelId: "veo-3.1-generate-preview",
  providerId: "google",
  subtaskId: "clip-1",
  reason: "test",
  fallbackModelIds: [],
};
const baseProviderInput = {
  promptHandleId: "mh_prompt",
  inputHandleIds: [] as string[],
  enclaveNonce: "nonce_1234567890123456",
  pinnedSignerKeyId: "device_key_1",
  revokedSignerKeyIds: new Set<string>(),
  seenConsentIds: new Set<string>(),
};

function makeRecords(record: MediaProvenanceRecord = promptRecord) {
  return new Map([[record.handleId, record]]);
}

// Fixed clock 30s after `promptRecord.createdAt` so the 900s TTL never expires
// during a test run. Without this every call to `runMediaSubtask` that does
// not inject its own `now` would silently fail `verifyProvenanceRecord` once
// the real wall clock advances past 08:15:00 UTC on 2026-05-19.
const FIXED_NOW = new Date("2026-05-19T08:00:30.000Z");

// Drives a single video.generate run with recording fakes for the billing +
// checkpoint surface, so the bill-on-generation / resumable-re-delivery tests
// stay readable. `load` lets a test resume from an existing checkpoint; `poll`
// defaults to an immediate `done`.
async function runVideoGen(opts: {
  ackOutcome?: "ok" | "denied_by_user" | "error";
  ackReason?: string;
  load?: any;
  linkedFolders?: any[];
  videoBytes?: Uint8Array;
}) {
  const events: any[] = [];
  const reserves: any[] = [];
  const reconciles: any[] = [];
  const terminals: any[] = [];
  const deliveryPendings: any[] = [];
  const bytes = opts.videoBytes ?? new TextEncoder().encode("mp4");
  const ack = fakeBinaryWriteAck(opts.ackOutcome ?? "ok", opts.ackReason);
  for await (const event of runMediaSubtask({
    agentTurnId: "turn_1",
    planId: "plan_1",
    subtask: { ...baseSubtask, media: baseGenerateMedia },
    route: baseRoute,
    videoAdapters: {
      google: {
        start: async () => ({ providerJobId: "op-1" }),
        poll: async () => ({
          status: "done",
          videoBytes: bytes,
          mimeType: "video/mp4",
          actualQuotaUnits: 200,
          billingSource: "provider_operation_metadata",
        }),
      },
    },
    providerInput: baseProviderInput,
    recordsByHandleId: makeRecords(),
    handleStore,
    provenanceSigner,
    consentVerifier,
    budgetClient: {
      reserve: async () => {
        reserves.push(true);
        return { ok: true, holdId: "hold_1" } as const;
      },
      reconcile: async (input) => {
        reconciles.push(input);
      },
    },
    checkpointClient: {
      ...checkpointClient,
      load: opts.load ?? (async () => null),
      markTerminal: async (input) => {
        terminals.push(input);
      },
      markDeliveryPending: async (input: any) => {
        deliveryPendings.push(input);
      },
    },
    binaryWorkItems: new BinaryWorkItemManager({ sweepIntervalMs: null }),
    awaitBinaryWriteAck: ack.fn,
    linkedFolders: opts.linkedFolders ?? [],
    sessionId: "sess_1",
    now: FIXED_NOW,
    maxProviderPolls: 1,
    providerPollDelayMs: 0,
    encryptArtifact: async () => ({
      artifactId: "artifact_1",
      ciphertextRef: "",
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
    }),
  })) {
    events.push(event);
  }
  return { events, reserves, reconciles, terminals, deliveryPendings, ack };
}

describe("orchestrator media executor", () => {
  it("delivers a video clip via the binary write-ACK path (preview-only, debits on ok)", async () => {
    const events: any[] = [];
    const reconciles: any[] = [];
    const terminals: any[] = [];
    const ack = fakeBinaryWriteAck("ok");
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-1" }),
          poll: async () => ({
            status: "done",
            videoBytes: new TextEncoder().encode("mp4"),
            mimeType: "video/mp4",
            actualQuotaUnits: 200,
            billingSource: "provider_operation_metadata",
          }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: async () => ({ ok: true, holdId: "hold_1" }) as const,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      binaryWorkItems: new BinaryWorkItemManager({ sweepIntervalMs: null }),
      awaitBinaryWriteAck: ack.fn,
      // No granted folder ⇒ preview-only delivery.
      linkedFolders: [],
      sessionId: "sess_1",
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "",
        sha256: sha256(new TextEncoder().encode("mp4")),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.kind === "orchestrator-artifact")).toBe(true);
    // The bytes were delivered through the binary write-ACK path, preview-only.
    const writeEvent = events.find((e) => e.kind === "binary-write-request");
    expect(writeEvent).toBeDefined();
    expect(writeEvent.payload.previewOnly).toBe(true);
    expect(writeEvent.payload.request.toolName).toBe("video.generate");
    expect(writeEvent.payload.request.outputPath.endsWith(".mp4")).toBe(true);
    expect(ack.calls.length).toBe(1);
    // Debited only after a successful write, with the provider's actual units.
    expect(reconciles.some((r) => r.status === "debited" && r.actualQuotaUnits === 200)).toBe(true);
    // Terminal hygiene so a resume cannot re-deliver.
    expect(terminals.some((t) => t.terminalState === "debited")).toBe(true);
    expect(events.some((e) => e.status === "done")).toBe(true);
  });

  it("bills the generation even when the user declines the folder save (delivered + viewed asset, no refund)", async () => {
    // Bill-on-generation: by the time the client ACKs, the irreversible provider
    // cost is already spent and the bytes were delivered (the preview renders
    // before the save prompt). Declining the FOLDER save is not a refund lever —
    // that was the bypass ("return a denied ACK to keep the bytes for free").
    const { reconciles, terminals } = await runVideoGen({
      ackOutcome: "denied_by_user",
      linkedFolders: [{ folderId: "fld_1", displayName: "Movies", status: "granted" }],
    });

    expect(reconciles.some((r) => r.status === "debited")).toBe(true);
    expect(reconciles.some((r) => r.status === "released")).toBe(false);
    // Delivered + viewed → terminal (no re-delivery owed), and billed.
    expect(terminals.some((t) => t.terminalState === "debited")).toBe(true);
    expect(terminals.some((t) => t.terminalState === "released")).toBe(false);
  });

  it("bills on generation and marks the job re-deliverable when the delivery ACK fails/withholds (no refund)", async () => {
    // The core bypass close: a client that received the bytes then returns an
    // error / withholds the ACK is STILL billed (we debit on the provider's
    // `done`, not on the ACK). The job is left re-deliverable rather than
    // refunded, so an honest client that genuinely missed the bytes can recover
    // the already-paid asset.
    const { reconciles, terminals, deliveryPendings } = await runVideoGen({
      ackOutcome: "error",
    });

    // Debited on generation; never released by a failed ACK.
    expect(reconciles.some((r) => r.status === "debited" && r.actualQuotaUnits === 200)).toBe(true);
    expect(reconciles.some((r) => r.status === "released")).toBe(false);
    // Recorded as re-deliverable (billed, awaiting receipt) — NOT a terminal row.
    expect(deliveryPendings.length).toBe(1);
    expect(deliveryPendings[0].providerJobId).toBe("op-1");
    expect(terminals.some((t) => t.terminalState === "released")).toBe(false);
    expect(terminals.some((t) => t.terminalState === "debited")).toBe(false);
  });

  it("emits the recovery sentinel detail (not the ACK reason) on an error ACK so the client surfaces retrieval", async () => {
    // Codex P2: when an ALIVE client reports an error/timeout ACK, awaitBinaryWriteAck
    // returns outcome:"error" WITH a reason (e.g. BINARY_WRITE_ACK_TIMEOUT) — the
    // MAIN recovery case. The web/mobile workspaces flip the "Retrieve your video"
    // banner only on the exact sentinel detail VIDEO_GENERATE_DELIVERY_UNCONFIRMED_BILLED,
    // so preferring the ACK reason over the sentinel made these billed,
    // re-deliverable jobs invisible to the user. The recoverable (non-denied) error
    // case must always carry the sentinel.
    const { events, deliveryPendings } = await runVideoGen({
      ackOutcome: "error",
      ackReason: "BINARY_WRITE_ACK_TIMEOUT",
    });

    // Still billed + left re-deliverable.
    expect(deliveryPendings.length).toBe(1);
    const errorProgress = events.find(
      (e) => e.kind === "orchestrator-media-job-progress" && e.status === "error",
    );
    expect(errorProgress).toBeDefined();
    expect(errorProgress.detail).toBe("VIDEO_GENERATE_DELIVERY_UNCONFIRMED_BILLED");
  });

  it("leaves the row delivery_pending (no second reconcile, no markBillingPending) when delivery THROWS after the in-turn debit", async () => {
    // Regression: once we have markDeliveryPending'd + reconciled('debited') in
    // the same turn, the hold is settled and the row is `delivery_pending`. A
    // throw AFTER that point — e.g. awaitBinaryWriteAck rejecting on a
    // network/abort/timeout while waiting for the client — must NOT re-enter the
    // billing_pending_provider reconcile / markBillingPending branch: doing so
    // settles an already-debited hold a second time AND overwrites the
    // delivery_pending row to billing_pending, which is outside both
    // RESUMABLE_STATES and the user-scoped list_user_delivery_pending filter →
    // the paid video is stranded out of every recovery path.
    const reconciles: any[] = [];
    const deliveryPendings: any[] = [];
    const billingPendings: any[] = [];
    const terminals: any[] = [];
    const events: any[] = [];
    const bytes = new TextEncoder().encode("mp4");
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-1" }),
          poll: async () => ({
            status: "done",
            videoBytes: bytes,
            mimeType: "video/mp4",
            actualQuotaUnits: 200,
            billingSource: "provider_operation_metadata",
          }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: async () => ({ ok: true, holdId: "hold_1" }) as const,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        load: async () => null,
        markDeliveryPending: async (input: any) => {
          deliveryPendings.push(input);
        },
        markBillingPending: async (input: any) => {
          billingPendings.push(input);
        },
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      binaryWorkItems: new BinaryWorkItemManager({ sweepIntervalMs: null }),
      // Reject AFTER the bytes are handed off, mimicking a client/connection drop
      // while the enclave awaits the write ACK.
      awaitBinaryWriteAck: async () => {
        throw new Error("connection reset while awaiting ack");
      },
      linkedFolders: [],
      sessionId: "sess_1",
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "",
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
      }),
    })) {
      events.push(event);
    }

    // Billed exactly once (the in-turn debit); never re-reconciled.
    expect(reconciles.filter((r) => r.status === "debited").length).toBe(1);
    expect(reconciles.some((r) => r.status === "billing_pending_provider")).toBe(false);
    expect(reconciles.some((r) => r.status === "released")).toBe(false);
    // Row stays delivery_pending — NEVER stomped to billing_pending.
    expect(deliveryPendings.length).toBe(1);
    expect(billingPendings.length).toBe(0);
    expect(terminals.length).toBe(0);
    // The turn still ends cleanly with an error progress event (no throw escapes).
    expect(events.at(-1)?.status).toBe("error");
  });

  it("creates NO delivery_pending row and releases the hold when the debit reconcile THROWS (debit-first; no free-asset path)", async () => {
    // Debit-FIRST ordering is the structural bypass close: the row is marked
    // delivery_pending only AFTER a confirmed debit, so a debit failure can never
    // leave an unpaid delivery_pending row for a later retrieve to re-deliver for
    // free. Here the debit reconcile throws → markDeliveryPending is NEVER reached
    // → no delivery_pending row exists → list_user_delivery_pending can never
    // surface it. The bytes never shipped (the binary-write yield is after the
    // debit), so nothing is owed: release the still-held hold. It must NOT fall
    // into billing_pending_provider / markBillingPending (which would bill the
    // user via the reconciler for an undelivered asset).
    const reconciles: any[] = [];
    const deliveryPendings: any[] = [];
    const billingPendings: any[] = [];
    const terminals: any[] = [];
    const events: any[] = [];
    const bytes = new TextEncoder().encode("mp4");
    let ackCalled = false;
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-1" }),
          poll: async () => ({
            status: "done",
            videoBytes: bytes,
            mimeType: "video/mp4",
            actualQuotaUnits: 200,
            billingSource: "provider_operation_metadata",
          }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: async () => ({ ok: true, holdId: "hold_1" }) as const,
        reconcile: async (input) => {
          reconciles.push(input);
          // The actual charge fails transiently (quota broker RPC error).
          if (input.status === "debited") throw new Error("quota broker transient");
        },
      },
      checkpointClient: {
        ...checkpointClient,
        load: async () => null,
        markDeliveryPending: async (input: any) => {
          deliveryPendings.push(input);
        },
        markBillingPending: async (input: any) => {
          billingPendings.push(input);
        },
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      binaryWorkItems: new BinaryWorkItemManager({ sweepIntervalMs: null }),
      awaitBinaryWriteAck: async () => {
        ackCalled = true;
        return { invocationId: "inv", outcome: "ok", resultJson: { status: "committed" } } as any;
      },
      linkedFolders: [],
      sessionId: "sess_1",
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "",
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
      }),
    })) {
      events.push(event);
    }

    // Debit-first: the debit threw BEFORE markDeliveryPending → no delivery_pending
    // row was ever written, so a retrieve can never re-deliver this unpaid asset.
    expect(deliveryPendings.length).toBe(0);
    // The debit was attempted exactly once (and threw); the bytes never shipped.
    expect(reconciles.filter((r) => r.status === "debited").length).toBe(1);
    expect(ackCalled).toBe(false);
    // NOT billed via the reconciler, NOT stomped to billing_pending.
    expect(reconciles.some((r) => r.status === "billing_pending_provider")).toBe(false);
    expect(billingPendings.length).toBe(0);
    // Released (no bill); no terminal_released needed (the provider_started row
    // simply TTL-expires, and it was never re-deliverable).
    expect(reconciles.some((r) => r.status === "released")).toBe(true);
    expect(terminals.some((t) => t.terminalState === "debited")).toBe(false);
    // Clean error event; no throw escapes the generator.
    expect(events.at(-1)?.status).toBe("error");
  });

  it("best-effort re-records delivery_pending (no release, no re-bill) when markDeliveryPending throws AFTER a successful debit", async () => {
    // Debit-first: the debit SUCCEEDED (asset paid) but markDeliveryPending threw,
    // so the paid row was never recorded re-deliverable on the happy path. The
    // catch must NOT release the already-debited hold and must NOT bill again — it
    // best-effort re-records the row delivery_pending so the paid asset stays
    // recoverable (a resume/retrieve then never re-debits). Here the retry (in the
    // catch) succeeds, so the row ends up delivery_pending.
    const reconciles: any[] = [];
    const deliveryPendings: any[] = [];
    const billingPendings: any[] = [];
    const events: any[] = [];
    const bytes = new TextEncoder().encode("mp4");
    let markCalls = 0;
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-1" }),
          poll: async () => ({
            status: "done",
            videoBytes: bytes,
            mimeType: "video/mp4",
            actualQuotaUnits: 200,
            billingSource: "provider_operation_metadata",
          }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: async () => ({ ok: true, holdId: "hold_1" }) as const,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        load: async () => null,
        markDeliveryPending: async (input: any) => {
          markCalls += 1;
          // The happy-path call (right after the debit) throws; the catch's
          // best-effort retry succeeds.
          if (markCalls === 1) throw new Error("checkpoint RPC blip");
          deliveryPendings.push(input);
        },
        markBillingPending: async (input: any) => {
          billingPendings.push(input);
        },
      },
      binaryWorkItems: new BinaryWorkItemManager({ sweepIntervalMs: null }),
      awaitBinaryWriteAck: async () => ({
        invocationId: "inv",
        outcome: "ok",
        resultJson: { status: "committed" },
      }) as any,
      linkedFolders: [],
      sessionId: "sess_1",
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "",
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
      }),
    })) {
      events.push(event);
    }

    // Debited exactly once (the asset is paid); never released, never re-billed.
    expect(reconciles.filter((r) => r.status === "debited").length).toBe(1);
    expect(reconciles.some((r) => r.status === "released")).toBe(false);
    expect(reconciles.some((r) => r.status === "billing_pending_provider")).toBe(false);
    expect(billingPendings.length).toBe(0);
    // markDeliveryPending was attempted twice (happy-path threw, catch retried)
    // and the retry recorded the paid row re-deliverable.
    expect(markCalls).toBe(2);
    expect(deliveryPendings.length).toBe(1);
  });

  it("re-delivers an already-paid asset from a delivery_pending checkpoint without reserving or debiting again", async () => {
    // Resume path: a job billed on a prior attempt (delivery_pending) re-polls
    // the provider job and re-delivers the asset. It must NOT reserve a new hold
    // or debit again (that would double-charge), and on success marks terminal.
    const { reserves, reconciles, terminals, deliveryPendings, ack } = await runVideoGen({
      ackOutcome: "ok",
      load: async () => ({
        state: "delivery_pending",
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        providerJobId: "op-1",
        provenanceSnapshotHash: promptProvenanceSnapshotHash,
      }),
    });

    // The asset was actually re-delivered.
    expect(ack.calls.length).toBe(1);
    // No second charge: no reserve, no debit.
    expect(reserves.length).toBe(0);
    expect(reconciles.some((r) => r.status === "debited")).toBe(false);
    expect(reconciles.some((r) => r.status === "released")).toBe(false);
    // Not re-marked delivery_pending; finalised as delivered.
    expect(deliveryPendings.length).toBe(0);
    expect(terminals.some((t) => t.terminalState === "debited")).toBe(true);
  });

  it("releases the hold (no bill) when the generated video exceeds the deliverable cap", async () => {
    // Bill-on-generation must NOT charge for an asset we can never deliver (our
    // own output cap). This is not a bypass — the attacker gets nothing — so the
    // honest-user protection (release, no debit) is preserved for undeliverable
    // output. (videoMaxOutputBytes default is far below this 200MB payload.)
    const { reconciles, deliveryPendings, events } = await runVideoGen({
      ackOutcome: "ok",
      videoBytes: new Uint8Array(200 * 1024 * 1024),
    });

    expect(reconciles.some((r) => r.status === "released")).toBe(true);
    expect(reconciles.some((r) => r.status === "debited")).toBe(false);
    expect(deliveryPendings.length).toBe(0);
    expect(events.some((e) => e.status === "error")).toBe(true);
  });

  it("blocks resumed specialist jobs when the provenance snapshot changed", async () => {
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => {
            throw new Error("must resume only");
          },
          poll: async () => ({
            status: "done",
            videoBytes: new TextEncoder().encode("mp4"),
            mimeType: "video/mp4",
            actualQuotaUnits: 200,
            billingSource: "provider_operation_metadata",
          }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "provider_started",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          providerJobId: "op-1",
          provenanceSnapshotHash: "old_snapshot",
        }),
      },
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_INPUT_PROVENANCE_SNAPSHOT_MISMATCH")).toBe(true);
  });

  it("recovers pending-start provider operations before retrying a non-idempotent provider", async () => {
    const saved: any[] = [];
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => {
            throw new Error("must recover instead of start");
          },
          recoverPendingStart: async () => ({ status: "found", providerJobId: "op-recovered" }),
          poll: async () => ({
            status: "done",
            videoBytes: new TextEncoder().encode("mp4"),
            mimeType: "video/mp4",
            actualQuotaUnits: 200,
            billingSource: "provider_operation_metadata",
          }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "pending_start",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          localIdempotencyKey: "key_1",
          provenanceSnapshotHash: promptProvenanceSnapshotHash,
        }),
        saveProviderJob: async (input) => {
          saved.push(input);
        },
      },
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: sha256(new TextEncoder().encode("mp4")),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(saved.some((s) => s.providerJobId === "op-recovered")).toBe(true);
    expect(events.some((e) => e.kind === "orchestrator-artifact")).toBe(true);
  });

  it("does not release quota when provider start returned but saveProviderJob fails", async () => {
    const reconciles: string[] = [];
    const markBillingPendingCalls: unknown[] = [];
    const events: any[] = [];

    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-orphan-window" }),
          poll: async () => ({ status: "running", progressPercent: 5 }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input.status);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        saveProviderJob: async () => {
          throw new Error("checkpoint down");
        },
        markBillingPending: async (input) => {
          markBillingPendingCalls.push(input);
        },
      },
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => {
        throw new Error("unused");
      },
    })) {
      events.push(event);
    }

    expect(reconciles).not.toContain("released");
    expect(reconciles).toContain("billing_pending_provider");
    expect(markBillingPendingCalls).toContainEqual(
      expect.objectContaining({ providerJobId: "op-orphan-window" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "orchestrator-media-job-progress",
        status: "error",
        detail: expect.stringContaining("PROVIDER_RECONCILIATION_PENDING"),
      }),
    );
  });

  it("does not release quota when start fails after pending_start is saved", async () => {
    const reconciles: string[] = [];
    const events: any[] = [];
    const providerStarts: string[] = [];

    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => {
            providerStarts.push("google-start");
            throw new Error("network lost after provider accepted request");
          },
          poll: async () => ({ status: "running", progressPercent: 5 }),
        },
        openai: {
          start: async () => {
            providerStarts.push("openai-start");
            return { providerJobId: "op-openai" };
          },
          poll: async () => ({ status: "running", progressPercent: 5 }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input.status);
        },
      },
      checkpointClient,
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => {
        throw new Error("unused");
      },
    })) {
      events.push(event);
    }

    expect(reconciles).not.toContain("released");
    expect(providerStarts).toEqual(["google-start"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "orchestrator-media-job-progress",
        status: "error",
        detail: expect.stringContaining("PENDING_START_RECONCILIATION_REQUIRED"),
      }),
    );
  });

  it("blocks pending-start retries when provider recovery cannot prove absence", async () => {
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => {
            throw new Error("must not start");
          },
          recoverPendingStart: async () => ({ status: "unavailable", reason: "LIST_UNAVAILABLE" }),
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "pending_start",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          localIdempotencyKey: "key_1",
          provenanceSnapshotHash: "old_snapshot",
        }),
      },
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_ORPHAN_RECONCILIATION_REQUIRED")).toBe(true);
  });

  it("blocks private-tainted provider inputs until signed consent is present", async () => {
    const privateRecord: MediaProvenanceRecord = { ...promptRecord, origin: "generated_from_private" };
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: { ...baseGenerateMedia, privacyPolicy: "provider_visible_requires_consent" } },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => {
            throw new Error("must not dispatch");
          },
          poll: async () => ({ status: "failed", reason: "unused" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(privateRecord),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient,
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.status === "waiting_for_consent")).toBe(true);
  });

  it("propagates cancellation to providers and reconciles the quota hold", async () => {
    const abort = new AbortController();
    const calls: string[] = [];
    abort.abort();
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-1" }),
          poll: async () => ({ status: "running" }),
          cancel: async () => {
            calls.push("cancel");
          },
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          calls.push(input.status);
        },
      },
      checkpointClient,
      abortSignal: abort.signal,
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(calls).toContain("cancel");
    expect(calls).toContain("cancelled_pending_provider");
    expect(events.some((e) => e.status === "cancelled")).toBe(true);
  });

  it("debits cancelled provider jobs that later complete and are billed", async () => {
    const reconciles: any[] = [];
    const terminals: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "unused" }),
          poll: async () => ({
            status: "done",
            videoBytes: new TextEncoder().encode("mp4"),
            mimeType: "video/mp4",
            actualQuotaUnits: 175,
            billingReceiptId: "bill_1",
            billingSource: "provider_final",
          }),
        },
      },
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          { mediaJobId: "mj_1", providerId: "google", providerJobId: "op_1", holdId: "hold_1" },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
    });

    expect(reconciles).toEqual([
      { holdId: "hold_1", status: "debited", actualQuotaUnits: 175, billingReceiptId: "bill_1" },
    ]);
    expect(terminals).toEqual([{ mediaJobId: "mj_1", terminalState: "debited" }]);
  });

  it("keeps cancelled provider jobs open while billing metadata is pending", async () => {
    const reconciles: any[] = [];
    const terminals: any[] = [];
    const alerts: any[] = [];
    const overrides: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "unused" }),
          poll: async () => ({ status: "billing_pending", reason: "PROVIDER_BILLING_METADATA_MISSING" }),
        },
      },
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          { mediaJobId: "mj_1", providerId: "google", providerJobId: "op_1", holdId: "hold_1" },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      emitOperatorAlert: async (input) => {
        alerts.push(input);
      },
      disableProviderModel: async (input) => {
        overrides.push(input);
      },
      now: new Date("2026-05-19T10:00:00.000Z"),
      billingMetadataSlaMs: 60 * 60 * 1000,
    });

    expect(reconciles).toEqual([]);
    expect(terminals).toEqual([]);
    expect(alerts).toEqual([]);
    expect(overrides).toEqual([]);
  });

  it("alerts and disables a provider model when billing-pending jobs exceed the SLA", async () => {
    const alerts: any[] = [];
    const overrides: any[] = [];
    const escalations: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "unused" }),
          poll: async () => ({ status: "billing_pending", reason: "PROVIDER_BILLING_METADATA_MISSING" }),
        },
      },
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        listBillingPending: async () => [
          {
            mediaJobId: "mj_1",
            providerId: "google",
            providerJobId: "op_1",
            holdId: "hold_1",
            firstBillingPendingAt: "2026-05-19T08:00:00.000Z",
            billingPendingPollCount: 12,
          },
        ],
        markBillingSlaEscalated: async (input) => {
          escalations.push(input);
        },
      },
      emitOperatorAlert: async (input) => {
        alerts.push(input);
      },
      disableProviderModel: async (input) => {
        overrides.push(input);
      },
      now: new Date("2026-05-19T10:00:00.000Z"),
      billingMetadataSlaMs: 60 * 60 * 1000,
    });

    expect(alerts.some((a) => a.code === "VIDEO_BILLING_METADATA_SLA_EXCEEDED" && a.mediaJobId === "mj_1")).toBe(true);
    expect(overrides.some((o) => o.providerId === "google" && o.reason === "VIDEO_BILLING_METADATA_SLA_EXCEEDED")).toBe(true);
    expect(escalations.some((e) => e.mediaJobId === "mj_1" && e.alertedAt === "2026-05-19T10:00:00.000Z")).toBe(true);
  });

  it("does not emit duplicate billing SLA alerts for already-escalated jobs", async () => {
    const alerts: any[] = [];
    const overrides: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "unused" }),
          poll: async () => ({ status: "billing_pending", reason: "PROVIDER_BILLING_METADATA_MISSING" }),
        },
      },
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        listBillingPending: async () => [
          {
            mediaJobId: "mj_1",
            providerId: "google",
            providerJobId: "op_1",
            holdId: "hold_1",
            firstBillingPendingAt: "2026-05-19T08:00:00.000Z",
            billingPendingPollCount: 25,
            slaAlertedAt: "2026-05-19T09:05:00.000Z",
          },
        ],
      },
      emitOperatorAlert: async (input) => {
        alerts.push(input);
      },
      disableProviderModel: async (input) => {
        overrides.push(input);
      },
      now: new Date("2026-05-19T10:00:00.000Z"),
      billingMetadataSlaMs: 60 * 60 * 1000,
    });

    expect(alerts).toEqual([]);
    expect(overrides).toEqual([]);
  });

  it("releases budget holds when pending_start is not durable before provider start", async () => {
    const calls: string[] = [];
    const events: any[] = [];
    let startedProvider = false;
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => {
            startedProvider = true;
            throw new Error("must not start without pending_start");
          },
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          calls.push(input.status);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        savePendingStart: async () => {
          throw new Error("checkpoint down");
        },
      },
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(startedProvider).toBe(false);
    expect(calls).toContain("released");
    expect(events.some((e) => e.status === "error" && e.detail === "checkpoint down")).toBe(true);
  });

  it("contains a quota-release reconcile failure inside the subtask error path (M6)", async () => {
    // The error-path `budgetClient.reconcile({status:'released'})` was the one
    // unguarded await in runMediaSubtask's catch: a reconcile throw escaped the
    // generator entirely, poisoning the orchestrator's media branch instead of
    // ending in an error progress event.
    const events: any[] = [];
    await (async () => {
      for await (const event of runMediaSubtask({
        agentTurnId: "turn_1",
        planId: "plan_1",
        subtask: { ...baseSubtask, media: baseGenerateMedia },
        route: baseRoute,
        videoAdapters: {
          google: {
            start: async () => {
              throw new Error("must not start without pending_start");
            },
            poll: async () => ({ status: "running" }) as const,
          },
        },
        providerInput: baseProviderInput,
        recordsByHandleId: makeRecords(),
        handleStore,
        provenanceSigner,
        consentVerifier,
        budgetClient: {
          reserve: budgetClient.reserve,
          reconcile: async () => {
            throw new Error("budget service down");
          },
        },
        checkpointClient: {
          ...checkpointClient,
          savePendingStart: async () => {
            throw new Error("checkpoint down");
          },
        },
        now: FIXED_NOW,
        maxProviderPolls: 1,
        providerPollDelayMs: 0,
        encryptArtifact: async () => ({
          artifactId: "artifact_1",
          ciphertextRef: "blob_1",
          sha256: "a".repeat(64),
          byteSize: 3,
        }),
      })) {
        events.push(event);
      }
    })();

    const errorEvent = events.find((e) => e.status === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.detail).toContain("checkpoint down");
    expect(errorEvent.detail).toContain("QUOTA_RELEASE_RECONCILIATION_FAILED");
  });

  it("runs a Remotion render only after custody and manifest checks pass", async () => {
    const events: any[] = [];
    const heroBytes = new TextEncoder().encode("hero");
    const heroRecord: MediaProvenanceRecord = {
      handleId: "mh_hero",
      kind: "image",
      origin: "generated",
      providerVisible: false,
      sourceHandleIds: [],
      createdBy: "test",
      createdAt: "2026-05-19T08:00:00.000Z",
      ttlSeconds: 900,
      byteSize: heroBytes.byteLength,
      sha256: sha256(heroBytes),
      signature: "sig",
    };
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: {
        id: "render-1",
        title: "Render teaser",
        objective: "Render a captioned teaser",
        kind: "video",
        requiredCapabilities: ["video_generation"],
        allowedTools: ["video.render"],
        dependsOn: [],
        producesArtifact: true,
        risk: "medium",
        media: {
          operation: "video_render",
          expectedArtifactKind: "video/mp4",
          maxDurationSeconds: 8,
          privacyPolicy: "attested_render_required",
        },
      },
      route: { modelId: "claude-opus-4-7", providerId: "anthropic", subtaskId: "render-1", reason: "test", fallbackModelIds: [] },
      createJobNonce: () => VALID_NITRO_FIXTURE.nonce,
      now: new Date("2026-05-19T08:01:00.000Z"),
      videoAdapters: {},
      budgetClient,
      checkpointClient,
      compositionSpec: {
        version: 1,
        title: "Render teaser",
        templateId: "promo_cut",
        format: { width: 1080, height: 1920, fps: 30, durationFrames: 240 },
        assets: [{ id: "hero", handleId: "mh_hero", kind: "image" }],
        scenes: [
          {
            id: "s1",
            startFrame: 0,
            durationFrames: 240,
            layout: "full_bleed",
            layers: [{ type: "asset", assetId: "hero", fit: "cover" }],
          },
        ],
      },
      recordsByHandleId: new Map([["mh_hero", heroRecord]]),
      handleStore: {
        getBytes: async (handleId: string) => (handleId === "mh_hero" ? heroBytes : null),
        getText: async () => null,
      },
      provenanceSigner,
      renderBackend: {
        trustLevel: "attested",
        requestAttestation: async (input) => ({
          rawDocument: fixtureNitroDocument(input.nonce === VALID_NITRO_FIXTURE.nonce ? "valid" : "mutated-nonce"),
        }),
        render: async (bundle) => ({
          videoBytes: new TextEncoder().encode("mp4"),
          mimeType: "video/mp4",
          manifest: {
            templateId: "promo_cut",
            inputHandleIds: ["mh_hero"],
            outputHash: sha256(new TextEncoder().encode("mp4")),
            renderVersion: "test-renderer",
            durationFrames: 240,
            provenanceSnapshotHash: bundle.provenanceSnapshotHash,
            jobNonce: bundle.jobNonce,
            signerKeyId: VALID_NITRO_FIXTURE.publicKeyId,
            signature: "sig",
          },
        }),
      },
      renderAttestationPolicy: {
        nitroRootBundle: fixtureNitroRootBundle(),
        allowedMeasurements: [VALID_NITRO_FIXTURE.pcr0],
        revokedMeasurements: [],
        allowedSignerKeyIds: [VALID_NITRO_FIXTURE.publicKeyId],
      },
      verifyRenderManifestSignature: () => true,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: sha256(new TextEncoder().encode("mp4")),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.kind === "orchestrator-artifact")).toBe(true);
  });

  it("refuses to resume when the current route disagrees with the checkpointed provider/model, AND cleans up the upstream job", async () => {
    const calls: string[] = [];
    const markedCancelled: any[] = [];
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: { ...baseRoute, providerId: "openai", modelId: "sora-2" },
      videoAdapters: {
        google: {
          start: async () => {
            calls.push("google-start");
            return { providerJobId: "op-1" };
          },
          poll: async () => ({ status: "running" }),
          cancel: async (input) => {
            calls.push(`google-cancel:${input.providerJobId}`);
          },
        },
        openai: {
          start: async () => {
            calls.push("openai-start");
            return { providerJobId: "op-2" };
          },
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "provider_started",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          providerJobId: "op-1",
          provenanceSnapshotHash: promptProvenanceSnapshotHash,
        }),
        markCancelled: async (input) => {
          markedCancelled.push(input);
        },
      },
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    // Neither adapter is asked to start a new job.
    expect(calls).not.toContain("google-start");
    expect(calls).not.toContain("openai-start");
    // The CHECKPOINT'S adapter cancels the in-flight job (not the new route's).
    expect(calls).toContain("google-cancel:op-1");
    // And we persist the cancelled checkpoint so the reconciler can settle the hold.
    expect(markedCancelled).toEqual([{ mediaJobId: expect.any(String), providerJobId: "op-1" }]);
    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_RESUME_ROUTE_MISMATCH")).toBe(true);
  });

  it("cancels the upstream provider job before releasing the hold on resume-time provenance mismatch", async () => {
    const cancelled: string[] = [];
    const reconciles: string[] = [];
    const markedCancelled: any[] = [];
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => {
            throw new Error("must not start on resume");
          },
          poll: async () => ({ status: "running" }),
          cancel: async (input) => {
            cancelled.push(input.providerJobId);
          },
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input.status);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "provider_started",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          providerJobId: "op-running",
          provenanceSnapshotHash: "old_snapshot",
        }),
        markCancelled: async (input) => {
          markedCancelled.push(input);
        },
      },
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(cancelled).toEqual(["op-running"]);
    expect(markedCancelled).toEqual([{ mediaJobId: expect.any(String), providerJobId: "op-running" }]);
    expect(reconciles).toContain("cancelled_pending_provider");
    expect(reconciles).not.toContain("released");
    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_INPUT_PROVENANCE_SNAPSHOT_MISMATCH")).toBe(true);
  });

  it("persists the cancelled checkpoint before attempting adapter.cancel so a throw does not orphan the provider job", async () => {
    const abort = new AbortController();
    const order: string[] = [];
    const events: any[] = [];
    abort.abort();
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-1" }),
          poll: async () => ({ status: "running" }),
          cancel: async () => {
            order.push("cancel");
            throw new Error("provider 503");
          },
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          order.push(`reconcile:${input.status}`);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        markCancelled: async () => {
          order.push("markCancelled");
        },
      },
      abortSignal: abort.signal,
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    // markCancelled must come before cancel so a throw cannot orphan the row.
    expect(order.indexOf("markCancelled")).toBeLessThan(order.indexOf("cancel"));
    // Even though cancel threw, the hold is reconciled cancelled_pending_provider.
    expect(order).toContain("reconcile:cancelled_pending_provider");
    expect(events.some((e) => e.status === "cancelled")).toBe(true);
  });

  it("recovers a pending_start provider job through the checkpoint adapter on route mismatch", async () => {
    const calls: string[] = [];
    const markedCancelled: any[] = [];
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: { ...baseRoute, providerId: "openai", modelId: "sora-2" },
      videoAdapters: {
        google: {
          start: async () => {
            calls.push("google-start");
            return { providerJobId: "op-1" };
          },
          poll: async () => ({ status: "running" }),
          cancel: async (input) => {
            calls.push(`google-cancel:${input.providerJobId}`);
          },
          recoverPendingStart: async () => ({ status: "found", providerJobId: "op-recovered" }),
        },
        openai: {
          start: async () => {
            calls.push("openai-start");
            return { providerJobId: "op-2" };
          },
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "pending_start",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          localIdempotencyKey: "key_1",
          provenanceSnapshotHash: promptProvenanceSnapshotHash,
        }),
        markCancelled: async (input) => {
          markedCancelled.push(input);
        },
      },
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    // checkpoint adapter probed, recovered provider job cleaned up.
    expect(markedCancelled).toEqual([{ mediaJobId: expect.any(String), providerJobId: "op-recovered" }]);
    expect(calls).toContain("google-cancel:op-recovered");
    expect(calls).not.toContain("openai-start");
    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_RESUME_ROUTE_MISMATCH")).toBe(true);
  });

  it("surfaces PROVIDER_RESUME_ROUTE_MISMATCH_PENDING_START_UNRECOVERABLE when the checkpoint's adapter is missing from the registry", async () => {
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: { ...baseRoute, providerId: "openai", modelId: "sora-2" },
      videoAdapters: {
        // Note: no "google" adapter registered. Checkpoint references google.
        openai: {
          start: async () => ({ providerJobId: "op-2" }),
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "pending_start",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          localIdempotencyKey: "key_1",
          provenanceSnapshotHash: promptProvenanceSnapshotHash,
        }),
      },
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_RESUME_ROUTE_MISMATCH_PENDING_START_UNRECOVERABLE")).toBe(true);
  });

  it("surfaces PROVIDER_RESUME_ROUTE_MISMATCH_CHECKPOINT_UNAVAILABLE when markCancelled fails in route-mismatch cleanup", async () => {
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: { ...baseRoute, providerId: "openai", modelId: "sora-2" },
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-1" }),
          poll: async () => ({ status: "running" }),
          cancel: async () => undefined,
        },
        openai: {
          start: async () => ({ providerJobId: "op-2" }),
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "provider_started",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          providerJobId: "op-running",
          provenanceSnapshotHash: promptProvenanceSnapshotHash,
        }),
        markCancelled: async () => {
          throw new Error("DB unreachable");
        },
      },
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_RESUME_ROUTE_MISMATCH_CHECKPOINT_UNAVAILABLE")).toBe(true);
  });

  it("surfaces PROVIDER_RESUME_ROUTE_MISMATCH_PENDING_START_UNRECOVERABLE when the checkpoint adapter cannot prove absence", async () => {
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: { ...baseRoute, providerId: "openai", modelId: "sora-2" },
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-1" }),
          poll: async () => ({ status: "running" }),
          recoverPendingStart: async () => ({ status: "unavailable", reason: "no list api" }),
        },
        openai: {
          start: async () => ({ providerJobId: "op-2" }),
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "pending_start",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          localIdempotencyKey: "key_1",
          provenanceSnapshotHash: promptProvenanceSnapshotHash,
        }),
      },
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_RESUME_ROUTE_MISMATCH_PENDING_START_UNRECOVERABLE")).toBe(true);
  });

  it("leaves the hold as held (not cancelled_pending_provider) when markCancelled fails on resume-time mismatch", async () => {
    const reconciles: string[] = [];
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: baseRoute,
      videoAdapters: {
        google: {
          start: async () => {
            throw new Error("must not start");
          },
          poll: async () => ({ status: "running" }),
          cancel: async () => undefined,
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input.status);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "provider_started",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          providerJobId: "op-running",
          provenanceSnapshotHash: "old_snapshot",
        }),
        markCancelled: async () => {
          throw new Error("DB unreachable");
        },
      },
      now: FIXED_NOW,
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    // markCancelled failed → the hold must NOT be marked cancelled_pending_provider
    // (the reconciler would never see it). It also is not "released" — TTL bounds
    // the leak instead. The blocked event composes +CHECKPOINT_UNAVAILABLE so the
    // failure is observable to operators paging on the route mismatch alarm.
    expect(reconciles).not.toContain("cancelled_pending_provider");
    expect(reconciles).not.toContain("released");
    expect(
      events.some(
        (e) =>
          e.status === "blocked" &&
          e.detail === "PROVIDER_INPUT_PROVENANCE_SNAPSHOT_MISMATCH+CHECKPOINT_UNAVAILABLE",
      ),
    ).toBe(true);
  });

  it("provider_started route mismatch with missing adapter writes the unreachable sentinel", async () => {
    const markedCancelled: any[] = [];
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: { ...baseRoute, providerId: "openai", modelId: "sora-2" },
      videoAdapters: {
        // no `google` adapter — registry pruned.
        openai: {
          start: async () => ({ providerJobId: "op-2" }),
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "provider_started",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          providerJobId: "op-running",
          provenanceSnapshotHash: promptProvenanceSnapshotHash,
        }),
        markCancelled: async (input) => {
          markedCancelled.push(input);
        },
      },
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    expect(markedCancelled).toEqual([
      {
        mediaJobId: expect.any(String),
        providerJobId: `${PROVIDER_STARTED_UNREACHABLE_SENTINEL_PREFIX}op-running`,
      },
    ]);
    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_RESUME_ROUTE_MISMATCH_PROVIDER_STARTED_UNREACHABLE")).toBe(true);
  });

  it("reconciler retires the provider_started-unreachable sentinel after confirmed alert delivery", async () => {
    const reconciles: any[] = [];
    const terminals: any[] = [];
    const alerts: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        // no adapter for the sentinel's providerId.
      },
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          {
            mediaJobId: "mj_sentinel",
            providerId: "google",
            providerJobId: `${PROVIDER_STARTED_UNREACHABLE_SENTINEL_PREFIX}op-original`,
            holdId: "hold_sentinel",
          },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      emitOperatorAlert: async (input) => {
        alerts.push(input);
      },
    });

    expect(alerts.some((a) => a.code === "VIDEO_RECONCILER_SENTINEL_RETIRED")).toBe(true);
    expect(reconciles).toEqual([{ holdId: "hold_sentinel", status: "released" }]);
    expect(terminals).toEqual([{ mediaJobId: "mj_sentinel", terminalState: "released" }]);
  });

  it("reconciler retires PENDING_START_UNRECOVERABLE_SENTINEL after confirmed alert delivery", async () => {
    const reconciles: any[] = [];
    const terminals: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {},
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          {
            mediaJobId: "mj_sentinel",
            providerId: "google",
            providerJobId: PENDING_START_UNRECOVERABLE_SENTINEL,
            holdId: "hold_sentinel",
          },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      emitOperatorAlert: async () => undefined,
    });

    expect(reconciles).toEqual([{ holdId: "hold_sentinel", status: "released" }]);
    expect(terminals).toEqual([{ mediaJobId: "mj_sentinel", terminalState: "released" }]);
  });

  it("retire-path tolerates markTerminal failure on first sweep then converges on retry", async () => {
    // Simulates two consecutive sweeps. First sweep: alert delivered,
    // reconcile succeeds, but markTerminal throws. Second sweep: same
    // row is still listed (because markTerminal didn't persist),
    // markTerminal succeeds. The contract is that the second invocation
    // does not corrupt accounting (budget reconcile is idempotent for
    // already-released holds) and the row finally exits the worklist.
    let markTerminalFailures = 1;
    const reconciles: any[] = [];
    const terminals: any[] = [];
    const alerts: any[] = [];
    const sweep = async () =>
      reconcileCancelledProviderCompletions({
        videoAdapters: {},
        budgetClient: {
          reserve: budgetClient.reserve,
          reconcile: async (input) => {
            reconciles.push(input);
          },
        },
        checkpointClient: {
          ...checkpointClient,
          listCancelledPending: async () =>
            terminals.length === 0
              ? [
                  {
                    mediaJobId: "mj_retry",
                    providerId: "google",
                    providerJobId: PENDING_START_UNRECOVERABLE_SENTINEL,
                    holdId: "hold_retry",
                  },
                ]
              : [],
          markTerminal: async (input) => {
            if (markTerminalFailures > 0) {
              markTerminalFailures -= 1;
              throw new Error("DB blip");
            }
            terminals.push(input);
          },
        },
        emitOperatorAlert: async (input) => {
          alerts.push(input);
        },
      });

    await sweep();
    await sweep();

    // Two release reconciles (one per sweep) — budgetClient.reconcile
    // is expected to be idempotent for already-released holds.
    expect(reconciles.filter((r) => r.status === "released")).toHaveLength(2);
    // Exactly one terminal write made it through; subsequent sweep
    // sees an empty list and converges.
    expect(terminals).toEqual([{ mediaJobId: "mj_retry", terminalState: "released" }]);
    // SENTINEL_RETIRED alert fires twice (once per sweep), plus a
    // SETTLEMENT_FAILED alert when markTerminal threw on sweep 1.
    expect(alerts.some((a) => a.code === "VIDEO_RECONCILER_SETTLEMENT_FAILED")).toBe(true);
  });

  it("does NOT destructively retire a sentinel row when the alert sink throws", async () => {
    const reconciles: any[] = [];
    const terminals: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {},
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          {
            mediaJobId: "mj_sentinel",
            providerId: "google",
            providerJobId: PENDING_START_UNRECOVERABLE_SENTINEL,
            holdId: "hold_sentinel",
          },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      emitOperatorAlert: async () => {
        throw new Error("alert sink down");
      },
    });

    // Alert swallowed → sentinel retirement is deferred to next sweep.
    expect(reconciles).toEqual([]);
    expect(terminals).toEqual([]);
  });

  it("reconciler isolation survives a degraded operator-alert sink (alert throws)", async () => {
    let healthySettled = false;
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        flaky: {
          start: async () => ({ providerJobId: "unused" }),
          poll: async () => {
            throw new Error("network 503");
          },
        },
        healthy: {
          start: async () => ({ providerJobId: "unused" }),
          poll: async () => ({
            status: "done",
            videoBytes: new TextEncoder().encode("mp4"),
            mimeType: "video/mp4",
            actualQuotaUnits: 100,
            billingSource: "provider_final",
          }),
        },
      },
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          if (input.holdId === "hold_2") healthySettled = true;
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          { mediaJobId: "mj_flaky", providerId: "flaky", providerJobId: "op_1", holdId: "hold_1" },
          { mediaJobId: "mj_healthy", providerId: "healthy", providerJobId: "op_2", holdId: "hold_2" },
        ],
      },
      emitOperatorAlert: async () => {
        throw new Error("alert sink degraded");
      },
    });

    // Despite emitOperatorAlert throwing on the flaky row, the healthy row
    // still reaches its reconcile call — per-job isolation is intact.
    expect(healthySettled).toBe(true);
  });

  it("does NOT destructively retire a missing-adapter row when the alert sink throws (alert must be confirmed delivered)", async () => {
    const reconciles: any[] = [];
    const terminals: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        // No adapter for the row's providerId.
      },
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          { mediaJobId: "mj_skew", providerId: "google", providerJobId: "op_real", holdId: "hold_skew" },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      emitOperatorAlert: async () => {
        throw new Error("alert sink down");
      },
    });

    // Alert swallowed → row must NOT be released or terminally retired.
    // Next sweep will retry; transient registry/alert outages cannot
    // silently drain quota holds.
    expect(reconciles).toEqual([]);
    expect(terminals).toEqual([]);
  });

  it("does NOT destructively retire a missing-adapter row when no alert sink is provided at all", async () => {
    const reconciles: any[] = [];
    const terminals: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {},
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          { mediaJobId: "mj_skew", providerId: "google", providerJobId: "op_real", holdId: "hold_skew" },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      // emitOperatorAlert intentionally not provided
    });

    expect(reconciles).toEqual([]);
    expect(terminals).toEqual([]);
  });

  it("terminally retires a non-sentinel row whose providerId has no registered adapter (exactly-once alert + release + markTerminal)", async () => {
    const alerts: any[] = [];
    const reconciles: any[] = [];
    const terminals: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        // No `google` adapter registered. The row is non-sentinel.
      },
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          { mediaJobId: "mj_orphan", providerId: "google", providerJobId: "op_real", holdId: "hold_orphan" },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
      emitOperatorAlert: async (input) => {
        alerts.push(input);
      },
    });

    // Exactly one VIDEO_RECONCILER_ADAPTER_MISSING alert (distinct from
    // VIDEO_RECONCILER_POLL_FAILED so dashboards can split structural
    // misconfig from provider-side fault), hold released, row terminally
    // retired so a subsequent sweep would not see it again.
    expect(alerts.filter((a) => a.code === "VIDEO_RECONCILER_ADAPTER_MISSING")).toHaveLength(1);
    expect(reconciles).toEqual([{ holdId: "hold_orphan", status: "released" }]);
    expect(terminals).toEqual([{ mediaJobId: "mj_orphan", terminalState: "released" }]);
  });

  it("emits operator alerts when reconciler isolates per-job poll failures", async () => {
    const alerts: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        flaky: {
          start: async () => ({ providerJobId: "unused" }),
          poll: async () => {
            throw new Error("network 503");
          },
        },
      },
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          { mediaJobId: "mj_1", providerId: "flaky", providerJobId: "op_1", holdId: "hold_1" },
        ],
      },
      emitOperatorAlert: async (input) => {
        alerts.push(input);
      },
    });

    expect(alerts.some((a) => a.code === "VIDEO_RECONCILER_POLL_FAILED" && a.mediaJobId === "mj_1")).toBe(true);
  });

  it("composes route-mismatch detail when adapter is unreachable AND markCancelled fails", async () => {
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: { ...baseRoute, providerId: "openai", modelId: "sora-2" },
      videoAdapters: {
        // Note: no google adapter (registry pruned).
        openai: {
          start: async () => ({ providerJobId: "op-2" }),
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "provider_started",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          providerJobId: "op-running",
          provenanceSnapshotHash: promptProvenanceSnapshotHash,
        }),
        markCancelled: async () => {
          throw new Error("DB unreachable");
        },
      },
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    // Composed detail keeps the harder-to-recover signal visible.
    expect(events.some((e) => e.status === "blocked" && /PROVIDER_STARTED_UNREACHABLE/.test(e.detail) && /CHECKPOINT_UNAVAILABLE/.test(e.detail))).toBe(true);
  });

  it("garbage-collects pending_start checkpoint when recoverPendingStart is unavailable so it cannot loop forever", async () => {
    const markedCancelled: any[] = [];
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtask: { ...baseSubtask, media: baseGenerateMedia },
      route: { ...baseRoute, providerId: "openai", modelId: "sora-2" },
      videoAdapters: {
        google: {
          start: async () => ({ providerJobId: "op-1" }),
          poll: async () => ({ status: "running" }),
          recoverPendingStart: async () => ({ status: "unavailable", reason: "no list api" }),
        },
        openai: {
          start: async () => ({ providerJobId: "op-2" }),
          poll: async () => ({ status: "running" }),
        },
      },
      providerInput: baseProviderInput,
      recordsByHandleId: makeRecords(),
      handleStore,
      provenanceSigner,
      consentVerifier,
      budgetClient,
      checkpointClient: {
        ...checkpointClient,
        load: async () => ({
          state: "pending_start",
          providerId: "google",
          modelId: "veo-3.1-generate-preview",
          localIdempotencyKey: "key_1",
          provenanceSnapshotHash: promptProvenanceSnapshotHash,
        }),
        markCancelled: async (input) => {
          markedCancelled.push(input);
        },
      },
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "blob_1",
        sha256: "a".repeat(64),
        byteSize: 3,
      }),
    })) {
      events.push(event);
    }

    // Checkpoint terminally marked so the row does not loop forever.
    expect(markedCancelled.length).toBeGreaterThan(0);
    expect(events.some((e) => e.status === "blocked" && e.detail === "PROVIDER_RESUME_ROUTE_MISMATCH_PENDING_START_UNRECOVERABLE")).toBe(true);
  });

  it("reconciler isolates per-job poll failures so one degraded provider does not stall the sweep", async () => {
    const reconciles: any[] = [];
    const terminals: any[] = [];
    await reconcileCancelledProviderCompletions({
      videoAdapters: {
        flaky: {
          start: async () => ({ providerJobId: "unused" }),
          poll: async () => {
            throw new Error("provider 503");
          },
        },
        healthy: {
          start: async () => ({ providerJobId: "unused" }),
          poll: async () => ({
            status: "done",
            videoBytes: new TextEncoder().encode("mp4"),
            mimeType: "video/mp4",
            actualQuotaUnits: 100,
            billingSource: "provider_final",
          }),
        },
      },
      budgetClient: {
        reserve: budgetClient.reserve,
        reconcile: async (input) => {
          reconciles.push(input);
        },
      },
      checkpointClient: {
        ...checkpointClient,
        listCancelledPending: async () => [
          { mediaJobId: "mj_flaky", providerId: "flaky", providerJobId: "op_1", holdId: "hold_1" },
          { mediaJobId: "mj_healthy", providerId: "healthy", providerJobId: "op_2", holdId: "hold_2" },
        ],
        markTerminal: async (input) => {
          terminals.push(input);
        },
      },
    });

    // Healthy provider's job still settled despite flaky provider's throw.
    expect(reconciles.some((r) => r.holdId === "hold_2" && r.status === "debited")).toBe(true);
    expect(terminals).toContainEqual({ mediaJobId: "mj_healthy", terminalState: "debited" });
  });
});
