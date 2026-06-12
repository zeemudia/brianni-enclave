import { createHash } from 'node:crypto';
import {
  MemoryRecordSchema,
  type MemoryRecord,
  type MemoryNamespace,
  type MemoryProvenance,
} from '@calypso/chat-types';

/**
 * Default confidence stamped on an agent-loop `memory.write` when the model
 * does not supply one. The model is told only a minimal delta shape
 * (action + record.kind + record.text); it cannot meaningfully calibrate a
 * probability, so we record a deliberately middling default rather than
 * forcing the model to invent a number.
 */
const DEFAULT_AGENT_WRITE_CONFIDENCE = 0.7;

/** Provenance excerpt is capped by MemoryProvenanceSchema at 2000 chars. */
const MAX_PROVENANCE_EXCERPT = 2000;

export interface RecordCanonicalisationContext {
  /** Authoritative blob id — usually `delta.targetId`. */
  blobId: string;
  /** Server-pinned namespace. */
  namespace: MemoryNamespace;
  /** Server-minted session/turn id that stamps record + provenance. */
  dreamSessionId: string;
  /** The envelope's newRecordVersion — record.baseVersion is forced to match. */
  newRecordVersion: number;
  /**
   * Server-controlled timestamp (ISO-8601) for record lifecycle fields
   * (`createdAt`, `updatedAt`). Both are stamped to this value so a
   * prompt-injected past/future timestamp cannot survive — R11
   * Finding C.
   */
  nowIso: string;
}

/**
 * Build the fully-canonical `MemoryRecord` the enclave hashes and signs.
 *
 * The record body that flows into `recordSerialisedHash` MUST be the same
 * one the storage layer parses and re-hashes at save time. Any model-
 * controlled field that affects the signed bytes is an opportunity for
 * the LLM (or a compromised bridge) to corrupt persisted state. This
 * helper:
 *
 *   1. Overrides every authoritative field (id, namespace, dreamSessionId,
 *      baseVersion, provenance[].dreamSessionId) from server-controlled
 *      context — R8 Finding A.
 *   2. Round-trips through `MemoryRecordSchema.parse` so key order matches
 *      the storage-core re-serialisation byte-for-byte — R7 Finding B.
 *   3. Returns null on schema-invalid records — callers map to the
 *      appropriate error reason.
 *
 * Both the agent-loop memory.write path (tier-b-draft) and the
 * dream-reconcile path use this single function so a hostile field
 * cannot survive in EITHER pipeline.
 */
export function canonicaliseMemoryRecord(
  raw: Partial<MemoryRecord> & Pick<MemoryRecord, 'kind' | 'text'>,
  ctx: RecordCanonicalisationContext,
): MemoryRecord | null {
  // The agent loop advertises only a MINIMAL delta shape to the model
  // (action + record.kind + record.text). Provenance is a min-1 array of
  // nested objects whose sourceRef the model cannot construct safely (it
  // does not have an authoritative conversationId), so when the model
  // omits it we synthesise a single server-authoritative entry from the
  // record text + the enclave-minted session id. Records that DO arrive
  // with provenance (the dream-reconcile pipeline) keep theirs, restamped
  // — this branch is additive, not a behaviour change for them.
  const rawProvenance = raw.provenance ?? [];
  const stampedProvenance: MemoryProvenance[] =
    rawProvenance.length > 0
      ? rawProvenance.map((p) => ({
          ...p,
          dreamSessionId: ctx.dreamSessionId,
          extractedAt: ctx.nowIso,
        }))
      : [synthesiseProvenance(raw.text, ctx)];
  const overridden = {
    ...raw,
    // Scalar record fields the model is not asked to supply get safe,
    // schema-valid defaults so a one-line memory.write succeeds. A model
    // that DOES supply them wins (the `...raw` spread above), so existing
    // full-record callers are byte-for-byte unchanged.
    structured: raw.structured ?? {},
    tags: raw.tags ?? [],
    confidence:
      typeof raw.confidence === 'number'
        ? raw.confidence
        : DEFAULT_AGENT_WRITE_CONFIDENCE,
    supersededBy: raw.supersededBy ?? null,
    visibleToUser:
      typeof raw.visibleToUser === 'boolean' ? raw.visibleToUser : true,
    // Authoritative server-controlled fields always win — they are set
    // AFTER the defaults/`...raw` so a model-lied value cannot survive.
    id: ctx.blobId,
    namespace: ctx.namespace,
    dreamSessionId: ctx.dreamSessionId,
    baseVersion: ctx.newRecordVersion,
    provenance: stampedProvenance,
    // R11 Finding C (Codex): record lifecycle metadata is enclave/
    // server policy — prompt-injected past/future timestamps would
    // otherwise distort listByNamespace `since` ordering and sync.
    createdAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
    // tombstoneEpoch is enclave-controlled too; agent-loop writes use
    // 0 (the action=TOMBSTONE branch is what actually tombstones).
    tombstoneEpoch: 0,
  };
  const parsed = MemoryRecordSchema.safeParse(overridden);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Build a single server-authoritative provenance entry for an agent-loop
 * write whose model-supplied delta carried no provenance. The excerpt is
 * the record text (capped to the schema limit); the sourceRef points at
 * the current agent turn so the user's ledger still shows what justified
 * the memory. Every field here is enclave-controlled — the model cannot
 * influence it.
 */
function synthesiseProvenance(
  text: string,
  ctx: RecordCanonicalisationContext,
): MemoryProvenance {
  const excerpt = text.slice(0, MAX_PROVENANCE_EXCERPT);
  return {
    excerpt,
    excerptHash: createHash('sha256').update(excerpt).digest('hex'),
    sourceRef: { type: 'conversation', conversationId: ctx.dreamSessionId },
    extractedAt: ctx.nowIso,
    dreamSessionId: ctx.dreamSessionId,
  };
}
