import type { MediaProvenanceRecord } from "@calypso/chat-types";
import { classifyProvenanceSet } from "./provenance";

export type RendererTrustLevel =
  | "disabled"
  | "non_attested_generated_only"
  | "attested"
  | "existing_tee";

export function evaluateRenderCustody(input: {
  records: readonly MediaProvenanceRecord[];
  rendererTrustLevel: RendererTrustLevel;
}):
  | { allowed: true; custody: "public_or_generated" | "private" }
  | { allowed: false; reason: string; custody: "public_or_generated" | "private" } {
  const classification = classifyProvenanceSet(input.records);
  const custody = classification.taint;
  if (input.rendererTrustLevel === "disabled") {
    return { allowed: false, reason: "RENDERER_DISABLED", custody };
  }
  if (custody === "private" && input.rendererTrustLevel === "non_attested_generated_only") {
    return {
      allowed: false,
      reason: "SECURE_RENDERING_UNAVAILABLE",
      custody,
    };
  }
  return { allowed: true, custody };
}
