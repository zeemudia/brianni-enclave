import { z } from "zod";

import {
  MediaArtifactKindSchema,
  MediaJobStatusSchema,
} from "./media";
import { ToolNameSchema, TOOL_NAMES } from "./skill-pack";

export const OrchestratorRunModeSchema = z.enum(["single", "orchestrator"]);
export type OrchestratorRunMode = z.infer<typeof OrchestratorRunModeSchema>;

export const ModelStrengthSchema = z.enum([
  "general_reasoning",
  "planning",
  "fast_reasoning",
  "classification",
  "long_context",
  "writing",
  "code",
  "research",
  "vision",
  "filesystem_read",
  "document_parsing",
  "image_generation",
  "video_generation",
  "audio_generation",
  "speech_to_text",
  "embedding",
  "moderation",
  "computer_use",
  "search_grounded",
  "structured_extraction",
  "synthesis",
]);
export type ModelStrength = z.infer<typeof ModelStrengthSchema>;

export const ModelQualityTierSchema = z.enum([
  "basic",
  "standard",
  "strong",
  "frontier",
]);
export type ModelQualityTier = z.infer<typeof ModelQualityTierSchema>;

export const ModelModalitySchema = z.enum([
  "text_in",
  "text_out",
  "image_in",
  "image_out",
  "audio_in",
  "audio_out",
  "video_in",
  "video_out",
]);
export type ModelModality = z.infer<typeof ModelModalitySchema>;

export const ModelEndpointFamilySchema = z.enum([
  "chat",
  "responses",
  "image",
  "audio_speech",
  "audio_transcription",
  "realtime",
  "embedding",
  "moderation",
  "video",
  "computer_use",
]);
export type ModelEndpointFamily = z.infer<typeof ModelEndpointFamilySchema>;

export const NativeWebSearchCapabilitySchema = z.object({
  providerTool: z.enum([
    "openai_web_search",
    "anthropic_web_search",
    "google_search_grounding",
  ]),
  toolVersion: z.string().min(1).max(64).optional(),
});
export type NativeWebSearchCapability = z.infer<
  typeof NativeWebSearchCapabilitySchema
>;

export const ModelCapabilitySchema = z.object({
  modelId: z.string().min(1).max(128),
  providerId: z.string().min(1).max(64),
  strengths: z.array(ModelStrengthSchema).min(1).max(12),
  strengthQuality: z
    .array(
      z.object({
        strength: ModelStrengthSchema,
        tier: ModelQualityTierSchema,
      }),
    )
    .max(12)
    .default([]),
  modalities: z.array(ModelModalitySchema).min(1).max(8),
  endpointFamily: ModelEndpointFamilySchema.default("chat"),
  costTier: z.enum(["low", "medium", "high"]),
  latencyTier: z.enum(["fast", "standard", "slow"]),
  routingStatus: z
    .enum(["enabled", "registered_pending_gateway", "disabled"])
    .default("enabled"),
  requiredGatewayTools: z.array(z.string().min(1).max(64)).max(8).default([]),
  maxContextTokens: z.number().int().positive().optional(),
  nativeWebSearch: NativeWebSearchCapabilitySchema.optional(),
});
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const AgentSubtaskKindSchema = z.enum([
  "planning",
  "classification",
  "file_inspection",
  "research",
  "extraction",
  "reasoning",
  "writing",
  "code",
  "image",
  "audio",
  "video",
  "tool_action",
  "synthesis",
]);
export type AgentSubtaskKind = z.infer<typeof AgentSubtaskKindSchema>;

export const AgentMediaSubtaskSchema = z
  .object({
    operation: z.enum([
      "image_generate",
      "image_edit",
      "audio_transcribe",
      "audio_speech",
      "video_generate",
      "video_render",
    ]),
    expectedArtifactKind: MediaArtifactKindSchema.optional(),
    maxDurationSeconds: z.number().int().positive().max(180).optional(),
    privacyPolicy: z.enum([
      "sanitized_only",
      "provider_visible_requires_consent",
      "attested_render_required",
    ]),
  })
  .strict();
export type AgentMediaSubtask = z.infer<typeof AgentMediaSubtaskSchema>;

export const AgentSubtaskSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  objective: z.string().min(1).max(500),
  kind: AgentSubtaskKindSchema,
  requiredCapabilities: z.array(ModelStrengthSchema).min(1).max(8),
  // Capped at the full tool universe (not an arbitrary 8) so the catch-all
  // fallback subtask can expose every tool a pack already grants — a single
  // "do it all" step must not silently drop a tool the user asked for (e.g.
  // web.fetch). Focused decomposition is steered by the planner prompt, not
  // a hard per-subtask tool-count ceiling. The executor still intersects
  // allowedTools with pack scopes and the gateway re-enforces scope at
  // dispatch, so widening this cap grants no new privilege.
  allowedTools: z.array(ToolNameSchema).max(TOOL_NAMES.length),
  dependsOn: z.array(z.string().min(1).max(64)).max(8),
  producesArtifact: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
  media: AgentMediaSubtaskSchema.optional(),
});
export type AgentSubtask = z.infer<typeof AgentSubtaskSchema>;

export const AgentTaskPlanSchema = z
  .object({
    planId: z.string().min(1).max(64),
    title: z.string().min(1).max(120),
    summary: z.string().min(1).max(800),
    subtasks: z.array(AgentSubtaskSchema).min(1).max(12),
  })
  .refine(
    (plan) =>
      new Set(plan.subtasks.map((subtask) => subtask.id)).size ===
      plan.subtasks.length,
    { message: "duplicate subtask id" },
  );
export type AgentTaskPlan = z.infer<typeof AgentTaskPlanSchema>;

export const ModelRouteDecisionSchema = z.object({
  subtaskId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
  providerId: z.string().min(1).max(64),
  reason: z.string().min(1).max(240),
  fallbackModelIds: z.array(z.string().min(1).max(128)).max(4).default([]),
});
export type ModelRouteDecision = z.infer<typeof ModelRouteDecisionSchema>;

export const OrchestratorWorkingMemoryEntrySchema = z.object({
  planId: z.string().min(1).max(64),
  subtaskId: z.string().min(1).max(64),
  kind: z.enum(["tool_summary", "subtask_result", "user_decision", "route_summary"]),
  label: z.string().min(1).max(120),
  content: z.string().min(1).max(2_000),
  sourceToolNames: z.array(ToolNameSchema).max(8).default([]),
});
export type OrchestratorWorkingMemoryEntry = z.infer<
  typeof OrchestratorWorkingMemoryEntrySchema
>;

export const OrchestratorLedgerEntrySchema = z.object({
  id: z.string().min(1).max(64),
  planId: z.string().min(1).max(64),
  subtaskId: z.string().min(1).max(64).optional(),
  action: z.enum([
    "plan_created",
    "model_selected",
    "provider_rerouted",
    "tool_requested",
    "tool_granted",
    "tool_denied",
    "read_completed",
    "draft_created",
    "write_requested",
    "write_completed",
    "write_skipped",
    "subtask_failed",
    "plan_cancelled",
  ]),
  label: z.string().min(1).max(160),
  status: z.enum(["queued", "running", "approved", "denied", "done", "error", "skipped"]),
  createdAt: z.string().datetime(),
  detail: z.string().max(500).optional(),
});
export type OrchestratorLedgerEntry = z.infer<typeof OrchestratorLedgerEntrySchema>;

export const OrchestratorEventScopeSchema = z.object({
  planId: z.string().min(1).max(64),
  subtaskId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
});
export type OrchestratorEventScope = z.infer<typeof OrchestratorEventScopeSchema>;

export const OrchestratorRequestContextSchema = z.object({
  runMode: OrchestratorRunModeSchema.default("single"),
  policyVersion: z
    .literal("calypso-orchestrator-v1")
    .default("calypso-orchestrator-v1"),
  preferredModelId: z.string().min(1).max(128).default("auto"),
  // This turn does NOT plan or call a model: the enclave handles the user's
  // billed-but-undelivered video(s) (delivery_pending checkpoints). The
  // honest-user recovery trigger for bill-on-generation.
  //   true   → deliver: re-poll + re-deliver the already-paid asset(s) (the
  //            client sends it after the user taps "Retrieve your video").
  //   'list' → list-only probe (#1b): the enclave only reports HOW MANY pending
  //            jobs exist (no poll/deliver) so the client can quietly surface the
  //            recovery banner on mount even if the user never saw the live
  //            VIDEO_GENERATE_DELIVERY_UNCONFIRMED_BILLED event. The enclave only
  //            understands 'list' once rotated — pre-rotation it fails closed
  //            (the probe is gated off by default; see the client probe flag).
  retrievePendingMedia: z.union([z.boolean(), z.literal("list")]).default(false),
  clientCapabilities: z
    .object({
      supportsPlanEvents: z.boolean().default(false),
      supportsBackgroundResume: z.boolean().default(false),
      supportsMediaProgress: z.boolean().default(false),
      supportsMediaArtifacts: z.boolean().default(false),
      supportsProviderVisibleConsent: z.boolean().default(false),
    })
    .default({
      supportsPlanEvents: false,
      supportsBackgroundResume: false,
      supportsMediaProgress: false,
      supportsMediaArtifacts: false,
      supportsProviderVisibleConsent: false,
    }),
});
export type OrchestratorRequestContext = z.infer<
  typeof OrchestratorRequestContextSchema
>;

export const OrchestratorProgressEventSchema = z.discriminatedUnion("_type", [
  z.object({
    _type: z.literal("orchestrator_plan"),
    plan: AgentTaskPlanSchema,
    routes: z.array(ModelRouteDecisionSchema).max(12),
  }),
  z.object({
    _type: z.literal("orchestrator_progress"),
    planId: z.string().min(1).max(64),
    subtaskId: z.string().min(1).max(64),
    status: z.enum(["queued", "running", "blocked", "done", "error", "skipped"]),
    label: z.string().min(1).max(160),
    detail: z.string().max(500).optional(),
  }),
  z.object({
    _type: z.literal("orchestrator_text"),
    planId: z.string().min(1).max(64),
    subtaskId: z.string().min(1).max(64),
    role: z.enum(["working", "final_artifact"]),
    text: z.string().min(1).max(8_000),
  }),
  z.object({
    _type: z.literal("orchestrator_media_job_progress"),
    planId: z.string().min(1).max(64),
    subtaskId: z.string().min(1).max(64),
    mediaJobId: z.string().min(1).max(128),
    status: MediaJobStatusSchema,
    label: z.string().min(1).max(160),
    detail: z.string().max(500).optional(),
    progressPercent: z.number().int().min(0).max(100).optional(),
  }),
  z.object({
    _type: z.literal("orchestrator_artifact"),
    planId: z.string().min(1).max(64),
    subtaskId: z.string().min(1).max(64),
    artifactId: z.string().min(1).max(128),
    kind: MediaArtifactKindSchema,
    title: z.string().min(1).max(160),
    byteSize: z.number().int().nonnegative().max(2_147_483_647),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    // Empty string is VALID and expected for generated media (image/video):
    // the bytes are delivered over the binary_work_item write-ACK path, not a
    // server-stored ciphertext, so the enclave emits ciphertextRef:"" by design
    // (enclave/src/index.ts, orchestrator/media-executor.ts). Requiring a
    // non-empty value here made the web+mobile client schema reject the live
    // artifact event → the SSE read loop threw before processing any binary
    // frame → R4 image/video never delivered. Keep the 512-char upper bound.
    ciphertextRef: z.string().max(512),
  }),
]);
export type OrchestratorProgressEvent = z.infer<
  typeof OrchestratorProgressEventSchema
>;

/**
 * Salvage a subtask-FAILURE signal from an orchestrator progress / media-job
 * frame that failed `OrchestratorProgressEventSchema` validation.
 *
 * Clients drop malformed best-effort metadata frames (plan / text / artifact /
 * non-error progress) fail-soft so one bad frame can't abort the whole turn.
 * But a `status: "error"` progress/media frame is NOT decorative — it is the
 * signal the workspace uses to mark a subtask failed. Silently dropping it
 * would let the terminal-state computation report a FALSE SUCCESS even though a
 * required subtask errored (Codex review, PR #106).
 *
 * Returns a minimal, schema-valid `orchestrator_progress` error event for the
 * subtask (over-long fields clamped, the offending `detail` truncated) so the
 * failure is still recorded — or `null` when the frame isn't a recoverable
 * subtask-error signal (not an error frame, or no identifiable subtask).
 */
export function recoverFailedSubtaskProgress(
  obj: unknown,
): Extract<OrchestratorProgressEvent, { _type: "orchestrator_progress" }> | null {
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Record<string, unknown>;
  if (
    raw._type !== "orchestrator_progress" &&
    raw._type !== "orchestrator_media_job_progress"
  ) {
    return null;
  }
  if (raw.status !== "error") return null;
  const planId = typeof raw.planId === "string" ? raw.planId.slice(0, 64) : "";
  const subtaskId =
    typeof raw.subtaskId === "string" ? raw.subtaskId.slice(0, 64) : "";
  if (planId.length === 0 || subtaskId.length === 0) return null;
  const label =
    typeof raw.label === "string" && raw.label.length > 0
      ? raw.label.slice(0, 160)
      : "Step failed";
  const detail =
    typeof raw.detail === "string" ? raw.detail.slice(0, 500) : undefined;
  const candidate = {
    _type: "orchestrator_progress" as const,
    planId,
    subtaskId,
    status: "error" as const,
    label,
    ...(detail !== undefined ? { detail } : {}),
  };
  // Re-validate so a clamping miss yields null (drop) rather than a bad event.
  const parsed = OrchestratorProgressEventSchema.safeParse(candidate);
  return parsed.success && parsed.data._type === "orchestrator_progress"
    ? parsed.data
    : null;
}
