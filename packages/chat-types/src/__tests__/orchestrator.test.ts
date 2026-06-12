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
