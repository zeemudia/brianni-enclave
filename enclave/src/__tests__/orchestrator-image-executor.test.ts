import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AgentLinkedFolderContext,
  AgentMediaSubtask,
  AgentSubtask,
  ToolResultFrame,
} from "@calypso/chat-types";

import { runMediaSubtask } from "../orchestrator/media-executor";
import { BinaryWorkItemManager } from "../tools/binary-work-items";
import type { GeneratedImage } from "../media/image-provider";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const grantedFolder: AgentLinkedFolderContext = {
  folderId: "fld_pics",
  displayName: "Pictures",
  status: "granted",
};

// Fake awaitBinaryWriteAck that records the payload it received and returns a
// caller-supplied terminal frame (default: an `ok` save).
function fakeBinaryWriteAck(
  outcome: ToolResultFrame["outcome"] = "ok",
  reason?: string,
) {
  const calls: Array<{ folderId: string; displayName: string; request: unknown; chunks: unknown }> = [];
  const fn = async (payload: {
    folderId: string;
    displayName: string;
    request: unknown;
    chunks: unknown;
  }): Promise<ToolResultFrame> => {
    calls.push(payload);
    return {
      invocationId: "inv_test",
      outcome,
      ...(reason ? { reason } : {}),
      resultJson: { status: outcome === "ok" ? "committed" : "error" },
    };
  };
  return { fn, calls };
}

// A signer whose verify() actually checks nothing crypto-real but lets
// verifyProvenanceRecord's sha256/ttl checks run (those use the real bytes).
const provenanceSigner = { sign: () => "sig", verify: () => true };

function makeBudgetClient() {
  const reconcileCalls: Array<{ status: string; actualQuotaUnits?: number }> = [];
  return {
    reconcileCalls,
    reserve: async () => ({ ok: true as const, holdId: "hold_img_1" }),
    reconcile: async (input: { status: string; actualQuotaUnits?: number }) => {
      reconcileCalls.push({ status: input.status, actualQuotaUnits: input.actualQuotaUnits });
    },
  };
}

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

function encryptArtifact() {
  return async (input: { bytes: Uint8Array; mimeType: string; title: string }) => ({
    artifactId: "art_img_1",
    ciphertextRef: "ref_img_1",
    sha256: sha256(input.bytes),
    byteSize: input.bytes.byteLength,
  });
}

const imageSubtask: AgentSubtask = {
  id: "st_poster",
  title: "Generate bake-sale poster",
  objective: "Make a cheerful poster for the school bake sale, Saturday 10am at the village hall",
  kind: "image",
  requiredCapabilities: ["image_generation"],
  allowedTools: ["image.generate"],
  dependsOn: [],
  producesArtifact: true,
  risk: "low",
};
const imageGenerateMedia: AgentMediaSubtask = {
  operation: "image_generate",
  expectedArtifactKind: "image/png",
  privacyPolicy: "sanitized_only",
};
const route = {
  modelId: "gpt-image-2",
  providerId: "openai",
  subtaskId: "st_poster",
  reason: "test",
  fallbackModelIds: [],
};

function imageAdapter(result: GeneratedImage, capture?: (input: unknown) => void) {
  return {
    openai: {
      generate: async (input: unknown) => {
        capture?.(input);
        return result;
      },
    },
  };
}

describe("orchestrator media executor — image_generate", () => {
  it("budget-reserves, signs provenance, and DELIVERS the image via the binary write-ACK path under DONE", async () => {
    const imageBytes = new TextEncoder().encode("PNGDATA-poster");
    const budgetClient = makeBudgetClient();
    const ack = fakeBinaryWriteAck("ok");
    const binaryWorkItems = new BinaryWorkItemManager();
    let adapterInput: any;
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_img",
      planId: "plan_img",
      subtask: { ...imageSubtask, media: imageGenerateMedia },
      route,
      videoAdapters: {},
      imageAdapters: imageAdapter(
        { status: "done", imageBytes, mimeType: "image/png", actualQuotaUnits: 3 },
        (i) => (adapterInput = i),
      ),
      checkpointClient,
      budgetClient,
      provenanceSigner,
      encryptArtifact: encryptArtifact(),
      awaitBinaryWriteAck: ack.fn,
      binaryWorkItems,
      linkedFolders: [grantedFolder],
      sessionId: "sess_img",
    })) {
      events.push(event);
    }

    // (a) The adapter was called with the masked objective as the prompt.
    expect(adapterInput.operation).toBe("image_generate");
    expect(adapterInput.prompt).toContain("bake sale");

    // Provenance was signed (observable in the trail).
    const provenanceEvent = events.find(
      (e) => e.kind === "orchestrator-media-job-progress" && typeof e.detail === "string" && e.detail.startsWith("IMAGE_PROVENANCE_SIGNED:"),
    );
    expect(provenanceEvent).toBeDefined();

    // The orchestrator-artifact metadata event is still emitted (receipt/trail).
    const artifact = events.find((e) => e.kind === "orchestrator-artifact");
    expect(artifact).toBeDefined();
    expect(artifact.artifactKind).toBe("image/png");
    expect(artifact.sha256).toBe(sha256(imageBytes));

    // (b) Delivery went through the binary write-ACK path: a binary-write-request
    // event was yielded (so the wire emits the frames) and awaitBinaryWriteAck
    // received the payload with the destination folder + a binary write request
    // + chunks.
    const writeEvent = events.find((e) => e.kind === "binary-write-request");
    expect(writeEvent).toBeDefined();
    expect(writeEvent.payload.folderId).toBe("fld_pics");
    expect(writeEvent.payload.request.kind).toBe("binary_work_item.write_request");
    // A text→image generation is labelled image.generate (image_edit → image.edit)
    // so the Activity trail/telemetry are honest; the client still routes by outputId.
    expect(writeEvent.payload.request.toolName).toBe("image.generate");
    expect(writeEvent.payload.request.outputPath).toBe("generate-bake-sale-poster.png");
    expect(Array.isArray(writeEvent.payload.chunks)).toBe(true);
    expect(writeEvent.payload.chunks.length).toBeGreaterThan(0);

    expect(ack.calls).toHaveLength(1);
    expect(ack.calls[0].folderId).toBe("fld_pics");
    expect(ack.calls[0].displayName).toBe("Pictures");
    expect((ack.calls[0].request as any).kind).toBe("binary_work_item.write_request");

    // (c) Terminal DONE, and (d) budget debited with the adapter's actual units.
    const done = events.find(
      (e) => e.kind === "orchestrator-media-job-progress" && e.status === "done",
    );
    expect(done).toBeDefined();
    expect(budgetClient.reconcileCalls).toContainEqual({ status: "debited", actualQuotaUnits: 3 });
    // Never released after a confirmed save.
    expect(budgetClient.reconcileCalls.some((c) => c.status === "released")).toBe(false);
    expect(events.some((e) => e.status === "error")).toBe(false);
  });

  it("attaches the signed provenance record to the binary-write payload, paired with the bytes by outputId", async () => {
    const imageBytes = new TextEncoder().encode("PNGDATA-poster");
    const budgetClient = makeBudgetClient();
    const ack = fakeBinaryWriteAck("ok");
    const binaryWorkItems = new BinaryWorkItemManager();
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_img",
      planId: "plan_img",
      subtask: { ...imageSubtask, media: imageGenerateMedia },
      route,
      videoAdapters: {},
      imageAdapters: imageAdapter({
        status: "done",
        imageBytes,
        mimeType: "image/png",
        actualQuotaUnits: 3,
      }),
      checkpointClient,
      budgetClient,
      provenanceSigner,
      encryptArtifact: encryptArtifact(),
      awaitBinaryWriteAck: ack.fn,
      binaryWorkItems,
      linkedFolders: [grantedFolder],
      sessionId: "sess_img",
    })) {
      events.push(event);
    }

    // The signed MediaProvenanceRecord rides the SAME binary-write payload that
    // carries the bytes, so the client pairs them by request.outputId. The
    // record is metadata-only (no plaintext): ids, kind, sha256, signature.
    const writeEvent = events.find((e) => e.kind === "binary-write-request");
    expect(writeEvent).toBeDefined();
    const provenance = writeEvent.payload.provenance;
    expect(provenance).toBeDefined();
    expect(provenance.kind).toBe("image");
    expect(provenance.origin).toBe("generated");
    expect(provenance.sha256).toBe(sha256(imageBytes));
    expect(provenance.signature).toBe("sig");
    expect(provenance.byteSize).toBe(imageBytes.byteLength);
    // Paired with the IMAGE_PROVENANCE_SIGNED trail entry by handleId.
    const signedEvent = events.find(
      (e) =>
        e.kind === "orchestrator-media-job-progress" &&
        typeof e.detail === "string" &&
        e.detail.startsWith("IMAGE_PROVENANCE_SIGNED:"),
    );
    expect(signedEvent.detail).toBe(`IMAGE_PROVENANCE_SIGNED:${provenance.handleId}`);
    // The record must carry no plaintext prompt/objective.
    expect(JSON.stringify(provenance)).not.toContain("bake");
    // It rides the binary write that also delivers the bytes (the bytes flow as
    // chunks keyed by request.outputId; the provenance is on the same payload).
    expect(writeEvent.payload.request.outputId).toBeTruthy();
  });

  it("attaches the signed provenance record on the preview-only delivery (no granted folder)", async () => {
    const imageBytes = new TextEncoder().encode("PNG-preview");
    const budgetClient = makeBudgetClient();
    const ack = fakeBinaryWriteAck("ok");
    const binaryWorkItems = new BinaryWorkItemManager();
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_img",
      planId: "plan_img",
      subtask: { ...imageSubtask, media: imageGenerateMedia },
      route,
      videoAdapters: {},
      imageAdapters: imageAdapter({
        status: "done",
        imageBytes,
        mimeType: "image/png",
        actualQuotaUnits: 3,
      }),
      checkpointClient,
      budgetClient,
      provenanceSigner,
      encryptArtifact: encryptArtifact(),
      awaitBinaryWriteAck: ack.fn,
      binaryWorkItems,
      linkedFolders: [{ folderId: "fld_x", displayName: "Old", status: "needs_regrant" }],
      sessionId: "sess_img",
    })) {
      events.push(event);
    }

    const writeEvent = events.find((e) => e.kind === "binary-write-request");
    expect(writeEvent.payload.previewOnly).toBe(true);
    expect(writeEvent.payload.provenance).toBeDefined();
    expect(writeEvent.payload.provenance.sha256).toBe(sha256(imageBytes));
    expect(writeEvent.payload.provenance.signature).toBe("sig");
  });

  it("delivers a preview-only binary write (no folder save) when no granted folder is available", async () => {
    const budgetClient = makeBudgetClient();
    const ack = fakeBinaryWriteAck("ok");
    const binaryWorkItems = new BinaryWorkItemManager();
    let adapterCalled = false;
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_img",
      planId: "plan_img",
      subtask: { ...imageSubtask, media: imageGenerateMedia },
      route,
      videoAdapters: {},
      imageAdapters: imageAdapter(
        { status: "done", imageBytes: new TextEncoder().encode("PNG"), mimeType: "image/png", actualQuotaUnits: 3 },
        () => (adapterCalled = true),
      ),
      checkpointClient,
      budgetClient,
      provenanceSigner,
      encryptArtifact: encryptArtifact(),
      awaitBinaryWriteAck: ack.fn,
      binaryWorkItems,
      // Only a needs_regrant folder — nothing the executor can SAVE to. With the
      // in-app preview channel, image generation no longer fails closed: it
      // delivers a preview-only write so the user still sees the result.
      linkedFolders: [{ folderId: "fld_x", displayName: "Old", status: "needs_regrant" }],
      sessionId: "sess_img",
    })) {
      events.push(event);
    }

    // A preview-only binary-write-request was yielded: previewOnly flag set, no
    // destination folder, but the same write_request/chunk frames carry the bytes.
    const writeEvent = events.find((e) => e.kind === "binary-write-request");
    expect(writeEvent).toBeDefined();
    expect(writeEvent.payload.previewOnly).toBe(true);
    expect(writeEvent.payload.folderId).toBe("");
    expect(writeEvent.payload.request.kind).toBe("binary_work_item.write_request");
    expect(writeEvent.payload.chunks.length).toBeGreaterThan(0);

    // Delivery was awaited + acknowledged ok → budget debited, terminal DONE,
    // never an IMAGE_GENERATE_NO_FOLDER error.
    expect(ack.calls).toHaveLength(1);
    const done = events.find(
      (e) => e.kind === "orchestrator-media-job-progress" && e.status === "done",
    );
    expect(done).toBeDefined();
    expect(budgetClient.reconcileCalls).toContainEqual({ status: "debited", actualQuotaUnits: 3 });
    expect(events.some((e) => e.status === "error")).toBe(false);
    expect(adapterCalled).toBe(true);
  });

  it("emits a blocked terminal and releases the hold when the client declines the save", async () => {
    const budgetClient = makeBudgetClient();
    const ack = fakeBinaryWriteAck("denied_by_user");
    const binaryWorkItems = new BinaryWorkItemManager();
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_img",
      planId: "plan_img",
      subtask: { ...imageSubtask, media: imageGenerateMedia },
      route,
      videoAdapters: {},
      imageAdapters: imageAdapter({
        status: "done",
        imageBytes: new TextEncoder().encode("PNGDATA"),
        mimeType: "image/png",
        actualQuotaUnits: 3,
      }),
      checkpointClient,
      budgetClient,
      provenanceSigner,
      encryptArtifact: encryptArtifact(),
      awaitBinaryWriteAck: ack.fn,
      binaryWorkItems,
      linkedFolders: [grantedFolder],
      sessionId: "sess_img",
    })) {
      events.push(event);
    }

    // The write was requested, declined, and reported honestly as blocked.
    expect(ack.calls).toHaveLength(1);
    const blocked = events.find(
      (e) => e.kind === "orchestrator-media-job-progress" && e.status === "blocked",
    );
    expect(blocked).toBeDefined();
    expect(events.some((e) => e.status === "done")).toBe(false);
    // Nothing landed → hold released, never debited.
    expect(budgetClient.reconcileCalls).toContainEqual({ status: "released", actualQuotaUnits: undefined });
    expect(budgetClient.reconcileCalls.some((c) => c.status === "debited")).toBe(false);
  });

  it("fails closed (delivery unavailable, hold released) when binary-write deps are missing", async () => {
    const budgetClient = makeBudgetClient();
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_img",
      planId: "plan_img",
      subtask: { ...imageSubtask, media: imageGenerateMedia },
      route,
      videoAdapters: {},
      imageAdapters: imageAdapter({
        status: "done",
        imageBytes: new TextEncoder().encode("PNGDATA"),
        mimeType: "image/png",
        actualQuotaUnits: 3,
      }),
      checkpointClient,
      budgetClient,
      provenanceSigner,
      encryptArtifact: encryptArtifact(),
      // A granted folder, but no awaitBinaryWriteAck / binaryWorkItems wired.
      linkedFolders: [grantedFolder],
      sessionId: "sess_img",
    })) {
      events.push(event);
    }

    expect(events.find((e) => e.status === "error")?.detail).toBe("IMAGE_GENERATE_DELIVERY_UNAVAILABLE");
    expect(budgetClient.reconcileCalls).toContainEqual({ status: "released", actualQuotaUnits: undefined });
    expect(budgetClient.reconcileCalls.some((c) => c.status === "debited")).toBe(false);
    expect(events.some((e) => e.kind === "binary-write-request")).toBe(false);
  });

  it("releases the budget hold and emits an error (no artifact) when the adapter fails", async () => {
    const budgetClient = makeBudgetClient();
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_img",
      planId: "plan_img",
      subtask: { ...imageSubtask, media: imageGenerateMedia },
      route,
      videoAdapters: {},
      imageAdapters: imageAdapter({ status: "failed", reason: "OPENAI_IMAGE_HTTP_429" }),
      checkpointClient,
      budgetClient,
      provenanceSigner,
      encryptArtifact: encryptArtifact(),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.kind === "orchestrator-artifact")).toBe(false);
    const errorEvent = events.find((e) => e.status === "error");
    expect(errorEvent?.detail).toBe("OPENAI_IMAGE_HTTP_429");
    expect(budgetClient.reconcileCalls).toContainEqual({ status: "released", actualQuotaUnits: undefined });
    // Never debited a failed generation.
    expect(budgetClient.reconcileCalls.some((c) => c.status === "debited")).toBe(false);
  });

  it("fails closed (no budget spend) when no image adapter is registered for the route provider", async () => {
    const budgetClient = makeBudgetClient();
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_img",
      planId: "plan_img",
      subtask: { ...imageSubtask, media: imageGenerateMedia },
      route,
      videoAdapters: {},
      imageAdapters: {}, // no 'openai' adapter
      checkpointClient,
      budgetClient,
      provenanceSigner,
      encryptArtifact: encryptArtifact(),
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.kind === "orchestrator-artifact")).toBe(false);
    expect(events.find((e) => e.status === "error")?.detail).toBe("IMAGE_ADAPTER_UNAVAILABLE");
    // Never reserved budget for an unroutable provider.
    expect(budgetClient.reconcileCalls).toHaveLength(0);
  });

  it("fails closed when the budget reserve is refused (over-quota): NO provider call, blocked with reason", async () => {
    // Hard-metering guarantee: an over-quota / unmetered reserve must block the
    // turn BEFORE any (billable) provider call, and must not reconcile a hold
    // that was never created.
    const reconcileCalls: Array<{ status: string }> = [];
    const overQuotaBudgetClient = {
      reserve: async () => ({ ok: false as const, reason: "USER_BUDGET_EXCEEDED" }),
      reconcile: async (input: { status: string }) => {
        reconcileCalls.push({ status: input.status });
      },
    };
    let adapterCalled = false;
    const events: any[] = [];
    for await (const event of runMediaSubtask({
      agentTurnId: "turn_img",
      planId: "plan_img",
      subtask: { ...imageSubtask, media: imageGenerateMedia },
      route,
      videoAdapters: {},
      imageAdapters: imageAdapter(
        { status: "done", imageBytes: new TextEncoder().encode("X"), mimeType: "image/png", actualQuotaUnits: 3 },
        () => (adapterCalled = true),
      ),
      checkpointClient,
      budgetClient: overQuotaBudgetClient,
      provenanceSigner,
      encryptArtifact: encryptArtifact(),
      awaitBinaryWriteAck: fakeBinaryWriteAck("ok").fn,
      binaryWorkItems: new BinaryWorkItemManager(),
      linkedFolders: [grantedFolder],
      sessionId: "sess_img",
    })) {
      events.push(event);
    }

    // No provider/adapter call, no artifact, no delivery.
    expect(adapterCalled).toBe(false);
    expect(events.some((e) => e.kind === "orchestrator-artifact")).toBe(false);
    expect(events.some((e) => e.kind === "binary-write-request")).toBe(false);
    // Terminal blocked carrying the broker's reason.
    const blocked = events.find((e) => e.status === "blocked");
    expect(blocked?.detail).toBe("USER_BUDGET_EXCEEDED");
    // No hold was created, so nothing to reconcile.
    expect(reconcileCalls).toHaveLength(0);
  });
});
