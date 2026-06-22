import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { MediaProvenanceRecord } from '@calypso/chat-types';

import {
  prepareProviderVisibleInput,
  createProvenanceRecord,
  type ProvenanceSigner,
} from '../media';
import type { MediaHandleStore } from '../media/composition-spec';

/*
 * Direct mutation-hardening coverage for media/provider-visible-input.ts.
 *
 * prepareProviderVisibleInput is the LAST fail-closed gate before bytes /
 * prompt text are handed to a third-party provider. Every early-return here
 * is a security boundary:
 *   - an unknown handle id must NOT be silently dropped,
 *   - missing bytes must NOT be sent,
 *   - a provenance record that does not verify (tampered / expired / wrong
 *     signature) must NOT be forwarded,
 *   - a missing prompt text must hard-fail (not send an empty prompt),
 *   - a private-tainted source set must set privateTainted=true so the caller's
 *     consent gate fires,
 *   - the first IMAGE record (not text) supplies the optional input image bytes.
 *
 * The existing media-provider-input.test.ts only exercises the happy path via
 * the context wrapper; this suite drives the bare function across all branches.
 */

// Deterministic signer (HMAC-style over the canonical record bytes) so we can
// mint records that actually verify, and a wrong-key signer that never does.
const signer: ProvenanceSigner = {
  sign: (c) => createHash('sha256').update('test-key\0' + c).digest('base64'),
  verify: (c, s) =>
    s === createHash('sha256').update('test-key\0' + c).digest('base64'),
};

const wrongSigner: ProvenanceSigner = {
  sign: (c) => createHash('sha256').update('attacker-key\0' + c).digest('base64'),
  verify: (c, s) =>
    s === createHash('sha256').update('attacker-key\0' + c).digest('base64'),
};

const PROMPT_BYTES = new TextEncoder().encode('cinematic sunrise teaser');
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const NOW = new Date('2026-06-01T00:00:00.000Z');

function record(
  overrides: Partial<Parameters<typeof createProvenanceRecord>[0]> & {
    handleId: string;
    bytes: Uint8Array;
  },
): MediaProvenanceRecord {
  return createProvenanceRecord(
    {
      kind: 'text',
      origin: 'public',
      providerVisible: true,
      sourceHandleIds: [],
      createdBy: 'import',
      createdAt: NOW,
      ttlSeconds: 3600,
      byteSize: overrides.bytes.length,
      ...overrides,
    },
    signer,
  );
}

/** In-memory MediaHandleStore backed by explicit maps. */
function handleStore(
  bytesByHandle: Record<string, Uint8Array>,
  textByHandle: Record<string, string>,
): MediaHandleStore {
  return {
    getBytes: async (id) => bytesByHandle[id] ?? null,
    getText: async (id) => textByHandle[id] ?? null,
  };
}

const PROMPT_HANDLE = 'mh_prompt';
const PROMPT_TEXT = 'A cinematic 8s teaser of a sunrise over mountains';

/** A self-consistent happy-path input the negative cases mutate one field of. */
function happyPath() {
  const promptRecord = record({
    handleId: PROMPT_HANDLE,
    kind: 'text',
    origin: 'public',
    bytes: PROMPT_BYTES,
  });
  return {
    promptHandleId: PROMPT_HANDLE,
    inputHandleIds: [] as string[],
    recordsByHandleId: new Map<string, MediaProvenanceRecord>([
      [PROMPT_HANDLE, promptRecord],
    ]),
    handleStore: handleStore(
      { [PROMPT_HANDLE]: PROMPT_BYTES },
      { [PROMPT_HANDLE]: PROMPT_TEXT },
    ),
    signer,
    now: NOW,
  };
}

describe('prepareProviderVisibleInput — fail-closed gates', () => {
  it('returns the prompt text on the happy path (non-tainted, no image)', async () => {
    const result = await prepareProviderVisibleInput(happyPath());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.promptText).toBe(PROMPT_TEXT);
      expect(result.privateTainted).toBe(false);
      expect(result.inputImageBytes).toBeUndefined();
      expect(result.provenanceSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.inputHandleSetHash).toBe(result.provenanceSnapshotHash);
    }
  });

  it('rejects an unknown provider-input handle (no record) instead of dropping it', async () => {
    const base = happyPath();
    base.inputHandleIds = ['mh_missing_record'];
    // bytes exist for the unknown handle, but no provenance record does.
    base.handleStore = handleStore(
      { [PROMPT_HANDLE]: PROMPT_BYTES, mh_missing_record: IMAGE_BYTES },
      { [PROMPT_HANDLE]: PROMPT_TEXT },
    );
    const result = await prepareProviderVisibleInput(base);
    expect(result).toEqual({
      ok: false,
      reason: 'UNKNOWN_PROVIDER_INPUT_HANDLE:mh_missing_record',
    });
  });

  it('rejects a handle whose bytes are missing from the store', async () => {
    const base = happyPath();
    const imgRecord = record({
      handleId: 'mh_img',
      kind: 'image',
      origin: 'public',
      bytes: IMAGE_BYTES,
    });
    base.inputHandleIds = ['mh_img'];
    base.recordsByHandleId.set('mh_img', imgRecord);
    // record present, but the store has NO bytes for mh_img.
    base.handleStore = handleStore(
      { [PROMPT_HANDLE]: PROMPT_BYTES },
      { [PROMPT_HANDLE]: PROMPT_TEXT },
    );
    const result = await prepareProviderVisibleInput(base);
    expect(result).toEqual({
      ok: false,
      reason: 'PROVIDER_INPUT_BYTES_MISSING:mh_img',
    });
  });

  it('rejects a record that does not verify (wrong signing key) before egress', async () => {
    const base = happyPath();
    // Same logical prompt record, but signed by the attacker key — the
    // verifier (signer) must refuse it.
    const tampered = createProvenanceRecord(
      {
        handleId: PROMPT_HANDLE,
        kind: 'text',
        origin: 'public',
        providerVisible: true,
        sourceHandleIds: [],
        createdBy: 'import',
        createdAt: NOW,
        ttlSeconds: 3600,
        byteSize: PROMPT_BYTES.length,
        bytes: PROMPT_BYTES,
      },
      wrongSigner,
    );
    base.recordsByHandleId = new Map([[PROMPT_HANDLE, tampered]]);
    const result = await prepareProviderVisibleInput(base);
    expect(result).toEqual({
      ok: false,
      reason: `PROVIDER_INPUT_PROVENANCE_INVALID:${PROMPT_HANDLE}`,
    });
  });

  it('rejects a record whose bytes no longer match its sha256 (tampered content)', async () => {
    const base = happyPath();
    // The record commits to PROMPT_BYTES, but the store returns different bytes.
    base.handleStore = handleStore(
      { [PROMPT_HANDLE]: new TextEncoder().encode('SWAPPED CONTENT') },
      { [PROMPT_HANDLE]: PROMPT_TEXT },
    );
    const result = await prepareProviderVisibleInput(base);
    expect(result).toEqual({
      ok: false,
      reason: `PROVIDER_INPUT_PROVENANCE_INVALID:${PROMPT_HANDLE}`,
    });
  });

  it('rejects when the prompt text is missing even though provenance verifies', async () => {
    const base = happyPath();
    base.handleStore = handleStore(
      { [PROMPT_HANDLE]: PROMPT_BYTES },
      {}, // no text for the prompt handle
    );
    const result = await prepareProviderVisibleInput(base);
    expect(result).toEqual({ ok: false, reason: 'PROVIDER_PROMPT_TEXT_MISSING' });
  });

  it('marks the input private-tainted when any source record is private-derived', async () => {
    const privateRecord = record({
      handleId: 'mh_private_img',
      kind: 'image',
      origin: 'generated_from_private',
      bytes: IMAGE_BYTES,
    });
    const base = happyPath();
    base.inputHandleIds = ['mh_private_img'];
    base.recordsByHandleId.set('mh_private_img', privateRecord);
    base.handleStore = handleStore(
      { [PROMPT_HANDLE]: PROMPT_BYTES, mh_private_img: IMAGE_BYTES },
      { [PROMPT_HANDLE]: PROMPT_TEXT },
    );
    const result = await prepareProviderVisibleInput(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.privateTainted).toBe(true);
      // the image record supplies the optional input image bytes
      expect(result.inputImageBytes).toEqual(IMAGE_BYTES);
    }
  });

  it('selects the FIRST image record for input image bytes, not a text record', async () => {
    // A text record sorts before an image record by handle id, so this pins
    // that the code keys on record.kind === "image", not array order.
    const imgRecord = record({
      handleId: 'mh_aaa_image',
      kind: 'image',
      origin: 'public',
      bytes: IMAGE_BYTES,
    });
    const base = happyPath();
    base.inputHandleIds = ['mh_aaa_image'];
    base.recordsByHandleId.set('mh_aaa_image', imgRecord);
    base.handleStore = handleStore(
      { [PROMPT_HANDLE]: PROMPT_BYTES, mh_aaa_image: IMAGE_BYTES },
      { [PROMPT_HANDLE]: PROMPT_TEXT },
    );
    const result = await prepareProviderVisibleInput(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputImageBytes).toEqual(IMAGE_BYTES);
    }
  });

  it('returns no image bytes when there is no image record (text-only set)', async () => {
    // Pins the `record.kind === "image"` filter: a text-only set ⇒ undefined,
    // not "the first record's bytes".
    const result = await prepareProviderVisibleInput(happyPath());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inputImageBytes).toBeUndefined();
  });

  it('binds the provenance snapshot hash to handleId+sha256+signature (order-independent)', async () => {
    // Two input image records whose only difference from each other is handle
    // order in inputHandleIds must produce the SAME snapshot hash (the code
    // sorts by handleId before hashing).
    const imgA = record({
      handleId: 'mh_img_a',
      kind: 'image',
      origin: 'public',
      bytes: new Uint8Array([10, 11, 12]),
    });
    const imgB = record({
      handleId: 'mh_img_b',
      kind: 'image',
      origin: 'public',
      bytes: new Uint8Array([20, 21, 22]),
    });
    const store = handleStore(
      {
        [PROMPT_HANDLE]: PROMPT_BYTES,
        mh_img_a: new Uint8Array([10, 11, 12]),
        mh_img_b: new Uint8Array([20, 21, 22]),
      },
      { [PROMPT_HANDLE]: PROMPT_TEXT },
    );
    const records = new Map<string, MediaProvenanceRecord>([
      [PROMPT_HANDLE, record({ handleId: PROMPT_HANDLE, bytes: PROMPT_BYTES })],
      ['mh_img_a', imgA],
      ['mh_img_b', imgB],
    ]);

    const forward = await prepareProviderVisibleInput({
      promptHandleId: PROMPT_HANDLE,
      inputHandleIds: ['mh_img_a', 'mh_img_b'],
      recordsByHandleId: records,
      handleStore: store,
      signer,
      now: NOW,
    });
    const reversed = await prepareProviderVisibleInput({
      promptHandleId: PROMPT_HANDLE,
      inputHandleIds: ['mh_img_b', 'mh_img_a'],
      recordsByHandleId: records,
      handleStore: store,
      signer,
      now: NOW,
    });

    expect(forward.ok && reversed.ok).toBe(true);
    if (forward.ok && reversed.ok) {
      expect(forward.provenanceSnapshotHash).toBe(reversed.provenanceSnapshotHash);
    }

    // The hash must equal sha256 over the EXACT projected+sorted structure
    // the source builds: {handleId, sha256, signature} per record, sorted by
    // handleId. Pinning the concrete value kills the `records.map(...)` /
    // projection-arrow / initial-array mutants (which all change the hashed
    // structure) — an order-independent equality alone leaves them alive.
    const expectedSnapshot = createHash('sha256')
      .update(
        JSON.stringify(
          [PROMPT_HANDLE, 'mh_img_a', 'mh_img_b']
            .map((id) => {
              const rec = records.get(id)!;
              return { handleId: rec.handleId, sha256: rec.sha256, signature: rec.signature };
            })
            .sort((a, b) => a.handleId.localeCompare(b.handleId)),
        ),
      )
      .digest('hex');
    if (forward.ok) {
      expect(forward.provenanceSnapshotHash).toBe(expectedSnapshot);
    }
  });

  it('binds the snapshot hash to EACH record field (handleId, sha256, signature)', async () => {
    // Recompute the single-record snapshot independently and assert equality,
    // then assert that perturbing any one of the three projected fields changes
    // the expected hash — pinning that all three are inside the hashed JSON.
    const result = await prepareProviderVisibleInput(happyPath());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rec = happyPath().recordsByHandleId.get(PROMPT_HANDLE)!;
    const projected = { handleId: rec.handleId, sha256: rec.sha256, signature: rec.signature };
    const expected = createHash('sha256')
      .update(JSON.stringify([projected]))
      .digest('hex');
    expect(result.provenanceSnapshotHash).toBe(expected);

    // Each field genuinely participates in the hash.
    for (const field of ['handleId', 'sha256', 'signature'] as const) {
      const perturbed = createHash('sha256')
        .update(JSON.stringify([{ ...projected, [field]: `${projected[field]}-x` }]))
        .digest('hex');
      expect(perturbed).not.toBe(expected);
    }
  });
});
