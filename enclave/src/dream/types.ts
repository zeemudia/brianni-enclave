import type {
  MemoryMutationEnvelope,
  MemoryKind,
  MemoryNamespace,
  MemoryProvenance,
  MemoryRecord,
} from '@calypso/chat-types';

export const DREAM_FINALISE_TIMEOUT_MS = 60_000;

/**
 * Chunk J Wave 4 — added 'reconcile-only'. Skips the extract pass and
 * only runs reconcile over passed-in `preExtractedCandidates`. Used by
 * the contradiction-tab "Keep both" supersession path, which feeds the
 * enclave a pre-built merged-record delta and needs the standard
 * round-2 finalise machinery to produce a signed envelope without
 * re-extracting from a fresh transcript. PCR0 rotates on this change.
 */
export type TriggerKind = 'end-of-session' | 'nightly-consolidation' | 'reconcile-only';

export interface DreamConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  conversationId?: string;
  messageIndex?: number;
}

export interface DreamCandidate {
  triggerKind: TriggerKind;
  dreamSessionId: string;
  userId: string;
  namespace: MemoryNamespace;
  conversationMessages: DreamConversationMessage[];
  existingMemoryRecords: MemoryRecord[];
  preExtractedCandidates?: CandidateMemory[];
}

export interface CandidateMemory {
  namespace: MemoryNamespace;
  kind: MemoryKind;
  text: string;
  structured: Record<string, unknown>;
  tags: string[];
  provenance: MemoryProvenance[];
  confidence: number;
}

export interface DreamMaskResult {
  remasked: string;
  next_counter: number;
}

export interface DreamMasker {
  mask(text: string, tokenCounter: number): Promise<DreamMaskResult>;
}

export interface UnsignedEnvelope {
  recordSerialisedHash: string;
  envelopeFields: Omit<MemoryMutationEnvelope, 'contentHash' | 'recordSerialisedHash'>;
  createdAt: number;
}

export type DreamFinaliseError =
  | 'unknown_dream_session'
  | 'unknown_delta_index'
  | 'finalise_timeout'
  | 'record_serialised_mismatch'
  | 'content_hash_invalid';

export type DreamFinaliseResult =
  | {
      ok: true;
      deltaIndex: number;
      signature: string;
      envelopeJson: string;
      signedEnvelope: MemoryMutationEnvelope;
    }
  | {
      ok: false;
      deltaIndex: number;
      error: DreamFinaliseError;
    };
