// packages/chat-types/src/index.ts

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * Ephemeral, provider-visible media for the current chat turn.
   *
   * Privacy invariant: direct chat attachments are carried only inside the
   * encrypted TEE payload. Clients should not persist dataBase64 in encrypted
   * conversation history unless a future product decision explicitly adds
   * durable media storage.
   */
  attachments?: ChatImageAttachment[];
}

export const CHAT_IMAGE_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type ChatImageAttachmentMimeType =
  (typeof CHAT_IMAGE_ATTACHMENT_MIME_TYPES)[number];

export const CHAT_IMAGE_ATTACHMENT_MAX_COUNT = 1;
export const CHAT_IMAGE_ATTACHMENT_MAX_BYTES = 160 * 1024;

export interface ChatImageAttachment {
  id: string;
  kind: "image";
  mimeType: ChatImageAttachmentMimeType;
  name?: string;
  sizeBytes: number;
  dataBase64: string;
}

export function isChatImageAttachmentMimeType(
  value: string,
): value is ChatImageAttachmentMimeType {
  return (CHAT_IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(value);
}

export function modelCapabilitiesSupportVision(
  capabilities:
    | { modalities?: readonly string[]; endpointFamily?: string; routingStatus?: string }
    | undefined,
): boolean {
  const modalities = capabilities?.modalities ?? [];
  return (
    (capabilities?.routingStatus ?? "enabled") === "enabled" &&
    (capabilities?.endpointFamily ?? "chat") === "chat" &&
    modalities.includes("image_in")
  );
}

export function validateChatImageAttachments(
  attachments: readonly ChatImageAttachment[] | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!attachments || attachments.length === 0) return { ok: true };
  if (attachments.length > CHAT_IMAGE_ATTACHMENT_MAX_COUNT) {
    return {
      ok: false,
      reason: `Only ${CHAT_IMAGE_ATTACHMENT_MAX_COUNT} image attachment is supported per turn.`,
    };
  }
  // Base64 expands every 3 bytes to 4 characters, so the data string for a
  // max-size image can never exceed this many characters. Bounding the string
  // itself (not just the client-claimed sizeBytes) keeps the size cap from
  // being decorative.
  const maxBase64Length = Math.ceil(CHAT_IMAGE_ATTACHMENT_MAX_BYTES / 3) * 4;
  for (const attachment of attachments) {
    if (attachment.kind !== "image") {
      return { ok: false, reason: "Only image attachments are supported." };
    }
    if (!isChatImageAttachmentMimeType(attachment.mimeType)) {
      return { ok: false, reason: "Unsupported image type." };
    }
    if (
      !Number.isFinite(attachment.sizeBytes) ||
      attachment.sizeBytes <= 0 ||
      attachment.sizeBytes > CHAT_IMAGE_ATTACHMENT_MAX_BYTES
    ) {
      return {
        ok: false,
        reason: `Image attachments must be ${CHAT_IMAGE_ATTACHMENT_MAX_BYTES} bytes or smaller.`,
      };
    }
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(attachment.dataBase64)) {
      return { ok: false, reason: "Invalid image attachment encoding." };
    }
    if (attachment.dataBase64.length > maxBase64Length) {
      return {
        ok: false,
        reason: `Image attachment data must decode to ${CHAT_IMAGE_ATTACHMENT_MAX_BYTES} bytes or smaller.`,
      };
    }
    // The declared size must also agree with what the base64 actually decodes
    // to (±2 bytes of tolerance for unpadded encoders), so neither field can
    // smuggle a different payload size past the cap.
    const padding = attachment.dataBase64.endsWith("==")
      ? 2
      : attachment.dataBase64.endsWith("=")
        ? 1
        : 0;
    const decodedBytes =
      Math.floor((attachment.dataBase64.length * 3) / 4) - padding;
    if (Math.abs(decodedBytes - attachment.sizeBytes) > 2) {
      return {
        ok: false,
        reason: "Image attachment size does not match its data.",
      };
    }
  }
  return { ok: true };
}

export type NativeWebSearchMode = "auto" | "off";

export type NativeWebSearchProviderTool =
  | "openai_web_search"
  | "anthropic_web_search"
  | "google_search_grounding";

export interface ChatCitation {
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
  anchorTextHash?: string;
  anchorTextLength?: number;
  provider?: string;
}

export interface ChatCitationCandidate extends ChatCitation {
  providerStartIndex?: number;
  providerEndIndex?: number;
  providerText?: string;
}

export interface ChatPayload {
  model: string;
  modelSource?: "catalog" | "custom";
  providerId?: string;
  messages: ChatMessage[];
  attachments?: ChatImageAttachment[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  nativeWebSearch?: NativeWebSearchMode;
}

export interface ChatChunk {
  id: string;
  choices: Array<{
    delta: { content?: string; role?: string };
    finish_reason: string | null;
  }>;
  citations?: ChatCitationCandidate[];
}

export interface ChatProcessor {
  streamChat(
    messages: ChatMessage[],
    options: {
      model: string;
      temperature?: number;
      max_tokens?: number;
      signal?: AbortSignal;
      nativeWebSearch?: NativeWebSearchMode;
    },
  ): AsyncGenerator<ChatChunk, unknown>;
}

export {
  annotateNativeWebSearchError,
  getAnnotatedNativeWebSearchCapabilityRejectionReason,
  getAnnotatedNativeWebSearchFallbackReason,
  getNativeWebSearchCapabilityRejectionReason,
  getNativeWebSearchPreOutputFallbackReason,
  type NativeWebSearchErrorInput,
} from "./native-web-search";

export * from "./file-capabilities";

// ---------------------------------------------------------------------------
// Regulated-information disclaimers.
//
// Single source of truth shared by the enclave (which detects the topic via a
// model-emitted control token on the chat path, and via skill packs on the
// agent path) and the clients (which render the disclaimer banner). Keeping the
// copy + mapping here prevents drift between the surface that decides a
// disclaimer is needed and the surface that shows it.
//
// A topic is an open lowercase slug, NOT a closed union: the model may flag any
// regulated / professional-advice domain it judges relevant (health, legal,
// financial, tax, security, …). High-stakes domains we have legally-reviewed
// copy for get that exact wording; anything else falls back to a neutral
// "not professional advice" line — so a new domain always produces a sensible
// banner without inventing per-domain legal claims in code.
// ---------------------------------------------------------------------------

/** A regulated-topic slug carried on the disclaimer signal. Open by design. */
export type RegulatedTopic = string;

/** Domains we ship legally-reviewed, domain-specific copy for. */
export type CanonicalDisclaimerTopic = "health" | "legal";

/** Curated order so canonical banners are deterministic across surfaces. */
export const CANONICAL_DISCLAIMER_TOPICS: readonly CanonicalDisclaimerTopic[] = [
  "health",
  "legal",
];

export const REGULATED_DISCLAIMERS: Record<CanonicalDisclaimerTopic, string> = {
  health:
    "This is general information, not medical advice. For your situation, consult a qualified healthcare professional.",
  legal:
    "This is general information, not legal advice. For your situation, consult a qualified solicitor or legal professional.",
};

/** Neutral fallback for a flagged domain we have no curated copy for. */
export const GENERIC_DISCLAIMER =
  "This is general information, not professional advice. For your situation, consult a qualified professional.";

function normaliseTopicSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z-]/g, "")
    .slice(0, 32);
}

/**
 * Resolve a set of flagged topics to the disclaimer lines a banner should show.
 * Canonical domains map to their reviewed copy (in canonical order); every other
 * recognised slug collapses to a single neutral line. De-duplicated and
 * order-stable so the same topics always render identically.
 */
export function disclaimerLinesForTopics(
  topics: readonly string[],
): string[] {
  const present = new Set<string>();
  for (const t of topics) {
    const slug = normaliseTopicSlug(t);
    if (slug && slug !== "none") present.add(slug);
  }
  const lines: string[] = [];
  for (const canonical of CANONICAL_DISCLAIMER_TOPICS) {
    if (present.has(canonical)) {
      lines.push(REGULATED_DISCLAIMERS[canonical]);
      present.delete(canonical);
    }
  }
  // Any remaining (non-canonical) slug → one shared neutral line.
  if (present.size > 0) lines.push(GENERIC_DISCLAIMER);
  return lines;
}

export interface VsockMessageType {
  ATTESTATION_REQUEST: 0x01;
  ATTESTATION_RESPONSE: 0x02;
  KEY_EXCHANGE: 0x03;
  KEY_EXCHANGE_ACK: 0x04;
  CHAT_REQUEST: 0x05;
  CHAT_CHUNK: 0x06;
  CHAT_DONE: 0x07;
  CHAT_ERROR: 0x08;
  HEALTH_PING: 0x09;
  HEALTH_PONG: 0x0a;
  USAGE_REPORT: 0x0b;
  AGENT_REQUEST: 0x0c;
  TOOL_INVOCATION: 0x0d;
  TOOL_RESULT: 0x0e;
  AGENT_DONE: 0x0f;
  DREAM_REQUEST: 0x10;
  DREAM_CHUNK: 0x11;
  DREAM_FINALISE: 0x12;
  DREAM_DONE: 0x13;
  DREAM_ERROR: 0x14;
  // Layer-3 research-query approval reverse-channel (Phase 3, cross-pack
  // claims advocate). RESEARCH_QUERY_APPROVAL is an enclave→client request
  // carrying the EXACT compiled outbound query for mid-turn user approval;
  // RESEARCH_QUERY_APPROVAL_RESULT is the client→enclave response.
  RESEARCH_QUERY_APPROVAL: 0x15;
  RESEARCH_QUERY_APPROVAL_RESULT: 0x16;
  // Phase 4 (cross-pack claims advocate audit receipts): enclave→client frame
  // emitted at a claims run's end, reporting the namespaces actually exercised
  // and the URLs the research subagent fetched. Encrypted under the session key
  // like every other agent frame — the relaying server must never learn the
  // exercised namespace set (server-blindness invariant).
  CLAIMS_SUMMARY: 0x17;
  // Consent-gated private-read -> web egress bridge (finding 11). When a
  // web-capable subtask is denied private-derived context, EGRESS_PROMOTION_REQUEST
  // is an enclave->client request listing the SPECIFIC private datums the user
  // may promote across the boundary (default DENY); EGRESS_PROMOTION_RESULT is
  // the client->enclave response carrying the approved candidate ids.
  EGRESS_PROMOTION_REQUEST: 0x18;
  EGRESS_PROMOTION_RESULT: 0x19;
}

export const MSG = {
  ATTESTATION_REQUEST: 0x01,
  ATTESTATION_RESPONSE: 0x02,
  KEY_EXCHANGE: 0x03,
  KEY_EXCHANGE_ACK: 0x04,
  CHAT_REQUEST: 0x05,
  CHAT_CHUNK: 0x06,
  CHAT_DONE: 0x07,
  CHAT_ERROR: 0x08,
  HEALTH_PING: 0x09,
  HEALTH_PONG: 0x0a,
  USAGE_REPORT: 0x0b,
  AGENT_REQUEST: 0x0c,
  TOOL_INVOCATION: 0x0d,
  TOOL_RESULT: 0x0e,
  AGENT_DONE: 0x0f,
  DREAM_REQUEST: 0x10,
  DREAM_CHUNK: 0x11,
  DREAM_FINALISE: 0x12,
  DREAM_DONE: 0x13,
  DREAM_ERROR: 0x14,
  RESEARCH_QUERY_APPROVAL: 0x15,
  RESEARCH_QUERY_APPROVAL_RESULT: 0x16,
  CLAIMS_SUMMARY: 0x17,
  EGRESS_PROMOTION_REQUEST: 0x18,
  EGRESS_PROMOTION_RESULT: 0x19,
} as const satisfies VsockMessageType;

export const DREAM_MSG = {
  DREAM_REQUEST: MSG.DREAM_REQUEST,
  DREAM_CHUNK: MSG.DREAM_CHUNK,
  DREAM_FINALISE: MSG.DREAM_FINALISE,
  DREAM_DONE: MSG.DREAM_DONE,
  DREAM_ERROR: MSG.DREAM_ERROR,
} as const;

export const MAX_VSOCK_PAYLOAD = 512 * 1024; // 512 KB

/**
 * Maximum HTTP body size for /v1/agent/:sessionId/tool-result.
 *
 * R4 finding #3 walked the FULL pipeline (both base64 expansions +
 * AES-GCM tag + per-file JSON envelope) and capped plaintext at
 * 200 KB. The HTTP body at that plaintext is ~363 KB. Setting the
 * route cap to 512 KB (= MAX_VSOCK_PAYLOAD) gives slack for envelope
 * variance — the wire layer is the hard ceiling anyway.
 */
export const MAX_AGENT_TOOL_RESULT_BYTES = 512 * 1024;

/**
 * Maximum body size for /v1/agent/:sessionId/tool-result-ack.
 * Only carries routing IDs + an opaque encrypted ack frame.
 */
export const MAX_AGENT_TOOL_RESULT_ACK_BYTES = 8 * 1024;

export {
  PADDING_BUCKETS,
  MAX_PADDED_PAYLOAD,
  PADDING_HEADER,
  PADDING_HEADER_V1,
  PaddedFrameEncoder,
  PaddedFrameDecoder,
  type PaddedFrameMode,
  type PaddedFrameDecoderOptions,
} from "./padding";

export {
  UsageReportRouteKindSchema,
  UsageReportPayloadSchema,
  encodeUsageReport,
  decodeUsageReport,
  MAX_USAGE_REPORT_BYTES,
} from "./usage";
export type { UsageReportPayload, UsageReportRouteKind } from "./usage";

export * from "./memory";

export * from "./cross-pack-grant";

export * from "./claims-receipt";

export * from "./research-query";

export {
  SkillPackSchema,
  ToolNameSchema,
  TOOL_NAMES,
  BANNED_PACK_IDS,
  registerSkillPackId,
  isRegisteredSkillPackId,
  type SkillPack,
  type SkillPackId,
  type ToolName,
  type BannedPackId,
} from "./skill-pack";

export {
  SkillPromptBundleSchema,
  MIN_SKILL_PROMPTS_VERSION,
  type SkillPromptBundle,
} from "./skill-prompts";

export {
  canonicalSkillPromptsSigningInput,
  SKILL_PROMPTS_SIGNING_DOMAIN,
} from "./canonical-skill-prompts";

export {
  SIGNED_DELETION_JOB_KINDS,
  SignedDeletionJobKindSchema,
  SignedDeletionItemSchema,
  SignedDeletionRequestScopeSchema,
  SignedDeletionManifestSchema,
  HybridSingleDeletionPayloadSchema,
  type SignedDeletionJobKind,
  type SignedDeletionItem,
  type SignedDeletionRequestScope,
  type SignedDeletionManifest,
  type HybridDeletionFlatFields,
  type HybridSingleDeletionPayload,
} from "./deletion-manifest";

export {
  BINARY_OUTPUT_CHUNK_BYTES,
  ToolInvocationFrameSchema,
  ToolResultFrameSchema,
  BinaryWorkItemChunkFrameSchema,
  BinaryWorkItemDirectionSchema,
  BinaryWorkItemToolNameSchema,
  BinaryWorkItemWriteAckFrameSchema,
  BinaryWorkItemWriteRequestFrameSchema,
  ToolCallLedgerEntrySchema,
  ToolResultOutcomeSchema,
  LedgerToolNameSchema,
  PARSER_REJECTION_TOOL_NAME,
  type ToolInvocationFrame,
  type ToolResultFrame,
  type BinaryWorkItemChunkFrame,
  type BinaryWorkItemDirection,
  type BinaryWorkItemToolName,
  type BinaryWorkItemWriteAckFrame,
  type BinaryWorkItemWriteRequestFrame,
  type ToolCallLedgerEntry,
  type ToolResultOutcome,
  type LedgerToolName,
  type ParserRejectionToolName,
} from "./tool-protocol";

export {
  AGENT_WRITE_PERMISSION_MODES,
  AgentLinkedFolderContextSchema,
  AgentRequestContextSchema,
  AgentWritePermissionModeSchema,
  MAX_AGENT_LINKED_FOLDERS,
  buildAgentLinkedFolderContext,
  type AgentLinkedFolderContext,
  type AgentRequestContext,
  type AgentWritePermissionMode,
} from "./agent-context";

export { EGRESS_TAINT_READ_TOOLS } from "./egress-taint-read-tools";

export {
  FOLLOW_UP_ASSISTANT_CHAR_LIMIT,
  PRIVATE_DERIVED_PRIOR_ANSWER_OMISSION,
  buildCalypsoTaskMessageHistory,
  type CalypsoFollowUpMessage,
  type CalypsoFollowUpPriorStatus,
} from "./calypso-follow-up";

export {
  AgentMediaSubtaskSchema,
  AgentSubtaskKindSchema,
  AgentSubtaskSchema,
  AgentTaskPlanSchema,
  ModelCapabilitySchema,
  ModelEndpointFamilySchema,
  ModelModalitySchema,
  NativeWebSearchCapabilitySchema,
  ModelQualityTierSchema,
  ModelRouteDecisionSchema,
  ModelStrengthSchema,
  OrchestratorEventScopeSchema,
  OrchestratorLedgerEntrySchema,
  OrchestratorProgressEventSchema,
  OrchestratorRequestContextSchema,
  OrchestratorRunModeSchema,
  OrchestratorWorkingMemoryEntrySchema,
  type AgentMediaSubtask,
  type AgentSubtask,
  type AgentSubtaskKind,
  type AgentTaskPlan,
  type ModelCapability,
  type ModelEndpointFamily,
  type ModelModality,
  type NativeWebSearchCapability,
  type ModelQualityTier,
  type ModelRouteDecision,
  type ModelStrength,
  type OrchestratorEventScope,
  type OrchestratorLedgerEntry,
  type OrchestratorProgressEvent,
  type OrchestratorRequestContext,
  type OrchestratorRunMode,
  type OrchestratorWorkingMemoryEntry,
} from "./orchestrator";

export {
  MediaArtifactKindSchema,
  MediaHandleKindSchema,
  MediaJobStatusSchema,
  MediaOriginSchema,
  MediaProvenanceRecordSchema,
  ProviderVisibleConsentSignatureSchema,
  ProviderVisibleInputConsentSchema,
  VideoCompositionSpecSchema,
  VideoTemplateIdSchema,
  canonicaliseProviderVisibleConsentUnsigned,
  canonicaliseStableJson,
  type MediaArtifactKind,
  type MediaHandleKind,
  type MediaJobStatus,
  type MediaOrigin,
  type MediaProvenanceRecord,
  type ProviderVisibleInputConsent,
  type VideoCompositionSpec,
  type VideoTemplateId,
} from "./media";

export {
  MediaBudgetRouteKindSchema,
  MediaBudgetReconcileStatusSchema,
  MediaBudgetReserveRequestSchema,
  MediaBudgetReconcileRequestSchema,
  MediaBudgetRequestSchema,
  MediaBudgetReserveResultSchema,
  MediaBudgetReconcileResultSchema,
  MAX_MEDIA_BUDGET_RPC_BYTES,
  encodeMediaBudgetRequest,
  decodeMediaBudgetRequest,
  encodeMediaBudgetReserveResult,
  decodeMediaBudgetReserveResult,
  encodeMediaBudgetReconcileResult,
  decodeMediaBudgetReconcileResult,
  type MediaBudgetRouteKind,
  type MediaBudgetReconcileStatus,
  type MediaBudgetReserveRequest,
  type MediaBudgetReconcileRequest,
  type MediaBudgetRequest,
  type MediaBudgetRequestInput,
  type MediaBudgetReserveResult,
  type MediaBudgetReconcileResult,
} from "./media-budget";

export {
  VideoCheckpointStateSchema,
  VideoCheckpointTerminalStateSchema,
  VideoCheckpointRequestSchema,
  VideoCheckpointLoadResultSchema,
  VideoCheckpointWriteResultSchema,
  VideoCheckpointCancelledListResultSchema,
  VideoCheckpointBillingListResultSchema,
  MAX_VIDEO_CHECKPOINT_RPC_BYTES,
  encodeVideoCheckpointRequest,
  decodeVideoCheckpointRequest,
  encodeVideoCheckpointLoadResult,
  decodeVideoCheckpointLoadResult,
  encodeVideoCheckpointWriteResult,
  decodeVideoCheckpointWriteResult,
  encodeVideoCheckpointCancelledListResult,
  decodeVideoCheckpointCancelledListResult,
  encodeVideoCheckpointBillingListResult,
  decodeVideoCheckpointBillingListResult,
  type VideoCheckpointState,
  type VideoCheckpointTerminalState,
  type VideoCheckpointRequest,
  type VideoCheckpointLoadResult,
  type VideoCheckpointWriteResult,
  type VideoCheckpointCancelledListResult,
  type VideoCheckpointBillingListResult,
  type VideoOperatorAlert,
} from "./video-checkpoint";
