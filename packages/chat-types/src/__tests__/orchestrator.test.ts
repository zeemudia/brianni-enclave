import { describe, expect, it } from "vitest";

import {
  AgentSubtaskSchema,
  AgentTaskPlanSchema,
  ModelCapabilitySchema,
  ModelEndpointFamilySchema,
  ModelStrengthSchema,
  OrchestratorEventScopeSchema,
  OrchestratorLedgerEntrySchema,
  OrchestratorProgressEventSchema,
  OrchestratorRequestContextSchema,
  OrchestratorWorkingMemoryEntrySchema,
  recoverFailedSubtaskProgress,
} from "../orchestrator";

describe("orchestrator contracts", () => {
  it("accepts a bounded todo-style task plan", () => {
    const parsed = AgentTaskPlanSchema.parse({
      planId: "plan_123",
      title: "Prepare OpenAI application materials",
      summary: "Read the linked folder, update resume, draft letter.",
      subtasks: [
        {
          id: "st_1",
          title: "Inspect linked folder",
          objective: "Find the vacancy and resume files.",
          kind: "file_inspection",
          requiredCapabilities: ["filesystem_read", "fast_reasoning"],
          allowedTools: ["folder.list", "folder.read", "file.read"],
          dependsOn: [],
          producesArtifact: false,
          risk: "low",
        },
      ],
    });
    expect(parsed.subtasks[0]?.kind).toBe("file_inspection");
  });

  it("rejects unbounded plans", () => {
    expect(() =>
      AgentTaskPlanSchema.parse({
        planId: "plan_123",
        title: "too much",
        summary: "too much",
        subtasks: Array.from({ length: 13 }, (_, i) => ({
          id: `st_${i}`,
          title: "step",
          objective: "step",
          kind: "reasoning",
          requiredCapabilities: ["general_reasoning"],
          allowedTools: [],
          dependsOn: [],
          producesArtifact: false,
          risk: "low",
        })),
      }),
    ).toThrow();
  });

  it("rejects duplicate subtask ids", () => {
    expect(() =>
      AgentTaskPlanSchema.parse({
        planId: "plan_dup",
        title: "bad plan",
        summary: "bad plan",
        subtasks: [
          {
            id: "st_same",
            title: "one",
            objective: "one",
            kind: "reasoning",
            requiredCapabilities: ["general_reasoning"],
            allowedTools: [],
            dependsOn: [],
            producesArtifact: false,
            risk: "low",
          },
          {
            id: "st_same",
            title: "two",
            objective: "two",
            kind: "reasoning",
            requiredCapabilities: ["general_reasoning"],
            allowedTools: [],
            dependsOn: [],
            producesArtifact: false,
            risk: "low",
          },
        ],
      }),
    ).toThrow("duplicate subtask id");
  });

  it("describes model capabilities without provider secrets", () => {
    const parsed = ModelCapabilitySchema.parse({
      modelId: "gpt-5.5",
      providerId: "openai",
      strengths: ["long_context", "writing", "code"],
      strengthQuality: [
        { strength: "writing", tier: "frontier" },
        { strength: "code", tier: "strong" },
      ],
      modalities: ["text_in", "text_out"],
      costTier: "high",
      latencyTier: "standard",
      maxContextTokens: 1050000,
    });
    expect(parsed.strengths).toContain("writing");
  });

  it("accepts image and audio specialist subtasks while reserving video for later routing", () => {
    expect(
      AgentSubtaskSchema.parse({
        id: "st_image",
        title: "Generate illustration",
        objective: "Create an image from the approved prompt.",
        kind: "image",
        requiredCapabilities: ["image_generation"],
        allowedTools: ["image.generate"],
        dependsOn: [],
        producesArtifact: true,
        risk: "medium",
      }).allowedTools,
    ).toEqual(["image.generate"]);

    expect(
      AgentSubtaskSchema.parse({
        id: "st_audio",
        title: "Render voiceover",
        objective: "Generate spoken audio from the final script.",
        kind: "audio",
        requiredCapabilities: ["audio_generation"],
        allowedTools: ["audio.speech"],
        dependsOn: [],
        producesArtifact: true,
        risk: "medium",
      }).allowedTools,
    ).toEqual(["audio.speech"]);

    expect(ModelStrengthSchema.parse("video_generation")).toBe(
      "video_generation",
    );
    expect(ModelEndpointFamilySchema.parse("video")).toBe("video");
  });

  it("accepts bounded working memory handoff entries", () => {
    const parsed = OrchestratorWorkingMemoryEntrySchema.parse({
      planId: "plan_123",
      subtaskId: "st_read",
      kind: "tool_summary",
      label: "Resume and vacancy findings",
      content:
        "Resume file: resume.pdf. Vacancy file: openai-role.txt. Resume is missing recent Brianni AI work.",
      sourceToolNames: ["folder.read", "file.read"],
    });
    expect(parsed.kind).toBe("tool_summary");
  });

  it("accepts encrypted-request orchestration context", () => {
    const parsed = OrchestratorRequestContextSchema.parse({
      runMode: "orchestrator",
      policyVersion: "calypso-orchestrator-v1",
      preferredModelId: "auto",
      clientCapabilities: {
        supportsPlanEvents: true,
        supportsBackgroundResume: false,
      },
    });
    expect(parsed.preferredModelId).toBe("auto");
  });

  it("defaults retrievePendingMedia to false and accepts true / 'list'", () => {
    expect(OrchestratorRequestContextSchema.parse({}).retrievePendingMedia).toBe(false);
    // true = deliver the user's pending video(s); 'list' = list-only probe (#1b).
    expect(
      OrchestratorRequestContextSchema.parse({ retrievePendingMedia: true })
        .retrievePendingMedia,
    ).toBe(true);
    expect(
      OrchestratorRequestContextSchema.parse({ retrievePendingMedia: "list" })
        .retrievePendingMedia,
    ).toBe("list");
  });

  it("rejects an unknown retrievePendingMedia mode string", () => {
    expect(() =>
      OrchestratorRequestContextSchema.parse({ retrievePendingMedia: "deliver" }),
    ).toThrow();
  });

  it("accepts plan and progress events", () => {
    expect(
      OrchestratorProgressEventSchema.parse({
        _type: "orchestrator_progress",
        planId: "plan_123",
        subtaskId: "st_1",
        status: "running",
        label: "Reading linked folder",
      }),
    ).toMatchObject({ status: "running" });

    expect(
      OrchestratorProgressEventSchema.parse({
        _type: "orchestrator_text",
        planId: "plan_123",
        subtaskId: "st_2",
        role: "final_artifact",
        text: "Draft complete.",
      }),
    ).toMatchObject({ role: "final_artifact" });
  });

  it("accepts a media orchestrator_artifact with an empty ciphertextRef (binary write-ACK delivery)", () => {
    // R4 root cause (2026-06-14): the enclave emits orchestrator_artifact for a
    // generated image/video with ciphertextRef:"" on purpose — the bytes are
    // delivered over the binary_work_item write-ACK path, not a server-stored
    // ciphertext (enclave/src/index.ts:3820, media-executor.ts:845). The client
    // schema required ciphertextRef non-empty, so OrchestratorProgressEventSchema
    // .parse() THREW in transport.handleChatChunk (web + mobile), killing the
    // turn's SSE read loop before any binary frame was processed → image never
    // rendered, enclave hung on the write-ACK → "couldn't finish".
    const parsed = OrchestratorProgressEventSchema.parse({
      _type: "orchestrator_artifact",
      planId: "plan_d571d616",
      subtaskId: "st_image",
      artifactId: "019e118e-7f89-4445-a1b9-b1ad721ce88b",
      kind: "image/png",
      title: "Generate image",
      byteSize: 1838418,
      sha256:
        "1031ad2b21e7ac09afedefdd7c488abb0eb03edfdf11c0fe0b89f4adf6a144e8",
      ciphertextRef: "",
    });
    expect(parsed).toMatchObject({
      _type: "orchestrator_artifact",
      kind: "image/png",
      ciphertextRef: "",
    });
  });

  it("still accepts a media orchestrator_artifact with a server-stored ciphertextRef", () => {
    const parsed = OrchestratorProgressEventSchema.parse({
      _type: "orchestrator_artifact",
      planId: "plan_123",
      subtaskId: "st_image",
      artifactId: "art_1",
      kind: "image/png",
      title: "Generate image",
      byteSize: 1024,
      sha256:
        "1031ad2b21e7ac09afedefdd7c488abb0eb03edfdf11c0fe0b89f4adf6a144e8",
      ciphertextRef: "blob_opaque_1",
    });
    expect(parsed).toMatchObject({ ciphertextRef: "blob_opaque_1" });
  });

  it("accepts durable local ledger entries", () => {
    const parsed = OrchestratorLedgerEntrySchema.parse({
      id: "ledger_1",
      planId: "plan_123",
      subtaskId: "st_write",
      action: "write_requested",
      label: "Save updated resume",
      status: "approved",
      createdAt: "2026-05-18T12:00:00.000Z",
    });
    expect(parsed.status).toBe("approved");
  });

  it("accepts orchestrator scope metadata for forwarded tool events", () => {
    expect(
      OrchestratorEventScopeSchema.parse({
        planId: "plan_123",
        subtaskId: "st_read",
        ordinal: 7,
      }).ordinal,
    ).toBe(7);
  });
});

describe("recoverFailedSubtaskProgress", () => {
  // Codex review (PR #106): when a progress/media frame that signals a subtask
  // FAILURE fails schema validation (e.g. an over-long `detail`), the consumer
  // must NOT silently drop it — doing so loses the only signal the workspace
  // uses to mark the subtask failed, so the turn computes a false success.
  // This salvages a minimal, schema-valid orchestrator_progress(error).

  it("recovers a subtask error from a progress frame with an over-long detail", () => {
    const recovered = recoverFailedSubtaskProgress({
      _type: "orchestrator_progress",
      planId: "plan_e",
      subtaskId: "st_write",
      status: "error",
      label: "Save the file",
      detail: "x".repeat(5000), // exceeds the 500-char bound → original fails
    });
    expect(recovered).toMatchObject({
      _type: "orchestrator_progress",
      planId: "plan_e",
      subtaskId: "st_write",
      status: "error",
    });
    // The recovered event is itself schema-valid (clamped detail).
    expect(() =>
      OrchestratorProgressEventSchema.parse(recovered),
    ).not.toThrow();
    expect((recovered?.detail ?? "").length).toBeLessThanOrEqual(500);
  });

  it("recovers a subtask error from a media_job_progress error frame", () => {
    const recovered = recoverFailedSubtaskProgress({
      _type: "orchestrator_media_job_progress",
      planId: "plan_v",
      subtaskId: "st_video",
      mediaJobId: "mj_1",
      status: "error",
      label: "x".repeat(9000), // over-long label → original fails
    });
    expect(recovered).toMatchObject({
      _type: "orchestrator_progress",
      subtaskId: "st_video",
      status: "error",
    });
  });

  it("returns null for a non-error frame (safe to drop fail-soft)", () => {
    expect(
      recoverFailedSubtaskProgress({
        _type: "orchestrator_progress",
        planId: "plan_e",
        subtaskId: "st_x",
        status: "running",
        label: "x".repeat(5000),
      }),
    ).toBeNull();
  });

  it("returns null for an artifact frame (metadata, not a failure signal)", () => {
    expect(
      recoverFailedSubtaskProgress({
        _type: "orchestrator_artifact",
        planId: "plan_e",
        subtaskId: "st_image",
        artifactId: "art_1",
        kind: "application/zip",
        title: "t",
        byteSize: 1,
        sha256: "a".repeat(64),
        ciphertextRef: "",
      }),
    ).toBeNull();
  });

  it("returns null when the subtask cannot be identified", () => {
    expect(
      recoverFailedSubtaskProgress({
        _type: "orchestrator_progress",
        planId: "plan_e",
        status: "error", // no subtaskId → cannot target a subtask
        label: "boom",
      }),
    ).toBeNull();
  });
});
