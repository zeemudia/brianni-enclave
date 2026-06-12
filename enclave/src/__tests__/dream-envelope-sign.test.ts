import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  canonicaliseEnvelopeForSigning,
  finaliseDreamEnvelopes,
} from '../dream/envelope-sign';
import { DREAM_FINALISE_TIMEOUT_MS, type UnsignedEnvelope } from '../dream/types';

const contentHash = 'a'.repeat(64);
const recordSerialisedHash = 'b'.repeat(64);

function makeUnsigned(deltaIndex: number, createdAt: number): UnsignedEnvelope {
  return {
    createdAt,
    recordSerialisedHash,
    envelopeFields: {
      v: 1,
      userId: 'user-1',
      namespace: 'default',
      blobId: `mem-${deltaIndex}`,
      action: 'ADD',
      expectedBaseVersion: -1,
      newRecordVersion: 0,
      kind: 'fact',
      mutationId: crypto.randomUUID(),
      dreamSessionId: 'dream-1',
      teeSessionId: 'tee-1',
      provenanceConversationIds: ['conv-1'],
      issuedAt: '2026-05-11T00:00:00.000Z',
      expiresAt: '2026-05-11T00:01:00.000Z',
    },
  };
}

function makeState(entries: Array<[number, UnsignedEnvelope]>) {
  return {
    inFlightUnsignedEnvelopes: new Map([
      ['dream-1', new Map(entries)],
    ]),
  };
}

describe('finaliseDreamEnvelopes lifecycle', () => {
  it('returns unknown_dream_session for stale or never-issued dreamSessionId', async () => {
    const result = await finaliseDreamEnvelopes({
      state: { inFlightUnsignedEnvelopes: new Map() },
      dreamSessionId: 'missing',
      items: [{ deltaIndex: 0, contentHash, recordSerialisedHash }],
      signEnvelope: async () => new Uint8Array([1]),
      now: () => 1,
    });

    expect(result).toEqual([
      { ok: false, deltaIndex: 0, error: 'unknown_dream_session' },
    ]);
  });

  it('reports finalise_timeout distinctly and deletes the aged entry', async () => {
    const state = makeState([
      [0, makeUnsigned(0, 1000)],
    ]);

    const result = await finaliseDreamEnvelopes({
      state,
      dreamSessionId: 'dream-1',
      items: [{ deltaIndex: 0, contentHash, recordSerialisedHash }],
      signEnvelope: async () => new Uint8Array([1]),
      now: () => 1000 + DREAM_FINALISE_TIMEOUT_MS + 1,
    });

    expect(result).toEqual([
      { ok: false, deltaIndex: 0, error: 'finalise_timeout' },
    ]);
    expect(state.inFlightUnsignedEnvelopes.get('dream-1')?.has(0)).toBe(false);
  });

  it('double-finalise returns unknown_delta_index after the first success', async () => {
    const state = makeState([
      [0, makeUnsigned(0, 1000)],
    ]);

    const first = await finaliseDreamEnvelopes({
      state,
      dreamSessionId: 'dream-1',
      items: [{ deltaIndex: 0, contentHash, recordSerialisedHash }],
      signEnvelope: async () => new Uint8Array([1, 2, 3]),
      now: () => 1000,
    });
    const second = await finaliseDreamEnvelopes({
      state,
      dreamSessionId: 'dream-1',
      items: [{ deltaIndex: 0, contentHash, recordSerialisedHash }],
      signEnvelope: async () => new Uint8Array([1, 2, 3]),
      now: () => 1000,
    });

    expect(first[0].ok).toBe(true);
    expect(second).toEqual([
      { ok: false, deltaIndex: 0, error: 'unknown_delta_index' },
    ]);
  });

  it('keeps a record_serialised_mismatch entry retryable within the timeout', async () => {
    const state = makeState([
      [0, makeUnsigned(0, 1000)],
    ]);

    const result = await finaliseDreamEnvelopes({
      state,
      dreamSessionId: 'dream-1',
      items: [{ deltaIndex: 0, contentHash, recordSerialisedHash: 'c'.repeat(64) }],
      signEnvelope: async () => new Uint8Array([1]),
      now: () => 1000,
    });

    expect(result).toEqual([
      { ok: false, deltaIndex: 0, error: 'record_serialised_mismatch' },
    ]);
    expect(state.inFlightUnsignedEnvelopes.get('dream-1')?.has(0)).toBe(true);
  });

  it('handles timeout, unknown index, and ok in the same batch', async () => {
    const state = makeState([
      [0, makeUnsigned(0, 1000)],
      [2, makeUnsigned(2, 2000)],
    ]);

    const result = await finaliseDreamEnvelopes({
      state,
      dreamSessionId: 'dream-1',
      items: [
        { deltaIndex: 0, contentHash, recordSerialisedHash },
        { deltaIndex: 1, contentHash, recordSerialisedHash },
        { deltaIndex: 2, contentHash, recordSerialisedHash },
      ],
      signEnvelope: async () => new Uint8Array([9]),
      now: () => 1000 + DREAM_FINALISE_TIMEOUT_MS + 1,
    });

    expect(result.map((item) => item.ok ? 'ok' : item.error)).toEqual([
      'finalise_timeout',
      'unknown_delta_index',
      'ok',
    ]);
  });

  it('signs canonical envelopes with verifiable Ed25519 signatures', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const state = makeState([
      [0, makeUnsigned(0, 1000)],
    ]);

    const result = await finaliseDreamEnvelopes({
      state,
      dreamSessionId: 'dream-1',
      items: [{ deltaIndex: 0, contentHash, recordSerialisedHash }],
      signEnvelope: async (canonical) =>
        new Uint8Array(sign(null, Buffer.from(canonical), privateKey)),
      now: () => 1000,
    });

    expect(result[0].ok).toBe(true);
    if (!result[0].ok) throw new Error('expected ok');
    expect(
      verify(
        null,
        Buffer.from(result[0].envelopeJson),
        publicKey,
        Buffer.from(result[0].signature, 'base64'),
      ),
    ).toBe(true);
    expect(result[0].envelopeJson).toBe(
      canonicaliseEnvelopeForSigning(result[0].signedEnvelope),
    );
  });
});
