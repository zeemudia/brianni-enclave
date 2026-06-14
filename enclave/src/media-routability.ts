import type { ModelCapability, ToolName } from "@calypso/chat-types";

/**
 * A video-output model is routable iff an ENABLED model with the "video"
 * endpoint family exists whose required gateway tools are all scoped by the
 * pack. Mirrors isImageGenerationRoutable — drives the fail-closed video
 * generation gate (a model being `enabled` in the registry is necessary but NOT
 * sufficient; the gateway adapter + checkpoint store must also be wired).
 */
export function isVideoGenerationRoutable(
  models: readonly ModelCapability[],
  packToolScopes: readonly ToolName[],
): boolean {
  const scoped = new Set<string>(packToolScopes);
  return models.some(
    (model) =>
      model.routingStatus === "enabled" &&
      model.endpointFamily === "video" &&
      model.requiredGatewayTools.every((tool) => scoped.has(tool)),
  );
}

/**
 * The set of media tools to strip from the canonical pack so the planner never
 * shapes an unroutable media subtask (which would dead-end in
 * NO_MODEL_FOR_SUBTASK / MEDIA_EXECUTOR_UNAVAILABLE under a false "done"). Each
 * tool is kept ONLY when its full pipeline is wired + routable:
 *   - image.generate / image.edit  ← a routable image model + image adapters
 *   - video.generate               ← a routable video model + video adapter + checkpoint store
 *   - video.render                 ← a wired render backend (Remotion appliance)
 */
export function computeMediaToolStripSet(input: {
  imageGenerationRoutable: boolean;
  videoGenerateRoutable: boolean;
  videoRenderRoutable: boolean;
}): Set<string> {
  const strip = new Set<string>();
  if (!input.imageGenerationRoutable) {
    strip.add("image.generate");
    strip.add("image.edit");
  }
  if (!input.videoGenerateRoutable) {
    strip.add("video.generate");
  }
  if (!input.videoRenderRoutable) {
    strip.add("video.render");
  }
  return strip;
}
