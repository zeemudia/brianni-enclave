import { describe, expect, it } from "vitest";
import type { AgentSubtask, ModelCapability } from "@calypso/chat-types";
import { selectModelForSubtask } from "../orchestrator/router";

const subtask: AgentSubtask = {
  id: "clip-1",
  title: "Generate video",
  objective: "Generate a teaser clip",
  kind: "video",
  requiredCapabilities: ["video_generation"],
  allowedTools: ["video.generate"],
  dependsOn: [],
  producesArtifact: true,
  risk: "medium",
};

const model: ModelCapability = {
  modelId: "veo-3.1-generate-preview",
  providerId: "google",
  strengths: ["video_generation"],
  strengthQuality: [{ strength: "video_generation", tier: "frontier" }],
  modalities: ["text_in", "image_in", "video_out"],
  endpointFamily: "video",
  costTier: "high",
  latencyTier: "slow",
  routingStatus: "enabled",
  requiredGatewayTools: ["video.generate"],
};

describe("video routing gates", () => {
  it("fails closed when video endpoint family is disabled", () => {
    expect(() =>
      selectModelForSubtask(subtask, [model], {
        enabledGatewayTools: ["video.generate"],
        enabledEndpointFamilies: ["chat"],
      }),
    ).toThrow("NO_MODEL_FOR_SUBTASK:clip-1");
  });

  it("fails closed when video gateway tool is disabled", () => {
    expect(() =>
      selectModelForSubtask(subtask, [model], {
        enabledGatewayTools: [],
        enabledEndpointFamilies: ["chat", "video"],
      }),
    ).toThrow("NO_MODEL_FOR_SUBTASK:clip-1");
  });

  it("routes when endpoint and gateway are enabled", () => {
    expect(
      selectModelForSubtask(subtask, [model], {
        enabledGatewayTools: ["video.generate"],
        enabledEndpointFamilies: ["chat", "video"],
      }),
    ).toMatchObject({
      modelId: "veo-3.1-generate-preview",
      providerId: "google",
    });
  });
});
