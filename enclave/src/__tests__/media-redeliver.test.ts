import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { redeliverPendingMedia } from "../orchestrator/media-redeliver";
import { BinaryWorkItemManager } from "../tools/binary-work-items";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Records the binary write ACK + returns a caller-chosen outcome.
function fakeAck(outcome: "ok" | "denied_by_user" | "error" = "ok", reason?: string) {
  const calls: unknown[] = [];
  const fn = async (payload: unknown) => {
    calls.push(payload);
    return { invocationId: "inv", outcome, ...(reason ? { reason } : {}) } as never;
  };
  return { fn, calls };
}

const PENDING_JOB = {
  mediaJobId: "mj_pending",
  providerId: "google",
  modelId: "veo-3.1-generate-preview",
  providerJobId: "op-1",
  provenanceSnapshotHash: "a".repeat(64),
};

const bytes = new TextEncoder().encode("mp4-bytes");

function baseDeps(overrides: {
  ack?: ReturnType<typeof fakeAck>;
  jobs?: (typeof PENDING_JOB)[];
  poll?: () => Promise<unknown>;
  videoAdapters?: Record<string, unknown>;
  terminals?: unknown[];
  mode?: "deliver" | "list";
}) {
  const terminals = overrides.terminals ?? [];
  const ack = overrides.ack ?? fakeAck("ok");
  return {
    deps: {
      ...(overrides.mode ? { mode: overrides.mode } : {}),
      agentTurnId: "turn_retrieve",
      sessionId: "sess_1",
      videoAdapters:
        overrides.videoAdapters ??
        ({
          google: {
            poll:
              overrides.poll ??
              (async () => ({
                status: "done",
                videoBytes: bytes,
                mimeType: "video/mp4",
                actualQuotaUnits: 100,
                billingSource: "provider_operation_metadata",
              })),
          },
        } as never),
      binaryWorkItems: new BinaryWorkItemManager({ sweepIntervalMs: null }),
      awaitBinaryWriteAck: ack.fn,
      checkpointClient: {
        listUserDeliveryPending: async () => overrides.jobs ?? [PENDING_JOB],
        markTerminal: async (input: unknown) => {
          terminals.push(input);
        },
      },
      encryptArtifact: async () => ({
        artifactId: "artifact_1",
        ciphertextRef: "",
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
      }),
      maxProviderPolls: 1,
      providerPollDelayMs: 0,
    } as never,
    ack,
    terminals,
  };
}

async function collect(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("redeliverPendingMedia", () => {
  it("re-delivers a pending video (preview-only) and marks it terminal-debited on ok", async () => {
    const { deps, ack, terminals } = baseDeps({ ack: fakeAck("ok") });
    const events = await collect(redeliverPendingMedia(deps));

    // The asset was re-delivered over the binary write-ACK path, preview-only.
    const write = events.find((e) => e.kind === "binary-write-request");
    expect(write).toBeDefined();
    expect(write.payload.previewOnly).toBe(true);
    expect(write.payload.request.toolName).toBe("video.generate");
    expect(ack.calls.length).toBe(1);
    // Finalised as delivered (debited terminal) so it is no longer re-deliverable.
    expect(terminals).toEqual([{ mediaJobId: "mj_pending", terminalState: "debited" }]);
    expect(events.some((e) => e.kind === "orchestrator-media-job-progress" && e.status === "done")).toBe(true);
    // No re-billing happens here (re-delivery never reserves/debits).
  });

  it("leaves the job delivery_pending (no terminal) when the delivery ACK fails", async () => {
    const { deps, terminals } = baseDeps({ ack: fakeAck("error") });
    const events = await collect(redeliverPendingMedia(deps));

    expect(events.some((e) => e.kind === "binary-write-request")).toBe(true);
    // NOT finalised → stays delivery_pending for a later retry. No refund either.
    expect(terminals).toEqual([]);
    expect(events.some((e) => e.kind === "orchestrator-media-job-progress" && e.status === "error")).toBe(true);
  });

  it("skips a job whose provider adapter is unavailable (no crash, no terminal)", async () => {
    const { deps, terminals } = baseDeps({ videoAdapters: {} });
    const events = await collect(redeliverPendingMedia(deps));

    expect(events.some((e) => e.kind === "binary-write-request")).toBe(false);
    expect(terminals).toEqual([]);
    expect(events.some((e) => e.kind === "orchestrator-media-job-progress" && e.status === "error")).toBe(true);
  });

  it("isolates a per-job throw: one job throwing still delivers the rest and emits the terminal done", async () => {
    // A transient throw (provider 500, RPC blip, connection reset awaiting the
    // ACK) in one job's re-delivery must NOT abort the whole retrieve pass: the
    // remaining pending jobs are still attempted, the thrown job stays
    // delivery_pending (no terminal) for a later retry, and the terminal `done`
    // still fires so the pump emits AGENT_DONE and the client ends cleanly.
    const badJob = { ...PENDING_JOB, mediaJobId: "mj_bad", providerJobId: "op-bad" };
    const goodJob = { ...PENDING_JOB, mediaJobId: "mj_good", providerJobId: "op-good" };
    const terminals: unknown[] = [];
    const ack = fakeAck("ok");
    const { deps } = baseDeps({
      jobs: [badJob, goodJob],
      ack,
      terminals,
      poll: async (input?: any) => {
        if (input?.providerJobId === "op-bad") throw new Error("provider 500");
        return {
          status: "done",
          videoBytes: bytes,
          mimeType: "video/mp4",
          actualQuotaUnits: 100,
          billingSource: "provider_operation_metadata",
        };
      },
    });

    const events = await collect(redeliverPendingMedia(deps));

    // The bad job reported an error and was NOT finalised (stays delivery_pending).
    expect(
      events.some((e) => e.subtaskId === "mj_bad" && e.status === "error"),
    ).toBe(true);
    // The good job was still delivered + finalised terminal-debited.
    expect(ack.calls.length).toBe(1);
    expect(terminals).toEqual([{ mediaJobId: "mj_good", terminalState: "debited" }]);
    // The terminal `done` still fired so the turn ends cleanly.
    expect(events.at(-1)).toEqual({ kind: "done" });
  });

  it("does nothing but cleanly ends the turn when the user has no pending media", async () => {
    const { deps, terminals } = baseDeps({ jobs: [] });
    const events = await collect(redeliverPendingMedia(deps));
    // Only the terminal done event — no delivery, no terminal write.
    expect(events).toEqual([{ kind: "done" }]);
    expect(terminals).toEqual([]);
  });

  it("ends the stream with a terminal done event (AGENT_DONE)", async () => {
    const { deps } = baseDeps({ ack: fakeAck("ok") });
    const events = await collect(redeliverPendingMedia(deps));
    expect(events.at(-1)).toEqual({ kind: "done" });
  });

  it("list mode: signals each pending job (VIDEO_DELIVERY_PENDING_AVAILABLE) without polling or delivering", async () => {
    let pollCalls = 0;
    const terminals: unknown[] = [];
    const ack = fakeAck("ok");
    const { deps } = baseDeps({
      jobs: [
        PENDING_JOB,
        { ...PENDING_JOB, mediaJobId: "mj_2", providerJobId: "op-2" },
      ],
      ack,
      terminals,
      mode: "list",
      poll: async () => {
        pollCalls += 1;
        return { status: "done", videoBytes: bytes, mimeType: "video/mp4" };
      },
    });

    const events = await collect(redeliverPendingMedia(deps));

    // A non-error "available" signal per pending job — NOT status:error (which
    // would flag the probe turn as failed) and NOT a delivery.
    const signals = events.filter(
      (e) =>
        e.kind === "orchestrator-media-job-progress" &&
        e.detail === "VIDEO_DELIVERY_PENDING_AVAILABLE",
    );
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.status === "blocked")).toBe(true);
    expect(signals.map((s) => s.mediaJobId).sort()).toEqual(["mj_2", "mj_pending"]);
    // List-only: never polls the provider, never delivers, never marks terminal.
    expect(pollCalls).toBe(0);
    expect(ack.calls.length).toBe(0);
    expect(events.some((e) => e.kind === "binary-write-request")).toBe(false);
    expect(terminals).toEqual([]);
    // Still ends the turn cleanly.
    expect(events.at(-1)).toEqual({ kind: "done" });
  });

  it("list mode: no pending jobs → just ends the turn with no signal", async () => {
    const { deps, terminals } = baseDeps({ jobs: [], mode: "list" });
    const events = await collect(redeliverPendingMedia(deps));
    expect(events).toEqual([{ kind: "done" }]);
    expect(terminals).toEqual([]);
  });

  it("leaves the job delivery_pending when the provider is not yet ready (not done)", async () => {
    const { deps, terminals } = baseDeps({
      poll: async () => ({ status: "running", progressPercent: 50 }),
    });
    const events = await collect(redeliverPendingMedia(deps));
    expect(events.some((e) => e.kind === "binary-write-request")).toBe(false);
    expect(terminals).toEqual([]);
    expect(events.some((e) => e.kind === "orchestrator-media-job-progress" && e.status === "error")).toBe(true);
  });
});
