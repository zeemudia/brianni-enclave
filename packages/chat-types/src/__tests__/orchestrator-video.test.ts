import { describe, expect, it } from "vitest";
import {
  AgentSubtaskSchema,
  ModelModalitySchema,
  OrchestratorProgressEventSchema,
} from "../orchestrator";
import { ToolNameSchema } from "../skill-pack";

describe("orchestrator video contracts", () => {
  it("accepts video tools, modalities, subtasks, media progress, and artifacts", () => {
    expect(ToolNameSchema.parse("video.generate")).toBe("video.generate");
    expect(ToolNameSchema.parse("video.render")).toBe("video.render");
    expect(ModelModalitySchema.parse("video_in")).toBe("video_in");
    expect(ModelModalitySchema.parse("video_out")).toBe("video_out");

    const subtask = AgentSubtaskSchema.parse({
      id: "clip-1",
      title: "Generate teaser clip",
      objective: "Create an 8 second generated product teaser.",
      kind: "video",
      requiredCapabilities: ["video_generation"],
      allowedTools: ["video.generate"],
      dependsOn: [],
      producesArtifact: true,
      risk: "medium",
      media: {
        operation: "video_generate",
        expectedArtifactKind: "video/mp4",
        maxDurationSeconds: 8,
        privacyPolicy: "provider_visible_requires_consent",
      },
    });

    expect(subtask.media?.operation).toBe("video_generate");

    expect(
      OrchestratorProgressEventSchema.parse({
        _type: "orchestrator_media_job_progress",
        planId: "plan_1",
        subtaskId: "clip-1",
        mediaJobId: "mj_1",
        status: "running",
        label: "Generating video",
        progressPercent: 42,
      }),
    ).toMatchObject({ status: "running" });

    expect(
      OrchestratorProgressEventSchema.parse({
        _type: "orchestrator_artifact",
        planId: "plan_1",
        subtaskId: "clip-1",
        artifactId: "artifact_1",
        kind: "video/mp4",
        title: "Launch teaser",
        byteSize: 2048,
        sha256: "c".repeat(64),
        ciphertextRef: "blob_opaque_1",
      }),
    ).toMatchObject({ kind: "video/mp4" });
  });
});
