import { describe, expect, it } from "vitest";
import {
  AgentSubtaskSchema,
  OrchestratorProgressEventSchema,
  ToolNameSchema,
} from "@calypso/chat-types";

describe("video wire contracts", () => {
  it("accepts a video subtask with media operation", () => {
    const subtask = AgentSubtaskSchema.parse({
      id: "clip-1",
      title: "Generate teaser",
      objective: "Create an 8 second teaser",
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
        privacyPolicy: "sanitized_only",
      },
    });
    expect(subtask.kind).toBe("video");
    expect(subtask.media?.operation).toBe("video_generate");
  });

  it("encodes media progress and artifact events in the orchestrator progress union", () => {
    const progress = OrchestratorProgressEventSchema.parse({
      _type: "orchestrator_media_job_progress",
      planId: "plan_1",
      subtaskId: "clip-1",
      mediaJobId: "mj_1",
      status: "starting",
      label: "Generating video",
    });
    expect(progress._type).toBe("orchestrator_media_job_progress");
    if (progress._type === "orchestrator_media_job_progress") {
      expect(progress.status).toBe("starting");
    }

    const artifact = OrchestratorProgressEventSchema.parse({
      _type: "orchestrator_artifact",
      planId: "plan_1",
      subtaskId: "clip-1",
      artifactId: "artifact_1",
      kind: "video/mp4",
      title: "Launch teaser",
      byteSize: 1024,
      sha256: "a".repeat(64),
      ciphertextRef: "blob_1",
    });
    expect(artifact._type).toBe("orchestrator_artifact");
    if (artifact._type === "orchestrator_artifact") {
      expect(artifact.kind).toBe("video/mp4");
    }
  });

  it("treats video.generate and video.render as specialist tool names", () => {
    expect(ToolNameSchema.parse("video.generate")).toBe("video.generate");
    expect(ToolNameSchema.parse("video.render")).toBe("video.render");
  });
});
