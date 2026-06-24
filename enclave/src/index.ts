import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Socket } from "node:net";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { decodeFrame, encodeFrame, MSG } from "./vsock";
import {
  EnclaveSessionManager,
  MEMORY_WRITE_ACK_TIMEOUT_MS,
} from "./session";
import { encryptChunk, decryptChunk, zeroBuffer } from "./crypto";
import {
  initRegistry,
  getProviderForCustomModel,
  getProviderForModel,
  getProviderById,
  createProcessor,
  getAllProviders,
  type ModelConfig,
  type ProviderConfig,
} from "./providers/registry";
import { OpenAIImageProcessor } from "./providers/adapters/openai-image-v1";
import { GoogleImageProcessor } from "./providers/adapters/google-image-v1";
import type { ImageProviderAdapter } from "./media/image-provider";
import {
  deriveProvenanceSigner,
  buildProvenanceUserData,
  GoogleVeoVideoAdapter,
  type ProvenanceSigner,
  type VideoProviderAdapter,
} from "./media";
import { createMediaBudgetClient } from "./media-budget-client";
import { createVideoCheckpointClient } from "./video-checkpoint-store";
import { createVideoProviderInputContext } from "./media-provider-input";
import {
  isVideoGenerationRoutable,
  computeMediaToolStripSet,
} from "./media-routability";
import {
  runVideoReconcilerOnce,
  VIDEO_RECONCILER_INTERVAL_MS,
  type StaleDeliveryAlertState,
} from "./video-reconciler";
import { buildProviderDisplayNameMap } from "./providers/display-name";
import { effectiveNativeWebSearchMode } from "./providers/native-web-search";
import { getNSMAttestationDoc, initNsmSidecar } from "./nsm";
import { createEnclaveListener } from "./vsock-listener";
import { fetchKeysViaAttestedKMS, type AttestedKmsResult } from "./kms-client";
import { fetchRegistryFromBroker } from "./registry-client";
import { fetchSkillPromptsFromBroker } from "./skills-client";
import { fetchConnectorsFromBroker } from "./connectors-client";
import {
  initConnectorRegistry,
  isConnectorRegistryLoaded,
  getConnectorCatalogVersion,
} from "./connectors/registry";
import {
  loadAndVerifySkillPrompts,
  buildPromptResolver,
} from "./skills/verify-skill-prompts";
import { startOutboundBridges } from "./vsock-proxy-bridge";
import {
  extractUsageFromProviderResponse,
  type ProviderResponseLike,
} from "./usage-report";
import {
  runDreamSession,
  AnthropicLlmTransport,
  type DreamCandidate,
  type DreamSessionDeltaOutput,
  type LlmTransport,
  type UnsignedEnvelope,
} from "./dream";
import {
  ChatProcessor,
  type ChatChunk,
  type ChatMessage,
  modelCapabilitiesSupportVision,
  MAX_VSOCK_PAYLOAD,
  validateChatImageAttachments,
  BANNED_PACK_IDS,
  AgentRequestContextSchema,
  BinaryWorkItemWriteAckFrameSchema,
  OrchestratorRequestContextSchema,
  SkillPackSchema,
  encodeUsageReport,
  CrossPackGrantEnvelopeSchema,
  CrossPackGrantBodySchema,
  type ChatImageAttachment,
  type BinaryWorkItemWriteAckFrame,
  type CrossPackGrantEnvelope,
  type ModelCapability,
  type ModelEndpointFamily,
  type SkillPack,
  type ToolInvocationFrame,
  type ToolName,
  type ToolResultFrame,
} from "@calypso/chat-types";
import { CLAIMS_PACK_ID, resolveCrossPackGrant } from "./agent/cross-pack-grant";
import {
  DEFAULT_PACK_ID,
  getEffectiveSkillPack,
  isKnownSkillPackId,
  type SkillPromptResolver,
} from "@calypso/chat-types/skills";
import { ToolGateway, type ClientBridge } from "./tools";
import {
  BinaryWorkItemManager,
  buildBinaryWriteWireFrames,
} from "./tools/binary-work-items";
import { MediaToolsClient } from "./tools/media-tools";
import { runAgentLoop, type MemoryWriteAckResult } from "./agent/loop";
import { AsyncFrameQueue } from "./agent/async-frame-queue";
import { createClaimsSummaryFlusher } from "./agent/claims-summary";
import {
  scopePackToPlan,
  FREE_AGENT_MAX_TOOL_CALLS,
  FREE_AGENT_READ_AGGREGATE_BYTES,
} from "./agent/free-tier-tools";
import {
  TOPIC_CONTROL_INSTRUCTION,
  finalizeTopicControl,
  pendingDisclaimerSuffix,
  resolveTopicControl,
  type RegulatedTopic,
} from "./agent/disclaimer";
import { ToolResultReassembler } from "./agent/tool-result-reassembler";
import { ProviderError } from "./providers/errors";
import {
  runOrchestrator,
  type RunOrchestratorDeps,
} from "./orchestrator/executor";
import { redeliverPendingMedia } from "./orchestrator/media-redeliver";
import { toProgressChunk } from "./orchestrator/events";
import { buildModelCapabilities } from "./orchestrator/model-capabilities";

export interface EnclaveRouterOptions {
  dreamLlmTransport?: LlmTransport;
  /**
   * Test seam: override the chat processor used by the agent loop.
   * Production uses the provider registry via getProviderForModel.
   */
  agentLoopProcessorFactory?: (model: string) => ChatProcessor;
  /**
   * Internal media executor dependencies. When absent, production routing
   * intentionally remains chat-only so specialist media subtasks fail at
   * routing instead of reaching a half-wired executor.
   */
  media?: RunOrchestratorDeps["media"];
  /**
   * Test seam for orchestrator routing. Production reads the signed
   * provider registry loaded at boot.
   */
  orchestratorModels?: ModelCapability[];
  /**
   * Codex R4 finding #5: per-invocation timeout for the
   * outstandingInvocations bridge. Default 60 s; tests override to a
   * tiny value so the timeout path can be exercised with vi fake
   * timers.
   */
  invocationTimeoutMs?: number;
}

const DEFAULT_INVOCATION_TIMEOUT_MS = 60_000;
const DEFAULT_BINARY_WRITE_ACK_TIMEOUT_MS = 5 * 60_000;
const ORCHESTRATOR_PROVIDER_CALL_BUDGET_BY_PLAN = {
  FREE: 0,
  PRO: 9,
  MAX: 17,
} as const;

/**
 * How long the per-invocation resolver waits for a client TOOL_RESULT before
 * giving up. Two tools are the exception:
 *  - `folder.write`: in "Ask before saving" mode it blocks on the user's
 *    confirmation modal, which emits NO interim chunks to refresh the idle timer.
 *  - `connector.act`: a connector MUTATION in a confirmation mode
 *    (always_ask / once_per_session) likewise blocks on the user's review modal
 *    before the client performs the external write — same human-in-the-loop wait
 *    as folder.write, no interim chunks.
 * A deliberate human review (reading a generated letter, or a calendar change,
 * before approving) must not be cut off at the short machine-round-trip default,
 * else the resolver fires INVOCATION_TIMEOUT and a later approval lands as an
 * UNSOLICITED result — the confirmed external action reported as lost. Give both
 * the human-review / durable-write window a binary/media write already gets.
 * This is a mode-AGNOSTIC ceiling (the enclave does not read the per-connector
 * mode — S5): an `auto` connector.act simply has a higher ceiling it won't reach.
 * Every other tool keeps the short timeout so a dead client can't hang a turn.
 * Pure + exported so the policy is unit-tested without standing up a session.
 */
export function clientInvocationTimeoutMs(
  toolName: string,
  timeouts: {
    invocationTimeoutMs: number;
    confirmationGatedWriteTimeoutMs: number;
  },
): number {
  return toolName === "folder.write" || toolName === "connector.act"
    ? timeouts.confirmationGatedWriteTimeoutMs
    : timeouts.invocationTimeoutMs;
}

type InvocationResolver = (result: ToolResultFrame) => void;

type ChatModelSelection = {
  modelSource: "catalog" | "custom";
  providerId?: string;
  modelId: string;
};

type AgentSubscriptionPlanId = "FREE" | "PRO" | "MAX";

function readAgentSubscriptionPlanId(value: unknown): AgentSubscriptionPlanId {
  return value === "PRO" || value === "MAX" ? value : "FREE";
}

/**
 * Error-handling audit H1: error frames cross the vsock boundary
 * UNENCRYPTED, so the host can read them. Thrown errors can embed
 * decrypted/derived content (JSON.parse source snippets, client field
 * values, Zod issue text, provider SDK messages) — none of that may leave
 * the enclave. In-enclave errors carry their code as the first
 * `:`-separated token of the message; the codes below are the only tokens
 * permitted onto the wire. Membership in this allowlist — not just
 * code-like SHAPE — is required so payload-derived text that happens to
 * look like a code is still dropped. Anything unrecognised collapses to
 * the per-handler fallback code.
 */
const WIRE_ERROR_CODES: ReadonlySet<string> = new Set([
  "AGENT_CLIENT_SYSTEM_ROLE_REJECTED",
  "AGENT_NO_CHAT_MODEL",
  "AGENT_NO_LOW_COST_MODEL",
  "AGENT_REQUEST_INVALID_MESSAGES",
  "AGENT_REQUEST_INVALID_PAYLOAD",
  "BANNED_SKILL_PACK_ID",
  "DECRYPT_FAILED",
  "DREAM_FINALISE_INVALID_PAYLOAD",
  "DREAM_REQUEST_INVALID_PAYLOAD",
  "FREE_AGENT_MODEL_NOT_ALLOWED",
  "MASKING_UNAVAILABLE",
  "MEDIA_TOOL_DEP_MISSING",
  "NO_MODEL_FOR_SUBTASK",
  "ORCHESTRATOR_CANCELLED",
  "ORCHESTRATOR_MEMORY_SUMMARY_FAILED",
  "ORCHESTRATOR_PLAN_CYCLE",
  "ORCHESTRATOR_PLAN_FAILED",
  "ORCHESTRATOR_PLAN_UNKNOWN_DEPENDENCY",
  "ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED",
  "ORCHESTRATOR_WORKER_NO_ATTEMPT_AVAILABLE",
  "ORCHESTRATOR_WORKER_TIMEOUT",
  "PROVIDER_KEY_MISSING",
  "REINJECT_CHAIN_EXHAUSTED",
  "RESEARCH_QUERY_APPROVAL_RESULT_INVALID",
  "SESSION_EXPIRED",
  "SKILL_PACK_OUTER_INNER_MISMATCH",
  "TOOL_RESULT_INVALID_PAYLOAD",
  "UNKNOWN_SKILL_PACK_ID",
  "UNROUTABLE_ENDPOINT_FAMILY",
]);

function opaqueWireErrorCode(err: unknown, fallback: string): string {
  // Provider failures already have a stable public meaning on the chat
  // path; reuse it rather than leaking provider/status detail.
  if (err instanceof ProviderError) return "PROVIDER_UNAVAILABLE";
  if (err instanceof Error) {
    const token = err.message.split(":", 1)[0]?.trim() ?? "";
    if (WIRE_ERROR_CODES.has(token)) return token;
  }
  return fallback;
}

/** Build the standard `{ error_code, message }` payload, message = code (H1). */
function wireErrorPayload(err: unknown, fallback: string): Buffer {
  const code = opaqueWireErrorCode(err, fallback);
  return Buffer.from(JSON.stringify({ error_code: code, message: code }));
}

/**
 * In-enclave diagnostic for a handler failure. Logs only the error class
 * name and the resolved wire code — enclave stdout/stderr is host-visible,
 * so the raw message (which may be payload-derived) is never printed.
 */
function logRedactedHandlerError(handler: string, err: unknown): void {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  console.error(`[enclave] ${handler} failed: name=${name}`);
}

type AgentModelAdmission =
  | { ok: true; modelId: string }
  | { ok: false; code: string; message: string };

/**
 * Enclave-authoritative agent model admission for the single-mode path. The
 * server can't see the encrypted model id, so the enclave decides:
 *  - FREE: map `auto`/empty to an approved low-cost chat model; REJECT any
 *    concrete non-low-cost model (the FREE per-turn fan-out cap bounds call
 *    COUNT, not price).
 *  - PRO/MAX: map `auto` to a routable chat model; concrete models pass through.
 * `chatModels` is the already-key-filtered chat-family routable set.
 */
export function admitAgentModel(
  requested: string,
  plan: AgentSubscriptionPlanId,
  chatModels: readonly ModelCapability[],
): AgentModelAdmission {
  const wantsAuto = !requested || requested === "auto";
  if (plan === "FREE") {
    const lowCost = chatModels.filter((m) => m.costTier === "low");
    if (wantsAuto) {
      const def =
        lowCost.find((m) => /haiku/i.test(m.modelId)) ?? lowCost[0];
      if (!def) {
        return {
          ok: false,
          code: "AGENT_NO_LOW_COST_MODEL",
          message: "No low-cost model is currently available.",
        };
      }
      return { ok: true, modelId: def.modelId };
    }
    if (!lowCost.some((m) => m.modelId === requested)) {
      return {
        ok: false,
        code: "FREE_AGENT_MODEL_NOT_ALLOWED",
        message:
          "This model requires Pro. Free agent turns use a low-cost model.",
      };
    }
    return { ok: true, modelId: requested };
  }
  if (wantsAuto) {
    const def = chatModels[0];
    if (!def) {
      return {
        ok: false,
        code: "AGENT_NO_CHAT_MODEL",
        message: "No chat model is currently available.",
      };
    }
    return { ok: true, modelId: def.modelId };
  }
  return { ok: true, modelId: requested };
}

function readModelSelection(value: unknown): ChatModelSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const selection = value as Partial<ChatModelSelection>;
  if (
    selection.modelSource !== "catalog" &&
    selection.modelSource !== "custom"
  ) {
    throw new Error(
      "CHAT_MODEL_SELECTION_INVALID: modelSource must be catalog or custom",
    );
  }
  if (typeof selection.modelId !== "string" || selection.modelId.length === 0) {
    throw new Error("CHAT_MODEL_SELECTION_INVALID: modelId is required");
  }
  if (
    selection.modelSource === "custom" &&
    (typeof selection.providerId !== "string" ||
      selection.providerId.length === 0)
  ) {
    throw new Error(
      "CHAT_MODEL_SELECTION_INVALID: providerId is required for custom models",
    );
  }
  return {
    modelSource: selection.modelSource,
    providerId: selection.providerId,
    modelId: selection.modelId,
  };
}

function assertDirectChatModelRoutable(model: ModelConfig): void {
  const routingStatus = model.capabilities?.routingStatus ?? "enabled";
  const endpointFamily = model.capabilities?.endpointFamily ?? "chat";
  if (routingStatus !== "enabled") {
    throw new Error(
      `CHAT_MODEL_ROUTING_INVALID:${model.id}:routingStatus=${routingStatus}`,
    );
  }
  if (endpointFamily !== "chat") {
    throw new Error(
      `CHAT_MODEL_ROUTING_INVALID:${model.id}:endpointFamily=${endpointFamily}`,
    );
  }
}

function resolveProviderForChatPayload(
  chatPayload: Record<string, unknown>,
  selection: ChatModelSelection | undefined,
): ReturnType<typeof getProviderForModel> {
  const payloadModel = chatPayload.model;
  if (typeof payloadModel !== "string" || payloadModel.length === 0) {
    throw new Error(
      "CHAT_REQUEST_INVALID_MODEL: model must be a non-empty string",
    );
  }

  if (!selection) {
    if (
      chatPayload.modelSource === "custom" ||
      chatPayload.providerId !== undefined
    ) {
      throw new Error("CUSTOM_MODEL_AUTHORIZATION_REQUIRED");
    }
    const entry = getProviderForModel(payloadModel);
    assertDirectChatModelRoutable(entry.model);
    return entry;
  }

  if (selection.modelId !== payloadModel) {
    throw new Error(
      "CHAT_MODEL_SELECTION_MISMATCH: encrypted payload model differs from server metadata",
    );
  }

  if (selection.modelSource === "catalog") {
    const entry = getProviderForModel(selection.modelId);
    assertDirectChatModelRoutable(entry.model);
    return entry;
  }

  const providerId = selection.providerId;
  if (!providerId) {
    throw new Error("CHAT_MODEL_SELECTION_INVALID: providerId is required");
  }
  if (
    chatPayload.modelSource !== "custom" ||
    chatPayload.providerId !== providerId
  ) {
    throw new Error(
      "CHAT_MODEL_SELECTION_MISMATCH: custom provider metadata differs from payload",
    );
  }

  return getProviderForCustomModel(providerId, selection.modelId);
}

export class EnclaveRouter {
  private sessionManager = new EnclaveSessionManager();
  private readonly binaryWorkItems = new BinaryWorkItemManager();
  private readonly mediaTools = new MediaToolsClient();
  private providerKeys: Record<string, string> = {};
  // KMS-released, PCR0-gated media-root secret (null when the blob predates
  // attestation-rooted provenance). HKDF-derived into the stable media
  // provenance signer in buildProductionMedia().
  private mediaRootSecret: string | null = null;
  // Raw 32-byte Ed25519 media-provenance public key, published in the session
  // attestation `user_data` so a client can verify image provenance against
  // the attested enclave identity. Set in buildProductionMedia().
  private provenancePublicKey: Uint8Array | null = null;
  private providerDisplayNames: ReadonlyMap<string, string> = new Map();

  // Verified persona-prompt resolver, populated at init() from the signed
  // skill-prompts bundle (host-served in prod, bundled fallback in dev/test).
  // null until loaded; the request path passes it to getEffectiveSkillPack so
  // the prompt is composed from verified bytes, never from a client bundle.
  private skillPromptResolver: SkillPromptResolver | null = null;
  private bootTime = Date.now();
  private dreamLlmTransport?: LlmTransport;
  private readonly agentLoopProcessorFactory?: (model: string) => ChatProcessor;
  // Set from opts.media (tests inject their own) OR constructed lazily in
  // init() once provider keys are available (production media gateway). Not
  // readonly: production assigns it post-key-fetch.
  private media?: RunOrchestratorDeps["media"];
  // Video providers disabled at runtime by the reconciler (billing-metadata SLA
  // breach). The fail-closed video gate drops a disabled provider from routing.
  private readonly disabledVideoProviders = new Set<string>();
  // Recurring orphan/billing reconciler tick (video). Started in init() once a
  // video adapter is wired; cleared in dispose().
  private videoReconcilerTimer: ReturnType<typeof setInterval> | null = null;
  private connectorRegistryLoadPromise: Promise<boolean> | null = null;
  // True only when `this.media` was constructed by buildProductionMedia (the
  // real gateway), NOT when a test injected its own media. Gates the per-request
  // budgetClient override so injected test budget clients are never replaced.
  private productionMediaWired = false;
  private readonly orchestratorModels?: ModelCapability[];
  private readonly invocationTimeoutMs: number;

  /**
   * Pending TOOL_INVOCATION promises awaiting a matching MSG.TOOL_RESULT.
   * Keyed by `${sessionId}::${agentTurnId}::${invocationId}` (codex R2
   * finding #2). State is shared across vsock sockets — the server may
   * post a TOOL_RESULT on a separate connection from the long-lived
   * AGENT_REQUEST socket; both connections route through this same
   * singleton router.
   */
  private outstandingInvocations = new Map<string, InvocationResolver>();

  /**
   * Per-(sessionId, agentTurnId, invocationId) handle that bumps the
   * resolver's per-invocation timeout. Chunked TOOL_RESULT transport
   * calls this when each chunk lands so a slow uploader (a mobile
   * client trickling a 5 MiB file over a degraded uplink across
   * 35–40 chunks) cannot exceed `invocationTimeoutMs` while still
   * making forward progress. The single-frame path never touches
   * this — its one POST either lands and resolves, or doesn't.
   */
  private invocationTimeoutRefreshers = new Map<string, () => void>();

  /**
   * R11 Finding A (Codex): the resolver promise for an outstanding
   * invocation, PRE-REGISTERED before the TOOL_INVOCATION wire frame
   * goes out. Closes the race where a fast client posts /tool-result
   * before bridge.invokeClient has had a chance to call
   * outstandingInvocations.set. invokeClient picks up this pre-existing
   * promise instead of creating a new one.
   */
  private preRegisteredResolverPromises = new Map<
    string,
    Promise<ToolResultFrame>
  >();

  /**
   * Layer-3 research-query approval resolvers (Phase 3, cross-pack claims
   * advocate). Keyed by an opaque approvalId of the form
   * `${sessionId}:${turnId}:${monotonic counter}`. The resolver is registered
   * by clientBridge.approveQuery the instant it emits the
   * RESEARCH_QUERY_APPROVAL frame, and fired by the
   * RESEARCH_QUERY_APPROVAL_RESULT reverse-channel handler with the user's
   * boolean decision (or by a fail-closed `false` timeout). Modelled on the
   * {@link outstandingInvocations} reverse-channel bridge, but the approval
   * round-trip is a plain boolean (no ToolResultFrame). State is shared across
   * vsock sockets — the client may POST the result on a separate connection
   * from the long-lived AGENT_REQUEST socket; both route through this singleton.
   */
  private pendingResearchApprovalResolvers = new Map<
    string,
    (approved: boolean) => void
  >();

  /** Monotonic counter for research-approval ids within this router. */
  private researchApprovalCounter = 0;

  /**
   * Egress-promotion reverse-channel (finding 11): an EGRESS_PROMOTION_REQUEST is
   * settled by an EGRESS_PROMOTION_RESULT carrying the approved candidate ids, or
   * by a fail-closed empty (DENY) timeout. Same shared-across-sockets + session-
   * binding contract as {@link pendingResearchApprovalResolvers}.
   */
  private pendingEgressPromotionResolvers = new Map<
    string,
    (approvedIds: string[]) => void
  >();

  /** Monotonic counter for egress-promotion ids within this router. */
  private egressPromotionCounter = 0;

  private pendingBinaryWriteAckResolvers = new Map<
    string,
    (frame: ToolResultFrame) => void
  >();

  /**
   * Definitive memory.write ACK-gating: the agent loop suspends after
   * delivering the signed envelope (`memory-write-signed`) and awaits
   * the client's durable-persist ACK. The resolver is registered here
   * (keyed by the triple-key) and fired by the `_ack` reverse-channel
   * handler once the client posts /tool-result-ack, or by a
   * MEMORY_WRITE_ACK_TIMEOUT_MS fallback so the turn never hangs.
   */
  private pendingMemoryWriteAckResolvers = new Map<
    string,
    (result: MemoryWriteAckResult) => void
  >();

  /**
   * Pre-registered memory.write ACK promises, keyed by the triple-key.
   *
   * Mirror of {@link preRegisteredResolverPromises} for the durable-write
   * ACK gate. The resolver behind {@link pendingMemoryWriteAckResolvers}
   * must be in place BEFORE the `memory_write_signed` CHAT_CHUNK leaves
   * the enclave. Otherwise a fast client that durably persists and POSTs
   * /tool-result-ack the instant it sees that chunk wins the race against
   * the agent loop resuming past `yield { kind: 'memory-write-signed' }`
   * and calling awaitMemoryWriteAck: the `_ack` handler finds no pending
   * resolver, drops the ack, and the loop hangs until
   * MEMORY_WRITE_ACK_TIMEOUT_MS while the model — never having observed a
   * result — re-issues the same memory.write each turn until
   * TOOL_LIMIT_EXCEEDED. We build the promise (which registers the
   * resolver) when the `memory-write-signed` frame is emitted, and
   * awaitMemoryWriteAck simply hands back the pre-registered promise.
   */
  private preRegisteredMemoryWriteAckPromises = new Map<
    string,
    Promise<MemoryWriteAckResult>
  >();

  /**
   * Chunked tool-result reassembler. Glues multi-frame TOOL_RESULT
   * POSTs back into one decrypted-plaintext blob before dispatching
   * through the existing single-frame resolver path. Buffers are
   * keyed by (sessionId, agentTurnId, invocationId) and wiped on the
   * same zeroSession path as session keys.
   */
  private readonly toolResultReassembler: ToolResultReassembler;

  constructor(opts: EnclaveRouterOptions = {}) {
    this.dreamLlmTransport = opts.dreamLlmTransport;
    this.agentLoopProcessorFactory = opts.agentLoopProcessorFactory;
    this.media = opts.media;
    this.orchestratorModels = opts.orchestratorModels;
    this.invocationTimeoutMs =
      opts.invocationTimeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS;
    this.toolResultReassembler = new ToolResultReassembler({
      onTimeout: (key) => {
        // Resolve any pending resolver so the agent loop sees a clean
        // error frame instead of waiting for the 60s invocation timeout.
        const resolverKey = invocationKey(
          key.sessionId,
          key.agentTurnId,
          key.invocationId,
        );
        const resolver = this.outstandingInvocations.get(resolverKey);
        if (resolver) {
          this.outstandingInvocations.delete(resolverKey);
          resolver({
            invocationId: key.invocationId,
            outcome: "error",
            reason: "TOOL_RESULT_REASSEMBLY_TIMEOUT",
          });
        }
      },
    });
    this.sessionManager.registerOnZeroed((sessionId) => {
      this.toolResultReassembler.clearForSession(sessionId);
      this.binaryWorkItems.clearForSession(sessionId);
      this.clearPendingBinaryWriteAcksForSession(sessionId);
    });
  }

  /** Test seam — populate the signed-finalisation cache for R4 finding #2 replay tests. */
  __sessionManagerForTest(): EnclaveSessionManager {
    return this.sessionManager;
  }

  /**
   * Tear down router-owned resources that hold timers or in-flight
   * plaintext buffers. Test suites and per-tenant router pools should
   * call this when the router instance is no longer needed; the
   * production main() relies on process exit (the timer is `.unref()`d
   * and the reassembler entries are GC'd along with the router).
   */
  dispose(): void {
    this.toolResultReassembler.stop();
    this.binaryWorkItems.stop();
    this.mediaTools.stop();
    if (this.videoReconcilerTimer) {
      clearInterval(this.videoReconcilerTimer);
      this.videoReconcilerTimer = null;
    }
    this.clearPendingBinaryWriteAcksForSession();
  }

  /**
   * Start the recurring video orphan/billing reconciler. No-op unless a video
   * adapter is wired. Each tick sweeps the durable checkpoint store and settles
   * holds for jobs cancelled/interrupted after their provider job started. Tick
   * errors are isolated + logged inside runVideoReconcilerOnce; the timer is
   * unref'd so it never keeps the process alive.
   */
  private startVideoReconciler(): void {
    if (this.videoReconcilerTimer) return;
    const videoAdapters = this.media?.videoAdapters;
    if (!videoAdapters || Object.keys(videoAdapters).length === 0) return;
    // Persistent across-tick holder so the stale-delivery alert is suppressed
    // between sweeps (re-alerts at most once per window while a backlog persists).
    const staleAlertState: StaleDeliveryAlertState = {};
    const tick = () =>
      void runVideoReconcilerOnce({
        videoAdapters,
        disabledVideoProviders: this.disabledVideoProviders,
        staleAlertState,
      });
    this.videoReconcilerTimer = setInterval(tick, VIDEO_RECONCILER_INTERVAL_MS);
    this.videoReconcilerTimer.unref?.();
    console.log(
      "[enclave] EnclaveRouter.init(): video reconciler started:",
      Object.keys(videoAdapters),
    );
  }

  private clearPendingBinaryWriteAcksForSession(sessionId?: string): void {
    for (const key of [...this.pendingBinaryWriteAckResolvers.keys()]) {
      if (sessionId === undefined || key.startsWith(`${sessionId}::`)) {
        this.pendingBinaryWriteAckResolvers.delete(key);
      }
    }
    for (const key of [...this.pendingMemoryWriteAckResolvers.keys()]) {
      if (sessionId === undefined || key.startsWith(`${sessionId}::`)) {
        this.pendingMemoryWriteAckResolvers.delete(key);
      }
    }
    for (const key of [...this.preRegisteredMemoryWriteAckPromises.keys()]) {
      if (sessionId === undefined || key.startsWith(`${sessionId}::`)) {
        this.preRegisteredMemoryWriteAckPromises.delete(key);
      }
    }
  }

  async init(): Promise<void> {
    console.log("[enclave] EnclaveRouter.init(): starting outbound bridges...");
    // Start vsock-to-TCP bridges for outbound provider traffic (Nitro only).
    // On local dev, this is a no-op — adapters use direct networking.
    this.cleanupBridges = await startOutboundBridges();
    console.log("[enclave] EnclaveRouter.init(): outbound bridges started.");

    // Load registry BEFORE keys so kms-client can cross-check the
    // blob's provider set against the registry's. Order matters:
    // PROVIDER_SET_MISMATCH is raised during fetchKeysFromKMS and
    // relies on the registry already being in memory.
    console.log("[enclave] EnclaveRouter.init(): loading provider registry...");
    await this.loadProviderRegistry();
    await this.loadSkillPrompts();
    await this.loadConnectorRegistry();
    console.log("[enclave] EnclaveRouter.init(): provider registry loaded.");

    console.log("[enclave] EnclaveRouter.init(): fetching keys from KMS...");
    const kms = await this.fetchKeysFromKMS();
    this.providerKeys = kms.providerKeys;
    this.mediaRootSecret = kms.mediaRootSecret;
    console.log(
      "[enclave] EnclaveRouter.init(): keys fetched successfully. Providers loaded:",
      Object.keys(this.providerKeys),
    );

    // Initialize dream LLM transport using the loaded Anthropic key so the
    // dream handler doesn't fall back to the empty process.env.ANTHROPIC_API_KEY.
    // The dream transport is Anthropic-only; use the first available Anthropic provider's baseUrl.
    const anthropicKey = this.providerKeys["anthropic"];
    if (anthropicKey && !this.dreamLlmTransport) {
      const anthropicProvider = getAllProviders().find(
        (p) => p.id === "anthropic",
      );
      console.log(
        `[enclave] EnclaveRouter.init(): configuring Anthropic dream transport. Base URL: ${anthropicProvider?.baseUrl ?? "https://api.anthropic.com"}`,
      );
      this.dreamLlmTransport = new AnthropicLlmTransport({
        apiKey: anthropicKey,
        baseUrl: anthropicProvider?.baseUrl ?? "https://api.anthropic.com",
      });
    }

    // Construct the production orchestrator media gateway (image generation)
    // now that provider keys + the registry are loaded. Skip when a media was
    // injected (tests) or an agentLoopProcessorFactory is set (the test seam
    // resolves processors without the real registry, so the real adapters are
    // meaningless). Wiring this opens the fail-closed imageMediaExecutorWired
    // gate so a routable image model can actually deliver a saved file.
    if (!this.media && !this.agentLoopProcessorFactory) {
      this.media = this.buildProductionMedia();
      console.log(
        "[enclave] EnclaveRouter.init(): media gateway wired:",
        this.media?.imageAdapters
          ? Object.keys(this.media.imageAdapters)
          : "none (no image provider key)",
      );
      // Start the orphan/billing reconciler ONLY when a video adapter is wired
      // (image generation is synchronous and never leaves a hold to reconcile).
      this.startVideoReconciler();
    }

    // Spawn the long-running NSM helper daemon. No-op on local dev (no /dev/nsm).
    // This pays the python3 + cbor2 import cost ONCE, not per attestation.
    console.log("[enclave] EnclaveRouter.init(): starting NSM sidecar...");
    await initNsmSidecar();
    console.log("[enclave] EnclaveRouter.init(): NSM sidecar started.");
  }

  private cleanupBridges: (() => void) | null = null;

  private async loadProviderRegistry(): Promise<void> {
    // The registry JSON is NOT baked into the EIF. Production fetches it
    // from the host-side registry-broker sidecar over vsock at boot; the
    // enclave verifies the Ed25519 signature (signed offline) against the
    // baked verify-key before trusting any bytes. This decouples "add a
    // provider that uses an existing adapter" from "rotate PCR0 + KMS
    // policy + client measurements" — registry changes are a signed-JSON
    // swap on the host, no rebuild required.
    //
    // Dev / test: filesystem fallback to the bundled providers.json so the
    // enclave boots without a host sidecar running.
    const verifyKeyPath =
      process.env.REGISTRY_VERIFY_KEY_PATH ||
      resolve(
        import.meta.dirname ?? __dirname,
        "providers/registry-verify-key.pem",
      );

    let registryJson: string | null = null;

    // 1. Prefer REGISTRY_PATH (filesystem) when explicitly set — dev iteration.
    const overridePath = process.env.REGISTRY_PATH;
    if (overridePath && existsSync(overridePath)) {
      registryJson = readFileSync(overridePath, "utf-8");
    }

    // 2. Try the vsock broker (production path on real Nitro hardware).
    if (
      registryJson === null &&
      process.env.NODE_ENV !== "test" &&
      process.env.MOCK_KMS !== "true"
    ) {
      try {
        registryJson = await fetchRegistryFromBroker();
      } catch (err) {
        // In production this is FATAL: the bundled fallback below is
        // gated to test/MOCK_KMS boots (L4), so registryJson stays null
        // and the loud "Provider registry unavailable" throw fires.
        console.warn(
          `[enclave] registry-broker fetch failed: ${(err as Error).message}`,
        );
      }
    }

    // 3. Dev/test fallback: bundled registry shipped alongside the code.
    // L4 (error-handling audit): PRODUCTION must NOT take this path.
    // providers.json is not baked into the EIF today (Dockerfile.enclave
    // bakes only the verify key), but if it ever were, a registry-broker
    // outage would silently downgrade the enclave to a STALE bundled
    // provider set instead of failing loudly. Restrict the fallback to
    // test / MOCK_KMS (local-dev) boots — the same predicate that gates
    // the broker attempt above.
    const bundledFallbackAllowed =
      process.env.NODE_ENV === "test" || process.env.MOCK_KMS === "true";
    if (registryJson === null && bundledFallbackAllowed) {
      const bundledPath = resolve(
        import.meta.dirname ?? __dirname,
        "providers/providers.json",
      );
      if (existsSync(bundledPath)) {
        registryJson = readFileSync(bundledPath, "utf-8");
        console.warn("[enclave] Using bundled registry (development mode)");
      }
    }

    if (registryJson === null) {
      if (process.env.NODE_ENV === "test") {
        console.warn("[enclave] Registry loading skipped in test environment");
        return;
      }
      throw new Error(
        "Provider registry unavailable: no REGISTRY_PATH, no registry-broker reachable, no bundled dev fallback.",
      );
    }

    try {
      const registryData = JSON.parse(registryJson);
      const verifyKey = readFileSync(verifyKeyPath, "utf-8");
      initRegistry(registryData, verifyKey);
      this.providerDisplayNames = buildProviderDisplayNameMap(getAllProviders());
    } catch (err) {
      if (process.env.NODE_ENV === "test") {
        console.warn("[enclave] Registry loading skipped in test environment");
        this.providerDisplayNames = new Map();
        return;
      }
      throw new Error(
        `Failed to load provider registry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async loadSkillPrompts(): Promise<void> {
    // The skill-prompts bundle (persona system prompts) is NOT baked into the
    // EIF and is NOT in any client bundle. Production fetches it from the
    // host-side skills-broker over vsock at boot; the enclave verifies the
    // Ed25519 signature (signed offline, domain-separated from the provider
    // registry) against the baked verify key before composing any prompt. This
    // keeps the persona-prompt IP out of the measured image AND the apps while
    // remaining attested for integrity. Mirrors loadProviderRegistry.
    //
    // Dev / test: filesystem fallback to the bundled skill-prompts.json so the
    // enclave boots without a host sidecar running.
    const verifyKeyPath =
      process.env.SKILL_PROMPTS_VERIFY_KEY_PATH ||
      resolve(
        import.meta.dirname ?? __dirname,
        "skills/skill-prompts-verify-key.pem",
      );

    let bundleJson: string | null = null;

    // 1. Prefer SKILL_PROMPTS_PATH (filesystem) when explicitly set — dev.
    const overridePath = process.env.SKILL_PROMPTS_PATH;
    if (overridePath && existsSync(overridePath)) {
      bundleJson = readFileSync(overridePath, "utf-8");
    }

    // 2. Try the vsock broker (production path on real Nitro hardware).
    if (
      bundleJson === null &&
      process.env.NODE_ENV !== "test" &&
      process.env.MOCK_KMS !== "true"
    ) {
      try {
        bundleJson = await fetchSkillPromptsFromBroker();
      } catch (err) {
        // Production: FATAL. The bundled fallback below is gated to
        // test/MOCK_KMS, so bundleJson stays null and the loud throw fires —
        // never a silently-unprompted or stale-persona agent.
        console.warn(
          `[enclave] skills-broker fetch failed: ${(err as Error).message}`,
        );
      }
    }

    // 3. Dev/test fallback: bundled bundle shipped alongside the code.
    // PRODUCTION must NOT take this path (mirrors loadProviderRegistry L4).
    const bundledFallbackAllowed =
      process.env.NODE_ENV === "test" || process.env.MOCK_KMS === "true";
    if (bundleJson === null && bundledFallbackAllowed) {
      const bundledPath = resolve(
        import.meta.dirname ?? __dirname,
        "skills/skill-prompts.json",
      );
      if (existsSync(bundledPath)) {
        bundleJson = readFileSync(bundledPath, "utf-8");
        console.warn("[enclave] Using bundled skill-prompts (development mode)");
      }
    }

    if (bundleJson === null) {
      if (process.env.NODE_ENV === "test") {
        console.warn(
          "[enclave] Skill-prompts loading skipped in test environment",
        );
        return;
      }
      throw new Error(
        "Skill prompts unavailable: no SKILL_PROMPTS_PATH, no skills-broker reachable, no bundled dev fallback.",
      );
    }

    try {
      const bundleData = JSON.parse(bundleJson);
      const verifyKey = readFileSync(verifyKeyPath, "utf-8");
      const verified = loadAndVerifySkillPrompts(bundleData, verifyKey);
      this.skillPromptResolver = buildPromptResolver(verified);
    } catch (err) {
      if (process.env.NODE_ENV === "test") {
        console.warn(
          "[enclave] Skill-prompts loading skipped in test environment",
        );
        return;
      }
      throw new Error(
        `Failed to load skill prompts: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async loadConnectorRegistry(): Promise<boolean> {
    if (isConnectorRegistryLoaded()) return true;

    // The connector catalog JSON is NOT baked into the EIF. Production fetches
    // it from the host-side connectors-broker sidecar over vsock at boot; the
    // enclave verifies the Ed25519 signature (signed offline, domain-separated
    // from the provider registry and skill-prompts) against the baked verify
    // key before trusting any bytes. This decouples "add or update a connector
    // definition" from a PCR0 rotation. Mirrors loadProviderRegistry.
    //
    // Dev / test: filesystem fallback to the bundled connectors.json so the
    // enclave boots without a host sidecar running.
    const verifyKeyPath =
      process.env.CONNECTORS_VERIFY_KEY_PATH ||
      resolve(
        import.meta.dirname ?? __dirname,
        "connectors/connectors-verify-key.pem",
      );

    let catalogJson: string | null = null;

    // 1. Prefer CONNECTORS_PATH (filesystem) when explicitly set — dev iteration.
    const overridePath = process.env.CONNECTORS_PATH;
    if (overridePath && existsSync(overridePath)) {
      catalogJson = readFileSync(overridePath, "utf-8");
    }

    // 2. Try the vsock broker (production path on real Nitro hardware).
    // The connectors-broker runs on vsock port 8106 (Phase-3 provisioning).
    if (
      catalogJson === null &&
      process.env.NODE_ENV !== "test" &&
      process.env.MOCK_KMS !== "true"
    ) {
      try {
        catalogJson = await fetchConnectorsFromBroker();
      } catch (err) {
        // In production this is FATAL: the bundled fallback below is
        // gated to test/MOCK_KMS boots, so catalogJson stays null
        // and the loud "Connector catalog unavailable" throw fires.
        console.warn(
          `[enclave] connectors-broker fetch failed: ${(err as Error).message}`,
        );
      }
    }

    // 3. Dev/test fallback: bundled catalog shipped alongside the code.
    // PRODUCTION must NOT take this path (mirrors loadProviderRegistry L4).
    const bundledFallbackAllowed =
      process.env.NODE_ENV === "test" || process.env.MOCK_KMS === "true";
    if (catalogJson === null && bundledFallbackAllowed) {
      const bundledPath = resolve(
        import.meta.dirname ?? __dirname,
        "connectors/connectors.json",
      );
      if (existsSync(bundledPath)) {
        catalogJson = readFileSync(bundledPath, "utf-8");
        console.warn("[enclave] Using bundled connector catalog (development mode)");
      }
    }

    if (catalogJson === null) {
      // ABSENT catalog (no CONNECTORS_PATH, broker unreachable/unprovisioned, no
      // dev fallback) is NON-FATAL: connectors are an ADDITIVE capability, not a
      // core dependency like the provider registry / skill prompts. Leaving the
      // registry UNLOADED makes connector.* reject CONNECTOR_CATALOG_NOT_LOADED at
      // dispatch (the documented fail-closed path) while the rest of the enclave
      // boots normally — so a PCR0 rotation carrying this measured code does NOT
      // brick boot before the Phase-3 connectors-broker (vsock:8106) is
      // provisioned. (A PRESENT-but-INVALID catalog — bad signature / rolled-back
      // version / parse error — stays FATAL in the verify step below: that is a
      // tamper signal, not an absent feature.)
      console.warn(
        "[enclave] Connector catalog unavailable (no CONNECTORS_PATH, no connectors-broker, no bundled fallback) — connectors DISABLED; connector.* will reject CONNECTOR_CATALOG_NOT_LOADED.",
      );
      return false;
    }

    try {
      const catalogData = JSON.parse(catalogJson);
      const verifyKey = readFileSync(verifyKeyPath, "utf-8");
      initConnectorRegistry(catalogData, verifyKey);
      return true;
    } catch (err) {
      if (process.env.NODE_ENV === "test") {
        console.warn("[enclave] Connector catalog loading skipped in test environment");
        return false;
      }
      throw new Error(
        `Failed to load connector catalog: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async ensureConnectorRegistryLoaded(): Promise<boolean> {
    if (isConnectorRegistryLoaded()) return true;
    if (!this.connectorRegistryLoadPromise) {
      this.connectorRegistryLoadPromise = this.loadConnectorRegistry()
        .catch((err) => {
          console.warn(
            `[enclave] Connector catalog retry failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return false;
        })
        .finally(() => {
          this.connectorRegistryLoadPromise = null;
        });
    }
    return this.connectorRegistryLoadPromise;
  }

  private async fetchKeysFromKMS(): Promise<AttestedKmsResult> {
    // Test / local dev: use env vars directly (no NSM hardware available).
    // MEDIA_ROOT_SECRET (optional) lets local dev exercise the stable derived
    // provenance key; absent ⇒ the ephemeral per-boot fallback.
    if (process.env.NODE_ENV === "test" || process.env.MOCK_KMS === "true") {
      return {
        providerKeys: {
          openai: process.env.OPENAI_API_KEY || "test-key",
          anthropic: process.env.ANTHROPIC_API_KEY || "test-key",
          google: process.env.GOOGLE_API_KEY || "test-key",
        },
        mediaRootSecret: process.env.MEDIA_ROOT_SECRET ?? null,
      };
    }

    // Production: attested KMS delivery via vsock proxy on parent EC2 instance.
    // The KMS key policy is conditioned on this enclave's PCR0 measurement —
    // only a genuine, unmodified enclave can decrypt the provider API keys.
    // Pass the registry provider IDs so kms-client can cross-check the
    // blob's provider set against what the registry actually declares.
    const registryProviderIds = new Set(getAllProviders().map((p) => p.id));
    return fetchKeysViaAttestedKMS(registryProviderIds);
  }

  // L1: `connectionSignal` is the per-connection abort owned by
  // parseFrames; it fires when the peer socket closes so long-running
  // handlers (chat/agent provider streams) stop doing work for a
  // connection that can no longer receive the result.
  async *handleMessage(
    raw: Buffer,
    connectionSignal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    const { type, payload } = decodeFrame(raw);

    switch (type) {
      case MSG.HEALTH_PING:
        if (!isConnectorRegistryLoaded()) {
          await this.ensureConnectorRegistryLoaded();
        }
        yield encodeFrame(
          MSG.HEALTH_PONG,
          Buffer.from(
            JSON.stringify({
              status: "ok",
              uptime: Math.floor((Date.now() - this.bootTime) / 1000),
              // Objective, Phase-2-independent rotation-verify probe: report
              // whether the signed connector catalog loaded + its version. Both
              // are generic status values that name no connector/operation, so
              // this rides the same measured rotation without coupling the
              // measured code to any specific catalog content. When the
              // registry is unloaded (older enclave, or booted before the
              // connectors-broker is provisioned) these are false + null.
              connectorRegistryLoaded: isConnectorRegistryLoaded(),
              connectorCatalogVersion: getConnectorCatalogVersion(),
            }),
          ),
        );
        break;

      case MSG.ATTESTATION_REQUEST: {
        // M3: malformed JSON, a bad nonce, or an NSM failure must produce a
        // typed frame instead of throwing out to parseFrames (which would
        // destroy the whole connection and log the raw error to
        // host-visible stderr). Code-only payload per the H1 discipline.
        try {
          const req = JSON.parse(payload.toString());
          const nonce = Buffer.from(req.nonce, "base64");
          const result = await this.sessionManager.handleAttestation(
            new Uint8Array(nonce),
          );

          // Request real attestation document from NSM hardware when available.
          // The public key is included in the attestation document so the client
          // can verify the ECDH key was generated inside the enclave. The
          // media-provenance public key (when the media gateway is wired) is
          // published in user_data, binding it to the attested PCR0 so a client
          // can verify generated-image provenance against this enclave identity.
          const nsmResult = await getNSMAttestationDoc(
            nonce,
            Buffer.from(result.ephemeralPublicKey),
            this.provenancePublicKey
              ? buildProvenanceUserData(this.provenancePublicKey)
              : undefined,
          );

          yield encodeFrame(
            MSG.ATTESTATION_RESPONSE,
            Buffer.from(
              JSON.stringify({
                attestation_document: nsmResult.attestationDoc,
                enclave_measurement: nsmResult.pcrs.PCR0,
                ephemeral_public_key: Buffer.from(
                  result.ephemeralPublicKey,
                ).toString("base64"),
                tee_type: "nitro",
                nonce: req.nonce,
                timestamp: result.timestamp,
                pcrs: nsmResult.pcrs,
              }),
            ),
          );
        } catch (err) {
          logRedactedHandlerError("ATTESTATION_REQUEST", err);
          yield encodeFrame(
            MSG.CHAT_ERROR,
            Buffer.from(
              JSON.stringify({
                error_code: "ATTESTATION_FAILED",
                message: "ATTESTATION_FAILED",
              }),
            ),
          );
        }
        break;
      }

      case MSG.KEY_EXCHANGE: {
        // M3: same typed-frame discipline as ATTESTATION_REQUEST. The
        // legitimate "no attestation keypair for this TEE public key"
        // case (expired keypair — the client retries with a fresh
        // attestation) lands here too and must not kill the connection.
        try {
          const req = JSON.parse(payload.toString());
          const ack = await this.sessionManager.handleKeyExchange(
            new Uint8Array(
              Buffer.from(req.client_ephemeral_public_key, "base64"),
            ),
            req.session_id,
            new Uint8Array(
              Buffer.from(req.client_key_exchange_nonce, "base64"),
            ),
            req.tee_public_key,
          );
          yield encodeFrame(
            MSG.KEY_EXCHANGE_ACK,
            Buffer.from(
              JSON.stringify({
                session_id: ack.sessionId,
                status: "ok",
                tee_key_exchange_nonce: Buffer.from(
                  ack.teeKeyExchangeNonce,
                ).toString("base64"),
                signingPublicKey: Buffer.from(ack.signingPublicKey).toString(
                  "base64",
                ),
              }),
            ),
          );
        } catch (err) {
          logRedactedHandlerError("KEY_EXCHANGE", err);
          yield encodeFrame(
            MSG.CHAT_ERROR,
            Buffer.from(
              JSON.stringify({
                error_code: "KEY_EXCHANGE_FAILED",
                message: "KEY_EXCHANGE_FAILED",
              }),
            ),
          );
        }
        break;
      }

      case MSG.DREAM_REQUEST: {
        console.log(
          "[enclave] DREAM_REQUEST: processing new session candidate",
        );
        let plaintext: Buffer | null = null;
        try {
          const req = JSON.parse(payload.toString());
          const sessionId = req.session_id;
          const sessionKey = await this.sessionManager.getSessionKey(sessionId);
          plaintext = await decryptChunk(
            sessionKey,
            Buffer.from(req.ciphertext, "base64"),
          );
          // H1: JSON.parse SyntaxErrors embed a source snippet of the
          // DECRYPTED body — throw a typed, code-only error instead.
          let candidate: DreamCandidate;
          try {
            candidate = JSON.parse(plaintext.toString()) as DreamCandidate;
          } catch {
            throw new Error(
              "DREAM_REQUEST_INVALID_PAYLOAD: decrypted body is not valid JSON",
            );
          }

          console.log("[enclave] DREAM_REQUEST: running dream session...");
          // PII de-identification for the dream candidate is performed
          // ON-DEVICE by the client (apps/{web,mobile}/lib/dream/dream-client.ts
          // → maskDreamConversationOnDevice, which reuses the agent masker).
          // The enclave no longer runs a Presidio masking pass: durable
          // memories carry only the client's masked tokens, and no rehydration
          // map is stored. See docs/legal/DPIA.md §masking + CLAUDE.md
          // privacy invariants ("PII masking is on-device only").
          const output = await runDreamSession({
            candidate,
            llmTransport: this.dreamLlmTransport,
          });
          await this.sessionManager.storeUnsignedEnvelopes(
            sessionId,
            output.dreamSessionId,
            output.deltas.map((delta) => [
              delta.deltaIndex,
              buildUnsignedEnvelope(candidate, sessionId, delta),
            ]),
          );
          const encrypted = await encryptChunk(
            sessionKey,
            Buffer.from(JSON.stringify(output)),
          );
          yield encodeFrame(MSG.DREAM_CHUNK, encrypted);
        } catch (err) {
          logRedactedHandlerError("DREAM_REQUEST", err);
          yield encodeFrame(
            MSG.DREAM_ERROR,
            wireErrorPayload(err, "DREAM_REQUEST_FAILED"),
          );
        } finally {
          if (plaintext) zeroBuffer(plaintext);
        }
        break;
      }

      case MSG.DREAM_FINALISE: {
        let plaintext: Buffer | null = null;
        try {
          const req = JSON.parse(payload.toString());
          const sessionId = req.session_id;
          const sessionKey = await this.sessionManager.getSessionKey(sessionId);
          plaintext = await decryptChunk(
            sessionKey,
            Buffer.from(req.ciphertext, "base64"),
          );
          // H1: typed, code-only error instead of a SyntaxError that embeds
          // a snippet of the decrypted body.
          let finaliseReq: {
            dreamSessionId: string;
            items: Array<{
              deltaIndex: number;
              contentHash: string;
              recordSerialisedHash: string;
            }>;
          };
          try {
            finaliseReq = JSON.parse(plaintext.toString());
          } catch {
            throw new Error(
              "DREAM_FINALISE_INVALID_PAYLOAD: decrypted body is not valid JSON",
            );
          }
          const results = await this.sessionManager.finaliseDreamEnvelopes(
            sessionId,
            finaliseReq.dreamSessionId,
            finaliseReq.items,
          );
          const encrypted = await encryptChunk(
            sessionKey,
            Buffer.from(JSON.stringify({ results })),
          );
          yield encodeFrame(MSG.DREAM_CHUNK, encrypted);
        } catch (err) {
          logRedactedHandlerError("DREAM_FINALISE", err);
          yield encodeFrame(
            MSG.DREAM_ERROR,
            wireErrorPayload(err, "DREAM_FINALISE_FAILED"),
          );
        } finally {
          if (plaintext) zeroBuffer(plaintext);
        }
        break;
      }

      case MSG.DREAM_DONE: {
        try {
          const req = JSON.parse(payload.toString()) as {
            session_id: string;
            dreamSessionId: string;
          };
          await this.sessionManager.clearDreamSession(
            req.session_id,
            req.dreamSessionId,
          );
          yield encodeFrame(
            MSG.DREAM_DONE,
            Buffer.from(JSON.stringify({ dreamSessionId: req.dreamSessionId })),
          );
        } catch (err) {
          logRedactedHandlerError("DREAM_DONE", err);
          yield encodeFrame(
            MSG.DREAM_ERROR,
            wireErrorPayload(err, "DREAM_DONE_FAILED"),
          );
        }
        break;
      }

      case MSG.CHAT_REQUEST: {
        let sessionId: string | null = null;
        let plaintext: Buffer | null = null;

        try {
          const req = JSON.parse(payload.toString());
          sessionId = req.session_id;
          const requestId =
            typeof req.requestId === "string"
              ? req.requestId
              : typeof req.request_id === "string"
                ? req.request_id
                : undefined;
          const modelSelection = readModelSelection(req.modelSelection);
          const sessionKey = await this.sessionManager.getSessionKey(
            req.session_id,
          );
          const ciphertext = Buffer.from(req.ciphertext, "base64");
          plaintext = await decryptChunk(sessionKey, ciphertext);
          const chatPayload = JSON.parse(plaintext.toString()) as Record<
            string,
            unknown
          > & {
            messages: {
              role: "user" | "assistant";
              content: string;
              attachments?: ChatImageAttachment[];
            }[];
            attachments?: ChatImageAttachment[];
            token_counter?: number;
            temperature?: number;
            max_tokens?: number;
            nativeWebSearch?: "auto" | "off";
            // Accepted-but-ignored: the client still sends a masking-strength
            // hint, but the enclave no longer masks (on-device only), so it is
            // never read. Kept in the schema to document the wire shape.
            privacyLevel?: "light" | "standard" | "strict";
            requestId?: string;
          };

          // Chunk I round-3 HIGH fix: strict decrypted-payload schema
          // on the enclave chat path. Previously the guard rejected
          // only exact `role === 'system'` (case-sensitive), so
          // mixed-case ('System', 'SYSTEM') or non-chat roles
          // ('developer', 'tool', 'function') slipped past — and
          // because the Google adapter maps any non-system/non-assistant
          // role to a user turn, raw unmasked content could still
          // reach the provider under the company key. Match the agent
          // path's strict schema: messages must be an array of non-null
          // objects, role MUST be exactly user/assistant
          // (case-normalised), content MUST be a string.
          if (!Array.isArray(chatPayload.messages)) {
            throw new Error(
              "CHAT_REQUEST_INVALID_MESSAGES: messages must be an array",
            );
          }
          for (let i = 0; i < chatPayload.messages.length; i += 1) {
            const m = chatPayload.messages[i] as {
              role?: unknown;
              content?: unknown;
              attachments?: unknown;
            } | null;
            if (!m || typeof m !== "object") {
              throw new Error(
                `CHAT_REQUEST_INVALID_MESSAGES: messages[${i}] must be a non-null object`,
              );
            }
            const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
            if (role !== "user" && role !== "assistant") {
              throw new Error(
                `CHAT_CLIENT_SYSTEM_ROLE_REJECTED: messages[${i}] has role=${JSON.stringify(m.role)}; only user/assistant are permitted on the chat path.`,
              );
            }
            if (typeof m.content !== "string") {
              throw new Error(
                `CHAT_REQUEST_INVALID_MESSAGES: messages[${i}].content must be a string`,
              );
            }
            // Per-message attachments are forbidden on the wire. The enclave
            // is the ONLY writer of message-level attachments (it copies the
            // validated top-level chatPayload.attachments onto the final user
            // message below), so a client-supplied `attachments` key here
            // would reach the provider adapters without the count/size/MIME
            // gates or the vision-capability gate — those run only on the
            // top-level field. Reject rather than strip, matching the
            // system-role guard above.
            if ("attachments" in m) {
              throw new Error(
                `CHAT_CLIENT_MESSAGE_ATTACHMENTS_REJECTED: messages[${i}] must not carry attachments; use the top-level attachments field.`,
              );
            }
            // Normalise the role to lowercase before downstream
            // consumers so masking + adapter logic only sees `user` or
            // `assistant`, never `User` / `ASSISTANT` etc.
            m.role = role;
          }

          const attachmentValidation = validateChatImageAttachments(
            chatPayload.attachments,
          );
          if (!attachmentValidation.ok) {
            throw new Error(
              `CHAT_ATTACHMENTS_INVALID: ${attachmentValidation.reason}`,
            );
          }
          if (
            chatPayload.attachments?.length &&
            chatPayload.messages[chatPayload.messages.length - 1]?.role !==
              "user"
          ) {
            throw new Error(
              "CHAT_ATTACHMENTS_INVALID: attachments must belong to the latest user message",
            );
          }

          // PII de-identification is performed ON-DEVICE by the client
          // before transmission (regex + ONNX NER tokenisation). The
          // enclave no longer runs a second Presidio pass over chat
          // content: it was over-masking benign text (filenames such as
          // `notes.md` → URL, `meeting-notes.txt` → PERSON, place names,
          // org names) which degraded answers without protecting anything
          // the client masker already handles. Content is forwarded to the
          // provider exactly as the client masked it; the client owns the
          // token map and rehydrates its own tokens in the response.
          // See docs/legal/DPIA.md §masking and CLAUDE.md privacy invariants.

          // Route to provider and stream encrypted chunks
          const { provider, model } = resolveProviderForChatPayload(
            chatPayload,
            modelSelection,
          );
          if (
            chatPayload.attachments?.length &&
            !modelCapabilitiesSupportVision(model.capabilities)
          ) {
            throw new Error(
              `CHAT_ATTACHMENTS_UNSUPPORTED: model ${model.id} does not support image input`,
            );
          }
          const modelId = model.id;
          console.log(
            `[enclave] CHAT_REQUEST: routing to providerId="${provider.id}", modelId="${modelId}"`,
          );
          const apiKey = this.providerKeys[provider.id];
          if (!apiKey) {
            console.error(
              `[enclave] CHAT_REQUEST error: key missing for providerId="${provider.id}"`,
            );
            throw new Error(`PROVIDER_KEY_MISSING: ${provider.id}`);
          }
          console.log(
            `[enclave] CHAT_REQUEST: adapter configured. Invoking streamChat...`,
          );
          const adapter = createProcessor(provider, apiKey);
          const nativeWebSearch = effectiveNativeWebSearchMode({
            requested: chatPayload.nativeWebSearch,
            capability: model.capabilities?.nativeWebSearch,
            allowedByServer: req.nativeWebSearchAllowed === true,
          });
          // Enclave-authored system instruction (the ONLY system prompt on the
          // chat path — client system messages are rejected upstream). It asks
          // the model to declare regulated topics via a leading control token so
          // the enclave can surface our disclaimer banner. Authored here inside
          // the TEE, never from the client, so the trust boundary is preserved.
          //
          // Kill switch: CALYPSO_DISABLE_CHAT_TOPIC_TAGGING=true skips the
          // injection entirely (no system prompt, no banner) so the behaviour
          // can be turned off at deploy time without a code change if a model
          // regresses. With it off the model emits no token; the parser below
          // simply resolves to "no token" on the first chunk and streams as-is.
          const topicTaggingEnabled =
            process.env.CALYPSO_DISABLE_CHAT_TOPIC_TAGGING !== "true";
          const chatMessages =
            chatPayload.attachments?.length && chatPayload.messages.length > 0
              ? chatPayload.messages.map((message, index) =>
                  index === chatPayload.messages.length - 1 &&
                  message.role === "user"
                    ? { ...message, attachments: chatPayload.attachments }
                    : message,
                )
              : chatPayload.messages;
          const messagesToSend: ChatMessage[] = topicTaggingEnabled
            ? [
                { role: "system", content: TOPIC_CONTROL_INSTRUCTION },
                ...chatMessages,
              ]
            : chatMessages;
          let stream;
          try {
            stream = adapter.streamChat(messagesToSend, {
              model: modelId,
              temperature: chatPayload.temperature,
              max_tokens: chatPayload.max_tokens,
              nativeWebSearch,
              // L1: cancel the provider stream if the host connection dies.
              signal: connectionSignal,
            });
            console.log(
              `[enclave] CHAT_REQUEST: streamChat returned stream object.`,
            );
          } catch (streamErr) {
            console.error(
              `[enclave] CHAT_REQUEST streamChat instantiation failed`,
            );
            throw streamErr;
          }

          let providerFinalResponse: ProviderResponseLike = {
            provider:
              provider.adapter === "anthropic_v1"
                ? "anthropic"
                : provider.adapter === "google_v1"
                  ? "google"
                  : "openai",
            model: modelId,
          };
          // Regulated-topic control token (model-tagged disclaimer). The model
          // is instructed to emit `[[topics:...]]` as its first line. We buffer
          // the leading text until the token resolves, STRIP it from the
          // user-visible stream, and emit a structured `disclaimer` signal the
          // client renders as a banner. If the model omits/mangles the token,
          // resolution falls back to "no topics" and the buffered text is
          // forwarded unchanged — the answer is never withheld or corrupted.
          //
          // When tagging is disabled (kill switch), start already-resolved so we
          // stream chunks verbatim with zero buffering — no token was requested,
          // so there is nothing to strip and no first-paint latency to pay.
          let controlResolved = !topicTaggingEnabled;
          let controlBuffer = "";
          // Native-web-search citation candidates carry provider offsets
          // (providerStartIndex/End, startIndex/End) computed against the FULL
          // provider text — which includes the `[[topics:...]]` token we strip.
          // Track how many provider chars we've removed so we can rebase those
          // offsets before forwarding; otherwise the client maps them against the
          // already-stripped text and drops/misplaces inline citations.
          let strippedProviderChars = 0;
          const rebaseCitations = (
            citations: readonly Record<string, unknown>[],
          ): Record<string, unknown>[] =>
            citations.map((citation) => {
              if (strippedProviderChars === 0) return citation;
              const out: Record<string, unknown> = { ...citation };
              for (const key of [
                "providerStartIndex",
                "providerEndIndex",
                "startIndex",
                "endIndex",
              ] as const) {
                if (typeof citation[key] === "number") {
                  out[key] = Math.max(
                    0,
                    (citation[key] as number) - strippedProviderChars,
                  );
                }
              }
              return out;
            });
          const emitDisclaimerSignal = async function* (
            topics: RegulatedTopic[],
          ) {
            if (topics.length === 0) return;
            const signal = await encryptChunk(
              sessionKey,
              Buffer.from(JSON.stringify({ _type: "disclaimer", topics })),
            );
            yield encodeFrame(MSG.CHAT_CHUNK, signal);
          };
          const emitContent = async function* (text: string, id: string) {
            if (text.length === 0) return;
            const contentChunk: ChatChunk = {
              id,
              choices: [{ delta: { content: text }, finish_reason: null }],
            };
            const enc = await encryptChunk(
              sessionKey,
              Buffer.from(JSON.stringify(contentChunk)),
            );
            yield encodeFrame(MSG.CHAT_CHUNK, enc);
          };

          while (true) {
            let next;
            try {
              next = await stream.next();
            } catch (streamErr) {
              console.error(
                `[enclave] CHAT_REQUEST stream error during stream.next()`,
              );
              throw streamErr;
            }
            if (next.done) {
              console.log(`[enclave] CHAT_REQUEST stream completed.`);
              if (isProviderResponseLike(next.value)) {
                providerFinalResponse = next.value;
              }
              break;
            }

            const chunk = next.value as ChatChunk;
            const delta = chunk?.choices?.[0]?.delta?.content;

            if (!controlResolved) {
              if (typeof delta === "string") controlBuffer += delta;
              // Forward any citations that somehow arrive during the (tiny)
              // buffering window without leaking the still-buffered text.
              if (chunk?.citations?.length) {
                const citationOnly: ChatChunk = {
                  id: chunk.id,
                  choices: [{ delta: {}, finish_reason: null }],
                  citations: rebaseCitations(
                    chunk.citations as unknown as Record<string, unknown>[],
                  ) as unknown as ChatChunk["citations"],
                };
                const enc = await encryptChunk(
                  sessionKey,
                  Buffer.from(JSON.stringify(citationOnly)),
                );
                yield encodeFrame(MSG.CHAT_CHUNK, enc);
              }
              const resolution = resolveTopicControl(controlBuffer);
              if (!resolution.done) {
                // Bounded-drain: stream out the safe preamble and keep only the
                // trailing partial-opener buffered, staying unresolved so a
                // token completing on a later chunk is still stripped.
                if (resolution.flush) {
                  yield* emitContent(resolution.flush, chunk?.id ?? "calypso");
                  controlBuffer = resolution.keep ?? "";
                }
                continue;
              }
              controlResolved = true;
              // Record the provider chars removed (token + trimmed whitespace)
              // so later citation offsets rebase correctly.
              strippedProviderChars += controlBuffer.length - resolution.rest.length;
              yield* emitDisclaimerSignal(resolution.topics);
              yield* emitContent(resolution.rest, chunk?.id ?? "calypso");
              continue;
            }

            const outChunk =
              chunk?.citations?.length && strippedProviderChars > 0
                ? {
                    ...chunk,
                    citations: rebaseCitations(
                      chunk.citations as unknown as Record<string, unknown>[],
                    ) as unknown as ChatChunk["citations"],
                  }
                : chunk;
            const chunkJson = Buffer.from(JSON.stringify(outChunk));
            const encrypted = await encryptChunk(sessionKey, chunkJson);
            yield encodeFrame(MSG.CHAT_CHUNK, encrypted);
          }

          // Stream ended while still buffering (e.g. the model emitted only a
          // partial token). Force-resolve so any partial opener is stripped
          // rather than forwarded verbatim — the token must never reach the user.
          if (!controlResolved && controlBuffer.length > 0) {
            const flushed = finalizeTopicControl(controlBuffer);
            yield* emitDisclaimerSignal(flushed.topics);
            yield* emitContent(flushed.rest, "calypso");
          }

          const usageRequestId =
            typeof requestId === "string" && requestId.length > 0
              ? requestId
              : typeof chatPayload.requestId === "string" &&
                  chatPayload.requestId.length > 0
                ? chatPayload.requestId
                : undefined;

          if (usageRequestId) {
            const usage = extractUsageFromProviderResponse(
              providerFinalResponse,
            );
            yield encodeFrame(
              MSG.USAGE_REPORT,
              encodeUsageReport({
                requestId: usageRequestId,
                routeKind: "chat",
                providerId: usage.providerId,
                model: usage.model,
                inputTokens: usage.inputTokens,
                cacheCreationInputTokens: usage.cacheCreationInputTokens,
                cachedInputTokens: usage.cachedInputTokens,
                inputTokensIncludeCachedTokens: usage.inputTokensIncludeCachedTokens,
                outputTokens: usage.outputTokens,
                providerUsagePresent: usage.providerUsagePresent,
              }),
            );
          }

          yield encodeFrame(
            MSG.CHAT_DONE,
            Buffer.from(JSON.stringify({ session_id: sessionId })),
          );
        } catch (err) {
          // M2: decrypt failures throw typed DECRYPT_FAILED (crypto.ts) and
          // session expiry throws SESSION_EXPIRED (session.ts) so neither is
          // misreported as PROVIDER_UNAVAILABLE. UNSUPPORTED / REJECTED cover
          // the deterministic payload gates (vision capability, system-role
          // and per-message-attachment rejection) so they map to the
          // non-retryable INVALID_PAYLOAD instead of falling through to the
          // retryable PROVIDER_UNAVAILABLE bucket.
          const errorCode =
            err instanceof Error && err.message.includes("MASKING_UNAVAILABLE")
              ? "MASKING_UNAVAILABLE"
              : err instanceof Error && err.message.includes("DECRYPT")
                ? "DECRYPT_FAILED"
                : err instanceof Error &&
                    err.message.includes("SESSION_EXPIRED")
                  ? "SESSION_EXPIRED"
                  : err instanceof Error &&
                      (err.message.includes("INVALID") ||
                        err.message.includes("UNSUPPORTED") ||
                        err.message.includes("REJECTED") ||
                        err.message.includes("CUSTOM_MODEL") ||
                        err.message.includes("MODEL_SELECTION"))
                    ? "INVALID_PAYLOAD"
                    : err instanceof Error &&
                        err.message.includes("PROVIDER_KEY_MISSING")
                      ? "PROVIDER_KEY_MISSING"
                      : "PROVIDER_UNAVAILABLE";

          yield encodeFrame(
            MSG.CHAT_ERROR,
            Buffer.from(
              JSON.stringify({
                error_code: errorCode,
                message: errorCode,
              }),
            ),
          );
        } finally {
          if (sessionId) await this.sessionManager.zeroSession(sessionId);
          if (plaintext) zeroBuffer(plaintext);
        }
        break;
      }

      case MSG.AGENT_REQUEST: {
        let sessionId: string | null = null;
        let agentTurnId: string | null = null;
        let plaintext: Buffer | null = null;
        try {
          const req = JSON.parse(payload.toString()) as {
            session_id: string;
            agent_turn_id: string;
            user_id?: string;
            // Chunk I — plaintext skill-pack id forwarded by the server
            // from the validated outer body. This is the AUTHORITATIVE
            // source for prompt assembly + tool scopes. Any client-
            // supplied inner skillPack is ignored for authority.
            active_skill_pack_id?: string;
            // Server-authored subscription metadata; never accepted from
            // the encrypted client body. Missing/unknown fails closed to
            // FREE for orchestrator admission.
            subscription_plan_id?: unknown;
            // Server-authoritative cross-pack grant envelope. Rides in
            // the PLAINTEXT outer envelope (trusted: server is the sole
            // vsock writer). The sensitive body rides in the ENCRYPTED
            // inner JSON (cross_pack_grant_body). See spec §4.2.1.
            cross_pack_grant?: unknown;
            ciphertext: string;
          };
          sessionId = req.session_id;
          agentTurnId = req.agent_turn_id;
          const subscriptionPlanId = readAgentSubscriptionPlanId(
            req.subscription_plan_id,
          );
          // R4 Finding 1 (Codex): the server route forwards the
          // authenticated userId in the OUTER envelope (plaintext to the
          // enclave but never to the LLM). memory.write stamps this
          // value into the signed envelope regardless of what the model
          // tries to supply.
          const authenticatedUserId =
            typeof req.user_id === "string" && req.user_id.length > 0
              ? req.user_id
              : "";

          // Chunk I round-1 CRITICAL fix — resolve the canonical skill
          // pack from the OUTER envelope id (server-validated against
          // the canonical registry + ban list). The client-supplied
          // inner skillPack is NOT trusted for prompt content or tool
          // scopes; a hostile client cannot ship outer
          // `personal-agent.default` while smuggling a custom inner
          // systemPromptBlock / toolScopes. Defense in depth: also
          // reject banned ids in case the server guard ever regresses.
          const outerPackId =
            typeof req.active_skill_pack_id === "string"
              ? req.active_skill_pack_id
              : DEFAULT_PACK_ID;
          if ((BANNED_PACK_IDS as readonly string[]).includes(outerPackId)) {
            throw new Error(
              `BANNED_SKILL_PACK_ID: ${outerPackId} is not available at MVP`,
            );
          }
          if (!isKnownSkillPackId(outerPackId)) {
            throw new Error(
              `UNKNOWN_SKILL_PACK_ID: ${outerPackId} is not in the canonical registry`,
            );
          }
          // FREE-tier agent turns get a narrowed "taste" tool set: read/reason
          // over the user's own files + memory and draft/write artifacts, but
          // NO web.fetch (egress cost/abuse + the read->egress exfil vector) and
          // NO media pipeline (unpriced compute). web.fetch, media, and the
          // orchestrator are the paid upgrades. Narrowing the pack here is the
          // single authoritative gate — the model's advertised tools and the
          // gateway's per-dispatch enforcement both read pack.toolScopes.
          const resolvedPack: SkillPack = getEffectiveSkillPack(
            outerPackId,
            this.skillPromptResolver ?? undefined,
          );
          const pack: SkillPack = scopePackToPlan(
            resolvedPack,
            subscriptionPlanId,
          );

          const sessionKey = await this.sessionManager.getSessionKey(sessionId);
          const ciphertext = Buffer.from(req.ciphertext, "base64");
          plaintext = await decryptChunk(sessionKey, ciphertext);
          // H1: JSON.parse SyntaxErrors embed a source snippet of the
          // DECRYPTED client body — throw a typed, code-only error instead.
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(plaintext.toString());
          } catch {
            throw new Error(
              "AGENT_REQUEST_INVALID_PAYLOAD: decrypted body is not valid JSON",
            );
          }
          const body = parsedBody as {
            messages: Array<{ role: "user" | "assistant"; content: string }>;
            model: string;
            runMode?: unknown;
            orchestrator?: unknown;
            linkedFolders?: unknown;
            writePermissionMode?: unknown;
            // Per-request connector connection set + ledger-only mode echoes +
            // owner per-turn budget override (spec §6/§7.3). MODE-FREE admission
            // input; the schema validates/bounds them (AgentRequestContextSchema).
            // Absent for old clients ⇒ defaults to [] / undefined (back-compat).
            connectedConnectors?: unknown;
            connectorModeEchoes?: unknown;
            connectorTurnBudgetOverride?: unknown;
            localTime?: unknown;
            // Inner skillPack is retained on the wire for back-compat
            // with older clients but the enclave IGNORES its prompt
            // content + scopes. If present, its `id` must match the
            // outer authoritative id — otherwise we fail closed.
            skillPack?: unknown;
            // Sensitive grant body: namespace list + folder/doc ids +
            // nonce. Rides ONLY in the encrypted inner body (never the
            // outer plaintext). Verified against the outer envelope's
            // commit before any namespace widening. See spec §4.2.1.
            cross_pack_grant_body?: unknown;
          };

          // Chunk I round-2 CRITICAL fix: reject decrypted system-role
          // messages on the agent path. The canonical system prompt is
          // assembled inside the enclave from the registry-resolved
          // pack (above). Any client-authored system message
          // smuggled into the encrypted body would be appended after
          // the canonical one — OpenAI accepts multi-system, Gemini
          // joins them — letting a hostile client steer prompt
          // authority despite the outer-id check. Fail closed before
          // runAgentLoop sees the message array.
          if (!Array.isArray(body.messages)) {
            throw new Error(
              "AGENT_REQUEST_INVALID_MESSAGES: messages must be an array",
            );
          }
          for (let i = 0; i < body.messages.length; i += 1) {
            const m = body.messages[i] as {
              role?: unknown;
              content?: unknown;
            } | null;
            if (!m || typeof m !== "object") {
              throw new Error(
                `AGENT_REQUEST_INVALID_MESSAGES: messages[${i}] must be a non-null object`,
              );
            }
            const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
            if (role !== "user" && role !== "assistant") {
              // H1: the rejected role VALUE is decrypted client content —
              // keep the thrown message static (index only).
              throw new Error(
                `AGENT_CLIENT_SYSTEM_ROLE_REJECTED: messages[${i}] role is not user/assistant; system prompts are authored by the enclave from the canonical skill pack.`,
              );
            }
            if (typeof m.content !== "string") {
              throw new Error(
                `AGENT_REQUEST_INVALID_MESSAGES: messages[${i}].content must be a string`,
              );
            }
            // Chunk I round-4 fix: write the lowercase role back to the
            // message so downstream consumers see only `user`/`assistant`,
            // never mixed-case. Without this, `{ role: 'User', ... }` would
            // pass validation (case-normalised) but the Google adapter,
            // reading the ORIGINAL `m.role`, could still treat it as a
            // provider user turn.
            m.role = role;
          }

          if (body.skillPack !== undefined && body.skillPack !== null) {
            const innerParsed = SkillPackSchema.safeParse(body.skillPack);
            if (innerParsed.success) {
              if (innerParsed.data.id !== outerPackId) {
                throw new Error(
                  `SKILL_PACK_OUTER_INNER_MISMATCH: outer=${outerPackId}, inner=${innerParsed.data.id}`,
                );
              }
              // Inner shape is well-formed; ignore its prompt + scopes
              // — the canonical pack resolved above is the source of
              // truth. Keep going.
            } else {
              // A malformed inner pack from an old client is not a
              // hard failure — we already have the canonical pack
              // from the outer id. Surface a soft log only.
              if (typeof console !== "undefined") {
                console.warn(
                  "AGENT_REQUEST_INNER_SKILL_PACK_MALFORMED",
                  innerParsed.error.issues,
                );
              }
            }
          }

          const requestContext = AgentRequestContextSchema.parse({
            linkedFolders: body.linkedFolders,
            writePermissionMode: body.writePermissionMode,
            // Connector request context (spec §6/§7.3). The schema bounds the
            // count (.max(MAX_AGENT_CONNECTORS)), strips any token/mode from the
            // mode-free admission entries, and validates the budget override; an
            // absent field defaults to [] / undefined so old clients are
            // unaffected. connectorModeEchoes feed ONLY the ledger (S5).
            connectedConnectors: body.connectedConnectors,
            connectorModeEchoes: body.connectorModeEchoes,
            connectorTurnBudgetOverride: body.connectorTurnBudgetOverride,
            localTime: body.localTime,
          });
          if (requestContext.connectedConnectors.length > 0) {
            await this.ensureConnectorRegistryLoaded();
          }
          const runMode =
            body.runMode === "orchestrator" ? "orchestrator" : "single";
          // Claims pack is orchestrator-only: it crosses namespace
          // boundaries and the isolation model relies on subtask-level
          // egress locking (strictEgressLock is NOT set for orchestrator).
          // Single-mode runs a merged read+egress context — allowing them
          // would open the read→egress exfil vector for cross-namespace
          // data. Reject before the plan gate so the error is deterministic
          // regardless of plan / quota state.
          if (pack.id === CLAIMS_PACK_ID && runMode === "single") {
            yield encodeFrame(
              MSG.CHAT_ERROR,
              Buffer.from(
                JSON.stringify({
                  error_code: "CLAIMS_REQUIRES_ORCHESTRATOR",
                  message: "The claims advocate runs only in orchestrator mode",
                }),
              ),
            );
            return;
          }
          const nestedOrchestrator =
            typeof body.orchestrator === "object" && body.orchestrator !== null
              ? body.orchestrator
              : {};
          const orchestratorContext = OrchestratorRequestContextSchema.parse({
            ...nestedOrchestrator,
            runMode,
            preferredModelId:
              typeof body.model === "string" && body.model.length > 0
                ? body.model
                : undefined,
          });
          if (
            orchestratorContext.runMode === "orchestrator" &&
            subscriptionPlanId === "FREE"
          ) {
            yield encodeFrame(
              MSG.CHAT_ERROR,
              Buffer.from(
                JSON.stringify({
                  error_code: "ORCHESTRATOR_REQUIRES_PAID_PLAN",
                  message: "Encrypted orchestrator turns require PRO or MAX",
                }),
              ),
            );
            return;
          }

          // Cross-pack grant: server-authoritative envelope rides in the OUTER
          // plaintext (trusted: server is the sole vsock writer); the sensitive
          // body rides in the ENCRYPTED inner JSON. resolveCrossPackGrant
          // re-verifies the commitment binding the two, applies purpose binding
          // + the healthVerified drop, and fails closed. See spec §4.2.1.
          //
          // Fail LOUD when a grant envelope is present but unparseable: a
          // tampered or corrupt envelope must never silently downgrade to the
          // no-grant (single-namespace) path. If no grant is present at all
          // (undefined/null), proceed normally — no grant is the common case.
          let grantEnvelope: CrossPackGrantEnvelope | undefined;
          if (req.cross_pack_grant !== undefined && req.cross_pack_grant !== null) {
            const r = CrossPackGrantEnvelopeSchema.safeParse(req.cross_pack_grant);
            if (!r.success) {
              yield encodeFrame(
                MSG.CHAT_ERROR,
                Buffer.from(
                  JSON.stringify({
                    error_code: "GRANT_ENVELOPE_INVALID",
                    message: "Cross-pack grant envelope rejected",
                  }),
                ),
              );
              return;
            }
            grantEnvelope = r.data;
          }
          const grantBody = (() => {
            const raw = body.cross_pack_grant_body;
            const r = CrossPackGrantBodySchema.safeParse(raw);
            return r.success ? r.data : undefined;
          })();
          const resolvedGrant = resolveCrossPackGrant({
            pack,
            envelope: grantEnvelope,
            body: grantBody,
            now: Date.now(),
          });
          if (!resolvedGrant.ok) {
            yield encodeFrame(
              MSG.CHAT_ERROR,
              Buffer.from(
                JSON.stringify({
                  error_code: resolvedGrant.reason,
                  message: "Cross-pack grant rejected",
                }),
              ),
            );
            return;
          }

          const buildResolverPromise = (
            key: string,
            invocationId: string,
            initialTimeoutMs: number = this.invocationTimeoutMs,
          ): Promise<ToolResultFrame> => {
            return new Promise<ToolResultFrame>((resolve) => {
              // A confirmation-gated write (folder.write) legitimately waits on
              // a human for longer than the chunk-round-trip default, so the
              // absolute cap must clear its initial window too.
              const absoluteInvocationDeadline =
                Date.now() +
                Math.max(this.invocationTimeoutMs * 10, initialTimeoutMs);
              let settled = false;
              let timer: ReturnType<typeof setTimeout>;

              const resolveWithTimeout = () => {
                if (settled) return;
                settled = true;
                this.outstandingInvocations.delete(key);
                this.invocationTimeoutRefreshers.delete(key);
                resolve({
                  invocationId,
                  outcome: "error",
                  reason: "INVOCATION_TIMEOUT",
                });
              };

              const armTimeout = (delayMs: number) => {
                timer = setTimeout(resolveWithTimeout, delayMs);
              };

              armTimeout(initialTimeoutMs);
              // Refresher: clear + rearm the timer. Called by the
              // chunked TOOL_RESULT handler each time a chunk lands so
              // a slow-but-progressing client doesn't trip the
              // invocation timeout mid-upload, while the absolute
              // deadline still caps total resolver lifetime.
              this.invocationTimeoutRefreshers.set(key, () => {
                clearTimeout(timer);
                const remainingMs = absoluteInvocationDeadline - Date.now();
                if (remainingMs <= 0) {
                  resolveWithTimeout();
                  return;
                }
                armTimeout(Math.min(this.invocationTimeoutMs, remainingMs));
              });
              this.outstandingInvocations.set(key, (resolvedFrame) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.invocationTimeoutRefreshers.delete(key);
                resolve(resolvedFrame);
              });
            });
          };

          const buildBinaryWriteAckPromise = (
            key: string,
            invocationId: string,
          ): Promise<ToolResultFrame> => {
            return new Promise<ToolResultFrame>((resolve) => {
              const timer = setTimeout(() => {
                this.pendingBinaryWriteAckResolvers.delete(key);
                resolve({
                  invocationId,
                  outcome: "error",
                  reason: "BINARY_WRITE_ACK_TIMEOUT",
                  resultJson: {
                    status: "error",
                    reason: "BINARY_WRITE_ACK_TIMEOUT",
                  },
                });
              }, DEFAULT_BINARY_WRITE_ACK_TIMEOUT_MS);
              this.pendingBinaryWriteAckResolvers.set(key, (resolvedFrame) => {
                clearTimeout(timer);
                this.pendingBinaryWriteAckResolvers.delete(key);
                resolve(resolvedFrame);
              });
            });
          };

          const buildMemoryWriteAckPromise = (
            key: string,
          ): Promise<MemoryWriteAckResult> => {
            return new Promise<MemoryWriteAckResult>((resolve) => {
              const timer = setTimeout(() => {
                this.pendingMemoryWriteAckResolvers.delete(key);
                // Bounded wait: a client that never durably persists +
                // ACKs must not hang the turn. Reinjects an honest
                // failure so the model reports truthfully.
                resolve({
                  outcome: "error",
                  reason: "MEMORY_WRITE_ACK_TIMEOUT",
                });
              }, MEMORY_WRITE_ACK_TIMEOUT_MS);
              this.pendingMemoryWriteAckResolvers.set(key, (result) => {
                clearTimeout(timer);
                this.pendingMemoryWriteAckResolvers.delete(key);
                resolve(result);
              });
            });
          };

          // Layer-3 research-query approval (Phase 3). Build the resolver
          // promise that approveQuery hands back: register the resolver in
          // pendingResearchApprovalResolvers under `approvalId` BEFORE the
          // RESEARCH_QUERY_APPROVAL frame is pushed, then await the client's
          // RESEARCH_QUERY_APPROVAL_RESULT (or a fail-closed `false` timeout
          // mirroring the per-invocation timeout). The user is approving the
          // EXACT compiled outbound query mid-turn.
          const buildApprovalResolverPromise = (
            approvalId: string,
          ): Promise<boolean> => {
            return new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => {
                // Fail closed: no decision in time → decline. No outbound
                // research query proceeds without an explicit user approval.
                this.pendingResearchApprovalResolvers.delete(approvalId);
                resolve(false);
              }, this.invocationTimeoutMs);
              this.pendingResearchApprovalResolvers.set(
                approvalId,
                (approved: boolean) => {
                  clearTimeout(timer);
                  this.pendingResearchApprovalResolvers.delete(approvalId);
                  resolve(approved);
                },
              );
            });
          };

          // Egress-promotion resolver (finding 11). Mirrors the research-approval
          // resolver, but the decision is the set of approved candidate ids
          // (default DENY = empty on timeout). No private datum crosses the
          // egress boundary without an explicit approved id.
          const buildEgressPromotionResolverPromise = (
            promotionId: string,
          ): Promise<{ approvedIds: string[] }> => {
            return new Promise<{ approvedIds: string[] }>((resolve) => {
              const timer = setTimeout(() => {
                this.pendingEgressPromotionResolvers.delete(promotionId);
                resolve({ approvedIds: [] }); // fail-closed: deny
              }, this.invocationTimeoutMs);
              this.pendingEgressPromotionResolvers.set(
                promotionId,
                (approvedIds: string[]) => {
                  clearTimeout(timer);
                  this.pendingEgressPromotionResolvers.delete(promotionId);
                  resolve({ approvedIds });
                },
              );
            });
          };

          // Concurrent output queue (Phase 3 Layer-3 reverse-channel). BOTH the
          // orchestrator/agent-loop pump (below) AND clientBridge.approveQuery
          // feed frames here; the OUTER handler iterates this queue. This is
          // what lets a RESEARCH_QUERY_APPROVAL frame reach the client WHILE
          // the orchestrator is suspended inside gateway.dispatch(research.ask)
          // awaiting approveQuery — a direct `yield` from the for-await loop
          // could not, because that loop is parked awaiting an orchestrator
          // event that won't arrive until dispatch (hence approveQuery)
          // returns. See AsyncFrameQueue.
          const outQueue = new AsyncFrameQueue();

          const clientBridge: ClientBridge = {
            invokeClient: (frame: ToolInvocationFrame) => {
              // Triple-key resolver — Codex R2 finding #2.
              // Per-invocation timeout — Codex R4 finding #5.
              // R11 Finding A: pick up a PRE-REGISTERED resolver (set
              // up before the TOOL_INVOCATION wire frame was emitted)
              // so a fast client cannot win the race against
              // outstandingInvocations.set.
              const key = invocationKey(
                sessionId!,
                frame.agentTurnId,
                frame.invocationId,
              );
              const preRegistered = this.preRegisteredResolverPromises.get(key);
              if (preRegistered) {
                this.preRegisteredResolverPromises.delete(key);
                return preRegistered;
              }
              return buildResolverPromise(
                key,
                frame.invocationId,
                clientInvocationTimeoutMs(frame.toolName, {
                  invocationTimeoutMs: this.invocationTimeoutMs,
                  confirmationGatedWriteTimeoutMs:
                    DEFAULT_BINARY_WRITE_ACK_TIMEOUT_MS,
                }),
              );
            },
            // SELF-EMITTING invokeClient for an air-gapped research subagent's
            // sibling gateway. The plain `invokeClient` above relies on the main
            // orchestrator pump's `tool-invocation` case to EMIT the
            // TOOL_INVOCATION wire frame; it only awaits the (pre-registered)
            // resolver. But a sibling's web.fetch never reaches that pump — its
            // loop events are consumed privately by runResearchSubagent (the air
            // gap), and the pump is parked inside gateway.dispatch(research.ask)
            // awaiting approveQuery. So the plain path created a resolver no
            // frame ever satisfied → INVOCATION_TIMEOUT → zero sources → "no web
            // access". This variant fixes the suspended-pump problem the same
            // way approveQuery does: build + register the resolver, then push
            // the TOOL_INVOCATION frame onto outQueue itself. The client/server
            // reverse-channel routes the TOOL_RESULT back by (sessionId,
            // agentTurnId, invocationId) into outstandingInvocations exactly as
            // for a pump-emitted frame — no client/server change needed.
            invokeClientFromSibling: (frame: ToolInvocationFrame) => {
              // R11 Finding A (race-safety): register the resolver BEFORE the
              // wire frame goes out so a fast client cannot POST the
              // TOOL_RESULT before outstandingInvocations.set runs.
              // buildResolverPromise self-registers into outstandingInvocations
              // + invocationTimeoutRefreshers, so we do NOT double-register.
              const key = invocationKey(
                sessionId!,
                frame.agentTurnId,
                frame.invocationId,
              );
              // Air-gap defense-in-depth (Codex review M2): the sibling research
              // subagent dispatches each web.fetch under a FRESH invocationId, so
              // a key already in flight means a duplicate self-emit. Pushing a
              // second TOOL_INVOCATION would run the (non-idempotent) web.fetch
              // twice on the client while only the first TOOL_RESULT resolves —
              // a wasted/possibly-leaky egress. There is no path that does this
              // today; fail FAST + OBSERVABLY if a future caller ever forwards a
              // sibling event through both the pump and this self-emit.
              if (
                this.outstandingInvocations.has(key) ||
                this.preRegisteredResolverPromises.has(key)
              ) {
                throw new Error(
                  `SIBLING_INVOCATION_ALREADY_IN_FLIGHT:${frame.invocationId}`,
                );
              }
              const promise = buildResolverPromise(
                key,
                frame.invocationId,
                clientInvocationTimeoutMs(frame.toolName, {
                  invocationTimeoutMs: this.invocationTimeoutMs,
                  confirmationGatedWriteTimeoutMs:
                    DEFAULT_BINARY_WRITE_ACK_TIMEOUT_MS,
                }),
              );
              return encryptChunk(
                sessionKey,
                Buffer.from(JSON.stringify(frame)),
              ).then((encrypted) => {
                outQueue.push(encodeFrame(MSG.TOOL_INVOCATION, encrypted));
                return promise;
              });
            },
            // Layer 3: surface the EXACT compiled outbound query to the client
            // for mid-turn approval. Called from tier-research.run, which runs
            // inside gateway.dispatch(research.ask) while the orchestrator is
            // suspended — so the approval frame MUST go out via outQueue (not a
            // for-await yield). Fail-closed on timeout (decline).
            approveQuery: (req: { turnId: string; query: string }) => {
              this.researchApprovalCounter += 1;
              const approvalId = `${sessionId!}:${req.turnId}:${this.researchApprovalCounter}`;
              const promise = buildApprovalResolverPromise(approvalId);
              return encryptChunk(
                sessionKey,
                Buffer.from(
                  JSON.stringify({
                    approvalId,
                    turnId: req.turnId,
                    query: req.query,
                  }),
                ),
              ).then((encrypted) => {
                outQueue.push(
                  encodeFrame(MSG.RESEARCH_QUERY_APPROVAL, encrypted),
                );
                return promise;
              });
            },
          };

          // Inject the verified cross-pack grant. undefined when the resolved
          // scope is exactly the pack's default single-namespace with no folders
          // AND no documents (no widening on ANY dimension) so all existing
          // requests hit the identical code path in the gateway's tier-a/b/media
          // guards. documentIds is unread in Phase 1, but it is included here so
          // that "no widening" stays honest once per-document enforcement lands
          // (Phase 3) — a grant carrying documents must NOT collapse to the
          // legacy path.
          const injectedCrossPackGrant =
            resolvedGrant.namespaces.size === 1 &&
            resolvedGrant.namespaces.has(pack.defaultNamespace) &&
            resolvedGrant.folderIds.size === 0 &&
            resolvedGrant.documentIds.size === 0
              ? undefined
              : {
                  namespaces: resolvedGrant.namespaces,
                  folderIds: resolvedGrant.folderIds,
                  documentIds: resolvedGrant.documentIds,
                };
          // Phase 4: a CLAIMS run is exactly one that resolved a real cross-pack
          // grant (the grant widened scope beyond the pack's single default
          // namespace). Normal (non-claims) runs leave injectedCrossPackGrant
          // undefined and emit NO CLAIMS_SUMMARY frame.
          const isClaimsRun = injectedCrossPackGrant !== undefined;

          const gateway = new ToolGateway({
            clientBridge,
            binaryWorkItems: this.binaryWorkItems,
            mediaTools: this.mediaTools,
            sessionManager: this.sessionManager,
            userId: authenticatedUserId,
            sessionId: sessionId!,
            // Trusted {folderId, displayName} pairs for the folders bound to
            // this skill. Lets the Tier-A/B/media folder handlers canonicalise
            // a frame whose folder the model referenced by (masked) displayName
            // instead of the opaque folderId. The client independently
            // re-validates the binding, so this never widens access.
            linkedFolders: requestContext.linkedFolders,
            // Connector admission inputs (spec §5.2/§6). connectedConnectors is
            // MODE-FREE; connectorModeEchoes reach ONLY the ledger; the override
            // raises the per-turn caps. The gateway's connector.* dispatch reads
            // these from deps (structural S5 boundary enforced at the call site).
            connectedConnectors: requestContext.connectedConnectors,
            connectorModeEchoes: requestContext.connectorModeEchoes,
            connectorTurnBudgetOverride: requestContext.connectorTurnBudgetOverride,
            // Single-mode runs read tools and web.fetch in one model context,
            // so block egress after any private read (structural). Orchestrator
            // mode isolates them across subtasks and does NOT set this.
            strictEgressLock: runMode === "single",
            // FREE turns get a tight per-read plaintext budget so a low-cost
            // agent can't pull tens of MiB of file content into context — the
            // fan-out cap bounds call count, not bytes.
            readAggregateByteCap:
              subscriptionPlanId === "FREE"
                ? FREE_AGENT_READ_AGGREGATE_BYTES
                : undefined,
            crossPackGrant: injectedCrossPackGrant,
            // Research subagent provider factory (Task 2C.1). Reuses the same
            // provider resolution as the orchestrator workerProviderFactory, so
            // tests that inject agentLoopProcessorFactory get the injected provider
            // via createProcessorForModelId too.
            researchProviderFactory: (modelId: string) =>
              this.createProcessorForModelId(modelId),
          });

          // PII de-identification for the agent route is performed
          // ON-DEVICE by the client before transmission (same regex +
          // ONNX NER tokeniser the chat path uses), and CRUCIALLY the
          // client masker is precise enough to leave task-relevant tokens
          // (filenames such as `agent-proof-notes.md`, URLs the user asks
          // the agent to fetch) intact so the agent can still act on them.
          // The enclave's earlier Presidio second pass was removed because
          // it over-masked those tokens (`.md` → URL, `meeting-notes.txt`
          // → PERSON), stranding the agent ("I need the actual filename
          // for [URL_1]"). User messages and linked-folder names are
          // forwarded exactly as the client masked them; the client owns
          // the token map and rehydrates its own tokens in tool drafts and
          // assistant text. See docs/legal/DPIA.md §masking + CLAUDE.md.
          const maskedRequestContext = { requestContext };

          // Only filter by provider-key availability on the real-processor
          // path. When agentLoopProcessorFactory is injected (tests/dev), it
          // resolves processors without consulting providerKeys, so key
          // filtering would wrongly empty the catalog.
          const routableModels = getRoutableModelCapabilities(
            this.orchestratorModels,
            this.agentLoopProcessorFactory
              ? undefined
              : new Set(Object.keys(this.providerKeys)),
          );
          const chatRoutableModels = routableModels.filter(
            (model) => model.endpointFamily === "chat",
          );
          // Fail-closed image-generation gate (finding 10): only offer
          // image.generate/image.edit to the planner/agent when an image-output
          // model is actually routable (enabled + image endpoint family + its
          // required gateway tools scoped). Otherwise strip them from the
          // effective pack so the planner shapes no unroutable image subtask —
          // which used to dead-end in NO_MODEL_FOR_SUBTASK under a false
          // "CALYPSO DONE". Auto-re-enables the moment a routable image model
          // lands (e.g. the registry flip + adapter wiring below).
          // Truly fail-closed: an image model being "enabled" in the registry
          // is necessary but NOT sufficient — the production orchestrator media
          // gateway (imageAdapters + budget/provenance/encrypt deps) must also
          // be wired (this.media). Without it an offered image subtask would hit
          // MEDIA_EXECUTOR_UNAVAILABLE. Requiring BOTH lets the registry flip to
          // `enabled` land safely ahead of the media-gateway wiring: image gen
          // simply stays gated off until the gateway is present.
          const imageMediaExecutorWired =
            !!this.media?.imageAdapters &&
            Object.keys(this.media.imageAdapters).length > 0;
          const imageGenerationRoutable =
            imageMediaExecutorWired &&
            isImageGenerationRoutable(routableModels, pack.toolScopes);
          // Video generate: a wired video adapter + a routable enabled video
          // model (necessary AND sufficient — mirrors the image gate). Video
          // render: a wired render backend (the attested Remotion appliance);
          // until one is wired, video.render stays fail-closed (gated off) so the
          // planner never shapes an unrenderable composition subtask.
          // A video provider is usable only if its adapter is wired AND it has
          // not been runtime-disabled by the reconciler (billing-metadata SLA
          // breach). With every video provider disabled, video generation gates
          // off (fail-closed) until an operator re-enables it.
          const videoMediaExecutorWired =
            !!this.media?.videoAdapters &&
            Object.keys(this.media.videoAdapters).some(
              (providerId) => !this.disabledVideoProviders.has(providerId),
            );
          const videoGenerateRoutable =
            videoMediaExecutorWired &&
            isVideoGenerationRoutable(routableModels, pack.toolScopes);
          const videoRenderRoutable = !!this.media?.renderBackend;
          const mediaToolStrip = computeMediaToolStripSet({
            imageGenerationRoutable,
            videoGenerateRoutable,
            videoRenderRoutable,
          });
          const effectivePack: SkillPack =
            mediaToolStrip.size === 0
              ? pack
              : {
                  ...pack,
                  toolScopes: pack.toolScopes.filter(
                    (tool) => !mediaToolStrip.has(tool),
                  ),
                };
          const enabledEndpointFamilies =
            getEnabledEndpointFamiliesForCanonicalPack(
              effectivePack,
              this.media,
              imageGenerationRoutable,
            );
          const plannerModelCandidates = choosePlannerModelIds(
            chatRoutableModels,
            orchestratorContext.preferredModelId,
          );
          const summaryModelCandidates =
            chooseSummaryModelIds(chatRoutableModels);

          // Enclave-authoritative model admission for the single-mode agent
          // path: FREE maps `auto`->low-cost and rejects costly models; paid
          // resolves `auto`. (Orchestrator routes per-subtask via the planner
          // candidates above and is unaffected.) Skipped when an
          // agentLoopProcessorFactory is injected (tests/dev): that seam
          // resolves processors WITHOUT the real registry, so admitting a model
          // against the routable catalog is meaningless — same reason the key
          // filter above is bypassed for the factory path.
          let singleModeAgentModel = body.model;
          if (
            orchestratorContext.runMode !== "orchestrator" &&
            !this.agentLoopProcessorFactory
          ) {
            const admission = admitAgentModel(
              body.model,
              subscriptionPlanId,
              chatRoutableModels,
            );
            if (!admission.ok) {
              yield encodeFrame(
                MSG.CHAT_ERROR,
                Buffer.from(
                  JSON.stringify({
                    error_code: admission.code,
                    message: admission.message,
                  }),
                ),
              );
              return;
            }
            singleModeAgentModel = admission.modelId;
          }

          const agentEventStream = orchestratorContext.retrievePendingMedia
            ? // Honest-user recovery: re-deliver the user's billed-but-undelivered
              // video(s) (delivery_pending checkpoints). This turn does NOT plan
              // or call a model — it re-polls the provider job(s) and re-delivers
              // over the same binary write-ACK pump below. Requires production
              // media + an authenticated user (the per-user checkpoint store);
              // otherwise there is nothing to retrieve, so end the turn cleanly.
              this.productionMediaWired &&
              this.media?.videoAdapters &&
              authenticatedUserId
              ? redeliverPendingMedia({
                  // 'list' = quiet on-mount probe (#1b): report how many pending
                  // jobs exist, no poll/deliver. true = deliver the asset(s).
                  mode:
                    orchestratorContext.retrievePendingMedia === "list"
                      ? "list"
                      : "deliver",
                  agentTurnId: agentTurnId!,
                  sessionId: sessionId!,
                  videoAdapters: this.media.videoAdapters,
                  binaryWorkItems: this.binaryWorkItems,
                  awaitBinaryWriteAck: (payload) => {
                    const key = invocationKey(
                      sessionId!,
                      payload.request.agentTurnId,
                      payload.request.invocationId,
                    );
                    return buildBinaryWriteAckPromise(
                      key,
                      payload.request.invocationId,
                    );
                  },
                  // The store client types listUserDeliveryPending optional (the
                  // shared media checkpoint type predates re-delivery); the real
                  // client always implements it.
                  checkpointClient: ((c) => ({
                    listUserDeliveryPending: c.listUserDeliveryPending!,
                    markTerminal: c.markTerminal,
                  }))(createVideoCheckpointClient({ userId: authenticatedUserId })),
                  encryptArtifact: this.media.encryptArtifact,
                  abortSignal: connectionSignal,
                })
              : (async function* emptyRetrieve() {
                  yield { kind: "done" as const };
                })()
            : orchestratorContext.runMode === "orchestrator"
              ? runOrchestrator({
                  gateway,
                  pack: effectivePack,
                  agentTurnId: agentTurnId!,
                  plannerProvider: this.createProcessorForModelId(
                    plannerModelCandidates[0] ??
                      orchestratorContext.preferredModelId,
                  ),
                  workerProviderFactory: (modelId) =>
                    this.createProcessorForModelId(modelId),
                  plannerModel:
                    plannerModelCandidates[0] ??
                    orchestratorContext.preferredModelId,
                  plannerModelCandidates,
                  summaryModel:
                    summaryModelCandidates[0] ??
                    chooseSummaryModelId(chatRoutableModels),
                  summaryModelCandidates,
                  providerDisplayNames: this.providerDisplayNames,
                  models: routableModels,
                  enabledGatewayTools: effectivePack.toolScopes,
                  enabledEndpointFamilies,
                  messages: body.messages,
                  requestContext: maskedRequestContext.requestContext,
                  // Keys the image-generate binary work item so its write ACK
                  // round-trips to the resolver registered below.
                  sessionId: sessionId!,
                  awaitBinaryWriteAck: (payload) => {
                    const key = invocationKey(
                      sessionId!,
                      payload.request.agentTurnId,
                      payload.request.invocationId,
                    );
                    return buildBinaryWriteAckPromise(
                      key,
                      payload.request.invocationId,
                    );
                  },
                  awaitMemoryWriteAck: (payload) => {
                    const key = invocationKey(
                      sessionId!,
                      payload.agentTurnId,
                      payload.invocationId,
                    );
                    // R12: hand back the resolver promise that was
                    // pre-registered when the `memory-write-signed` frame
                    // went out, so a fast client's ACK cannot race ahead
                    // of registration. Falls back to a fresh promise if
                    // (defensively) none was pre-registered.
                    const preRegistered =
                      this.preRegisteredMemoryWriteAckPromises.get(key);
                    if (preRegistered) {
                      this.preRegisteredMemoryWriteAckPromises.delete(key);
                      return preRegistered;
                    }
                    return buildMemoryWriteAckPromise(key);
                  },
                  // Consent-gated private-read → web egress bridge (finding 11).
                  // Emits an EGRESS_PROMOTION_REQUEST carrying the candidate
                  // datums and awaits the client's approved-id set (default DENY
                  // on timeout). Like approveQuery, the frame must travel via
                  // outQueue because the orchestrator is suspended awaiting it.
                  awaitEgressPromotion: (req) => {
                    this.egressPromotionCounter += 1;
                    const promotionId = `${sessionId!}:${req.agentTurnId}:egress:${this.egressPromotionCounter}`;
                    const promise =
                      buildEgressPromotionResolverPromise(promotionId);
                    return encryptChunk(
                      sessionKey,
                      Buffer.from(
                        JSON.stringify({
                          promotionId,
                          // turnId is REQUIRED by both client transports
                          // (handleEgressPromotion fails closed without it) so
                          // the client can address the result POST back to this
                          // turn — mirrors approveQuery's turnId. Omitting it
                          // left every promotion silently denying after a
                          // timeout stall (the modal never showed).
                          turnId: req.agentTurnId,
                          planId: req.planId,
                          subtaskId: req.subtaskId,
                          candidates: req.candidates,
                        }),
                      ),
                    ).then((encrypted) => {
                      outQueue.push(
                        encodeFrame(MSG.EGRESS_PROMOTION_REQUEST, encrypted),
                      );
                      return promise;
                    });
                  },
                  providerCallBudget:
                    ORCHESTRATOR_PROVIDER_CALL_BUDGET_BY_PLAN[subscriptionPlanId],
                  // Hard metering: bind the REAL per-user budget client to this
                  // request's authenticated userId/planId, overriding the
                  // fail-closed boot-time default. Only for the production
                  // gateway — injected test media keeps its own budgetClient.
                  media:
                    this.productionMediaWired && this.media && authenticatedUserId
                      ? {
                          ...this.media,
                          budgetClient: createMediaBudgetClient({
                            userId: authenticatedUserId,
                            planId: subscriptionPlanId,
                          }),
                          // Durable video checkpoint store, bound to this
                          // request's user. Image generation never touches it;
                          // video load/save/cancel/billing route to the durable
                          // server-backed store over the video-checkpoint broker.
                          checkpointClient: createVideoCheckpointClient({
                            userId: authenticatedUserId,
                          }),
                          // Provider-visible-input bundle for video_generate: the
                          // (on-device-masked) prompt is stored as a signed
                          // "public"-origin TEXT handle so it clears the same
                          // custody/provenance gate the media flow requires
                          // (media-executor ~L505). Request-scoped, built from the
                          // gateway's stable provenance signer.
                          ...(this.media.provenanceSigner
                            ? (() => {
                                const ctx = createVideoProviderInputContext({
                                  provenanceSigner: this.media.provenanceSigner,
                                  userId: authenticatedUserId,
                                });
                                return {
                                  handleStore: ctx.handleStore,
                                  consentVerifier: ctx.consentVerifier,
                                  resolveProviderInput: ctx.resolveProviderInput,
                                  resolveRecords: ctx.resolveRecords,
                                };
                              })()
                            : {}),
                        }
                      : this.media,
                  // L1: stop orchestration when the host connection dies.
                  abortSignal: connectionSignal,
                })
              : runAgentLoop(
                  {
                    gateway,
                    provider: this.agentLoopProcessorFactory
                      ? this.agentLoopProcessorFactory(singleModeAgentModel)
                      : this.resolveProductionProcessor(singleModeAgentModel),
                    pack: effectivePack,
                    agentTurnId: agentTurnId!,
                    // FREE single-mode turns get a tighter per-turn fan-out cap
                    // (vs the default 10) so "5 messages/day" can't expand into
                    // an unbounded number of tool calls + model round-trips.
                    maxToolCalls:
                      subscriptionPlanId === "FREE"
                        ? FREE_AGENT_MAX_TOOL_CALLS
                        : undefined,
                    requestContext: maskedRequestContext.requestContext,
                    subscriptionPlanId,
                    fullSkillToolScopes: resolvedPack.toolScopes,
                    awaitBinaryWriteAck: (payload) => {
                      const key = invocationKey(
                        sessionId!,
                        payload.request.agentTurnId,
                        payload.request.invocationId,
                      );
                      return buildBinaryWriteAckPromise(
                        key,
                        payload.request.invocationId,
                      );
                    },
                    awaitMemoryWriteAck: (payload) => {
                      const key = invocationKey(
                        sessionId!,
                        payload.agentTurnId,
                        payload.invocationId,
                      );
                      // R12: see the orchestrator branch above — return
                      // the resolver pre-registered at frame-emit time so
                      // a fast client's ACK can't race registration.
                      const preRegistered =
                        this.preRegisteredMemoryWriteAckPromises.get(key);
                      if (preRegistered) {
                        this.preRegisteredMemoryWriteAckPromises.delete(key);
                        return preRegistered;
                      }
                      return buildMemoryWriteAckPromise(key);
                    },
                    // L1: stop the loop when the host connection dies.
                    abortSignal: connectionSignal,
                  },
                  { messages: body.messages, model: singleModeAgentModel },
                );

          // Mechanism B: accumulate the turn's user-facing text so the
          // enclave can deterministically append the not-advice disclaimer for
          // the regulated legal/health packs if the model omitted it. Tracking
          // the last orchestrator-text scope lets the append ride the same
          // orchestrator_text channel the rest of the answer used.
          let emittedAgentText = "";
          let lastOrchestratorTextScope:
            | { planId: string; subtaskId: string }
            | null = null;
          let agentUsageReportCount = 0;

          // Phase 4 audit hardening: the CLAIMS_SUMMARY frame ({exercised
          // namespaces, fetched URLs}) must reach the client on EVERY terminal
          // exit of this loop — not only the clean `done` path it shipped with.
          // A claims run that read memory / issued web egress and THEN errored
          // or aborted would otherwise leave the client (the only party able to
          // read plaintext) with no audit receipt of a run that touched data —
          // permanently lost, since the server is blind to plaintext. The shared
          // flusher is invoked at all terminal points below (done, error, and
          // the pump-teardown backstop); it self-gates to claims runs and emits
          // AT MOST ONCE per run, sealing the payload under the session key with
          // the SAME encryptChunk every other agent frame uses (server-blind).
          // It only READS the live gateway getters — tracking is unchanged.
          const claimsSummaryFlusher = createClaimsSummaryFlusher({
            isClaimsRun,
            sessionKey,
            getExercisedNamespaces: () => gateway.getExercisedNamespaces(),
            getFetchedUrls: () => gateway.getFetchedUrls(),
            encryptChunk,
            pushFrame: (frame) => outQueue.push(frame),
          });

          // Phase 3 Layer-3 restructure: drain the orchestrator/agent-loop
          // generator into outQueue from a BACKGROUND pump instead of yielding
          // directly. Every prior `yield encodeFrame(...)` inside this loop is
          // now `outQueue.push(encodeFrame(...))`; nothing else in the loop
          // changed (resolver pre-registrations, emittedAgentText accounting,
          // and the encryption are all preserved verbatim). The OUTER handler
          // (below) consumes outQueue, which ALSO receives the
          // RESEARCH_QUERY_APPROVAL frame pushed by clientBridge.approveQuery
          // while this pump is suspended awaiting dispatch — that is the whole
          // point of the queue. On pump completion/error we close() the queue
          // in a finally so the outer for-await ends; the outer then `await`s
          // the pump to propagate any error.
          const pump = (async () => {
            try {
              for await (const item of agentEventStream) {
                switch (item.kind) {
              case "orchestrator-plan":
              case "orchestrator-progress":
              case "orchestrator-text":
              case "orchestrator-media-job-progress":
              case "orchestrator-artifact": {
                if (item.kind === "orchestrator-text") {
                  emittedAgentText += item.text;
                  lastOrchestratorTextScope = {
                    planId: item.planId,
                    subtaskId: item.subtaskId,
                  };
                }
                const encrypted = await encryptChunk(
                  sessionKey,
                  Buffer.from(JSON.stringify(toProgressChunk(item))),
                );
                outQueue.push(encodeFrame(MSG.CHAT_CHUNK, encrypted));
                break;
              }
              case "chunk": {
                emittedAgentText += item.text;
                const encrypted = await encryptChunk(
                  sessionKey,
                  Buffer.from(JSON.stringify({ text: item.text })),
                );
                outQueue.push(encodeFrame(MSG.CHAT_CHUNK, encrypted));
                break;
              }
              case "usage": {
                agentUsageReportCount += 1;
                const usage = extractUsageFromProviderResponse(item.response);
                outQueue.push(
                  encodeFrame(
                    MSG.USAGE_REPORT,
                    encodeUsageReport({
                      requestId: `${agentTurnId!}:usage:${agentUsageReportCount}`,
                      routeKind: item.routeKind,
                      providerId: usage.providerId,
                      model: usage.model,
                      inputTokens: usage.inputTokens,
                      cacheCreationInputTokens: usage.cacheCreationInputTokens,
                      cachedInputTokens: usage.cachedInputTokens,
                      inputTokensIncludeCachedTokens: usage.inputTokensIncludeCachedTokens,
                      outputTokens: usage.outputTokens,
                      providerUsagePresent: usage.providerUsagePresent,
                    }),
                  ),
                );
                break;
              }
              case "tool-invocation": {
                // R11 Finding A (Codex): register the resolver promise
                // BEFORE the wire frame goes out. Without this, a fast
                // client could POST /tool-result between the SSE
                // frame arriving and gateway.dispatch calling
                // invokeClient — the enclave would reject as
                // UNSOLICITED_TOOL_RESULT and the legitimate write
                // would be lost.
                const key = invocationKey(
                  sessionId!,
                  item.frame.agentTurnId,
                  item.frame.invocationId,
                );
                if (!this.preRegisteredResolverPromises.has(key)) {
                  this.preRegisteredResolverPromises.set(
                    key,
                    buildResolverPromise(
                      key,
                      item.frame.invocationId,
                      clientInvocationTimeoutMs(item.frame.toolName, {
                        invocationTimeoutMs: this.invocationTimeoutMs,
                        confirmationGatedWriteTimeoutMs:
                          DEFAULT_BINARY_WRITE_ACK_TIMEOUT_MS,
                      }),
                    ),
                  );
                }
                const encrypted = await encryptChunk(
                  sessionKey,
                  Buffer.from(
                    JSON.stringify({
                      ...item.frame,
                      ...("orchestrator" in item
                        ? { orchestrator: item.orchestrator }
                        : {}),
                    }),
                  ),
                );
                outQueue.push(encodeFrame(MSG.TOOL_INVOCATION, encrypted));
                break;
              }
              case "ledger": {
                // Ledger frames piggyback as encrypted CHAT_CHUNK with a
                // _type marker so the client can route them to the local
                // tool-call ledger without needing a new MSG constant.
                const encrypted = await encryptChunk(
                  sessionKey,
                  Buffer.from(
                    JSON.stringify({
                      _type: "ledger",
                      entry: item.entry,
                      ...("orchestrator" in item
                        ? { orchestrator: item.orchestrator }
                        : {}),
                    }),
                  ),
                );
                outQueue.push(encodeFrame(MSG.CHAT_CHUNK, encrypted));
                break;
              }
              case "memory-write-signed": {
                // R12: register the durable-persist ACK resolver BEFORE
                // the signed-envelope frame goes out — same race fix as
                // the `tool-invocation` case above. A client that POSTs
                // /tool-result-ack the instant it sees this chunk would
                // otherwise race ahead of the loop resuming past
                // `yield { kind: 'memory-write-signed' }` and calling
                // awaitMemoryWriteAck; the `_ack` handler would find no
                // pending resolver, drop the ack, and the loop would hang
                // until MEMORY_WRITE_ACK_TIMEOUT_MS while the model
                // re-issues the same memory.write to TOOL_LIMIT_EXCEEDED.
                const memoryAckKey = invocationKey(
                  sessionId!,
                  agentTurnId!,
                  item.invocationId,
                );
                if (
                  !this.preRegisteredMemoryWriteAckPromises.has(memoryAckKey)
                ) {
                  this.preRegisteredMemoryWriteAckPromises.set(
                    memoryAckKey,
                    buildMemoryWriteAckPromise(memoryAckKey),
                  );
                }
                // Codex finding #1: deliver signed envelope back to the
                // CLIENT (not the model). Client routes this to
                // saveMemory + posts /tool-result-ack. Piggybacks the
                // existing CHAT_CHUNK with a _type marker — same
                // pattern as the ledger event — so we don't burn a
                // new MSG constant.
                const encrypted = await encryptChunk(
                  sessionKey,
                  Buffer.from(
                    JSON.stringify({
                      _type: "memory_write_signed",
                      invocationId: item.invocationId,
                      signedEnvelope: item.signedEnvelope,
                      signature: item.signature,
                      signedBlobB64: item.signedBlobB64,
                      ...("orchestrator" in item
                        ? { orchestrator: item.orchestrator }
                        : {}),
                    }),
                  ),
                );
                outQueue.push(encodeFrame(MSG.CHAT_CHUNK, encrypted));
                break;
              }
              case "binary-write-request": {
                // D3: emit the write_request metadata frame followed by ONE
                // frame per chunk, instead of serializing the whole payload
                // (incl. every chunk) into a single frame that overflows the
                // 256 KB padded-frame cap for large artifacts (e.g. an 860 KB
                // WAV). Each chunk is already FRAME_SAFE_OUTPUT_CHUNK_BYTES.
                const wireFrames = buildBinaryWriteWireFrames(
                  item.payload,
                  "orchestrator" in item ? item.orchestrator : undefined,
                );
                for (const frame of wireFrames) {
                  const encrypted = await encryptChunk(
                    sessionKey,
                    Buffer.from(JSON.stringify(frame)),
                  );
                  outQueue.push(encodeFrame(MSG.CHAT_CHUNK, encrypted));
                }
                break;
              }
              case "done": {
                // Mechanism B: guarantee the not-advice disclaimer on the
                // regulated legal/health packs even if the model dropped it.
                const disclaimer = pendingDisclaimerSuffix(
                  pack.id,
                  emittedAgentText,
                );
                if (disclaimer) {
                  const disclaimerChunk = lastOrchestratorTextScope
                    ? {
                        _type: "orchestrator_text" as const,
                        planId: lastOrchestratorTextScope.planId,
                        subtaskId: lastOrchestratorTextScope.subtaskId,
                        role: "final_artifact" as const,
                        text: `\n\n${disclaimer}`,
                      }
                    : { text: `\n\n${disclaimer}` };
                  const encryptedDisclaimer = await encryptChunk(
                    sessionKey,
                    Buffer.from(JSON.stringify(disclaimerChunk)),
                  );
                  outQueue.push(
                    encodeFrame(MSG.CHAT_CHUNK, encryptedDisclaimer),
                  );
                }
                // Phase 4 claims audit summary on the clean-completion path:
                // flushed immediately BEFORE AGENT_DONE so the client receives
                // the exercised namespaces + fetched URLs before the done signal
                // closes the stream. The flusher self-gates to claims runs, emits
                // at most once, and seals the payload under the session key (the
                // helper now owns those invariants — see createClaimsSummaryFlusher).
                await claimsSummaryFlusher.flush();
                outQueue.push(
                  encodeFrame(
                    MSG.AGENT_DONE,
                    Buffer.from(
                      JSON.stringify({
                        session_id: sessionId,
                        agent_turn_id: agentTurnId,
                      }),
                    ),
                  ),
                );
                break;
              }
              case "error": {
                // Phase 4 audit: flush the claims summary BEFORE the error frame
                // so a claims run that read memory / issued egress and then hit
                // an error terminal still delivers its audit receipt ahead of the
                // failure. No-op for non-claims runs / if already flushed.
                await claimsSummaryFlusher.flush();
                outQueue.push(
                  encodeFrame(
                    MSG.CHAT_ERROR,
                    Buffer.from(
                      JSON.stringify({
                        error_code: item.reason,
                        message: item.reason,
                      }),
                    ),
                  ),
                );
                break;
              }
                }
              }
            } finally {
              // Phase 4 audit BACKSTOP: a claims run whose generator THREW out
              // of the for-await (e.g. an unrecoverable internal error / pump
              // failure) or was aborted/torn down early never reached the `done`
              // or `error` cases above, so its summary was never flushed. Flush
              // it here, BEFORE outQueue.close() (a push after close() is dropped
              // — see AsyncFrameQueue), so the partial run's audit receipt still
              // reaches the client over the still-live channel. The flusher's
              // once-guard makes this a no-op when done/error already flushed.
              // Guarded so a flush failure can never mask the original pump error
              // or prevent the queue from closing (which would hang the outer
              // drain). If the socket is already gone the push is harmless.
              try {
                await claimsSummaryFlusher.flush();
              } catch {
                // best-effort audit backstop; never let it break teardown.
              }
              // Pump done (clean or error): end the outer for-await drain.
              // Errors are re-thrown so the outer `await pump` surfaces them
              // into the AGENT_REQUEST catch (which emits AGENT_REQUEST_FAILED).
              outQueue.close();
            }
          })();

          // OUTER drain: yield frames from outQueue, which receives BOTH the
          // pump's orchestrator frames AND any RESEARCH_QUERY_APPROVAL frame
          // pushed concurrently by clientBridge.approveQuery. After the queue
          // closes, await the pump to propagate any pump error.
          for await (const frame of outQueue) {
            yield frame;
          }
          await pump;
        } catch (err) {
          logRedactedHandlerError("AGENT_REQUEST", err);
          yield encodeFrame(
            MSG.CHAT_ERROR,
            wireErrorPayload(err, "AGENT_REQUEST_FAILED"),
          );
        } finally {
          if (plaintext) zeroBuffer(plaintext);
          if (sessionId && agentTurnId) {
            // Codex finding #3: clear ONLY the outstanding bridge
            // resolvers for THIS turn; do NOT call the agent-turn
            // cache cleaner from the session manager here. The
            // signedFinalisationCache must survive stream teardown so a
            // client that experiences a network drop between
            // sign-and-persist can replay the reverse-channel post and
            // recover the cached signed bytes (R8-H1). Cache deletion
            // is owned by the ACK route, MEMORY_WRITE_ACK_TIMEOUT_MS
            // expiry sweep, or zeroSession — NEVER by stream teardown.
            const prefix = `${sessionId}::${agentTurnId}::`;
            for (const key of [...this.outstandingInvocations.keys()]) {
              if (key.startsWith(prefix)) {
                this.outstandingInvocations.delete(key);
              }
            }
            // R11 Finding A: also drop pre-registered resolver promises
            // for this turn — they share the same triple-key namespace
            // and would otherwise leak.
            for (const key of [...this.preRegisteredResolverPromises.keys()]) {
              if (key.startsWith(prefix)) {
                this.preRegisteredResolverPromises.delete(key);
              }
            }
            // Drop the invocation-timeout refreshers for this turn —
            // they share the same triple-key namespace as the
            // outstandingInvocations resolvers above.
            for (const key of [...this.invocationTimeoutRefreshers.keys()]) {
              if (key.startsWith(prefix)) {
                this.invocationTimeoutRefreshers.delete(key);
              }
            }
            for (const key of [...this.pendingBinaryWriteAckResolvers.keys()]) {
              if (key.startsWith(prefix)) {
                this.pendingBinaryWriteAckResolvers.delete(key);
              }
            }
            // Same triple-key namespace as the memory-write ACK gate;
            // drop this turn's resolvers so they don't leak. Any
            // still-pending resolver will already have been resolved by
            // the buildMemoryWriteAckPromise timeout fallback.
            for (const key of [...this.pendingMemoryWriteAckResolvers.keys()]) {
              if (key.startsWith(prefix)) {
                this.pendingMemoryWriteAckResolvers.delete(key);
              }
            }
            // R12: same triple-key namespace; drop any pre-registered
            // memory-write ACK promise for this turn that was never
            // consumed by awaitMemoryWriteAck so it doesn't leak. Its
            // underlying resolver is already cleared above (or will fire
            // the timeout fallback).
            for (const key of [
              ...this.preRegisteredMemoryWriteAckPromises.keys(),
            ]) {
              if (key.startsWith(prefix)) {
                this.preRegisteredMemoryWriteAckPromises.delete(key);
              }
            }
            // Phase 3: drop any pending Layer-3 research-approval resolvers
            // for this turn. Approval ids use a single-colon namespace
            // (`${sessionId}:${agentTurnId}:${counter}`), distinct from the
            // double-colon triple-key above. Fail closed: resolve any still-
            // pending approval to `false` before deleting so an awaiting
            // approveQuery promise settles (declined) on stream teardown
            // rather than leaking a pending promise. The resolver's own
            // timeout would also fire `false`, but resolving here is
            // deterministic and immediate.
            const approvalPrefix = `${sessionId}:${agentTurnId}:`;
            for (const approvalId of [
              ...this.pendingResearchApprovalResolvers.keys(),
            ]) {
              if (approvalId.startsWith(approvalPrefix)) {
                const resolve =
                  this.pendingResearchApprovalResolvers.get(approvalId);
                this.pendingResearchApprovalResolvers.delete(approvalId);
                if (resolve) resolve(false);
              }
            }
            // Fail closed: settle any still-pending egress promotions for this
            // turn as DENY (empty) on teardown so an awaiting awaitEgressPromotion
            // promise resolves rather than leaking — no private datum crosses.
            for (const promotionId of [
              ...this.pendingEgressPromotionResolvers.keys(),
            ]) {
              if (promotionId.startsWith(approvalPrefix)) {
                const resolve =
                  this.pendingEgressPromotionResolvers.get(promotionId);
                this.pendingEgressPromotionResolvers.delete(promotionId);
                if (resolve) resolve([]);
              }
            }
            // Drop any in-flight reassembly buffers for this turn —
            // they share the same triple-key namespace and have no
            // resolver to deliver into once stream teardown wipes
            // outstandingInvocations above.
            this.toolResultReassembler.clearForTurn(sessionId, agentTurnId);
          }
        }
        break;
      }

      case MSG.TOOL_RESULT: {
        try {
          const req = JSON.parse(payload.toString()) as {
            session_id: string;
            agent_turn_id: string;
            ciphertext: string;
          };
          const sessionId = req.session_id;
          const sessionKey = await this.sessionManager.getSessionKey(sessionId);
          const ciphertext = Buffer.from(req.ciphertext, "base64");
          const plaintext = await decryptChunk(sessionKey, ciphertext);
          let reassembled: Buffer | null = null;
          try {
            // H1: typed, code-only error instead of a SyntaxError that
            // embeds a snippet of the decrypted body.
            let raw: Record<string, unknown>;
            try {
              raw = JSON.parse(plaintext.toString());
            } catch {
              throw new Error(
                "TOOL_RESULT_INVALID_PAYLOAD: decrypted body is not valid JSON",
              );
            }

            // Chunked tool-result transport: when `_chunk` is present,
            // delegate to the reassembler. The reassembled bytes are
            // byte-identical to what a single-frame POST would have
            // decrypted, so we replace `raw` with the parsed result and
            // fall through to the standard dispatch below. Inner-
            // agentTurnId / invocationId validation still happens on
            // every chunk so a malicious client cannot route across
            // turns.
            if (raw._chunk && typeof raw._chunk === "object") {
              const chunkMeta = raw._chunk as Record<string, unknown>;
              const chunkAgentTurnId = String(raw.agentTurnId ?? "");
              if (chunkAgentTurnId !== req.agent_turn_id) {
                yield encodeFrame(
                  MSG.CHAT_ERROR,
                  Buffer.from(
                    JSON.stringify({
                      error_code: "AGENT_TURN_ID_MISMATCH",
                      message:
                        "Decrypted agent_turn_id does not match envelope",
                    }),
                  ),
                );
                return;
              }
              const chunkInvocationId = String(raw.invocationId ?? "");
              const chunkResolverKey = invocationKey(
                sessionId,
                chunkAgentTurnId,
                chunkInvocationId,
              );
              if (!this.outstandingInvocations.has(chunkResolverKey)) {
                const cached =
                  await this.sessionManager.lookupSignedFinalisation(
                    sessionId,
                    chunkAgentTurnId,
                    chunkInvocationId,
                  );
                if (cached) {
                  const replayPayload = Buffer.from(
                    JSON.stringify({
                      _type: "memory_write_signed",
                      invocationId: chunkInvocationId,
                      signedEnvelope: cached.signedEnvelope,
                      signature: cached.signature,
                      signedBlobB64: cached.signedBlobB64,
                    }),
                  );
                  const encryptedReplay = await encryptChunk(
                    sessionKey,
                    replayPayload,
                  );
                  yield encodeFrame(MSG.CHAT_CHUNK, encryptedReplay);
                  return;
                }
                yield encodeFrame(
                  MSG.CHAT_ERROR,
                  Buffer.from(
                    JSON.stringify({
                      error_code: "UNSOLICITED_TOOL_RESULT",
                      message: `No pending invocation for ${chunkInvocationId}`,
                    }),
                  ),
                );
                return;
              }
              const result = this.toolResultReassembler.addChunk({
                sessionId,
                agentTurnId: chunkAgentTurnId,
                invocationId: chunkInvocationId,
                index: Number(chunkMeta.index),
                total: Number(chunkMeta.total),
                partB64: String(raw.partB64 ?? ""),
              });
              if (result.status === "rejected") {
                yield encodeFrame(
                  MSG.CHAT_ERROR,
                  Buffer.from(
                    JSON.stringify({
                      error_code: result.error_code,
                      message: result.message,
                    }),
                  ),
                );
                return;
              }
              if (result.status === "pending") {
                // Codex MEDIUM duplicate-chunk pin — only refresh the
                // resolver timer when the reassembler accepted new
                // bytes. Idempotent retransmits return
                // `accepted: false` and MUST NOT extend the timer:
                // otherwise an authenticated client can keep an
                // invocation alive forever by replaying one chunk.
                // `accepted` is optional; undefined means accepted
                // (back-compat with pre-fix returns).
                if (result.accepted !== false) {
                  // Extend the resolver's per-invocation timeout — a
                  // chunk landed, so the client is making forward
                  // progress and the agent loop should keep waiting.
                  const refreshKey = invocationKey(
                    sessionId,
                    chunkAgentTurnId,
                    chunkInvocationId,
                  );
                  const refresh =
                    this.invocationTimeoutRefreshers.get(refreshKey);
                  if (refresh) refresh();
                }
                // 204 — no payload to return; the next chunk's POST
                // will continue the assembly. Caller's HTTP semantics
                // are preserved by the server's "empty response →
                // 204" branch in handleReverseChannel.
                return;
              }
              if (result.status === "already-finalised") {
                // The triple-key was reassembled and dispatched within
                // REASSEMBLY_FINALISED_LRU_TTL_MS. This POST is a
                // duplicate HTTP retry from a client whose original
                // 204 was lost in transit. Return cleanly (204) so the
                // client stops retrying, and DO NOT re-dispatch.
                return;
              }
              // Final chunk: parse the reassembled bytes and fall
              // through. Track the buffer so it can be zeroed in the
              // outer finally{}.
              reassembled = result.reassembled;
              try {
                raw = JSON.parse(reassembled.toString()) as Record<
                  string,
                  unknown
                >;
              } catch {
                yield encodeFrame(
                  MSG.CHAT_ERROR,
                  Buffer.from(
                    JSON.stringify({
                      error_code: "TOOL_RESULT_REASSEMBLY_INVALID",
                      message: "reassembled bytes are not valid JSON",
                    }),
                  ),
                );
                return;
              }
              // Defence in depth: a hostile client could attempt to
              // smuggle an _ack flag or different (agentTurnId,
              // invocationId) inside the reassembled bytes. The triple-
              // key in the reassembled payload MUST match the wire-
              // chunk triple-key, and chunked _ack frames are not
              // supported.
              if (raw._ack === true) {
                yield encodeFrame(
                  MSG.CHAT_ERROR,
                  Buffer.from(
                    JSON.stringify({
                      error_code: "TOOL_RESULT_REASSEMBLY_INVALID",
                      message: "chunked _ack frames are not permitted",
                    }),
                  ),
                );
                return;
              }
              if (
                String(raw.agentTurnId ?? "") !== chunkAgentTurnId ||
                String(raw.invocationId ?? "") !== chunkInvocationId
              ) {
                yield encodeFrame(
                  MSG.CHAT_ERROR,
                  Buffer.from(
                    JSON.stringify({
                      error_code: "TOOL_RESULT_REASSEMBLY_INVALID",
                      message:
                        "reassembled triple-key does not match chunk envelope",
                    }),
                  ),
                );
                return;
              }
              // Fall through: reassembled `raw` now has the same shape
              // a single-frame TOOL_RESULT would have. A full-sequence
              // retransmit after the original dispatch already consumed
              // the resolver lands in the standard "no pending
              // invocation" branch below — which returns either the
              // R4 finding #2 signed-finalisation replay (memory.write)
              // or UNSOLICITED_TOOL_RESULT (everything else). Behaviour
              // matches the single-frame replay contract.
            }

            if (raw._binaryAck === true) {
              const parsedAck = BinaryWorkItemWriteAckFrameSchema.safeParse({
                kind: "binary_work_item.write_ack",
                agentTurnId: raw.agentTurnId,
                invocationId: raw.invocationId,
                operationId: raw.operationId,
                outputId: raw.outputId,
                outputPath: raw.outputPath,
                sha256Hex: raw.sha256Hex,
                byteLength: raw.byteLength,
                outcome: raw.outcome,
                reason: raw.reason,
              });
              if (!parsedAck.success) {
                yield encodeFrame(
                  MSG.CHAT_ERROR,
                  Buffer.from(
                    JSON.stringify({
                      error_code: "BINARY_WRITE_ACK_INVALID",
                      message: "binary write ack failed schema validation",
                    }),
                  ),
                );
                return;
              }
              const ack: BinaryWorkItemWriteAckFrame & { sessionId: string } = {
                ...parsedAck.data,
                sessionId,
              };
              const ackResult = this.binaryWorkItems.ackOutputWrite(ack);
              const key = invocationKey(
                sessionId,
                ack.agentTurnId,
                ack.invocationId,
              );
              const pendingBinaryAck =
                this.pendingBinaryWriteAckResolvers.get(key);
              if (pendingBinaryAck) {
                const denied =
                  ack.outcome === "denied_by_user" ||
                  (ackResult.status === "rejected" &&
                    ackResult.errorCode === "BINARY_WORK_ITEM_ACK_DENIED");
                pendingBinaryAck({
                  invocationId: ack.invocationId,
                  outcome:
                    ackResult.status === "acknowledged"
                      ? "ok"
                      : denied
                        ? "denied_by_user"
                        : "error",
                  ...(ackResult.status === "rejected"
                    ? { reason: ackResult.message }
                    : ack.reason
                      ? { reason: ack.reason }
                      : {}),
                  resultJson: {
                    status:
                      ackResult.status === "acknowledged"
                        ? "committed"
                        : denied
                          ? "denied_by_user"
                          : "error",
                    outputId: ack.outputId,
                    outputPath: ack.outputPath,
                    byteLength: ack.byteLength,
                    sha256Hex: ack.sha256Hex,
                    ...(ackResult.status === "rejected"
                      ? {
                          errorCode: ackResult.errorCode,
                          reason: ackResult.message,
                        }
                      : ack.reason
                        ? { reason: ack.reason }
                        : {}),
                  },
                });
              }
              const encrypted = await encryptChunk(
                sessionKey,
                Buffer.from(
                  JSON.stringify({
                    _type: "binary_work_item.write_ack",
                    agentTurnId: ack.agentTurnId,
                    invocationId: ack.invocationId,
                    operationId: ack.operationId,
                    outputId: ack.outputId,
                    outcome:
                      ackResult.status === "acknowledged" ? "ok" : "error",
                    ...(ackResult.status === "rejected"
                      ? {
                          errorCode: ackResult.errorCode,
                          reason: ackResult.message,
                        }
                      : {}),
                  }),
                ),
              );
              yield encodeFrame(MSG.CHAT_CHUNK, encrypted);
              return;
            }

            if (raw._ack === true) {
              const agentTurnId = String(raw.agentTurnId ?? "");
              const invocationId = String(raw.invocationId ?? "");
              const ackContentHash = String(raw.ackContentHash ?? "");
              const ackResult = await this.sessionManager.ackSignedFinalisation(
                sessionId,
                agentTurnId,
                invocationId,
                ackContentHash,
              );
              // Definitive ACK-gating: release the suspended agent loop
              // with the REAL durable-write outcome. The client only
              // posts this ACK after saveMemory succeeds, so a matching
              // cache ack ('ok') is a confirmed durable write; carry the
              // server-authoritative recordVersion through to the model.
              // A 'mismatch'/'absent' is surfaced as an honest failure so
              // the model stops instead of re-writing.
              const memoryAckKey = invocationKey(
                sessionId,
                agentTurnId,
                invocationId,
              );
              const pendingMemoryAck =
                this.pendingMemoryWriteAckResolvers.get(memoryAckKey);
              if (pendingMemoryAck) {
                if (ackResult.outcome === "ok") {
                  const recordVersionRaw = raw.recordVersion;
                  pendingMemoryAck({
                    outcome: "ok",
                    recordVersion:
                      typeof recordVersionRaw === "number"
                        ? recordVersionRaw
                        : undefined,
                  });
                } else {
                  pendingMemoryAck({
                    outcome: "error",
                    reason: `MEMORY_WRITE_ACK_${ackResult.outcome.toUpperCase()}`,
                  });
                }
              }
              // Codex R4 finding #4 preempt: include agentTurnId so the
              // client can validate the ack outcome belongs to THIS turn
              // (not a stale cached frame from a prior turn). The client
              // surfaces ACK_TURN_MISMATCH if these disagree.
              const encrypted = await encryptChunk(
                sessionKey,
                Buffer.from(
                  JSON.stringify({
                    _type: "tool_result_ack",
                    agentTurnId,
                    invocationId,
                    outcome: ackResult.outcome,
                  }),
                ),
              );
              yield encodeFrame(MSG.CHAT_CHUNK, encrypted);
              return;
            }

            const invocationId = String(raw.invocationId ?? "");
            // Codex finding #2: the decrypted payload's agentTurnId MUST
            // match the URL/envelope's agent_turn_id. The triple-key
            // (sessionId, agentTurnId, invocationId) is the only way a
            // resolver from turn-A can be reached; if the decrypted
            // payload omits/mismatches agentTurnId, we cannot safely
            // route to ANY resolver — fail closed.
            const innerAgentTurnId = String(raw.agentTurnId ?? "");
            if (innerAgentTurnId !== req.agent_turn_id) {
              yield encodeFrame(
                MSG.CHAT_ERROR,
                Buffer.from(
                  JSON.stringify({
                    error_code: "AGENT_TURN_ID_MISMATCH",
                    message: "Decrypted agent_turn_id does not match envelope",
                  }),
                ),
              );
              return;
            }
            const key = invocationKey(
              sessionId,
              innerAgentTurnId,
              invocationId,
            );
            const resolver = this.outstandingInvocations.get(key);
            if (!resolver) {
              // Codex R4 finding #2: replay-recovery. The bridge resolver
              // was cleared in the AGENT_REQUEST finally{} block (stream
              // teardown), but the signed-finalisation cache survives so
              // a network-drop client can retry POST /tool-result and
              // recover the same memory_write_signed chunk it would have
              // received over the dropped SSE. If the cache holds an
              // entry for THIS triple-key, return the signed bytes as a
              // CHAT_CHUNK (encrypted under sessionKey). Otherwise fall
              // back to UNSOLICITED_TOOL_RESULT.
              const cached = await this.sessionManager.lookupSignedFinalisation(
                sessionId,
                innerAgentTurnId,
                invocationId,
              );
              if (cached) {
                const replayPayload = Buffer.from(
                  JSON.stringify({
                    _type: "memory_write_signed",
                    invocationId,
                    signedEnvelope: cached.signedEnvelope,
                    signature: cached.signature,
                    signedBlobB64: cached.signedBlobB64,
                  }),
                );
                const encryptedReplay = await encryptChunk(
                  sessionKey,
                  replayPayload,
                );
                yield encodeFrame(MSG.CHAT_CHUNK, encryptedReplay);
                return;
              }
              yield encodeFrame(
                MSG.CHAT_ERROR,
                Buffer.from(
                  JSON.stringify({
                    error_code: "UNSOLICITED_TOOL_RESULT",
                    message: `No pending invocation for ${invocationId}`,
                  }),
                ),
              );
              return;
            }
            this.outstandingInvocations.delete(key);
            resolver({
              invocationId,
              outcome: raw.outcome as ToolResultFrame["outcome"],
              resultJson: raw.resultJson,
              resultB64:
                typeof raw.resultB64 === "string" ? raw.resultB64 : undefined,
              reason: typeof raw.reason === "string" ? raw.reason : undefined,
            });
          } finally {
            zeroBuffer(plaintext);
            if (reassembled) zeroBuffer(reassembled);
          }
        } catch (err) {
          logRedactedHandlerError("TOOL_RESULT", err);
          yield encodeFrame(
            MSG.CHAT_ERROR,
            wireErrorPayload(err, "TOOL_RESULT_FAILED"),
          );
        }
        break;
      }

      case MSG.RESEARCH_QUERY_APPROVAL_RESULT: {
        // Phase 3 Layer-3 reverse-channel: the client's decision on a
        // RESEARCH_QUERY_APPROVAL it was shown. Decrypt the payload under the
        // session key (same as TOOL_RESULT), look up the pending approval
        // resolver by approvalId, and resolve it with the boolean. Modelled on
        // the TOOL_RESULT → outstandingInvocations routing, with the payload a
        // plain { approvalId, approved }.
        //
        // SESSION BINDING (P1): the approvalId MUST belong to the session
        // whose key decrypted this frame. approvalIds are minted in
        // approveQuery as `${sessionId}:${turnId}:${counter}` (single-colon
        // namespace, same one the AGENT_STREAM_END teardown sweeps), but
        // session_id / agent_turn_id ride in the PLAINTEXT outer envelope the
        // host can read, and pendingResearchApprovalResolvers is a
        // process-GLOBAL map. Without the prefix check, any holder of a valid
        // session key (their own account), colluding with the host, could
        // spray forged { approvalId, approved: true } results during a
        // victim's approval window and auto-approve the victim's in-flight
        // research query. Possession of the victim's session key — proven by
        // producing a frame that decrypts under it — is the only acceptable
        // approval credential.
        //
        // A mismatched approvalId is IGNORED exactly like an unknown/absent
        // one (no throw, no error frame, resolver neither looked up nor
        // deleted) — a stale or duplicate result must not error the
        // connection.
        try {
          const req = JSON.parse(payload.toString()) as {
            session_id: string;
            ciphertext: string;
          };
          const sessionId = req.session_id;
          const sessionKey = await this.sessionManager.getSessionKey(sessionId);
          const ciphertext = Buffer.from(req.ciphertext, "base64");
          const plaintext = await decryptChunk(sessionKey, ciphertext);
          try {
            // H1: typed, code-only error instead of a SyntaxError that
            // embeds a snippet of the decrypted body.
            let raw: Record<string, unknown>;
            try {
              raw = JSON.parse(plaintext.toString());
            } catch {
              throw new Error(
                "RESEARCH_QUERY_APPROVAL_RESULT_INVALID: decrypted body is not valid JSON",
              );
            }
            const approvalId =
              typeof raw.approvalId === "string" ? raw.approvalId : "";
            const approved = raw.approved === true;
            // Session binding: only consult the resolver map when the
            // approvalId is namespaced under the decrypting session.
            if (approvalId.startsWith(`${sessionId}:`)) {
              const resolve =
                this.pendingResearchApprovalResolvers.get(approvalId);
              // Unknown/absent approvalId → ignore (no throw). A late result
              // for an already-settled (timed-out or torn-down) approval
              // simply has no resolver to fire.
              if (resolve) {
                this.pendingResearchApprovalResolvers.delete(approvalId);
                resolve(approved);
              }
            }
          } finally {
            zeroBuffer(plaintext);
          }
        } catch (err) {
          logRedactedHandlerError("RESEARCH_QUERY_APPROVAL_RESULT", err);
          yield encodeFrame(
            MSG.CHAT_ERROR,
            wireErrorPayload(err, "RESEARCH_QUERY_APPROVAL_RESULT_FAILED"),
          );
        }
        break;
      }

      case MSG.EGRESS_PROMOTION_RESULT: {
        // Finding 11 reverse-channel: the client's decision on an
        // EGRESS_PROMOTION_REQUEST it was shown. Same session-binding + ignore-
        // unknown contract as RESEARCH_QUERY_APPROVAL_RESULT — a forged result
        // from a colluding host can't auto-promote a victim's private datum
        // because the promotionId must be namespaced under the decrypting
        // session, and only the candidate ids the enclave itself offered (and
        // the user approved) are resolved. approvedIds is validated to a string
        // array; anything else collapses to DENY (empty).
        try {
          const req = JSON.parse(payload.toString()) as {
            session_id: string;
            ciphertext: string;
          };
          const sessionId = req.session_id;
          const sessionKey = await this.sessionManager.getSessionKey(sessionId);
          const ciphertext = Buffer.from(req.ciphertext, "base64");
          const plaintext = await decryptChunk(sessionKey, ciphertext);
          try {
            let raw: Record<string, unknown>;
            try {
              raw = JSON.parse(plaintext.toString());
            } catch {
              throw new Error(
                "EGRESS_PROMOTION_RESULT_INVALID: decrypted body is not valid JSON",
              );
            }
            const promotionId =
              typeof raw.promotionId === "string" ? raw.promotionId : "";
            const approvedIds = Array.isArray(raw.approvedIds)
              ? raw.approvedIds.filter(
                  (id): id is string => typeof id === "string",
                )
              : [];
            if (promotionId.startsWith(`${sessionId}:`)) {
              const resolve =
                this.pendingEgressPromotionResolvers.get(promotionId);
              if (resolve) {
                this.pendingEgressPromotionResolvers.delete(promotionId);
                resolve(approvedIds);
              }
            }
          } finally {
            zeroBuffer(plaintext);
          }
        } catch (err) {
          logRedactedHandlerError("EGRESS_PROMOTION_RESULT", err);
          yield encodeFrame(
            MSG.CHAT_ERROR,
            wireErrorPayload(err, "EGRESS_PROMOTION_RESULT_FAILED"),
          );
        }
        break;
      }

      default:
        yield encodeFrame(
          MSG.CHAT_ERROR,
          Buffer.from(
            JSON.stringify({
              error_code: "UNKNOWN_MESSAGE_TYPE",
              message: `Unhandled message type: 0x${type.toString(16)}`,
            }),
          ),
        );
    }
  }

  /**
   * Construct the production orchestrator media gateway for image generation.
   * Wired in init() once provider keys are available; gated off when an
   * agentLoopProcessorFactory is set (the test seam injects its own media so
   * tests never hit the real adapters/registry). Building this opens the
   * fail-closed `imageMediaExecutorWired` gate (image generation stays routed
   * off until both this AND a routable image model are present).
   *
   * Image AND video generation are wired: imageAdapters + videoAdapters are
   * built per provider key. The boot-time checkpoint client is a fail-closed
   * default; the AGENT_REQUEST handler binds the REAL per-user durable video
   * checkpoint client + the video provider-visible-input bundle. Video RENDER
   * (Remotion composition) stays gated off until a render backend is wired — the
   * fail-closed videoRenderRoutable gate keeps video.render out of the pack.
   */
  private buildProductionMedia(): RunOrchestratorDeps["media"] | undefined {
    // Build an image adapter for each provider whose key is present, mirroring
    // resolveProductionProcessor: provider baseUrl + id from the signed
    // registry, key from the KMS-delivered providerKeys.
    const imageAdapters: Record<string, ImageProviderAdapter> = {};
    const tryProvider = (
      providerId: string,
      make: (provider: ProviderConfig, apiKey: string) => ImageProviderAdapter,
    ): void => {
      const apiKey = this.providerKeys[providerId];
      if (!apiKey) return;
      let provider: ProviderConfig;
      try {
        provider = getProviderById(providerId);
      } catch {
        // Provider not in the loaded registry — skip (key without a provider
        // entry cannot be routed anyway).
        return;
      }
      imageAdapters[providerId] = make(provider, apiKey);
    };
    tryProvider(
      "openai",
      (provider, apiKey) =>
        new OpenAIImageProcessor(provider.baseUrl, apiKey, {
          providerId: provider.id,
          providerName: provider.displayName,
        }),
    );
    tryProvider(
      "google",
      (provider, apiKey) =>
        new GoogleImageProcessor(provider.baseUrl, apiKey, {
          providerId: provider.id,
          providerName: provider.displayName,
        }),
    );

    // Video adapters, mirroring the image wiring: provider baseUrl + id from the
    // signed registry, key from the KMS-delivered providerKeys. Veo (google)
    // today; the fail-closed videoGenerateRoutable gate keeps video routed off
    // until BOTH a wired adapter here AND a routable enabled video model exist.
    const videoAdapters: Record<string, VideoProviderAdapter> = {};
    const tryVideoProvider = (
      providerId: string,
      make: (provider: ProviderConfig, apiKey: string) => VideoProviderAdapter,
    ): void => {
      const apiKey = this.providerKeys[providerId];
      if (!apiKey) return;
      let provider: ProviderConfig;
      try {
        provider = getProviderById(providerId);
      } catch {
        return;
      }
      videoAdapters[providerId] = make(provider, apiKey);
    };
    tryVideoProvider(
      "google",
      (provider, apiKey) =>
        new GoogleVeoVideoAdapter({ baseUrl: provider.baseUrl, apiKey }),
    );

    // No provider key for ANY media provider ⇒ leave media unwired so the
    // fail-closed gate keeps image + video generation routed off (better than a
    // half-wired gateway that hits MEDIA_EXECUTOR_UNAVAILABLE mid-subtask).
    if (
      Object.keys(imageAdapters).length === 0 &&
      Object.keys(videoAdapters).length === 0
    ) {
      return undefined;
    }

    // Media-provenance signer. PREFERRED: HKDF-derive a STABLE Ed25519 keypair
    // from the KMS-released, PCR0-gated media-root secret — stable across boots
    // and transitively rooted in the attestation chain (only a genuine,
    // measured enclave can decrypt the secret). The raw public key is published
    // in the session attestation `user_data` (ATTESTATION_RESPONSE) so a client
    // can verify image provenance against the attested enclave identity.
    // FALLBACK (no media-root secret in the blob — pre-rotation): an ephemeral
    // per-boot key. Still published in user_data, so a client can verify within
    // that boot; it just is not stable across boots.
    let provenanceSigner: ProvenanceSigner;
    if (this.mediaRootSecret) {
      const derived = deriveProvenanceSigner(
        Buffer.from(this.mediaRootSecret, "utf8"),
      );
      provenanceSigner = derived.signer;
      this.provenancePublicKey = derived.publicKeyRaw;
      console.log(
        "[enclave] EnclaveRouter.init(): media provenance key = attestation-rooted (stable, derived from media-root secret).",
      );
    } else {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      provenanceSigner = {
        sign: (canonical: string): string =>
          cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString(
            "base64",
          ),
        verify: (canonical: string, signatureB64: string): boolean => {
          try {
            return cryptoVerify(
              null,
              Buffer.from(canonical, "utf8"),
              publicKey as KeyObject,
              Buffer.from(signatureB64, "base64"),
            );
          } catch {
            return false;
          }
        },
      };
      // Publish the ephemeral public key too (raw 32 bytes from the SPKI tail),
      // so in-boot client verification still works pre-rotation.
      this.provenancePublicKey = Uint8Array.prototype.slice.call(
        publicKey.export({ format: "der", type: "spki" }),
        12,
      );
      console.log(
        "[enclave] EnclaveRouter.init(): media provenance key = ephemeral per-boot (no media-root secret; pre-rotation fallback).",
      );
    }

    // Hard metering: the REAL per-user budget client is bound per AGENT_REQUEST
    // (createMediaBudgetClient with the authenticated userId/planId) — see the
    // AGENT_REQUEST handler, which overrides this field. This boot-time default
    // is FAIL CLOSED: if a request ever reaches the gateway without the
    // per-request override (e.g. an unauthenticated path), reserve refuses so
    // no image is generated unmetered.
    const budgetClient: NonNullable<
      RunOrchestratorDeps["media"]
    >["budgetClient"] = {
      reserve: async () => ({
        ok: false as const,
        reason: "MEDIA_BUDGET_USER_CONTEXT_MISSING",
      }),
      reconcile: async () => undefined,
    };

    // Boot-time checkpoint client: FAIL CLOSED. The REAL per-user durable client
    // (createVideoCheckpointClient with the authenticated userId) is bound per
    // AGENT_REQUEST — see the handler, which overrides this field alongside
    // budgetClient. Constructed with no user, its user-scoped ops throw rather
    // than silently returning null, so a video subtask that ever reached the
    // gateway without the per-request override fails closed (the executor's
    // per-subtask catch releases the hold) instead of starting an un-checkpointed
    // provider job. Image generation is synchronous and never touches it.
    const checkpointClient: NonNullable<
      RunOrchestratorDeps["media"]
    >["checkpointClient"] = createVideoCheckpointClient({});

    // Mark that the production gateway is wired so AGENT_REQUEST overrides the
    // fail-closed budgetClient with the real per-user one (injected test media
    // never sets this flag, so its budgetClient is left untouched).
    this.productionMediaWired = true;

    return {
      videoAdapters,
      imageAdapters,
      binaryWorkItems: this.binaryWorkItems,
      checkpointClient,
      budgetClient,
      provenanceSigner,
      // The binary write-ACK is the real delivery; this only feeds the
      // orchestrator-artifact metadata trail event (its sha256/byteSize). No
      // ciphertext is persisted server-side, so ciphertextRef is empty.
      encryptArtifact: async (input) => ({
        artifactId: randomUUID(),
        ciphertextRef: "",
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        byteSize: input.bytes.byteLength,
      }),
      // `now` is intentionally omitted: the media type expects a fixed Date,
      // but this router is long-lived, so a single boot-time Date would freeze
      // provenance timestamps. The executor defaults to `new Date()` per call
      // when `now` is absent — the correct behaviour here.
    };
  }

  private resolveProductionProcessor(model: string): ChatProcessor {
    const { provider, model: modelConfig } = getProviderForModel(model);
    assertDirectChatModelRoutable(modelConfig);
    const apiKey = this.providerKeys[provider.id];
    if (!apiKey) {
      throw new Error(`PROVIDER_KEY_MISSING: ${provider.id}`);
    }
    return createProcessor(provider, apiKey);
  }

  private createProcessorForModelId(modelId: string): ChatProcessor {
    if (this.agentLoopProcessorFactory) {
      return this.agentLoopProcessorFactory(modelId);
    }
    const { provider, model } = getProviderForModel(modelId);
    const endpointFamily = model.capabilities?.endpointFamily ?? "chat";
    if (endpointFamily !== "chat") {
      throw new Error(
        `UNROUTABLE_ENDPOINT_FAMILY:${model.id}:${endpointFamily}`,
      );
    }
    const apiKey = this.providerKeys[provider.id];
    if (!apiKey) {
      throw new Error(`PROVIDER_KEY_MISSING: ${provider.id}`);
    }
    return createProcessor(provider, apiKey);
  }
}

export function getRoutableModelCapabilities(
  override?: readonly ModelCapability[],
  // Provider ids that currently have a delivered key. When supplied, models
  // whose provider key is absent are dropped so the router never selects a
  // model that createProcessorForModelId would reject with
  // PROVIDER_KEY_MISSING mid-subtask. Omitted (undefined) ⇒ no key filtering
  // (back-compat for callers that don't know the key set).
  availableProviderIds?: ReadonlySet<string>,
): ModelCapability[] {
  const hasKey = (model: ModelCapability): boolean =>
    availableProviderIds === undefined ||
    availableProviderIds.has(model.providerId);
  if (override) {
    return override
      .filter((model) => model.routingStatus === "enabled")
      .filter(hasKey);
  }
  try {
    return buildModelCapabilities(getAllProviders())
      .filter((model) => model.routingStatus === "enabled")
      .filter(hasKey);
  } catch {
    const fallback: ModelCapability[] = [
      {
        modelId: "gpt-5.5",
        providerId: "openai",
        strengths: ["general_reasoning", "planning", "long_context", "writing"],
        strengthQuality: [
          { strength: "planning", tier: "frontier" },
          { strength: "writing", tier: "frontier" },
        ],
        modalities: ["text_in", "text_out"],
        endpointFamily: "chat",
        costTier: "high",
        latencyTier: "standard",
        routingStatus: "enabled",
        requiredGatewayTools: [],
        maxContextTokens: 1050000,
      },
      {
        modelId: "gpt-5.4-mini",
        providerId: "openai",
        strengths: [
          "general_reasoning",
          "fast_reasoning",
          "classification",
          "structured_extraction",
        ],
        strengthQuality: [
          { strength: "fast_reasoning", tier: "strong" },
          { strength: "structured_extraction", tier: "standard" },
        ],
        modalities: ["text_in", "text_out"],
        endpointFamily: "chat",
        costTier: "low",
        latencyTier: "fast",
        routingStatus: "enabled",
        requiredGatewayTools: [],
        maxContextTokens: 400000,
      },
    ];
    return fallback.filter(hasKey);
  }
}

function getEnabledEndpointFamiliesForCanonicalPack(
  pack: SkillPack,
  media?: RunOrchestratorDeps["media"],
  imageGenerationRoutable = false,
): ModelEndpointFamily[] {
  const families: ModelEndpointFamily[] = ["chat"];
  if (
    media &&
    (pack.toolScopes.includes("video.generate") ||
      pack.toolScopes.includes("video.render"))
  ) {
    families.push("video");
  }
  // Enable the image endpoint family only when an image-output model is
  // routable AND the (already image-gate-filtered) pack still scopes an
  // image-generation tool — keeping the router fail-closed: no routable image
  // model ⇒ no "image" family ⇒ an image subtask can never be routed.
  if (
    imageGenerationRoutable &&
    (pack.toolScopes.includes("image.generate") ||
      pack.toolScopes.includes("image.edit"))
  ) {
    families.push("image");
  }
  return families;
}

// An image-output model is routable iff an enabled model with the "image"
// endpoint family exists whose required gateway tools are all scoped by the
// pack. Drives the fail-closed image-generation gate (finding 10).
function isImageGenerationRoutable(
  models: readonly ModelCapability[],
  packToolScopes: readonly ToolName[],
): boolean {
  const scoped = new Set<string>(packToolScopes);
  return models.some(
    (model) =>
      model.routingStatus === "enabled" &&
      model.endpointFamily === "image" &&
      model.requiredGatewayTools.every((tool) => scoped.has(tool)),
  );
}

function choosePlannerModelId(
  models: readonly ModelCapability[],
  preferredModelId: string,
): string {
  if (
    preferredModelId !== "auto" &&
    models.some((model) => model.modelId === preferredModelId)
  ) {
    return preferredModelId;
  }
  return (
    [...models]
      .filter((model) => model.strengths.includes("planning"))
      .sort(comparePlannerModels)[0]?.modelId ??
    models[0]?.modelId ??
    preferredModelId
  );
}

function choosePlannerModelIds(
  models: readonly ModelCapability[],
  preferredModelId: string,
): string[] {
  const primary = choosePlannerModelId(models, preferredModelId);
  const candidates = [...models]
    .filter((model) => model.endpointFamily === "chat")
    .filter((model) => model.modelId !== primary)
    .filter(
      (model) =>
        model.strengths.includes("planning") ||
        model.strengths.includes("general_reasoning"),
    )
    .sort(comparePlannerModels)
    .map((model) => model.modelId);
  return [primary, ...providerDiverseModelIdOrder(candidates, models)].slice(
    0,
    3,
  );
}

function chooseSummaryModelId(models: readonly ModelCapability[]): string {
  return (
    [...models]
      .filter(
        (model) =>
          model.strengths.includes("fast_reasoning") &&
          (model.strengths.includes("synthesis") ||
            model.strengths.includes("structured_extraction")),
      )
      .sort(compareCheapFastModels)[0]?.modelId ??
    [...models]
      .filter((model) => model.strengths.includes("fast_reasoning"))
      .sort(compareCheapFastModels)[0]?.modelId ??
    models[0]?.modelId ??
    "gpt-5.4-mini"
  );
}

function chooseSummaryModelIds(models: readonly ModelCapability[]): string[] {
  const primary = chooseSummaryModelId(models);
  const candidates = [...models]
    .filter((model) => model.endpointFamily === "chat")
    .filter((model) => model.modelId !== primary)
    .filter(
      (model) =>
        model.strengths.includes("fast_reasoning") ||
        model.strengths.includes("synthesis"),
    )
    .sort(compareCheapFastModels)
    .map((model) => model.modelId);
  return [primary, ...providerDiverseModelIdOrder(candidates, models)].slice(
    0,
    3,
  );
}

function providerDiverseModelIdOrder(
  candidateModelIds: readonly string[],
  models: readonly ModelCapability[],
): string[] {
  const byId = new Map(models.map((model) => [model.modelId, model]));
  const buckets = new Map<string, string[]>();
  for (const modelId of candidateModelIds) {
    const providerId = byId.get(modelId)?.providerId;
    if (!providerId) continue;
    const bucket = buckets.get(providerId) ?? [];
    bucket.push(modelId);
    buckets.set(providerId, bucket);
  }

  const providerOrder = [...buckets.keys()];
  const out: string[] = [];
  while (out.length < candidateModelIds.length) {
    let added = false;
    for (const providerId of providerOrder) {
      const next = buckets.get(providerId)?.shift();
      if (!next) continue;
      out.push(next);
      added = true;
    }
    if (!added) break;
  }
  return out;
}

const COST_RANK = { low: 0, medium: 1, high: 2 } as const;
const LATENCY_RANK = { fast: 0, standard: 1, slow: 2 } as const;
const QUALITY_RANK = { basic: 0, standard: 1, strong: 2, frontier: 3 } as const;

function comparePlannerModels(a: ModelCapability, b: ModelCapability): number {
  return plannerQuality(b) - plannerQuality(a) || compareCheapFastModels(a, b);
}

function plannerQuality(model: ModelCapability): number {
  const planning = model.strengthQuality.find(
    (entry) => entry.strength === "planning",
  )?.tier;
  return planning ? QUALITY_RANK[planning] : 1;
}

function compareCheapFastModels(
  a: ModelCapability,
  b: ModelCapability,
): number {
  return (
    COST_RANK[a.costTier] - COST_RANK[b.costTier] ||
    LATENCY_RANK[a.latencyTier] - LATENCY_RANK[b.latencyTier] ||
    a.modelId.localeCompare(b.modelId)
  );
}

/**
 * Triple-key resolver index for outstanding TOOL_INVOCATION promises.
 * Codex finding #2: scoping by (sessionId, invocationId) alone is not
 * enough — two concurrent agent turns on one TEE session can both
 * generate the same invocationId; result from one turn could satisfy
 * the other. Adding `agentTurnId` namespaces invocations per turn so
 * cross-turn collisions can never happen.
 */
function invocationKey(
  sessionId: string,
  agentTurnId: string,
  invocationId: string,
): string {
  return `${sessionId}::${agentTurnId}::${invocationId}`;
}

function isProviderResponseLike(value: unknown): value is ProviderResponseLike {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<ProviderResponseLike>;
  return (
    (maybe.provider === "openai" ||
      maybe.provider === "anthropic" ||
      maybe.provider === "google") &&
    typeof maybe.model === "string"
  );
}

function buildUnsignedEnvelope(
  candidate: DreamCandidate,
  teeSessionId: string,
  output: DreamSessionDeltaOutput,
): UnsignedEnvelope {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const record = output.delta.record;
  const provenanceConversationIds = Array.from(
    new Set(
      (record?.provenance ?? [])
        .map((entry) =>
          entry.sourceRef.type === "conversation"
            ? entry.sourceRef.conversationId
            : null,
        )
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  return {
    createdAt: Date.now(),
    recordSerialisedHash: output.recordSerialisedHash,
    envelopeFields: {
      v: 1,
      userId: candidate.userId,
      namespace: candidate.namespace,
      blobId: output.delta.targetId,
      action: output.delta.action,
      expectedBaseVersion: output.delta.expectedBaseVersion,
      newRecordVersion:
        output.delta.action === "ADD"
          ? 0
          : output.delta.expectedBaseVersion + 1,
      kind: record?.kind ?? "fact",
      mutationId: output.delta.mutationId,
      dreamSessionId: candidate.dreamSessionId,
      teeSessionId,
      provenanceConversationIds,
      issuedAt,
      expiresAt,
    },
  };
}

// ------------------------------------------------------------------
// Main entry point — vsock/TCP listener
// ------------------------------------------------------------------

const HEADER_SIZE = 5;

export function parseFrames(socket: Socket, router: EnclaveRouter): void {
  let buffer = Buffer.alloc(0);
  let processing = false;
  let dataArrivedWhileProcessing = false;

  // L1: per-connection abort. When the peer disconnects (close/error) we
  // (a) stop pulling frames from the in-flight handler — its finally{}
  // blocks (session/plaintext zeroization) still run via generator
  // return — (b) never write into the dead socket, and (c) hand the
  // signal to handleMessage so provider calls are cancelled instead of
  // streaming tokens into the void.
  const connectionAbort = new AbortController();
  const abortConnection = () => {
    if (!connectionAbort.signal.aborted) {
      connectionAbort.abort(new Error("VSOCK_CONNECTION_CLOSED"));
    }
  };
  socket.on("close", abortConnection);

  // Write honoring backpressure: when the kernel buffer is full
  // (write() === false), wait for 'drain' — or connection teardown, which
  // resolves the wait so a dead socket cannot hang the drain loop.
  async function writeFrame(frame: Buffer): Promise<void> {
    if (connectionAbort.signal.aborted) return;
    const ok = socket.write(frame);
    if (ok) return;
    await new Promise<void>((resolveDrain) => {
      const onDrain = () => {
        cleanup();
        resolveDrain();
      };
      const onAbort = () => {
        cleanup();
        resolveDrain();
      };
      const cleanup = () => {
        socket.off("drain", onDrain);
        connectionAbort.signal.removeEventListener("abort", onAbort);
      };
      socket.once("drain", onDrain);
      connectionAbort.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    });
  }

  async function drainFrames(): Promise<void> {
    if (processing) {
      dataArrivedWhileProcessing = true;
      return;
    }
    processing = true;
    dataArrivedWhileProcessing = false;

    try {
      while (buffer.length >= HEADER_SIZE) {
        const payloadLen = buffer.readUInt32BE(1);

        if (payloadLen > MAX_VSOCK_PAYLOAD) {
          console.error(
            `[enclave] Inbound frame declares ${payloadLen} bytes, exceeds ${MAX_VSOCK_PAYLOAD} limit`,
          );
          buffer = Buffer.alloc(0);
          socket.destroy();
          return;
        }

        const frameLen = HEADER_SIZE + payloadLen;

        if (buffer.length < frameLen) break; // Wait for more data

        const frame = buffer.subarray(0, frameLen);
        buffer = buffer.subarray(frameLen);

        try {
          for await (const responseFrame of router.handleMessage(
            frame,
            connectionAbort.signal,
          )) {
            // Breaking out of the for-await calls the generator's
            // .return(), which runs the handler's finally{} cleanup.
            if (connectionAbort.signal.aborted) break;
            await writeFrame(responseFrame);
            if (connectionAbort.signal.aborted) break;
          }
        } catch (err) {
          // H1/L2 discipline: the raw error can carry payload-derived
          // content and host-visible stderr must stay redacted.
          logRedactedHandlerError("frame processing", err);
          buffer = Buffer.alloc(0);
          socket.destroy();
          return;
        }
        if (connectionAbort.signal.aborted) {
          buffer = Buffer.alloc(0);
          return;
        }
      }
    } finally {
      processing = false;
      // Only re-drain if NEW data arrived while we were processing.
      // Without this flag, an incomplete frame (header present but payload
      // not yet received) would cause an infinite re-entry loop.
      if (dataArrivedWhileProcessing) {
        dataArrivedWhileProcessing = false;
        void drainFrames();
      }
    }
  }

  socket.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    void drainFrames();
  });

  socket.on("error", (err) => {
    console.error("[enclave] Socket error:", err.message);
    abortConnection();
  });

  // Peer finished sending. Once we've drained any in-flight request and
  // written the response, end our write-half so the kernel can free the fd.
  // Without this the accepted vsock fd leaks after every request —
  // libuv worker pool saturates after ~4 sequential connections and
  // subsequent accepts appear to hang.
  socket.on("end", () => {
    void (async () => {
      while (processing) {
        await new Promise((r) => setImmediate(r));
      }
      try {
        socket.end();
      } catch {
        // socket may already be ended/destroyed
      }
    })();
  });
}

async function main(): Promise<void> {
  // Codex LOW F2 — fail CLOSED on a genuinely-undefined-state fault. An
  // uncaughtException is a synchronous throw that escaped all try/catch, so
  // the process state (and any security cleanup) is undefined; this enclave
  // holds provider keys, session key material and decrypted payloads, so we
  // log and exit non-zero. The host supervisor relaunches a fresh, clean
  // enclave (deploy health checks detect a down enclave).
  //
  // Deliberate trade-off (claude-adv review): exiting here is a theoretical DoS
  // lever IF attacker-controlled input could surface as a synchronous throw.
  // We accept it because (a) per-frame processing is wrapped at the operation
  // boundary (parseFrames catches router errors and destroys only the offending
  // socket), so attacker input surfaces as a caught error, not an
  // uncaughtException; and (b) continuing to serve a secrets-handling TEE on
  // genuinely-undefined state is a worse failure than a supervised restart.
  // Unlike unhandledRejection (kept alive below), an uncaughtException cannot
  // be safely resumed, so it is NOT given the keep-alive treatment.
  process.on("uncaughtException", (err) => {
    console.error("[enclave] Uncaught Exception — failing closed:", err);
    process.exit(1);
  });

  // unhandledRejection is, by definition, the async path that escaped local
  // handling. Per-frame errors are already caught at the operation boundary
  // (parseFrames destroys the offending socket), so a rejection reaching here
  // is a latent missing-await bug, NOT necessarily corrupt global state.
  // Exiting on it would let any attacker-reachable input that provokes a
  // rejection become a repeatable multi-tenant DoS — killing every concurrent
  // session and forcing attestation + KMS key re-delivery churn (claude-adv
  // adversarial review). Log it loudly as an operator-actionable metric and
  // keep serving; the genuinely-corrupt-state case is covered by
  // uncaughtException above.
  // L2: stderr is host-visible — print only the rejection's error class
  // name, never the reason/promise objects (whose messages can embed
  // payload-derived content).
  process.on("unhandledRejection", (reason) => {
    const reasonName = reason instanceof Error ? reason.name : typeof reason;
    console.error(
      `[enclave] Unhandled Rejection (kept alive — see metric): name=${reasonName}`,
    );
    console.error(
      JSON.stringify({
        event: "metric",
        name: "calypso-enclave-unhandled-rejection",
        value: 1,
      }),
    );
  });

  const router = new EnclaveRouter();
  await router.init();

  const port = parseInt(process.env.ENCLAVE_PORT ?? "5000", 10);

  // Uses AF_VSOCK inside Nitro Enclaves (detected via /dev/nsm),
  // TCP on local dev. See vsock-listener.ts for the abstraction.
  const server = await createEnclaveListener((socket) => {
    parseFrames(socket, router);
  }, port);

  console.log(`[enclave] Mode: ${process.env.NODE_ENV ?? "development"}`);

  // Graceful shutdown
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.log(`[enclave] Received ${signal}, shutting down...`);
      server.close();
      process.exit(0);
    });
  }
}

// Only run main when executed directly (not when imported in tests)
if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error("[enclave] Fatal startup error:", err);
    process.exit(1);
  });
}
