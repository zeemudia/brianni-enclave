import {
  MemoryMutationEnvelopeSchema,
  SHA256_OF_EMPTY,
  type MemoryMutationEnvelope,
} from '@calypso/chat-types';

import {
  DREAM_FINALISE_TIMEOUT_MS,
  type DreamFinaliseResult,
  type UnsignedEnvelope,
} from './types';

export interface DreamEnvelopeState {
  inFlightUnsignedEnvelopes: Map<string, Map<number, UnsignedEnvelope>>;
}

export interface DreamFinaliseItem {
  deltaIndex: number;
  contentHash: string;
  recordSerialisedHash: string;
}

export interface FinaliseDreamEnvelopesRequest {
  state: DreamEnvelopeState;
  dreamSessionId: string;
  items: DreamFinaliseItem[];
  signEnvelope(canonicalJson: string): Promise<Uint8Array> | Uint8Array;
  now?: () => number;
}

export async function finaliseDreamEnvelopes(
  req: FinaliseDreamEnvelopesRequest,
): Promise<DreamFinaliseResult[]> {
  const inner = req.state.inFlightUnsignedEnvelopes.get(req.dreamSessionId);
  if (!inner) {
    return req.items.map((item) => ({
      ok: false,
      deltaIndex: item.deltaIndex,
      error: 'unknown_dream_session',
    }));
  }

  const now = req.now?.() ?? Date.now();
  const timedOutIndexes = new Set<number>();
  for (const [deltaIndex, unsigned] of inner) {
    if (now - unsigned.createdAt > DREAM_FINALISE_TIMEOUT_MS) {
      timedOutIndexes.add(deltaIndex);
      inner.delete(deltaIndex);
    }
  }

  const results: DreamFinaliseResult[] = [];
  for (const item of req.items) {
    if (timedOutIndexes.has(item.deltaIndex)) {
      results.push({ ok: false, deltaIndex: item.deltaIndex, error: 'finalise_timeout' });
      continue;
    }

    const unsigned = inner.get(item.deltaIndex);
    if (!unsigned) {
      results.push({ ok: false, deltaIndex: item.deltaIndex, error: 'unknown_delta_index' });
      continue;
    }

    if (!/^[a-f0-9]{64}$/.test(item.contentHash)) {
      results.push({ ok: false, deltaIndex: item.deltaIndex, error: 'content_hash_invalid' });
      continue;
    }
    if (
      unsigned.envelopeFields.action !== 'TOMBSTONE' &&
      item.contentHash === SHA256_OF_EMPTY
    ) {
      results.push({ ok: false, deltaIndex: item.deltaIndex, error: 'content_hash_invalid' });
      continue;
    }
    if (item.recordSerialisedHash !== unsigned.recordSerialisedHash) {
      results.push({
        ok: false,
        deltaIndex: item.deltaIndex,
        error: 'record_serialised_mismatch',
      });
      continue;
    }

    const signedEnvelope = MemoryMutationEnvelopeSchema.parse({
      ...unsigned.envelopeFields,
      contentHash: item.contentHash,
      recordSerialisedHash: unsigned.recordSerialisedHash,
    });
    const envelopeJson = canonicaliseEnvelopeForSigning(signedEnvelope);
    const signature = await req.signEnvelope(envelopeJson);
    inner.delete(item.deltaIndex);
    results.push({
      ok: true,
      deltaIndex: item.deltaIndex,
      envelopeJson,
      signature: Buffer.from(signature).toString('base64'),
      signedEnvelope,
    });
  }

  // Keep an empty inner map until DREAM_DONE clears it. This lets a
  // same-session double finalise report unknown_delta_index rather
  // than making a still-live session look like a stale dreamSessionId.
  return results;
}

export function canonicaliseEnvelopeForSigning(env: MemoryMutationEnvelope): string {
  return JSON.stringify({
    action: env.action,
    blobId: env.blobId,
    contentHash: env.contentHash,
    dreamSessionId: env.dreamSessionId,
    expectedBaseVersion: env.expectedBaseVersion,
    expiresAt: env.expiresAt,
    issuedAt: env.issuedAt,
    kind: env.kind,
    mutationId: env.mutationId,
    namespace: env.namespace,
    newRecordVersion: env.newRecordVersion,
    provenanceConversationIds: env.provenanceConversationIds,
    recordSerialisedHash: env.recordSerialisedHash,
    teeSessionId: env.teeSessionId,
    userId: env.userId,
    v: env.v,
  });
}
