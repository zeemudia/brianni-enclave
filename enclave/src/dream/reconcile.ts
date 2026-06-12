import {
  DreamDeltaSchema,
  type DreamDelta,
  type MemoryNamespace,
  type MemoryRecord,
} from '@calypso/chat-types';

import type { LlmTransport } from './llm-transport';
import type { CandidateMemory } from './types';
import { canonicaliseMemoryRecord } from '../memory/canonicalise-record';
import { selectDreamReconcileModel } from './model-routing';
import { parseStrictJsonFromModelText } from './parse-json';

export interface DreamReconcileContext {
  userId: string;
  namespace: MemoryNamespace;
  dreamSessionId: string;
}

export interface ReconcileCandidateMemoriesRequest {
  candidates: CandidateMemory[];
  existingMemoryRecords: MemoryRecord[];
  context: DreamReconcileContext;
  llmTransport: LlmTransport;
}

export interface ReconciledDreamDelta {
  delta: DreamDelta;
  recordSerialised: string;
}

export async function reconcileCandidateMemories(
  req: ReconcileCandidateMemoriesRequest,
): Promise<ReconciledDreamDelta[]> {
  const response = await req.llmTransport.complete({
    model: selectDreamReconcileModel({
      candidates: req.candidates,
      existingMemoryRecords: req.existingMemoryRecords,
    }),
    systemPrompt: buildReconcileSystemPrompt(req.context.namespace),
    userMessage: JSON.stringify({
      task: 'reconcile_candidate_memories',
      context: req.context,
      candidates: req.candidates,
      existingMemoryRecords: req.existingMemoryRecords,
    }),
    maxOutputTokens: 4096,
    temperature: 0,
  });

  return parseReconcileDeltas(response.text);
}

function buildReconcileSystemPrompt(namespace: string): string {
  return [
    'You are Calypso\'s memory reconcile pass inside an AWS Nitro Enclave.',
    'Decide ADD/UPDATE/SUPERSEDE/TOMBSTONE for each candidate against existing records.',
    'When candidates is an empty array, perform a nightly consolidation pass over',
    'existingMemoryRecords: find near-duplicate records (emit SUPERSEDE for the older,',
    'ADD for a merged version), tombstone clearly outdated or superseded facts, and',
    'update records that contain stale information. Return {"deltas":[]} if nothing',
    'needs consolidation — never emit spurious deltas.',
    `Only emit deltas for namespace: ${namespace}.`,
    'Return strict JSON only matching the schema: {"deltas": [Delta]}',
    'Where Delta has the following JSON schema format:',
    '{',
    '  "action": "ADD" | "UPDATE" | "SUPERSEDE" | "TOMBSTONE",',
    '  "targetId": "string (the memory ID; for ADD use a dummy string like \'new-id\')",',
    '  "expectedBaseVersion": -1 | integer, // -1 for ADD, >= 0 for other actions (must match the existing memory\'s baseVersion)',
    '  "mutationId": "00000000-0000-0000-0000-000000000000", // Must be a valid UUID v4',
    '  "record": { // null only if action is TOMBSTONE, otherwise required:',
    '    "id": "string (matches targetId)",',
    `    "namespace": "${namespace}",`,
    '    "baseVersion": 0 | integer, // 0 for ADD, existing baseVersion + 1 for update/supersede',
    '    "tombstoneEpoch": 0,',
    '    "dreamSessionId": "string (copy from task/context)",',
    '    "kind": "fact" | "preference" | "episode" | "lesson" | "goal",',
    '    "text": "The memory summary text",',
    '    "structured": {}, // Key-value details object',
    '    "tags": ["tag-name"],',
    '    "provenance": [',
    '      {',
    '        "excerpt": "Exact quote from the conversation",',
    '        "excerptHash": "sha256:...", // Hash of the excerpt (at least 8 chars)',
    '        "sourceRef": { "type": "conversation", "conversationId": "string" },',
    '        "extractedAt": "YYYY-MM-DDTHH:mm:ss.sssZ", // Current ISO datetime',
    '        "dreamSessionId": "string" // The dreamSessionId from the input task',
    '      }',
    '    ],',
    '    "confidence": 0.9, // float between 0 and 1',
    '    "createdAt": "YYYY-MM-DDTHH:mm:ss.sssZ", // ISO datetime',
    '    "updatedAt": "YYYY-MM-DDTHH:mm:ss.sssZ", // ISO datetime',
    '    "supersededBy": null,',
    '    "visibleToUser": true',
    '  }',
    '}',
  ].join('\n');
}

function parseReconcileDeltas(text: string): ReconciledDreamDelta[] {
  let parsed: unknown;
  try {
    parsed = parseStrictJsonFromModelText(text);
  } catch {
    // Privacy boundary: JSON.parse SyntaxErrors embed a snippet of the
    // model output (derived from decrypted memory content), and the dream
    // LLM emitting prose is a realistic production trigger. Static only.
    throw new Error('dream_reconcile_json_parse_failed');
  }

  const deltas = parsed && typeof parsed === 'object' && Array.isArray((parsed as { deltas?: unknown }).deltas)
    ? (parsed as { deltas: unknown[] }).deltas
    : null;
  if (!deltas) {
    throw new Error('dream_reconcile_json_shape_invalid: expected deltas array');
  }

  return deltas.map((delta, index) => {
    const parsedDelta = DreamDeltaSchema.safeParse(delta);
    if (!parsedDelta.success) {
      // Privacy boundary: the rejected delta can carry plaintext memory
      // text/structured fields/provenance excerpts, and enclave stderr is
      // host-observable. Log AND throw only the index — never the delta
      // payload, and never the raw Zod error (it can echo received field
      // values, and the thrown message can end up in a host-visible frame).
      console.error(`Dream delta failed schema validation at index ${index}`);
      throw new Error(`dream_reconcile_delta_invalid:${index}`);
    }
    return {
      delta: parsedDelta.data,
      // R8 Finding B (Codex): canonicalisation happens later in
      // canonicaliseDreamRecord (called by buildUnsignedEnvelope's
      // caller). Without context (dreamSessionId, newRecordVersion) we
      // can't produce the final hash here. Leave the raw record on the
      // delta and defer canonicalisation to runDreamSession.
      recordSerialised: parsedDelta.data.record
        ? JSON.stringify(parsedDelta.data.record)
        : '',
    };
  });
}

/**
 * R8 Finding B (Codex): canonicalise a dream-reconciled record before
 * hashing/signing. Identical contract to the agent memory.write
 * canonicaliser — both pipelines must produce byte-identical signed
 * bytes for the same logical record. Returns the canonicalised record
 * + its serialised form (which the caller hashes).
 */
export interface CanonicalisedDreamRecord {
  record: MemoryRecord;
  recordSerialised: string;
}

export function canonicaliseDreamRecord(
  raw: MemoryRecord,
  context: {
    blobId: string;
    namespace: MemoryNamespace;
    dreamSessionId: string;
    newRecordVersion: number;
    nowIso: string;
  },
): CanonicalisedDreamRecord | null {
  const canonical = canonicaliseMemoryRecord(raw, context);
  if (!canonical) return null;
  return {
    record: canonical,
    recordSerialised: JSON.stringify(canonical),
  };
}
