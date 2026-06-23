import {
  ConnectorInvocationArgsSchema,
  ConnectorListArgsSchema,
  EGRESS_TAINT_READ_TOOLS,
  MEMORY_NAMESPACES,
  type AgentLinkedFolderContext,
  type BinaryWorkItemWriteRequestFrame,
  type ConnectedConnectorContext,
  type ConnectorDescriptor,
  type ConnectorModeEcho,
  type ConnectorOperation,
  type MediaProvenanceRecord,
  type MemoryMutationEnvelope,
  type MemoryNamespace,
  type SkillPack,
  type ToolCallLedgerEntry,
  type ToolInvocationFrame,
  type ToolName,
  type ToolResultFrame,
} from '@calypso/chat-types';

import { randomUUID } from 'node:crypto';

import { isToolBanned, isToolInScope } from './scope-check';
import { EgressTaintLedger } from './egress-taint';
import { sanitizeToolOutputForModel } from '../agent/tool-output-sanitizer';
import { buildConnectorListView } from '../agent/prompt';
import {
  getAllConnectors,
  getConnector,
  getConnectorOperation,
  isConnectorRegistryLoaded,
} from '../connectors/registry';
import {
  admitConnectorInvocation,
  applyConnectorReadDefaults,
  buildConnectorLedgerEntry,
  checkConnectorTurnBudget,
  MAX_CONNECTOR_MUTATIONS_PER_TURN,
  MAX_CONNECTOR_READS_PER_TURN,
  type ConnectorLedgerModeInEffect,
  type ConnectorTurnBudgetOverride,
  type ConnectorTurnState,
} from './tier-connector';
import * as tierA from './tier-a-read';
import * as tierB from './tier-b-draft';
import * as tierMedia from './tier-media';
import * as tierResearch from './tier-research';
import {
  canonicaliseMemoryWrite,
  type PreparedMemoryWrite,
} from './tier-b-draft';
import type { UnsignedEnvelope } from '../dream/types';
import type { MediaToolRequest, MediaToolResult } from './media-tools';
import type {
  BinaryWorkItemManager,
  BinaryOutputChunk,
} from './binary-work-items';

export interface ClientBridge {
  invokeClient(frame: ToolInvocationFrame): Promise<ToolResultFrame>;
  /**
   * SELF-EMITTING variant of {@link invokeClient} for an air-gapped research
   * subagent's sibling gateway.
   *
   * The main `invokeClient` only awaits the resolver — it relies on the main
   * orchestrator pump's `tool-invocation` case to actually emit the
   * TOOL_INVOCATION wire frame to the client. A research subagent runs its OWN
   * agent loop on a sibling gateway whose `tool-invocation` events are consumed
   * privately by runResearchSubagent (the air gap); they NEVER reach the main
   * pump, AND the main pump is parked inside gateway.dispatch(research.ask)
   * awaiting approveQuery. So a sibling web.fetch's plain `invokeClient` creates
   * a resolver that is never delivered a frame and times out → "no web access".
   *
   * This variant solves the suspended-pump problem the same way `approveQuery`
   * does: it registers the resolver then SELF-EMITs the TOOL_INVOCATION frame
   * onto the reverse-channel output queue. Optional so existing test bridges and
   * any non-pump caller keep working; createSiblingGateway falls back to the
   * plain `invokeClient` when this is absent.
   */
  invokeClientFromSibling?(
    frame: ToolInvocationFrame,
  ): Promise<ToolResultFrame>;
  /**
   * Surface the EXACT `query` string to the user for approval before an
   * outbound research question is dispatched. The host/client UI must show
   * the unmodified query string (Phase 3 builds the UI; Phase 2 tests stub
   * this). Returns true if the user approved, false or undefined if declined.
   * Absent (undefined) → fail-closed: no approval channel means no outbound query.
   */
  approveQuery?(req: { turnId: string; query: string }): Promise<boolean>;
}

/**
 * Narrow surface of the session manager that the gateway's memory.write
 * path needs. Defined as a structural interface so the dispatcher tests
 * can substitute a stub without standing up the full TLS-derived key
 * pipeline.
 */
export interface SessionManagerLike {
  storeUnsignedEnvelopes(
    sessionId: string,
    dreamSessionId: string,
    entries: Array<[number, UnsignedEnvelope]>,
  ): Promise<void>;
  finaliseDreamEnvelopes(
    sessionId: string,
    dreamSessionId: string,
    items: Array<{
      deltaIndex: number;
      contentHash: string;
      recordSerialisedHash: string;
    }>,
  ): Promise<
    Array<
      | {
          ok: true;
          deltaIndex: number;
          envelopeJson: string;
          signature: string;
          signedEnvelope: MemoryMutationEnvelope;
        }
      | {
          ok: false;
          deltaIndex: number;
          error:
            | 'unknown_dream_session'
            | 'unknown_delta_index'
            | 'finalise_timeout'
            | 'record_serialised_mismatch'
            | 'content_hash_invalid';
        }
    >
  >;
  cacheSignedFinalisation(
    sessionId: string,
    agentTurnId: string,
    invocationId: string,
    entry: {
      signedEnvelope: MemoryMutationEnvelope;
      signature: string;
      contentHash: string;
      recordSerialisedHash: string;
      signedAt: number;
      pendingClientAck: boolean;
      signedBlobB64: string;
    },
  ): Promise<void>;
  lookupSignedFinalisation(
    sessionId: string,
    agentTurnId: string,
    invocationId: string,
  ): Promise<{
    signedEnvelope: MemoryMutationEnvelope;
    signature: string;
    contentHash: string;
    recordSerialisedHash: string;
    signedBlobB64: string;
  } | null>;
}

export interface ToolGatewayDeps {
  clientBridge: ClientBridge;
  mediaTools?: {
    start?: () => Promise<void>;
    stop?: () => void;
    isReady?: () => boolean;
    run: (request: MediaToolRequest) => Promise<MediaToolResult>;
  };
  binaryWorkItems?: BinaryWorkItemManager;
  /**
   * Required for memory.write; the dispatcher stores the unsigned envelope,
   * relays the encrypt-and-finalise round-trip via the bridge, signs via
   * the shared dream-finalise handler, and caches the signed bytes for
   * R8-H1 post-sign network-drop recovery. Tier-A tools and the other
   * Tier-B draft tools don't require it.
   */
  sessionManager?: SessionManagerLike;
  /**
   * Authenticated user identifier for the current AGENT_REQUEST stream.
   * Plumbed from the server route (server-authoritative; the better-auth
   * session derives it). memory.write stamps this into the signed envelope
   * regardless of what the model supplied — R4 Finding 1 (Codex).
   */
  userId?: string;
  /**
   * The TEE session id for the current AGENT_REQUEST stream.
   * memory.write uses this as `teeSessionId` in the signed envelope.
   */
  sessionId?: string;
  /**
   * R7 Finding A (Codex): handed to the agent loop so it can prepare
   * the sanitised memory.write frame BEFORE yielding TOOL_INVOCATION
   * on the wire, then hand the prepared state back to the gateway at
   * dispatch time so the canonicalisation isn't run twice with
   * different randomUUID() / clock seeds. Direct-dispatch tests can
   * omit this — handleMemoryWrite falls back to inline canonicalisation.
   */
  takePreparedMemoryWrite?: (
    invocationId: string,
  ) => PreparedMemoryWrite | null;
  /**
   * Server/client-authoritative linked-folder context for this AGENT_REQUEST
   * stream (`requestContext.linkedFolders`): the {folderId, displayName} pairs
   * for exactly the folders bound to the active skill. The Tier-A/B/media
   * folder handlers use it to canonicalise a frame whose folder the model
   * referenced by (masked) displayName instead of opaque folderId — see
   * `folder-resolver.ts`. Absent on direct-dispatch / test callers, in which
   * case a model-supplied folderId passes through unchanged.
   */
  linkedFolders?: readonly AgentLinkedFolderContext[];
  /**
   * Connected-connector context for this AGENT_REQUEST stream
   * (`requestContext.connectedConnectors`). MODE-FREE by construction (the
   * schema strips any per-connector mode) — this is the admission input the
   * connector.* dispatch passes to `admitConnectorInvocation`. Each entry was
   * already filtered client-side to a connector BOUND to the active pack and not
   * revoked, so the set of `connectorId`s here IS the bound-connector set the
   * admission ctx needs. Absent on direct-dispatch / non-connector callers.
   */
  connectedConnectors?: readonly ConnectedConnectorContext[];
  /**
   * (spec §6 invariant 2 — S5 STRUCTURAL) Ledger-only per-connector mode echoes,
   * carried on a SEPARATE field from `connectedConnectors`. The connector.*
   * dispatch routes these ONLY into `buildConnectorLedgerEntry`, NEVER into
   * admission — which receives the mode-free `connectedConnectors`. A compromised
   * client echoing a permissive mode therefore changes no gate decision; the
   * mode is recorded for the audit trail only.
   */
  connectorModeEchoes?: readonly ConnectorModeEcho[];
  /**
   * (spec §6 invariant 4) Optional owner-raised per-turn connector budget. Absent
   * ⇒ the enclave enforces its MEASURED baseline (MAX_CONNECTOR_*_PER_TURN). A
   * present override may only RAISE a cap (or set it "unbounded") — a
   * hijacked-MODEL guard, never a user-facing control. The connector.* dispatch
   * passes it to `checkConnectorTurnBudget`.
   */
  connectorTurnBudgetOverride?: ConnectorTurnBudgetOverride;
  /**
   * Single-mode egress lock (defense-in-depth). When true, block ANY web.fetch
   * once a private read was OBSERVED this turn (content-independent — a short
   * secret that harvests no grams/tokens still trips it), not just one whose
   * URL/query reproduces harvested content. Set for runMode 'single', where
   * read tools and web.fetch can co-reside in one model context (orchestrator
   * mode isolates them across subtasks instead). FREE turns carry no web.fetch
   * at all, so this only bites a PRO/MAX single-mode turn co-locating read +
   * egress.
   */
  strictEgressLock?: boolean;
  /**
   * Per-invocation MODEL-VISIBLE byte budget for read tools (memory/file/folder/
   * media — the EGRESS_TAINT_READ_TOOLS set). Enforced on the SERIALISED
   * resultJson (contentB64 + extracted text + metadata + records), so it can't
   * be bypassed by base64 expansion or the memory path. Unset ⇒ no extra cap
   * (paid; the standard ~5 MiB raw aggregate still applies). Set tighter for
   * FREE so a low-cost agent can't pull large payloads into context — the
   * per-turn tool-call cap bounds call COUNT, not bytes.
   */
  readAggregateByteCap?: number;
  /**
   * Resolved cross-pack authorization for this request. Absent → single-namespace
   * (today's) behaviour. Populated by the enclave request path AFTER purpose binding
   * + commitment verification (see enclave/src/agent/cross-pack-grant.ts).
   */
  crossPackGrant?: {
    namespaces: ReadonlySet<MemoryNamespace>;
    folderIds: ReadonlySet<string>;
    documentIds: ReadonlySet<string>;
  };
  /**
   * Factory that creates a ChatProcessor for the air-gapped research subagent
   * (Task 2C.1). Called with RESEARCH_MODEL and must return a chat-capable
   * processor. Absent → research.ask rejects RESEARCH_UNAVAILABLE (fail-closed).
   * In production this is `(modelId) => this.createProcessorForModelId(modelId)`;
   * tests inject a fake provider.
   */
  researchProviderFactory?: (modelId: string) => import('@calypso/chat-types').ChatProcessor;
}

export type { PreparedMemoryWrite };

export type PrepareInvocationResult =
  | { ok: true; wireFrame: ToolInvocationFrame; preparedKey?: string }
  | {
      ok: false;
      reason: string;
      ledgerEntry: Omit<ToolCallLedgerEntry, 'id'>;
      gatewayResult: DispatchResult;
    };

export type DispatchResult = ToolResultFrame & {
  ledgerEntry: Omit<ToolCallLedgerEntry, 'id'>;
  clientOnlyBinaryWrite?: {
    folderId: string;
    displayName: string;
    request: BinaryWorkItemWriteRequestFrame;
    chunks: BinaryOutputChunk[];
    /**
     * Preview-only delivery (F1 image generation with no granted folder). When
     * true the client reassembles + sha-verifies the bytes and surfaces the
     * in-app preview, but performs NO folder write (folderId is empty). Absent /
     * false = the normal folder-save path. Worker binary tools never set this.
     */
    previewOnly?: boolean;
    /**
     * #1 attestation-rooted provenance: the in-TEE-signed MediaProvenanceRecord
     * for a generated IMAGE output, delivered alongside the bytes so the client
     * can verify the image against the attestation-published provenance public
     * key (verifyMediaProvenance). Rides this payload so it pairs with the bytes
     * by request.outputId. Metadata-only (ids/kind/sha256/signature) — carries
     * NO plaintext prompt/content. Only the image-generate path sets this;
     * worker binary tools (document.edit/pdf.edit/image.transform) leave it
     * absent, and the client fails closed (renders "unverified") when absent.
     */
    provenance?: MediaProvenanceRecord;
  };
};

export class ToolGateway {
  /**
   * R7 Finding A (Codex): persisted prepared state from `prepareInvocation`.
   * Keyed by invocationId; consumed (deleted) at dispatch time by the
   * deps.takePreparedMemoryWrite seam that the gateway wires into deps.
   */
  private readonly preparedMemoryWrites = new Map<
    string,
    PreparedMemoryWrite
  >();

  /**
   * Per-session content-egress taint ledger. Harvests plaintext returned by
   * read tools (memory/file/folder) and blocks any later `web.fetch` whose
   * URL/query reproduces it — closing the "read private data then exfiltrate
   * via web.fetch" path the default skill pack otherwise enables.
   */
  private readonly egressTaint = new EgressTaintLedger();

  /**
   * Cumulative model-visible read bytes per turn, for the FREE read budget
   * (readAggregateByteCap). Keyed by turnId so the cap is enforced ACROSS all
   * reads in a turn, not per individual result.
   */
  private readonly readBytesByTurn = new Map<string, number>();

  /**
   * Per-turn connector invocation budget state ({ mutations, reads }), keyed by
   * turnId. The SAME ToolGateway instance services every orchestrator subtask in
   * a request (see the claims-audit note above), so this is keyed by turnId —
   * mirroring `readBytesByTurn` — so the §6-invariant-4 per-turn caps accumulate
   * across all connector.* dispatches in one turn rather than resetting per call.
   * Lives only for the request (stateless enclave); never persisted.
   */
  private readonly connectorTurnStateByTurn = new Map<
    string,
    ConnectorTurnState
  >();

  /**
   * Phase 4 claims audit (observability ONLY — never gates a read or egress).
   * Per-REQUEST aggregation, recorded on the SUCCESS path of dispatch() AFTER
   * every existing guard has already passed and the result is finalised:
   *
   *  - `exercisedNamespaces`: the MemoryNamespace of each SUCCESSFUL memory.read
   *    / memory.list. These are the only Tier-A reads that resolve a typed
   *    MemoryNamespace (folder/file reads resolve a folderId, which the client
   *    already holds — they feed the receipt's folderIds, not this set). Deduped
   *    by Set semantics; only successful reads land here (gated on outcome ok).
   *  - `fetchedUrls`: the deduped source URLs the air-gapped research subagent
   *    actually fetched, recorded via recordResearchFetchedUrls() from
   *    tier-research.run with the subagent's `sources` REGARDLESS of the
   *    research.ask outcome (so a URL fetched before a subagent timeout/failure
   *    is still audited — privacy policy §19 / DPIA §5.5 must not under-report
   *    egress). `sources` lists ONLY successful web.fetch URLs. The research
   *    subagent is the ONLY egress path, so this is the sole URL collection
   *    point. NOTE: unlike exercisedNamespaces, fetchedUrls is NOT gated on the
   *    dispatch ok-path.
   *
   * The same ToolGateway instance services every orchestrator subtask (see
   * executor.ts: runAgentLoop is called with `gateway: deps.gateway`), so these
   * sets aggregate ALL reads/fetches across the request. Read once at run end in
   * enclave/src/index.ts to build the encrypted CLAIMS_SUMMARY frame.
   */
  private readonly exercisedNamespaces = new Set<MemoryNamespace>();
  private readonly fetchedUrls = new Set<string>();

  constructor(private readonly deps: ToolGatewayDeps) {
    this.deps = {
      ...deps,
      takePreparedMemoryWrite: (invocationId: string) => {
        const upstream = deps.takePreparedMemoryWrite?.(invocationId) ?? null;
        if (upstream) return upstream;
        const local = this.preparedMemoryWrites.get(invocationId) ?? null;
        if (local) this.preparedMemoryWrites.delete(invocationId);
        return local;
      },
    };
  }

  /**
   * R7 Finding A (Codex): produce the SANITISED wire frame BEFORE
   * the agent loop yields TOOL_INVOCATION. For non-memory.write tools
   * this is the identity (the model's frame is fine to expose because
   * gating/sanitisation isn't load-bearing for them). For memory.write
   * this is the canonical (delta, namespace, recordSerialisedHash)
   * triple the client must operate on; the prepared envelope state is
   * cached for dispatch.
   *
   * Errors that would have rejected dispatch (NAMESPACE_ESCAPE_REJECTED,
   * INVALID_DELTA_BASE_VERSION, etc.) surface here instead of after
   * the TOOL_INVOCATION frame goes out — so the wire never sees a
   * frame the gateway would have rejected.
   */
  prepareInvocation(
    frame: ToolInvocationFrame,
    pack: SkillPack,
    turnId: string,
  ): PrepareInvocationResult {
    const rejectionLedger = (
      reason: string,
    ): Omit<ToolCallLedgerEntry, 'id'> => ({
      invokedAt: new Date().toISOString(),
      toolName: frame.toolName,
      scope: '',
      approvedPath: null,
      outcome: 'gateway_rejected',
      reason,
      skillPackId: pack.id,
      turnId,
    });
    const rejection = (reason: string): PrepareInvocationResult => ({
      ok: false,
      reason,
      ledgerEntry: rejectionLedger(reason),
      gatewayResult: {
        invocationId: frame.invocationId,
        outcome: 'gateway_rejected',
        reason,
        ledgerEntry: rejectionLedger(reason),
      },
    });

    if (isToolBanned(frame.toolName)) return rejection('TIER_C_D_BANNED');
    if (!isToolInScope(frame.toolName, pack)) return rejection('OUT_OF_SCOPE');

    // Egress taint guard — reject BEFORE the TOOL_INVOCATION frame goes on
    // the wire, so a tainted web.fetch is never even dispatched to the client.
    if (frame.toolName === 'web.fetch' && this.isWebFetchTainted(frame)) {
      return rejection('TAINTED_EGRESS_BLOCKED');
    }

    // BUG-B — connector.read preflight MUST run BEFORE the wire frame is emitted.
    // The live agent loop yields prepared.wireFrame to the client (the client makes
    // the provider call) before dispatch() parks on the resolver. So read-side
    // safety checks that prevent an external provider read — catalog loaded,
    // admission, window/ceiling bounds, scope, and per-turn budget — belong here
    // too. This preflight never increments budgets; dispatch() remains the single
    // admission-consumption point and repeats the same checks for direct callers.
    if (frame.toolName === 'connector.read') {
      return this.prepareConnectorReadInvocation(frame, pack, turnId);
    }

    if (frame.toolName !== 'memory.write') {
      return { ok: true, wireFrame: frame };
    }

    if (!this.deps.userId || !this.deps.sessionId) {
      // The wire frame can't be prepared without auth context — but
      // the dispatch path will return UNAUTHENTICATED_AGENT_CONTEXT
      // anyway, so we surface that here instead of forwarding the
      // model's raw frame to the client.
      const reason = 'UNAUTHENTICATED_AGENT_CONTEXT';
      const ledger: Omit<ToolCallLedgerEntry, 'id'> = {
        ...rejectionLedger(reason),
        outcome: 'error',
      };
      return {
        ok: false,
        reason,
        ledgerEntry: ledger,
        gatewayResult: {
          invocationId: frame.invocationId,
          outcome: 'error',
          reason,
          ledgerEntry: ledger,
        },
      };
    }

    const result = canonicaliseMemoryWrite(
      frame,
      pack,
      {
        userId: this.deps.userId,
        sessionId: this.deps.sessionId,
        agentTurnId: frame.agentTurnId,
      },
      {
        now: Date.now(),
        mutationId: randomUUID(),
        addBlobId: randomUUID(),
      },
    );
    if (!result.ok) {
      const reason = result.reason;
      const ledger: Omit<ToolCallLedgerEntry, 'id'> = {
        ...rejectionLedger(reason),
        outcome: 'error',
      };
      return {
        ok: false,
        reason,
        ledgerEntry: ledger,
        gatewayResult: {
          invocationId: frame.invocationId,
          outcome: 'error',
          reason,
          ledgerEntry: ledger,
        },
      };
    }

    this.preparedMemoryWrites.set(frame.invocationId, result.prepared);
    return {
      ok: true,
      wireFrame: result.prepared.sanitisedFrame,
      preparedKey: frame.invocationId,
    };
  }

  private prepareConnectorReadInvocation(
    frame: ToolInvocationFrame,
    pack: SkillPack,
    turnId: string,
  ): PrepareInvocationResult {
    const echoes = this.deps.connectorModeEchoes ?? [];
    const reject = (
      reason: string,
      connectorId?: string,
      operation?: string,
    ): PrepareInvocationResult => {
      const gatewayResult = this.connectorReject(
        frame,
        pack,
        turnId,
        reason,
        echoes,
        connectorId,
        operation,
      );
      return {
        ok: false,
        reason,
        ledgerEntry: gatewayResult.ledgerEntry,
        gatewayResult,
      };
    };

    if (!isConnectorRegistryLoaded()) {
      return reject('CONNECTOR_CATALOG_NOT_LOADED');
    }

    const parsed = ConnectorInvocationArgsSchema.safeParse(frame.args);
    if (!parsed.success) {
      return reject('CONNECTOR_INVOCATION_ARGS_INVALID');
    }
    const { connectorId, operation, params } = parsed.data;

    let effectiveParams = params;
    let wireFrame = frame;
    const readOp = getConnector(connectorId)?.operations.find(
      (o) => o.id === operation,
    );
    if (readOp) {
      const defaulted = applyConnectorReadDefaults(readOp, params);
      if (defaulted !== params) {
        effectiveParams = defaulted;
        wireFrame = {
          ...frame,
          args: { connectorId, operation, params: defaulted },
        };
      }
    }

    const connected = this.deps.connectedConnectors ?? [];
    const connectedForAdmission = connected.map((c) => ({
      connectorId: c.connectorId,
      displayName: c.displayName,
      status: c.status,
      grantedScopes: c.grantedScopes,
    }));
    const admission = admitConnectorInvocation({
      catalog: getAllConnectors() ?? [],
      pack: { toolScopes: pack.toolScopes },
      connectedConnectors: connectedForAdmission,
      boundConnectorIds: this.boundConnectorIdsFromContext(connected),
      tool: 'connector.read',
      connectorId,
      operation,
      params: effectiveParams,
    });
    if (!admission.ok) {
      return reject(admission.reason, connectorId, operation);
    }

    const scopeDescriptor = getConnector(connectorId);
    const scopeOp = scopeDescriptor?.operations.find((o) => o.id === operation);
    const grantedScopes =
      connected.find((c) => c.connectorId === connectorId)?.grantedScopes ?? [];
    if (
      scopeDescriptor &&
      scopeOp &&
      !connectorOperationScopeSatisfied(scopeDescriptor, scopeOp, grantedScopes)
    ) {
      return reject('CONNECTOR_SCOPE_NOT_GRANTED', connectorId, operation);
    }

    const budget = checkConnectorTurnBudget(
      this.connectorTurnState(turnId),
      'connector.read',
      this.deps.connectorTurnBudgetOverride,
    );
    if (!budget.ok) {
      return reject(budget.reason, connectorId, operation);
    }

    return { ok: true, wireFrame };
  }

  /** Test seam: read prepared state without consuming it. */
  __peekPreparedMemoryWrite(invocationId: string): PreparedMemoryWrite | null {
    return this.preparedMemoryWrites.get(invocationId) ?? null;
  }

  /**
   * Spawn a sibling gateway for an air-gapped research subagent: shares the
   * stateless deps but gets a BRAND-NEW (empty) EgressTaintLedger automatically
   * (each ToolGateway constructs its own at field-init), with NO linked folders,
   * NO cross-pack grant, egress lock disabled, NO researchProviderFactory (so
   * research.ask on a sibling fails RESEARCH_UNAVAILABLE — no transitive
   * delegation), and a stripped clientBridge that exposes only invokeClient
   * (no approveQuery — a sibling has no user-approval channel). See spec §4.3.
   */
  createSiblingGateway(overrides: {
    linkedFolders?: readonly AgentLinkedFolderContext[];
  }): ToolGateway {
    // Grounding: a sibling's web.fetch has no orchestrator pump to emit its
    // TOOL_INVOCATION frame (its loop events are consumed privately by
    // runResearchSubagent — the air gap), so prefer the SELF-EMITTING
    // invokeClientFromSibling that pushes the frame itself. Fall back to the
    // plain invokeClient when the parent bridge does not provide it (existing
    // test bridges / back-compat). approveQuery is still stripped — a sibling
    // has no user-approval channel.
    const siblingInvokeClient = this.deps.clientBridge.invokeClientFromSibling
      ? this.deps.clientBridge.invokeClientFromSibling.bind(
          this.deps.clientBridge,
        )
      : this.deps.clientBridge.invokeClient.bind(this.deps.clientBridge);
    return new ToolGateway({
      ...this.deps,
      linkedFolders: overrides.linkedFolders ?? [],
      strictEgressLock: false,
      crossPackGrant: undefined, // never grant the research worker private access
      researchProviderFactory: undefined, // no transitive delegation — research.ask → RESEARCH_UNAVAILABLE
      clientBridge: {
        invokeClient: siblingInvokeClient,
      },
    });
  }

  /**
   * Layer-2 identifier backstop for research.ask (Task 2C.1).
   * Returns true if `text` (the compiled research query string) reproduces any
   * content harvested by this gateway's egress-taint ledger — i.e. private-doc
   * content from this turn's reads. Keeps the EgressTaintLedger private while
   * giving the tier-research handler a clean public surface.
   *
   * Signature mirrors isEgressTainted(url, query): passes `text` as the URL arg
   * and '' as the query arg. The ledger normaliser strips the resulting trailing
   * separator space before gram/token matching, so the match is effectively on
   * the query content alone.
   */
  isQuestionEgressTainted(text: string): boolean {
    return this.egressTaint.isEgressTainted(text, '');
  }

  /**
   * Consent-gated private-read → web bridge: promote a SPECIFIC private datum
   * the user has explicitly authorised across the egress boundary. After this,
   * an egress reproducing only the promoted datum passes the taint guard; every
   * un-promoted harvested datum stays blocked. The orchestrator calls this only
   * after a user APPROVED a promotion via the bridge consent surface (default
   * deny) — never automatically.
   */
  promoteEgress(datum: string): void {
    this.egressTaint.promote(datum);
  }

  /**
   * Test-only seam: expose the egress-taint ledger for Layer-2 test assertions
   * without requiring the private-field cast `(gw as unknown as {egressTaint}).egressTaint`.
   * Parallel to `__peekPreparedMemoryWrite`. Do NOT use in production paths.
   */
  __egressTaintForTest(): EgressTaintLedger {
    return this.egressTaint;
  }

  /**
   * Test-only seam: read the per-turn connector budget state for a turnId
   * WITHOUT mutating it (returns a defensive copy; an unseen turn reads as
   * zeroed). Parallel to `__egressTaintForTest`. Do NOT use in production paths.
   */
  __connectorTurnStateForTest(
    turnId: string,
  ): Pick<ConnectorTurnState, 'mutations' | 'reads'> {
    const state = this.connectorTurnStateByTurn.get(turnId) ?? {
      mutations: 0,
      reads: 0,
    };
    return { mutations: state.mutations, reads: state.reads };
  }

  /**
   * Test-only seam: read the §12 #2 turn-scoped destructive lock for a turnId
   * WITHOUT mutating it (returns a defensive sorted copy of the connector ids
   * that have armed the lock; an unseen turn reads as empty). Lets a test assert
   * the invariant "a destructive op arms exactly its own connector id and that
   * id persists for the turn" directly, rather than only via end-to-end
   * rejection observation. Do NOT use in production paths.
   */
  __connectorDestructiveLockForTest(turnId: string): string[] {
    const state = this.connectorTurnStateByTurn.get(turnId);
    return state ? [...state.destructiveConnectors].sort() : [];
  }

  async dispatch(
    frame: ToolInvocationFrame,
    pack: SkillPack,
    turnId: string,
  ): Promise<DispatchResult> {
    const reject = (reason: string): DispatchResult => ({
      invocationId: frame.invocationId,
      outcome: 'gateway_rejected',
      reason,
      ledgerEntry: {
        invokedAt: new Date().toISOString(),
        toolName: frame.toolName,
        scope: '',
        approvedPath: null,
        outcome: 'gateway_rejected',
        reason,
        skillPackId: pack.id,
        turnId,
      },
    });

    if (isToolBanned(frame.toolName)) return reject('TIER_C_D_BANNED');
    // F3: Policy-driven web.fetch block — any pack that declares crossPackNamespaces
    // (i.e. any cross-pack pack) is forbidden from calling web.fetch directly.
    // This guard fires BEFORE isToolInScope so the reason is unambiguous
    // (WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK, not the generic OUT_OF_SCOPE), and
    // future cross-pack packs inherit the backstop automatically.
    if (
      Array.isArray(pack.crossPackNamespaces) &&
      pack.crossPackNamespaces.length > 0 &&
      frame.toolName === 'web.fetch'
    ) {
      return reject('WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK');
    }
    if (!isToolInScope(frame.toolName, pack)) return reject('OUT_OF_SCOPE');

    // Egress taint guard — defence regardless of entry path (some callers
    // dispatch directly without prepareInvocation).
    if (frame.toolName === 'web.fetch' && this.isWebFetchTainted(frame)) {
      return reject('TAINTED_EGRESS_BLOCKED');
    }

    let result: DispatchResult;
    switch (frame.toolName) {
      case 'memory.list':
      case 'memory.read':
      case 'folder.list':
      case 'folder.read':
      case 'file.read':
      case 'web.fetch':
        result = await tierA.run(frame, this.deps, pack, turnId);
        break;
      case 'memory.write':
      case 'email.draft':
      case 'doc.draft':
      case 'event.draft':
      case 'folder.write':
        result = await tierB.run(frame, this.deps, pack, turnId);
        break;
      case 'image.inspect':
      case 'image.ocr':
      case 'image.transform':
      case 'audio.inspect':
      case 'audio.transcribe':
      case 'audio.transform':
      case 'video.inspect':
      case 'video.transcribe':
      case 'video.transform':
      case 'document.edit':
      case 'pdf.edit':
        result = await tierMedia.run(frame, this.deps, pack, turnId);
        break;
      case 'research.ask':
        result = await tierResearch.run(frame, this.deps, pack, turnId, this);
        break;
      case 'connector.list':
      case 'connector.read':
      case 'connector.act':
        // Connector ops have their OWN admission/budget/ledger path AND their own
        // egress-taint harvest (connector.read taints inside dispatchConnector),
        // so they return directly here and do NOT ride the generic post-dispatch
        // read-byte budget / claims-audit / harvesting block below. The client
        // fulfils the op against the external service and returns resultJson; the
        // enclave RELAYS that result and (for connector.read) harvests its
        // model-visible bytes into the egress-taint ledger — so the datum transits
        // the TEE but is never persisted (the TEE stays stateless).
        return this.dispatchConnector(frame, pack, turnId);
      default:
        return reject('UNHANDLED_TOOL');
    }

    // FREE-tier model-visible read budget. Bounds the ACTUAL bytes read tools
    // reinject into the model context, enforced CUMULATIVELY across the turn (so
    // N reads each just under the cap can't sum past it) and measured on the
    // EXACT sanitized reinjection string the model receives (pretty-printed
    // JSON + fence escaping + wrapper lines — not compact JSON.stringify). A
    // single choke point covering every read tool (file/folder/memory/media),
    // so it can't be bypassed by base64 expansion, the memory path, or
    // per-result accounting.
    if (
      result.outcome === 'ok' &&
      this.deps.readAggregateByteCap !== undefined &&
      EGRESS_TAINT_READ_TOOLS.has(frame.toolName as ToolName)
    ) {
      let modelVisibleBytes: number;
      try {
        const reinjected = sanitizeToolOutputForModel({
          toolName: frame.toolName,
          outcome: 'ok',
          payload: result.resultJson,
        });
        modelVisibleBytes = Buffer.byteLength(reinjected, 'utf8');
      } catch {
        modelVisibleBytes = Number.POSITIVE_INFINITY; // non-serialisable → fail closed
      }
      const usedThisTurn = this.readBytesByTurn.get(turnId) ?? 0;
      if (usedThisTurn + modelVisibleBytes > this.deps.readAggregateByteCap) {
        return reject('TOOL_RESULT_TOO_LARGE');
      }
      this.readBytesByTurn.set(turnId, usedThisTurn + modelVisibleBytes);
    }

    // Harvest sensitive read output so a later web.fetch can't exfiltrate it.
    if (result.outcome === 'ok') {
      this.harvestEgressTaint(frame.toolName, result.resultJson);
      // Phase 4 claims audit (observability only). Record AFTER the result is
      // finalised, gated on outcome 'ok' so only SUCCESSFUL reads/fetches land.
      this.recordClaimsAudit(frame.toolName, result.resultJson);
    }
    return result;
  }

  /**
   * connector.* dispatch (Task 11, spec §5.2 / §6 / §12).
   *
   * Self-contained path for the three generic connector tool families. Order:
   *   1. registry guard (fail-closed if the signed catalog isn't loaded)
   *   2. parse args FIRST (defaults `params` to `{}`) — BEFORE any catalog lookup
   *   3. connector.list → runtime view, envelope-wrapped, NOT metered, no egress
   *   4. connector.read/act → admission (mode-FREE) → budget → increment-at-
   *      admission → hand to the client fulfiller → ledger (with the mode echo)
   *
   * STRUCTURAL S5 boundary (R2-low-2): `connectedConnectors` (mode-free) +
   * `connectorTurnBudgetOverride` feed admission/budget; `connectorModeEchoes`
   * reach ONLY `buildConnectorLedgerEntry`. The whole request context is never
   * handed to admission — its ctx type has no echoes field, so a future refactor
   * is type-incapable of turning the ledger mode into a gate input.
   */
  private async dispatchConnector(
    frame: ToolInvocationFrame,
    pack: SkillPack,
    turnId: string,
  ): Promise<DispatchResult> {
    const tool = frame.toolName;
    const connected = this.deps.connectedConnectors ?? [];
    const echoes = this.deps.connectorModeEchoes ?? [];

    // 1 — registry guard: fail closed if the signed catalog is not loaded.
    if (!isConnectorRegistryLoaded()) {
      return this.connectorReject(
        frame,
        pack,
        turnId,
        'CONNECTOR_CATALOG_NOT_LOADED',
        echoes,
      );
    }

    // 2 — parse args FIRST (defaults `params` to `{}`), before catalog lookup.
    if (tool === 'connector.list') {
      const parsed = ConnectorListArgsSchema.safeParse(frame.args);
      if (!parsed.success) {
        return this.connectorReject(
          frame,
          pack,
          turnId,
          'CONNECTOR_INVOCATION_ARGS_INVALID',
          echoes,
        );
      }
      // Run the documented connector.list admission ladder (spec §5.2) so its
      // checks are LIVE, not dead code: the pack must expose a connector.* scope
      // and a SCOPED list (explicit connectorId) must target a BOUND + CONNECTED
      // connector. Without this, `connector.list({connectorId: <unbound/unknown>})`
      // is silently emptied instead of rejected, and the documented ladder drifts
      // from what runs. Mode-FREE: connectedConnectors carries no mode (S5).
      const listAdmission = admitConnectorInvocation({
        catalog: getAllConnectors() ?? [],
        pack: { toolScopes: pack.toolScopes },
        connectedConnectors: connected.map((c) => ({
          connectorId: c.connectorId,
          displayName: c.displayName,
          status: c.status,
          grantedScopes: c.grantedScopes,
        })),
        boundConnectorIds: this.boundConnectorIdsFromContext(connected),
        tool,
        connectorId: parsed.data.connectorId,
      });
      if (!listAdmission.ok) {
        return this.connectorReject(
          frame,
          pack,
          turnId,
          listAdmission.reason,
          echoes,
          parsed.data.connectorId,
        );
      }
      return this.dispatchConnectorList(
        frame,
        pack,
        turnId,
        parsed.data.connectorId,
        connected,
        echoes,
      );
    }

    const parsed = ConnectorInvocationArgsSchema.safeParse(frame.args);
    if (!parsed.success) {
      return this.connectorReject(
        frame,
        pack,
        turnId,
        'CONNECTOR_INVOCATION_ARGS_INVALID',
        echoes,
      );
    }
    const { connectorId, operation, params } = parsed.data;

    // BUG-B — for a connector.read whose catalog op declares a results ceiling,
    // default an ABSENT results-count to that ceiling BEFORE admission, so a model
    // that omits the technical maxResults cap gets a reliable BOUNDED read instead
    // of an intermittent CONNECTOR_READ_RESULTS_REQUIRED reject ("calendar wasn't
    // available" / "rejected by the gateway"). The WINDOW is NOT defaulted (a time
    // range is semantically required). The defaulted params flow to BOTH admission
    // (so the gate sees a bounded value) AND the client frame (so the bound reaches
    // the provider call). A truly-absent cap still REJECTS at the gate for any
    // direct caller that bypasses this dispatch path (defense-in-depth).
    let effectiveParams = params;
    let effectiveFrame = frame;
    if (tool === 'connector.read') {
      const readOp = getConnector(connectorId)?.operations.find(
        (o) => o.id === operation,
      );
      if (readOp) {
        const defaulted = applyConnectorReadDefaults(readOp, params);
        if (defaulted !== params) {
          effectiveParams = defaulted;
          effectiveFrame = {
            ...frame,
            args: { connectorId, operation, params: defaulted },
          };
        }
      }
    }

    // The connected-connector ids ARE the bound set — a client-asserted
    // consistency check by C1 necessity, not enclave-side defense-in-depth. See
    // boundConnectorIdsFromContext for the full rationale.
    const boundConnectorIds = this.boundConnectorIdsFromContext(connected);

    // Build the admission catalog from the registry. Pass the whole catalog so
    // admission resolves the connector/op itself (it owns the unknown-id check).
    const catalog = getAllConnectors() ?? [];

    // 4a — admission (mode-FREE: connectedConnectors carries no mode).
    const admission = admitConnectorInvocation({
      catalog,
      pack: { toolScopes: pack.toolScopes },
      connectedConnectors: connected.map((c) => ({
        connectorId: c.connectorId,
        displayName: c.displayName,
        status: c.status,
        grantedScopes: c.grantedScopes,
      })),
      boundConnectorIds,
      tool,
      connectorId,
      operation,
      // PARSED/defaulted params — NOT raw frame.args — so a ceiling-declaring op
      // with no params field still fails closed (§12 read-side, defense-in-depth).
      // `effectiveParams` carries the BUG-B read-cap default (absent maxResults →
      // ceiling); the window is never defaulted, so an absent window still REQUIRES.
      params: effectiveParams,
    });
    if (!admission.ok) {
      return this.connectorReject(
        frame,
        pack,
        turnId,
        admission.reason,
        echoes,
        connectorId,
        operation,
      );
    }

    // 4a-bis — subsumption-aware granted-scope satisfaction, applied to the
    // INVOCATION (not just the connector.list discovery view). The SAME signed-
    // catalog check that HIDES a write op from a read-only grant in connector.list
    // is enforced here, so a write op reached by a DIRECT or alias-normalized
    // connector.act (which the planner was never shown) fails closed BEFORE the
    // budget / destructive lock / client modal — never a "confirm then provider
    // 403". Authoritative (it honours catalog scopeSubsumes, accounting for a
    // broader grant), so unlike admission's coarse flat-match (deliberately
    // inconclusive-never-reject) it is safe to hard-reject. Keeps "invocable" ==
    // "listed". Catalog-driven; names no connector/op (C1).
    {
      const scopeDescriptor = getConnector(connectorId);
      const scopeOp = scopeDescriptor?.operations.find(
        (o) => o.id === operation,
      );
      const grantedScopes =
        connected.find((c) => c.connectorId === connectorId)?.grantedScopes ??
        [];
      if (
        scopeDescriptor &&
        scopeOp &&
        !connectorOperationScopeSatisfied(scopeDescriptor, scopeOp, grantedScopes)
      ) {
        return this.connectorReject(
          frame,
          pack,
          turnId,
          'CONNECTOR_SCOPE_NOT_GRANTED',
          echoes,
          connectorId,
          operation,
        );
      }
    }

    // 4b — per-turn budget (override may RAISE the cap; never lower it).
    const override = this.deps.connectorTurnBudgetOverride;
    const turnState = this.connectorTurnState(turnId);
    const budget = checkConnectorTurnBudget(turnState, tool, override);
    if (!budget.ok) {
      return this.connectorReject(
        frame,
        pack,
        turnId,
        budget.reason,
        echoes,
        connectorId,
        operation,
      );
    }

    // 4b-bis — §12 #2 TURN-SCOPED DESTRUCTIVE-SEQUENCE GUARD (measured), ORDER-
    // SYMMETRIC. A `destructive` connector.act and ANY other mutating
    // connector.act on the SAME connector in the SAME turn cannot both execute as
    // two free-standing frames — whichever arrives SECOND is rejected
    // (CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED). This blocks BOTH laundering
    // orderings of a data-loss "replace":
    //   • delete → recreate    (a prior destructive op locks subsequent mutations)
    //   • create-new → delete-old  (a destructive op is rejected once ANY mutation
    //     already happened for that connector this turn)
    // Without the second arm a hijacked/prompt-injected model evades the guard
    // merely by emitting the replace create-first (Codex P1). COARSE STRUCTURAL +
    // resource-BLIND + content-INDEPENDENT, mirroring strictEgressLock: the enclave
    // sees only MASKED params and (S5) cannot trust client confirm-state, so it
    // cannot resource-match. Over-rejection (a destructive op + an UNRELATED
    // mutation on the same connector in one turn, EITHER order) is the SAFE
    // direction and is accepted. Keyed ONLY off the catalog `destructive`/`mutating`
    // flags + the connector.read/act tool family — names no connector/operation id
    // (the connectors-no-measured-coupling tripwire stays green). ORCHESTRATOR
    // coverage is automatic: every worker subtask runs runAgentLoop with the SAME
    // deps.agentTurnId + gateway, so this per-turn state is shared across subtasks.
    //
    // BY DESIGN there is no in-turn escape: the legitimate paths are unaffected — an
    // in-place edit uses the catalog's non-destructive update op (§12 rule 1, never
    // forms a pair), and a genuine delete+recreate is the CLIENT's combined-
    // confirmation flow (one modal), not two enclave frames. A blocked frame is
    // observable via the existing `gateway_rejected` ledger entry (no new
    // telemetry); recovery guidance ("prefer the in-place update op") rides the
    // UNMEASURED skill-prompts, not this measured reason code.
    //
    // Fail-CLOSED on an unresolvable op: an admitted connector.act ALWAYS resolves
    // here today (admission rejected CONNECTOR_UNKNOWN_OPERATION synchronously
    // above, with no await or catalog mutation between), so the unresolvable branch
    // is unreachable in the current flow. We still treat it AS destructive
    // (defense-in-depth) so a future refactor — or a thrown registry lookup
    // (hot-reload / schema panic) — over-blocks (SAFE) rather than failing OPEN.
    // `op.destructive` is a schema-defaulted boolean (chat-types
    // `z.boolean().default(false)`), so a catalog that OMITS the flag reads as
    // non-destructive by design — a mis-tagged op is a signed-catalog authoring
    // concern, not something measured code can infer.
    if (tool === 'connector.act') {
      let thisOpIsDestructive: boolean;
      try {
        const op = getConnectorOperation(connectorId, operation);
        thisOpIsDestructive = op === null || op.destructive === true;
      } catch {
        thisOpIsDestructive = true;
      }
      const blocked =
        // a prior destructive op on this connector locks ANY later mutation, OR
        turnState.destructiveConnectors.has(connectorId) ||
        // this op is destructive AND a prior mutation already happened for it.
        (thisOpIsDestructive && turnState.mutatedConnectors.has(connectorId));
      if (blocked) {
        return this.connectorReject(
          frame,
          pack,
          turnId,
          'CONNECTOR_DESTRUCTIVE_SEQUENCE_BLOCKED',
          echoes,
          connectorId,
          operation,
        );
      }
      // Record AFTER the block decision (so the op never self-blocks): every
      // admitted connector.act is a mutation; a destructive one also arms the lock.
      turnState.mutatedConnectors.add(connectorId);
      if (thisOpIsDestructive) {
        turnState.destructiveConnectors.add(connectorId);
      }
    }

    // 4c — INCREMENT AT ADMISSION (before fulfilment) so a failed/rate-limited
    // fulfilment still consumes the budget (Finding #11 — a retry hits the cap).
    if (tool === 'connector.act') {
      turnState.mutations += 1;
    } else {
      turnState.reads += 1;
    }

    // R4-6: mark the ledger when the effective override exceeded the measured
    // baseline (esp. "unbounded") — auditable, never a gate change.
    const uncapped = this.connectorOverrideExceedsBaseline(tool, override);

    // 4d — hand the admitted op to the client fulfiller (like folder.write):
    // the client calls the external service and returns the structured result.
    // `effectiveFrame` carries the BUG-B read-cap default in args.params so the
    // bound reaches the provider call (identical to `frame` for non-read / when no
    // default was applied).
    const result = await this.deps.clientBridge.invokeClient(effectiveFrame);

    // 4d-bis — FREE-tier model-visible read budget for connector.read. The generic
    // post-dispatch byte cap (readAggregateByteCap) lives BELOW the early return
    // that routed us into dispatchConnector, so a connector read would otherwise
    // escape it entirely: a large calendar payload would be reinjected to the model
    // while an equally large folder/memory/media read is rejected
    // TOOL_RESULT_TOO_LARGE. Meter it against the SAME per-turn counter
    // (readBytesByTurn) so connector + other reads share one budget, measured on the
    // exact sanitized reinjection string (the ACTUAL outcome/reason). Gated on
    // resultJson being PRESENT, NOT on outcome === 'ok' — mirroring the harvest
    // below and the dispatch's outcome-agnostic resultJson forward: a buggy/
    // rate-limited adapter that smuggles a large partial payload under an error
    // envelope is reinjected too, so it must be metered too. Checked BEFORE the
    // harvest: a rejected (over-cap) read is never reinjected, so there is nothing
    // to taint.
    if (
      tool === 'connector.read' &&
      this.deps.readAggregateByteCap !== undefined &&
      result.resultJson !== undefined
    ) {
      let modelVisibleBytes: number;
      try {
        modelVisibleBytes = Buffer.byteLength(
          sanitizeToolOutputForModel({
            toolName: tool,
            outcome: result.outcome,
            reason: result.reason,
            payload: result.resultJson,
          }),
          'utf8',
        );
      } catch {
        modelVisibleBytes = Number.POSITIVE_INFINITY; // non-serialisable → fail closed
      }
      const usedThisTurn = this.readBytesByTurn.get(turnId) ?? 0;
      if (usedThisTurn + modelVisibleBytes > this.deps.readAggregateByteCap) {
        return this.connectorReject(
          frame,
          pack,
          turnId,
          'TOOL_RESULT_TOO_LARGE',
          echoes,
          connectorId,
          operation,
        );
      }
      this.readBytesByTurn.set(turnId, usedThisTurn + modelVisibleBytes);
    }

    // 4e — egress-taint accounting for connector.read. The client fulfils the
    // read against the external service and returns resultJson, which the agent
    // loop reinjects to the planner verbatim — so a connector.read surfaces
    // PRIVATE external data into the model context exactly like folder.read /
    // memory.read. Without this, a same-turn web.fetch could exfiltrate calendar
    // (later: mail/chat) content the planner just read, and the single-mode
    // structural lock (keyed on observed private reads) would never trip — the
    // inverse of the boundary the rest of the taint ledger enforces.
    //
    // Gate on resultJson being PRESENT, NOT on outcome === 'ok': the dispatch
    // below forwards resultJson to the planner REGARDLESS of outcome, and this
    // path does NOT re-validate the bridge's return against the envelope contract
    // (ok:false ⇒ no data). So a non-conforming/buggy adapter returning
    // {ok:false, errorCode:'rate_limited', data:{...private...}} would otherwise
    // smuggle a private payload to the model UNtainted — arming neither the
    // single-mode lock nor the content-match guard. Tie the taint to exactly what
    // is reinjected. Only READS taint (connector.act is a mutation, mirroring
    // memory.write not being harvested); connector.list returns from its own
    // branch above (catalog metadata, not private external data).
    if (tool === 'connector.read' && result.resultJson !== undefined) {
      this.harvestConnectorReadEgressTaint(result.resultJson);
    }

    const modeInEffect = this.connectorModeInEffect(connectorId, echoes);
    const reason =
      result.outcome === 'ok' ? null : result.reason ?? null;
    const ledgerEntry = buildConnectorLedgerEntry({
      tool,
      connectorId,
      operation,
      outcome: result.outcome,
      modeInEffect,
      reason,
      skillPackId: pack.id,
      turnId,
      uncapped,
    });

    return {
      invocationId: frame.invocationId,
      outcome: result.outcome,
      ...(result.resultJson !== undefined
        ? { resultJson: result.resultJson }
        : {}),
      ...(result.resultB64 !== undefined ? { resultB64: result.resultB64 } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ledgerEntry,
    };
  }

  /** connector.list → runtime view ∩ connected, wrapped as { ok, data }. */
  private dispatchConnectorList(
    frame: ToolInvocationFrame,
    pack: SkillPack,
    turnId: string,
    scopeToConnectorId: string | undefined,
    connected: readonly ConnectedConnectorContext[],
    _echoes: readonly ConnectorModeEcho[],
  ): DispatchResult {
    // Intersect the registry catalog with the connected set (optionally narrowed
    // to one connector). The display name is the client-masked token from the
    // connected context (the enclave never holds the real label).
    const view = connected
      .filter(
        (c) =>
          (scopeToConnectorId === undefined ||
            c.connectorId === scopeToConnectorId) &&
          // Only advertise a CONNECTED connector. A needs_reauth connector still
          // rides in the request context (buildConnectedConnectorContext keeps
          // everything except revoked), but connector.read/act on it would be
          // rejected NOT_CONNECTED — so listing its operations would mislead the
          // planner into forming a doomed call. Mirror admission's isConnected
          // status gate here so the discovery view matches what is invocable.
          c.status === 'connected',
      )
      .map((c) => {
        const descriptor = getConnector(c.connectorId);
        if (!descriptor) return null;
        return {
          connectorId: c.connectorId,
          displayName: c.displayName,
          operations: descriptor.operations
            // v1 forbids binary ops; do not advertise an op the gateway would
            // hard-reject at admission.
            .filter((op) => op.binary !== true)
            .filter((op) =>
              connectorOperationScopeSatisfied(
                descriptor,
                op,
                c.grantedScopes,
              ),
            )
            .map((op) => ({
              id: op.id,
              mutating: op.mutating,
              paramsSchema: op.paramsSchema,
              contentFields: op.contentFields,
              maxWindowDays: op.maxWindowDays,
              maxResults: op.maxResults,
              windowParams: op.windowParams,
              maxResultsParam: op.maxResultsParam,
            })),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const data = buildConnectorListView(view);
    return {
      invocationId: frame.invocationId,
      outcome: 'ok',
      // Envelope-wrapped (Finding R2-3): { ok: true, data: { connectors: [...] } }.
      resultJson: { ok: true, data },
      ledgerEntry: buildConnectorLedgerEntry({
        tool: 'connector.list',
        connectorId: scopeToConnectorId,
        outcome: 'ok',
        modeInEffect: 'unknown',
        skillPackId: pack.id,
        turnId,
      }),
    };
  }

  /**
   * The connector ids the client asserts are BOUND to the active session.
   *
   * BY DESIGN this equals the connected set: under the C1 invariant the MEASURED
   * pack declares only the generic connector.* scopes (no per-connector literal),
   * so the enclave has no independent, measured source of "which connectors are
   * bound to THIS pack" — the authoritative bound set is the client's, surfaced as
   * `connectedConnectors` (buildConnectedConnectorContext already filters to bound
   * + not-revoked). The downstream admission binding predicate is therefore a
   * client-asserted CONSISTENCY check, NOT enclave-side defense-in-depth against a
   * compromised client: a client that already holds the user's OAuth token could
   * call the external service directly, so asserting a bogus binding grants it
   * nothing it didn't already have (documented threat model — spec §7.3 / §10).
   * The catalog lookup (admission check 1) independently rejects an UNKNOWN
   * connector regardless of this assertion. A real enclave-side binding gate would
   * require either a per-connector measured signal (a C1 violation) or a
   * server-authoritative binding record (out of Phase-0/1 scope). Centralised here
   * so the tautology is explicit and intentional rather than incidental.
   */
  private boundConnectorIdsFromContext(
    connected: readonly { connectorId: string }[],
  ): string[] {
    return connected.map((c) => c.connectorId);
  }

  /** Resolve (creating if absent) the per-turn connector budget state. */
  private connectorTurnState(turnId: string): ConnectorTurnState {
    let state = this.connectorTurnStateByTurn.get(turnId);
    if (!state) {
      // destructiveConnectors + mutatedConnectors back the §12 #2 turn-scoped
      // (order-symmetric) destructive-sequence lock.
      state = {
        mutations: 0,
        reads: 0,
        destructiveConnectors: new Set(),
        mutatedConnectors: new Set(),
      };
      this.connectorTurnStateByTurn.set(turnId, state);
    }
    return state;
  }

  /**
   * Harvest a connector.read result into the egress-taint ledger so a same-turn
   * web.fetch cannot exfiltrate the private external data the connector surfaced
   * to the model. Mirrors {@link harvestEgressTaint} for the connector envelope
   * shape ({ ok, data }):
   *  - marks the content-INDEPENDENT observed-private-read flag, which trips the
   *    single-mode structural egress lock even for an empty/short read; and
   *  - adds the serialised model-visible payload for the content-match guard.
   * The connector.* dispatch returns before the generic post-dispatch harvesting
   * block, so this is the connector path's equivalent hook.
   */
  private harvestConnectorReadEgressTaint(resultJson: unknown): void {
    // Observed-private-read first, before any parsing — a short/empty connector
    // read still arms the single-mode lock (parallels harvestEgressTaint).
    this.egressTaint.markPrivateReadObserved();
    if (resultJson === null || resultJson === undefined) return;
    // The model sees the `data` payload of the { ok, data } envelope; harvest its
    // string content for the content-match guard (fall back to the whole envelope
    // if the fulfiller returned a non-enveloped shape). We walk string LEAVES
    // rather than JSON.stringify the payload: a single all-or-nothing stringify
    // could THROW on a future non-serialisable adapter payload (BigInt, circular
    // ref) and — in ORCHESTRATOR mode, where the single-mode structural lock does
    // NOT apply and the content-match is the only gate — silently skip the harvest
    // entirely. The cycle-safe, depth-bounded walk below cannot throw, so the
    // content guard never silently misses.
    const data = (resultJson as { data?: unknown }).data ?? resultJson;
    this.harvestConnectorStrings(data);
  }

  /**
   * Feed EVERY string in `root` — string leaves AND object keys — into the
   * egress-taint ledger. ITERATIVE (an explicit heap stack, not recursion) so
   * there is NO call-stack depth limit and therefore no depth-based silent miss:
   * in orchestrator mode the single-mode structural lock does not apply, so the
   * content-match guard is the only gate against a connector.read → web.fetch
   * reproduction, and it must see the WHOLE payload (a fixed recursion-depth cap
   * would silently drop leaves below it — nested attendees / conferenceData /
   * message threads routinely nest deeply). Cycle-safe via a visited WeakSet. The
   * connector result is already size-bounded by the client transport, so a full
   * walk can't run away. Object KEYS are harvested too: a connector adapter may
   * carry identifying data in keys (e.g. an attendee-email-keyed RSVP map), not
   * only in values.
   */
  private harvestConnectorStrings(root: unknown): void {
    const seen = new WeakSet<object>();
    const stack: unknown[] = [root];
    while (stack.length > 0) {
      const value = stack.pop();
      if (typeof value === 'string') {
        if (value.length > 0) this.egressTaint.addText(value);
        continue;
      }
      if (value === null || typeof value !== 'object') continue;
      if (seen.has(value)) continue; // cycle guard
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) stack.push(item);
        continue;
      }
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (key.length > 0) this.egressTaint.addText(key);
        stack.push(child);
      }
    }
  }

  /**
   * The per-connector mode echo recorded on the ledger — "unknown" when no echo
   * matched (S5: ledger-only, never an authz input).
   */
  private connectorModeInEffect(
    connectorId: string,
    echoes: readonly ConnectorModeEcho[],
  ): ConnectorLedgerModeInEffect {
    const echo = echoes.find((e) => e.connectorId === connectorId);
    return echo?.writePermissionMode ?? 'unknown';
  }

  /**
   * True when the effective per-turn cap for `tool` exceeds the MEASURED
   * baseline — i.e. the owner raised it above the default (or to "unbounded").
   * Drives the auditable :uncapped ledger marker (R4-6). Pure observability.
   */
  private connectorOverrideExceedsBaseline(
    tool: ToolName,
    override: ConnectorTurnBudgetOverride | undefined,
  ): boolean {
    if (!override) return false;
    if (tool === 'connector.act') {
      const raw = override.mutationsPerTurn;
      if (raw === 'unbounded') return true;
      return typeof raw === 'number' && raw > MAX_CONNECTOR_MUTATIONS_PER_TURN;
    }
    if (tool === 'connector.read') {
      const raw = override.readsPerTurn;
      if (raw === 'unbounded') return true;
      return typeof raw === 'number' && raw > MAX_CONNECTOR_READS_PER_TURN;
    }
    return false;
  }

  /** Build a gateway_rejected connector DispatchResult with a connector ledger. */
  private connectorReject(
    frame: ToolInvocationFrame,
    pack: SkillPack,
    turnId: string,
    reason: string,
    echoes: readonly ConnectorModeEcho[],
    connectorId?: string,
    operation?: string,
  ): DispatchResult {
    const modeInEffect =
      connectorId !== undefined
        ? this.connectorModeInEffect(connectorId, echoes)
        : 'unknown';
    return {
      invocationId: frame.invocationId,
      outcome: 'gateway_rejected',
      reason,
      ledgerEntry: buildConnectorLedgerEntry({
        tool: frame.toolName,
        connectorId,
        operation,
        outcome: 'gateway_rejected',
        modeInEffect,
        reason,
        skillPackId: pack.id,
        turnId,
      }),
    };
  }

  /**
   * Phase 4: read-only claims-audit getters. Return frozen snapshots so a
   * caller (enclave/src/index.ts at run end) cannot mutate the live request
   * sets. Order is insertion order (Set semantics) — purely informational.
   */
  getExercisedNamespaces(): readonly MemoryNamespace[] {
    return [...this.exercisedNamespaces];
  }

  getFetchedUrls(): readonly string[] {
    return [...this.fetchedUrls];
  }

  /**
   * Phase 4: WRITE-ONLY URL-audit channel for the air-gapped research subagent.
   *
   * The research subagent runs on a sibling gateway (clean ledger, no grant, no
   * folders, no main-ledger access). The ONLY thing it hands back to the parent
   * is the list of URLs it ACTUALLY fetched — which is exactly what the claims
   * receipt must record. tier-research.run calls this with the subagent's
   * `sources` REGARDLESS of the research.ask outcome, so a URL that was fetched
   * before the subagent failed/timed out is still recorded (privacy policy §19 /
   * DPIA §5.5: the receipt records the URLs fetched, and must not under-report
   * egress). `sources` already contains ONLY successful web.fetch URLs
   * (runResearchSubagent's ok-gate is unchanged) — this never records attempts.
   *
   * This is the sibling's sole write-back surface; it grants the sibling NO read
   * access to parent state, the grant, folders, or the egress-taint ledger.
   */
  recordResearchFetchedUrls(sources: readonly unknown[]): void {
    for (const url of sources) {
      if (typeof url === 'string' && url.length > 0) {
        this.fetchedUrls.add(url);
      }
    }
  }

  /**
   * Phase 4: aggregate the request's exercised namespaces from a SUCCESSFUL
   * dispatch result. Pure observability — never reads inputs, never gates,
   * never widens scope. Called only after `result.outcome === 'ok'`.
   *
   * NOTE: fetched URLs are NOT recorded here. They are recorded directly in
   * tier-research.run via recordResearchFetchedUrls(), decoupled from the
   * research.ask dispatch outcome so a partial-but-failed run's already-fetched
   * URLs still reach the audit.
   */
  private recordClaimsAudit(toolName: string, resultJson: unknown): void {
    const isNs = (s: unknown): s is MemoryNamespace =>
      typeof s === 'string' &&
      (MEMORY_NAMESPACES as readonly string[]).includes(s);

    if (toolName === 'memory.read') {
      // tier-a-read validated the record against MemoryRecordSchema and confirmed
      // the namespace is authorised before this point, so resultJson.record
      // carries a real MemoryNamespace.
      const record = (resultJson as { record?: { namespace?: unknown } })
        ?.record;
      if (record && isNs(record.namespace)) {
        this.exercisedNamespaces.add(record.namespace);
      }
      return;
    }

    if (toolName === 'memory.list') {
      const records = (resultJson as { records?: unknown })?.records;
      if (Array.isArray(records)) {
        for (const rec of records) {
          const ns = (rec as { namespace?: unknown })?.namespace;
          if (isNs(ns)) this.exercisedNamespaces.add(ns);
        }
      }
      return;
    }
    // research.ask fetched URLs are recorded out-of-band in tier-research.run
    // (recordResearchFetchedUrls), NOT here — see that method's docstring.
  }

  /** True if web.fetch must be blocked for content-egress reasons. */
  private isWebFetchTainted(frame: ToolInvocationFrame): boolean {
    // Single-mode egress lock: once any private read has happened this turn,
    // block ALL egress — read + web.fetch share one model context here, so a
    // structural lock is the only guarantee (the content-match below is
    // heuristic and a model can re-encode/paraphrase past it). Keyed on the
    // content-INDEPENDENT observed flag so a short read (a PIN, a tiny
    // filename) that harvests no grams/tokens still trips the lock.
    if (
      this.deps.strictEgressLock &&
      this.egressTaint.hasObservedPrivateRead()
    ) {
      return true;
    }
    const args = frame.args as { url?: unknown; query?: unknown };
    const url = typeof args.url === 'string' ? args.url : '';
    const query = typeof args.query === 'string' ? args.query : '';
    return this.egressTaint.isEgressTainted(url, query);
  }

  /** Feed plaintext returned by read tools into the egress taint ledger. */
  private harvestEgressTaint(toolName: string, resultJson: unknown): void {
    // Mark the observed-private-read flag for ANY successful private read,
    // before any content parsing — a short/empty read still counts (used by the
    // single-mode egress lock, which must trip even when nothing is harvested).
    if (EGRESS_TAINT_READ_TOOLS.has(toolName as ToolName)) {
      this.egressTaint.markPrivateReadObserved();
    }
    const r = resultJson as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') return;

    const addRecord = (rec: unknown): void => {
      if (!rec || typeof rec !== 'object') return;
      const m = rec as Record<string, unknown>;
      if (typeof m.text === 'string') this.egressTaint.addText(m.text);
      if (m.structured && typeof m.structured === 'object') {
        this.egressTaint.addText(JSON.stringify(m.structured));
      }
      if (Array.isArray(m.tags)) {
        this.egressTaint.addText(
          m.tags.filter((t) => typeof t === 'string').join(' '),
        );
      }
      if (Array.isArray(m.provenance)) {
        for (const p of m.provenance) {
          if (
            p &&
            typeof p === 'object' &&
            typeof (p as { excerpt?: unknown }).excerpt === 'string'
          ) {
            this.egressTaint.addText((p as { excerpt: string }).excerpt);
          }
        }
      }
    };

    // Media extraction tools (image.ocr / audio.transcribe / video.transcribe
    // and any other media op that surfaces extracted text) return the text
    // pulled out of a PRIVATE linked-folder file as resultJson.text (with
    // optional structured metadata). Treat that text exactly like file.read /
    // folder.read output: harvest it so a later web.fetch can't exfiltrate the
    // OCR'd / transcribed contents of a user file.
    if (
      toolName === 'image.ocr' ||
      toolName === 'image.inspect' ||
      toolName === 'image.transform' ||
      toolName === 'audio.transcribe' ||
      toolName === 'audio.inspect' ||
      toolName === 'audio.transform' ||
      toolName === 'video.transcribe' ||
      toolName === 'video.inspect' ||
      toolName === 'video.transform' ||
      toolName === 'document.edit' ||
      toolName === 'pdf.edit'
    ) {
      // *.transform tools surface private-derived model-visible fields too
      // (extracted text and metadata describing the private source file), so
      // harvest the same fields — a same-turn web.fetch can't exfiltrate them.
      if (typeof r.text === 'string') this.egressTaint.addText(r.text);
      if (r.metadata && typeof r.metadata === 'object') {
        this.egressTaint.addText(JSON.stringify(r.metadata));
      }
      // Binary-output transforms (the production path) instead surface a
      // binary-work-item descriptor with model-visible, private-derived
      // identifiers: the output path (can echo the private source filename) and
      // the SHA-256 of the transformed private bytes. Harvest both so a
      // same-turn web.fetch can't exfiltrate the output fingerprint/path.
      if (typeof r.outputPath === 'string') this.egressTaint.addText(r.outputPath);
      if (typeof r.sha256Hex === 'string') this.egressTaint.addText(r.sha256Hex);
      return;
    }

    // folder.list returns { entries: [{ filename, byteLength }] } — the
    // filenames are private (they come from a user's linked folder) and are
    // model-visible, so harvest them exactly like file.read/folder.read
    // filenames to block a same-turn web.fetch that exfiltrates a filename.
    if (toolName === 'folder.list' && Array.isArray(r.entries)) {
      for (const e of r.entries) {
        if (e && typeof e === 'object') {
          const entry = e as Record<string, unknown>;
          if (typeof entry.filename === 'string') {
            this.egressTaint.addText(entry.filename);
          }
        }
      }
      return;
    }

    if (toolName === 'memory.read') {
      addRecord(r.record);
    } else if (toolName === 'memory.list' && Array.isArray(r.records)) {
      for (const rec of r.records) addRecord(rec);
    } else if (
      (toolName === 'file.read' || toolName === 'folder.read') &&
      Array.isArray(r.files)
    ) {
      for (const f of r.files) {
        if (!f || typeof f !== 'object') continue;
        const file = f as Record<string, unknown>;
        if (typeof file.filename === 'string')
          {this.egressTaint.addText(file.filename);}
        if (typeof file.text === 'string') this.egressTaint.addText(file.text);
        if (file.metadata && typeof file.metadata === 'object') {
          this.egressTaint.addText(JSON.stringify(file.metadata));
        }
        const b64 =
          typeof file.contentB64 === 'string'
            ? file.contentB64
            : typeof file.firstBytesB64 === 'string'
              ? file.firstBytesB64
              : null;
        if (b64) {
          try {
            this.egressTaint.addText(
              Buffer.from(b64, 'base64').toString('utf8'),
            );
          } catch {
            // non-utf8 binary — skip
          }
        }
      }
    }
  }
}

function connectorOperationScopeSatisfied(
  descriptor: ConnectorDescriptor,
  operation: ConnectorOperation,
  grantedScopes: readonly string[],
): boolean {
  const requiredScopes = Array.isArray(operation.requiredScope)
    ? operation.requiredScope
    : [operation.requiredScope];
  return requiredScopes.some((requiredScope) =>
    grantedScopes.some((grantedScope) =>
      grantCoversRequiredScope(descriptor, grantedScope, requiredScope),
    ),
  );
}

function grantCoversRequiredScope(
  descriptor: ConnectorDescriptor,
  grantedScope: string,
  requiredScope: string,
): boolean {
  if (scopeTokenMatches(grantedScope, requiredScope)) return true;
  return (
    descriptor.scopeSubsumes?.some(
      (rule) =>
        scopeTokenMatches(grantedScope, rule.grant) &&
        rule.covers.some((coveredScope) =>
          scopeTokenMatches(coveredScope, requiredScope),
        ),
    ) ?? false
  );
}

function scopeTokenMatches(left: string, right: string): boolean {
  return (
    left === right ||
    left.endsWith(`/${right}`) ||
    right.endsWith(`/${left}`)
  );
}
