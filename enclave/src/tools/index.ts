import {
  EGRESS_TAINT_READ_TOOLS,
  MEMORY_NAMESPACES,
  type AgentLinkedFolderContext,
  type BinaryWorkItemWriteRequestFrame,
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
    return new ToolGateway({
      ...this.deps,
      linkedFolders: overrides.linkedFolders ?? [],
      strictEgressLock: false,
      crossPackGrant: undefined, // never grant the research worker private access
      researchProviderFactory: undefined, // no transitive delegation — research.ask → RESEARCH_UNAVAILABLE
      // Strip approveQuery so a sibling has no user-approval channel;
      // invokeClient is preserved so web.fetch can still dispatch.
      clientBridge: {
        invokeClient: this.deps.clientBridge.invokeClient.bind(
          this.deps.clientBridge,
        ),
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
   * Test-only seam: expose the egress-taint ledger for Layer-2 test assertions
   * without requiring the private-field cast `(gw as unknown as {egressTaint}).egressTaint`.
   * Parallel to `__peekPreparedMemoryWrite`. Do NOT use in production paths.
   */
  __egressTaintForTest(): EgressTaintLedger {
    return this.egressTaint;
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
