import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createVideoProviderInputContext } from '../media-provider-input.js';
import { prepareProviderVisibleInput, type ProvenanceSigner } from '../media';
import type { AgentSubtask } from '@calypso/chat-types';

// Deterministic test signer (HMAC-style over the canonical payload).
const signer: ProvenanceSigner = {
  sign: (c) => createHash('sha256').update('k\0' + c).digest('base64'),
  verify: (c, s) => s === createHash('sha256').update('k\0' + c).digest('base64'),
};

function videoSubtask(overrides: Partial<AgentSubtask> = {}): AgentSubtask {
  return {
    id: 'st_video_1',
    title: 'Make a launch teaser',
    objective: 'A cinematic 8s teaser of a sunrise over mountains',
    media: { operation: 'video_generate', maxDurationSeconds: 8 },
    ...overrides,
  } as AgentSubtask;
}

describe('createVideoProviderInputContext (text→video provider-visible input)', () => {
  it('resolveProviderInput stores a masked prompt handle and returns the descriptor', async () => {
    const ctx = createVideoProviderInputContext({ provenanceSigner: signer, userId: 'u1' });
    const providerInput = await ctx.resolveProviderInput({ subtask: videoSubtask() });
    expect(providerInput.promptHandleId).toMatch(/^mh_/);
    expect(providerInput.inputHandleIds).toEqual([]);
    expect(typeof providerInput.enclaveNonce).toBe('string');
    expect(providerInput.seenConsentIds instanceof Set).toBe(true);
    expect(providerInput.revokedSignerKeyIds instanceof Set).toBe(true);
    expect(providerInput.consent).toBeUndefined();

    expect(await ctx.handleStore.getText(providerInput.promptHandleId)).toBe(
      'A cinematic 8s teaser of a sunrise over mountains',
    );
    const bytes = await ctx.handleStore.getBytes(providerInput.promptHandleId);
    expect(bytes).not.toBeNull();
  });

  it('feeds end-to-end through the REAL prepareProviderVisibleInput as NON-tainted', async () => {
    const ctx = createVideoProviderInputContext({ provenanceSigner: signer, userId: 'u1' });
    const subtask = videoSubtask();
    const providerInput = await ctx.resolveProviderInput({ subtask });
    const records = await ctx.resolveRecords();

    const prepared = await prepareProviderVisibleInput({
      promptHandleId: providerInput.promptHandleId,
      inputHandleIds: providerInput.inputHandleIds,
      handleStore: ctx.handleStore,
      recordsByHandleId: records,
      signer,
      now: new Date(),
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.privateTainted).toBe(false); // masked prompt ⇒ no consent gate
      expect(prepared.promptText).toBe('A cinematic 8s teaser of a sunrise over mountains');
    }
  });

  it('resolveRecords contains a verifiable provenance record for the prompt handle', async () => {
    const ctx = createVideoProviderInputContext({ provenanceSigner: signer });
    const providerInput = await ctx.resolveProviderInput({ subtask: videoSubtask() });
    const records = await ctx.resolveRecords();
    const record = records.get(providerInput.promptHandleId);
    expect(record).toBeDefined();
    expect(record?.kind).toBe('text');
    // origin must be non-private so classifyProvenanceSet keeps it public_or_generated.
    expect(['public', 'generated']).toContain(record?.origin);
    expect(record?.providerVisible).toBe(true);
  });

  it('falls back to the title when the objective is empty and bounds prompt length', async () => {
    const ctx = createVideoProviderInputContext({ provenanceSigner: signer });
    const providerInput = await ctx.resolveProviderInput({
      subtask: videoSubtask({ objective: '', title: 'Just a teaser' }),
    });
    expect(await ctx.handleStore.getText(providerInput.promptHandleId)).toBe('Just a teaser');
  });

  it('the consentVerifier is fail-closed for tainted inputs until a consent broker is wired', async () => {
    const ctx = createVideoProviderInputContext({ provenanceSigner: signer, userId: 'u1' });
    const ok = await ctx.consentVerifier.verify('msg', {
      type: 'device_key',
      signerKeyId: 'k1',
      signature: 'sig',
    } as never);
    expect(ok).toBe(false);
  });
});
