import { createHash, randomUUID } from 'node:crypto';
import {
  TOMBSTONE_RECORD_SERIALISED_HASH,
  type DreamDelta,
  type MemoryNamespace,
  type MemoryRecord,
  type SkillPack,
  type ToolCallLedgerEntry,
  type ToolInvocationFrame,
  type ToolResultFrame,
} from '@calypso/chat-types';

import type { DispatchResult, ToolGatewayDeps } from './index';
import { validateFileForGateway } from './file-allowlist';
import { sanitiseBridgeResultForDispatch } from './bridge-result-sanitiser';
import {
  resolveClientWrittenPath,
  resolveCopyOutputPath,
} from './copy-on-write-policy';
import { resolveLinkedFolder } from './folder-resolver';
import { canonicaliseMemoryRecord } from '../memory/canonicalise-record';
import type { UnsignedEnvelope } from '../dream/types';

const ENVELOPE_TTL_MS = 60_000;

/**
 * R7 Finding A + B (Codex): the canonicalised state computed once per
 * memory.write invocation. Built by `canonicaliseMemoryWrite` BEFORE
 * the TOOL_INVOCATION is yielded to the wire (so the client receives
 * the sanitised frame, not the model's), then read back by
 * `handleMemoryWrite` during dispatch (so we don't re-canonicalise
 * with a fresh mutationId / now). The canonical record is parsed via
 * MemoryRecordSchema so the key order matches `MemoryStorage.saveMemory`'s
 * parse + serialise (Zod normalises key order).
 */
export interface PreparedMemoryWrite {
  sanitisedFrame: ToolInvocationFrame;
  sanitisedDelta: DreamDelta;
  envelopeFields: UnsignedEnvelope['envelopeFields'];
  recordSerialised: string;
  recordSerialisedHash: string;
  canonicalRecord: MemoryRecord | null;
  namespace: MemoryNamespace;
  deltaIndex: number;
  createdAt: number;
}

export type CanonicaliseResult =
  | { ok: true; prepared: PreparedMemoryWrite }
  | { ok: false; reason: string };

export function canonicaliseMemoryWrite(
  frame: ToolInvocationFrame,
  pack: SkillPack,
  context: { userId: string; sessionId: string; agentTurnId: string },
  clock: { now: number; mutationId: string; addBlobId?: string },
): CanonicaliseResult {
  const args = frame.args as { delta?: unknown };
  if (!args.delta) return { ok: false, reason: 'INVALID_ARGS' };

  const validated = validateDelta(args.delta);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  const rawDelta = validated.delta;

  // R13 Finding C (Codex): the durable blob uniqueness key is
  // `[userId, id]` (global), so a model could pick a known id from
  // another namespace to make ADD collide with `memory_blob_already_exists`.
  // For ADD we override delta.targetId with an enclave-minted UUID
  // — the model cannot supply a colliding id. For non-ADD the
  // targetId IS the existing row, so we must trust the model
  // (CAS + namespace pinning still protects the wrong-row case).
  const targetId =
    rawDelta.action === 'ADD'
      ? clock.addBlobId ?? randomUUID()
      : rawDelta.targetId;
  const delta: DreamDelta = { ...rawDelta, targetId };

  const namespace = pack.defaultNamespace;
  // The model is told to omit namespace (the enclave pins it). Only treat
  // a PRESENT, differing namespace as an escape attempt; an omitted one is
  // pinned to the active namespace by canonicaliseMemoryRecord below.
  if (
    delta.action !== 'TOMBSTONE' &&
    delta.record!.namespace !== undefined &&
    delta.record!.namespace !== namespace
  ) {
    return { ok: false, reason: 'NAMESPACE_ESCAPE_REJECTED' };
  }

  let expectedBaseVersion: number;
  if (delta.action === 'ADD') {
    expectedBaseVersion = -1;
  } else {
    if (
      typeof delta.expectedBaseVersion !== 'number' ||
      !Number.isInteger(delta.expectedBaseVersion) ||
      delta.expectedBaseVersion < 0
    ) {
      return { ok: false, reason: 'INVALID_DELTA_BASE_VERSION' };
    }
    expectedBaseVersion = delta.expectedBaseVersion;
  }
  const newRecordVersion =
    delta.action === 'ADD' ? 0 : expectedBaseVersion + 1;

  // R7 Finding B + R8 Finding A + R8 Finding B (Codex): single shared
  // canonicaliseMemoryRecord helper, also reused by the dream-reconcile
  // path so both pipelines produce byte-identical signed bytes for the
  // same logical record.
  const nowIso = new Date(clock.now).toISOString();
  let canonicalRecord: MemoryRecord | null = null;
  if (delta.action !== 'TOMBSTONE' && delta.record !== null) {
    canonicalRecord = canonicaliseMemoryRecord(delta.record, {
      blobId: delta.targetId,
      namespace,
      dreamSessionId: context.agentTurnId,
      newRecordVersion,
      nowIso,
    });
    if (!canonicalRecord) {
      return { ok: false, reason: 'INVALID_DELTA_RECORD_SCHEMA' };
    }
  }

  const recordSerialised =
    canonicalRecord === null ? '' : JSON.stringify(canonicalRecord);
  const recordSerialisedHash =
    canonicalRecord === null
      ? TOMBSTONE_RECORD_SERIALISED_HASH
      : sha256Hex(recordSerialised);

  const provenanceConversationIds = extractProvenanceConversationIds(canonicalRecord);
  const issuedAt = new Date(clock.now).toISOString();
  const expiresAt = new Date(clock.now + ENVELOPE_TTL_MS).toISOString();

  const envelopeFields: UnsignedEnvelope['envelopeFields'] = {
    v: 1,
    userId: context.userId,
    namespace,
    blobId: delta.targetId,
    action: delta.action,
    expectedBaseVersion,
    newRecordVersion,
    kind: canonicalRecord === null ? 'fact' : canonicalRecord.kind,
    mutationId: clock.mutationId,
    dreamSessionId: context.agentTurnId,
    teeSessionId: context.sessionId,
    provenanceConversationIds,
    issuedAt,
    expiresAt,
  };

  const sanitisedDelta: DreamDelta = {
    ...delta,
    mutationId: clock.mutationId,
    expectedBaseVersion,
    record: canonicalRecord,
  } as DreamDelta;

  const deltaIndex = 0;
  const sanitisedFrame: ToolInvocationFrame = {
    invocationId: frame.invocationId,
    agentTurnId: frame.agentTurnId,
    toolName: frame.toolName,
    args: {
      delta: sanitisedDelta,
      deltaIndex,
      namespace,
      recordSerialisedHash,
    },
  };

  return {
    ok: true,
    prepared: {
      sanitisedFrame,
      sanitisedDelta,
      envelopeFields,
      recordSerialised,
      recordSerialisedHash,
      canonicalRecord,
      namespace,
      deltaIndex,
      createdAt: clock.now,
    },
  };
}

type BaseLedger = Omit<
  ToolCallLedgerEntry,
  'id' | 'outcome' | 'reason' | 'scope' | 'approvedPath'
>;

export async function run(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  turnId: string,
): Promise<DispatchResult> {
  const baseLedger: BaseLedger = {
    invokedAt: new Date().toISOString(),
    toolName: frame.toolName,
    skillPackId: pack.id,
    turnId,
  };

  switch (frame.toolName) {
    case 'email.draft':
      return handleDraft(frame, baseLedger, 'email');
    case 'doc.draft':
      return handleDraft(frame, baseLedger, 'doc');
    case 'event.draft':
      return handleDraft(frame, baseLedger, 'event');
    case 'memory.write':
      return handleMemoryWrite(frame, deps, pack, baseLedger);
    case 'folder.write':
      return handleFolderWrite(frame, deps, pack, baseLedger);
    default:
      return errorResult(frame, baseLedger, 'NOT_IMPLEMENTED');
  }
}

function handleDraft(
  frame: ToolInvocationFrame,
  baseLedger: BaseLedger,
  kind: 'email' | 'doc' | 'event',
): DispatchResult {
  const args = frame.args as Record<string, unknown>;
  // Pure-passthrough: format the args into a structured draft envelope.
  // No 'send', no 'autoSend', no network IO — the agent shows the user
  // the draft and the user copies it out themselves at MVP.
  const draft = {
    kind,
    fields: pickDraftFields(args, kind),
  };
  return {
    invocationId: frame.invocationId,
    outcome: 'ok',
    resultJson: draft,
    ledgerEntry: {
      ...baseLedger,
      scope: `${kind}/draft`,
      approvedPath: null,
      outcome: 'ok',
      reason: null,
    },
  };
}

function pickDraftFields(
  args: Record<string, unknown>,
  kind: 'email' | 'doc' | 'event',
): Record<string, unknown> {
  switch (kind) {
    case 'email': {
      const { to, cc, subject, body } = args as {
        to?: unknown;
        cc?: unknown;
        subject?: unknown;
        body?: unknown;
      };
      return {
        to: typeof to === 'string' ? to : undefined,
        cc: typeof cc === 'string' ? cc : undefined,
        subject: typeof subject === 'string' ? subject : '',
        body: typeof body === 'string' ? body : '',
      };
    }
    case 'doc': {
      const { title, body, format } = args as {
        title?: unknown;
        body?: unknown;
        format?: unknown;
      };
      return {
        title: typeof title === 'string' ? title : '',
        body: typeof body === 'string' ? body : '',
        format: typeof format === 'string' ? format : 'markdown',
      };
    }
    case 'event': {
      const { title, startsAt, endsAt, body } = args as {
        title?: unknown;
        startsAt?: unknown;
        endsAt?: unknown;
        body?: unknown;
      };
      return {
        title: typeof title === 'string' ? title : '',
        startsAt: typeof startsAt === 'string' ? startsAt : undefined,
        endsAt: typeof endsAt === 'string' ? endsAt : undefined,
        body: typeof body === 'string' ? body : '',
      };
    }
  }
}

async function handleMemoryWrite(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  baseLedger: BaseLedger,
): Promise<DispatchResult> {
  if (!deps.sessionManager) {
    return errorResult(frame, baseLedger, 'SESSION_MANAGER_UNAVAILABLE');
  }
  if (!deps.userId || !deps.sessionId) {
    return errorResult(frame, baseLedger, 'UNAUTHENTICATED_AGENT_CONTEXT');
  }
  const sessionId = deps.sessionId;
  const agentTurnId = frame.agentTurnId;

  // R7 Finding A (Codex): the agent loop prepares the canonical state
  // BEFORE yielding TOOL_INVOCATION, so the wire carries the sanitised
  // frame. Look it up here; if not found (direct-dispatch test path),
  // canonicalise inline with the same deterministic clock seeds.
  let prepared = deps.takePreparedMemoryWrite?.(frame.invocationId) ?? null;
  if (!prepared) {
    const result = canonicaliseMemoryWrite(
      frame,
      pack,
      { userId: deps.userId, sessionId, agentTurnId },
      {
        now: Date.now(),
        mutationId: randomUUID(),
        addBlobId: randomUUID(),
      },
    );
    if (!result.ok) {
      return result.reason === 'INVALID_ARGS'
        ? invalidArgs(frame, baseLedger)
        : errorResult(frame, baseLedger, result.reason);
    }
    prepared = result.prepared;
  }

  const {
    sanitisedFrame,
    envelopeFields,
    recordSerialisedHash,
    namespace,
    deltaIndex,
    createdAt,
  } = prepared;

  try {
    await deps.sessionManager.storeUnsignedEnvelopes(sessionId, agentTurnId, [
      [
        deltaIndex,
        {
          recordSerialisedHash,
          envelopeFields,
          createdAt,
        },
      ],
    ]);
  } catch (err) {
    return errorResult(
      frame,
      baseLedger,
      err instanceof Error ? err.message : 'STORE_UNSIGNED_FAILED',
    );
  }

  // Step 1 — bridge to the client with the SANITISED frame. The wire
  // path already emitted this same frame as TOOL_INVOCATION (R7
  // Finding A); invokeClient just awaits the resolver keyed by
  // invocationId.
  const bridgeResult: ToolResultFrame =
    await deps.clientBridge.invokeClient(sanitisedFrame);
  if (bridgeResult.outcome !== 'ok') {
    return sanitiseBridgeResultForDispatch(
      bridgeResult,
      baseLedger,
      `memory/${namespace}`,
      null,
    );
  }
  const payload = bridgeResult.resultJson as
    | {
        deltaIndex?: number;
        contentHash?: string;
        recordSerialisedHash?: string;
        signedBlobB64?: string;
      }
    | undefined;
  if (
    !payload ||
    typeof payload.contentHash !== 'string' ||
    typeof payload.recordSerialisedHash !== 'string'
  ) {
    return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT');
  }

  // Defense in depth: even before finaliseDreamEnvelopes verifies the
  // hashes, reject any bridge response whose recordSerialisedHash
  // disagrees with the enclave-computed one. This converts a
  // "record_serialised_mismatch" finalise error into an earlier
  // controlled rejection and ensures no signing attempt is made on
  // tampered bridge data.
  if (payload.recordSerialisedHash !== recordSerialisedHash) {
    return errorResult(frame, baseLedger, 'RECORD_SERIALISED_MISMATCH');
  }

  // Step 2 — invoke the shared dream-finalise handler.
  let signResults;
  try {
    signResults = await deps.sessionManager.finaliseDreamEnvelopes(
      sessionId,
      agentTurnId,
      [
        {
          deltaIndex,
          contentHash: payload.contentHash,
          recordSerialisedHash,
        },
      ],
    );
  } catch (err) {
    return errorResult(
      frame,
      baseLedger,
      err instanceof Error ? err.message : 'FINALISE_FAILED',
    );
  }
  const result = signResults[0];
  if (!result) {
    // finaliseDreamEnvelopes is contracted to return one result per input
    // descriptor; an empty array would mean the signer dropped the only item.
    // Fail closed rather than dereferencing undefined.
    return errorResult(frame, baseLedger, 'FINALISE_FAILED');
  }
  if (!result.ok) {
    const reason =
      result.error === 'record_serialised_mismatch'
        ? 'RECORD_SERIALISED_MISMATCH'
        : result.error === 'unknown_delta_index'
          ? 'INVOCATION_ALREADY_CONSUMED'
          : result.error === 'finalise_timeout'
            ? 'FINALISE_TIMEOUT'
            : result.error === 'content_hash_invalid'
              ? 'CONTENT_HASH_INVALID'
              : 'UNKNOWN_DREAM_SESSION';
    return errorResult(frame, baseLedger, reason);
  }

  // Step 3 — R8-H1: cache the signed envelope keyed by (agentTurnId,
  // invocationId) so a network-drop replay before the client durably
  // persists returns the same signed bytes deterministically.
  await deps.sessionManager.cacheSignedFinalisation(
    sessionId,
    agentTurnId,
    frame.invocationId,
    {
      signedEnvelope: result.signedEnvelope,
      signature: result.signature,
      contentHash: payload.contentHash,
      recordSerialisedHash: payload.recordSerialisedHash,
      signedAt: Date.now(),
      pendingClientAck: true,
      // Codex R4 finding #2: the canonical bytes the client uses to
      // verify the signature; stashed so TOOL_RESULT replay returns the
      // SAME memory_write_signed chunk byte-for-byte.
      signedBlobB64: payload.signedBlobB64 ?? '',
    },
  );

  return {
    invocationId: frame.invocationId,
    outcome: 'ok',
    resultJson: {
      signedEnvelope: result.signedEnvelope,
      signature: result.signature,
      signedBlobB64: payload.signedBlobB64 ?? '',
      invocationId: frame.invocationId,
    },
    ledgerEntry: {
      ...baseLedger,
      scope: `memory/${result.signedEnvelope.namespace}`,
      approvedPath: null,
      outcome: 'ok',
      reason: null,
    },
  };
}

async function handleFolderWrite(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  baseLedger: BaseLedger,
): Promise<DispatchResult> {
  const args = frame.args as {
    folderId?: unknown;
    displayName?: unknown;
    sourcePath?: unknown;
    path?: unknown;
    existingPaths?: unknown;
    contentBytesB64?: unknown;
  };
  const path = args.path;
  const contentBytesB64 = args.contentBytesB64;
  const sourcePath =
    typeof args.sourcePath === 'string' && args.sourcePath.length > 0
      ? args.sourcePath
      : null;

  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    typeof contentBytesB64 !== 'string'
  ) {
    return invalidArgs(frame, baseLedger);
  }

  // Canonicalise the target folder against the trusted linked-folder context
  // before any write: the model often references a linked folder by its
  // (masked) displayName instead of the opaque folderId. See folder-resolver.ts.
  const resolved = resolveLinkedFolder(args, deps.linkedFolders ?? []);
  if (!resolved) {
    return invalidArgs(frame, baseLedger);
  }

  // Cross-pack grant binds folder access to the authorized set (defense-in-depth:
  // unreachable for today's read-only claims pack, but keeps the invariant
  // complete for any future grant-bearing pack with this tool). Fail closed.
  const grant = deps.crossPackGrant;
  if (grant && !grant.folderIds.has(resolved.folderId)) {
    return errorResult(frame, baseLedger, 'FOLDER_NOT_IN_GRANT');
  }

  const displayName = resolved.displayName || 'unknown';

  // Reject any client-supplied source hash: provenance for this copy is
  // derived inside the enclave/gateway, never trusted from the caller, so the
  // presence of `sourceSha256` in args is treated as schema-invalid rather than
  // silently ignored (which could let a client forge the recorded provenance).
  if (Object.prototype.hasOwnProperty.call(args, 'sourceSha256')) {
    return invalidArgs(frame, baseLedger);
  }

  const scope = `folder/${displayName}`;
  const copyPath = resolveCopyOutputPath({
    sourcePath,
    requestedOutputPath: path,
    existingPaths: parseExistingPaths(args.existingPaths),
  });
  if (!copyPath.ok) {
    return {
      invocationId: frame.invocationId,
      outcome: 'gateway_rejected',
      reason:
        copyPath.reason === 'INVALID_SOURCE_PATH'
          ? 'INVALID_SOURCE_PATH'
          : copyPath.reason === 'INVALID_OUTPUT_PATH'
            ? 'INVALID_PATH'
            : 'NO_AVAILABLE_COPY_PATH',
      ledgerEntry: {
        ...baseLedger,
        scope,
        approvedPath: null,
        outcome: 'gateway_rejected',
        reason:
          copyPath.reason === 'INVALID_SOURCE_PATH'
            ? 'INVALID_SOURCE_PATH'
            : copyPath.reason === 'INVALID_OUTPUT_PATH'
              ? 'INVALID_PATH'
              : 'NO_AVAILABLE_COPY_PATH',
      },
    };
  }
  const finalPath = copyPath.outputPath;

  const filename = basename(finalPath);
  const contentBytes = decodeB64ToBytes(contentBytesB64);
  const byteLength = contentBytes?.length ?? 0;

  const verdict = validateFileForGateway({
    filename,
    byteLength,
    firstBytes: contentBytes,
    // `.docx` requires the full ZIP for OOXML container validation.
    // Other extensions ignore the field.
    fullBytes: contentBytes,
    capabilitySuiteIds: pack.capabilitySuiteIds,
  });
  if (!verdict.ok) {
    return {
      invocationId: frame.invocationId,
      outcome: 'gateway_rejected',
      reason: verdict.reason,
      ...(copyPath.pathAdjusted
        ? { resultJson: { resolvedPath: finalPath } }
        : {}),
      ledgerEntry: {
        ...baseLedger,
        scope,
        approvedPath: null,
        outcome: 'gateway_rejected',
        reason: verdict.reason,
      },
    };
  }

  // ONLY exit: delegate to the client. The enclave has no filesystem handle;
  // the client renders the confirmation modal with the exact path and exact
  // content, and only the client (after user Allow) calls the OS write API.
  const result: ToolResultFrame = await deps.clientBridge.invokeClient({
    ...frame,
    args: {
      ...args,
      // Forward the resolved real folderId + trusted displayName so the client
      // resolves the handle by the vetted id and its label cross-check passes.
      folderId: resolved.folderId,
      displayName: resolved.displayName,
      path: finalPath,
      requestedPath: copyPath.requestedOutputPath,
      pathAdjusted: copyPath.pathAdjusted,
    },
  });
  const writtenPath =
    (result.resultJson as { writtenPath?: unknown } | undefined)?.writtenPath;
  let acceptedWrittenPath:
    | { writtenPath: string; pathAdjusted: boolean }
    | null = null;
  if (result.outcome === 'ok') {
    if (typeof writtenPath !== 'string') {
      return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT');
    }
    const resolvedWrittenPath = resolveClientWrittenPath({
      sourcePath,
      requestedOutputPath: copyPath.requestedOutputPath,
      enclaveOutputPath: finalPath,
      writtenPath,
    });
    if (!resolvedWrittenPath.ok) {
      return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT');
    }
    const writtenVerdict = validateFileForGateway({
      filename: basename(resolvedWrittenPath.writtenPath),
      byteLength,
      firstBytes: contentBytes,
      fullBytes: contentBytes,
      capabilitySuiteIds: pack.capabilitySuiteIds,
    });
    if (!writtenVerdict.ok) {
      return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT');
    }
    acceptedWrittenPath = {
      writtenPath: resolvedWrittenPath.writtenPath,
      pathAdjusted: resolvedWrittenPath.pathAdjusted,
    };
  }
  const approvedPath =
    result.outcome === 'ok' ? acceptedWrittenPath!.writtenPath : null;
  const okResultJson = acceptedWrittenPath?.pathAdjusted
    ? {
        writtenPath: acceptedWrittenPath.writtenPath,
        requestedPath: copyPath.requestedOutputPath,
        pathAdjusted: true,
      }
    : { writtenPath: acceptedWrittenPath?.writtenPath ?? finalPath };
  return sanitiseBridgeResultForDispatch(
    result,
    baseLedger,
    scope,
    approvedPath,
    result.outcome === 'ok' ? okResultJson : undefined,
  );
}

function basename(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return slash < 0 ? p : p.slice(slash + 1);
}

function decodeB64ToBytes(value: string): Uint8Array | undefined {
  if (value === '') return new Uint8Array(0);
  try {
    return new Uint8Array(Buffer.from(value, 'base64'));
  } catch {
    return undefined;
  }
}

function parseExistingPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function invalidArgs(
  frame: ToolInvocationFrame,
  baseLedger: BaseLedger,
): DispatchResult {
  return {
    invocationId: frame.invocationId,
    outcome: 'error',
    reason: 'INVALID_ARGS',
    ledgerEntry: {
      ...baseLedger,
      scope: '',
      approvedPath: null,
      outcome: 'error',
      reason: 'INVALID_ARGS',
    },
  };
}

function errorResult(
  frame: ToolInvocationFrame,
  baseLedger: BaseLedger,
  reason: string,
): DispatchResult {
  return {
    invocationId: frame.invocationId,
    outcome: 'error',
    reason,
    ledgerEntry: {
      ...baseLedger,
      scope: '',
      approvedPath: null,
      outcome: 'error',
      reason,
    },
  };
}

const DREAM_DELTA_ACTIONS = new Set<DreamDelta['action']>([
  'ADD',
  'UPDATE',
  'SUPERSEDE',
  'TOMBSTONE',
]);

/**
 * Structural validation of the model-supplied delta. We do NOT run the
 * full DreamDeltaSchema parse here — some legacy fixtures + tier-A flows
 * exercise this path with looser shapes, and the production safety
 * guarantees come from the enclave reconstructing the envelope fields
 * regardless. We do require enough fields to build the envelope safely.
 */
function validateDelta(
  raw: unknown,
): { ok: true; delta: DreamDelta } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'INVALID_ARGS' };
  }
  const d = raw as Partial<DreamDelta> & Record<string, unknown>;
  if (typeof d.action !== 'string' || !DREAM_DELTA_ACTIONS.has(d.action as DreamDelta['action'])) {
    return { ok: false, reason: 'INVALID_DELTA_ACTION' };
  }
  // ADD mints its own blob id server-side (R13 Finding C), so the model
  // is told to omit targetId — only the existing-row actions require it.
  if (d.action !== 'ADD') {
    if (typeof d.targetId !== 'string' || d.targetId.length === 0) {
      return { ok: false, reason: 'INVALID_DELTA_TARGET' };
    }
  }
  if (d.action === 'TOMBSTONE') {
    if (d.record !== null && d.record !== undefined) {
      return { ok: false, reason: 'INVALID_DELTA_TOMBSTONE_RECORD' };
    }
  } else {
    if (!d.record || typeof d.record !== 'object') {
      return { ok: false, reason: 'INVALID_DELTA_RECORD' };
    }
    const r = d.record as Partial<MemoryRecord>;
    // namespace is OPTIONAL on the model-supplied record — the enclave
    // pins it to the active namespace in canonicaliseMemoryWrite. If the
    // model supplies one it must match (escape guard there). kind + text
    // are the only fields the model must actually provide.
    if (typeof r.kind !== 'string') {
      return { ok: false, reason: 'INVALID_DELTA_KIND' };
    }
    if (typeof r.text !== 'string' || r.text.length === 0) {
      return { ok: false, reason: 'INVALID_DELTA_TEXT' };
    }
  }
  return { ok: true, delta: d as DreamDelta };
}

function extractProvenanceConversationIds(record: MemoryRecord | null): string[] {
  if (!record) return [];
  const ids = new Set<string>();
  for (const entry of record.provenance ?? []) {
    if (entry?.sourceRef?.type === 'conversation' && entry.sourceRef.conversationId) {
      ids.add(entry.sourceRef.conversationId);
    }
  }
  return Array.from(ids);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Re-export for tests; the parameter is structurally typed but Node's
// MemoryNamespace lives in @calypso/chat-types.
export type { MemoryNamespace };
