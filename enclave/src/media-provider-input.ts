/**
 * Request-scoped provider-visible-input bundle for VIDEO generation.
 *
 * The video_generate branch treats the prompt as a provider-visible input that
 * must clear the same custody/provenance gate the rest of the media flow uses
 * (the prompt is sent to the external video provider, e.g. Veo). Unlike
 * image_generate (which uses the masked objective directly), video_generate
 * REQUIRES a populated handleStore + resolveProviderInput + consentVerifier
 * (see media-executor.ts ~line 505).
 *
 * This builds those, request-scoped, for the masked text→video path:
 *   - the (already on-device-masked) prompt is stored as a "public"-origin,
 *     provider-visible TEXT handle with a signed provenance record;
 *   - because the origin is non-private, classifyProvenanceSet keeps it
 *     `public_or_generated`, so the consent gate is skipped (no WebAuthn consent
 *     credential needed for a masked prompt — same trust class as a chat message).
 *
 * The consentVerifier is wired against a FAIL-CLOSED credential store: a
 * private/tainted input (e.g. a user_private source image → video) would require
 * consent and is therefore safely blocked until the consent-credential broker is
 * wired — text→video and public/generated-source→video are unaffected.
 */
import { randomUUID, createHash } from 'node:crypto';
import type { MediaProvenanceRecord, AgentSubtask } from '@calypso/chat-types';
import {
  createProvenanceRecord,
  createEnclaveConsentVerifier,
  type ProvenanceSigner,
  type MediaHandleStore,
  type ConsentVerifier,
  type ConsentCredentialStore,
} from './media';
import type { RunMediaSubtaskDeps } from './orchestrator/media-executor';

type ProviderInput = NonNullable<RunMediaSubtaskDeps['providerInput']>;

/** Masked prompt → provider instruction; bounded to a sane provider length. */
function deriveVideoPrompt(subtask: AgentSubtask): string {
  const text = (subtask.objective || subtask.title || '').trim();
  return text.slice(0, 4000);
}

/**
 * Fail-closed consent credential store. For text→video (non-tainted) the
 * verifier is never invoked; if a tainted input ever reaches consent
 * verification before the consent-credential broker exists, it is rejected.
 */
const FAIL_CLOSED_CONSENT_STORE: ConsentCredentialStore = {
  verifyDeviceKey: async () => false,
  withWebAuthnCredentialLock: async () => false,
};

export interface VideoProviderInputContext {
  handleStore: MediaHandleStore;
  consentVerifier: ConsentVerifier;
  resolveProviderInput: (input: { subtask: AgentSubtask }) => Promise<ProviderInput>;
  resolveRecords: () => Promise<Map<string, MediaProvenanceRecord>>;
}

export function createVideoProviderInputContext(opts: {
  provenanceSigner: ProvenanceSigner;
  consentCredentialStore?: ConsentCredentialStore;
  userId?: string;
  now?: () => Date;
  promptTtlSeconds?: number;
}): VideoProviderInputContext {
  const now = opts.now ?? (() => new Date());
  const ttlSeconds = opts.promptTtlSeconds ?? 3600;
  const createdBy = opts.userId ?? 'agent';

  // Request-scoped stores shared across the executor's resolveProviderInput →
  // resolveRecords calls for this turn (the executor invokes them in order).
  const bytesByHandle = new Map<string, Uint8Array>();
  const textByHandle = new Map<string, string>();
  const records = new Map<string, MediaProvenanceRecord>();

  const handleStore: MediaHandleStore = {
    getBytes: async (handleId) => bytesByHandle.get(handleId) ?? null,
    getText: async (handleId) => textByHandle.get(handleId) ?? null,
  };

  const consentVerifier = createEnclaveConsentVerifier({
    userId: opts.userId ?? '',
    signerKeyId: '',
    credentialStore: opts.consentCredentialStore ?? FAIL_CLOSED_CONSENT_STORE,
  });

  return {
    handleStore,
    consentVerifier,
    resolveProviderInput: async ({ subtask }) => {
      const promptText = deriveVideoPrompt(subtask);
      const promptBytes = Buffer.from(promptText, 'utf8');
      const promptHandleId = `mh_${createHash('sha256')
        .update(`prompt\0${subtask.id}`)
        .digest('hex')
        .slice(0, 32)}`;
      const record = createProvenanceRecord(
        {
          handleId: promptHandleId,
          kind: 'text',
          // Masked prompt: non-private (same trust class as a chat message), so
          // the consent gate is not triggered. providerVisible because it is sent
          // to the external video provider.
          origin: 'public',
          providerVisible: true,
          sourceHandleIds: [],
          createdBy,
          createdAt: now(),
          ttlSeconds,
          byteSize: promptBytes.byteLength,
          bytes: promptBytes,
        },
        opts.provenanceSigner,
      );
      bytesByHandle.set(promptHandleId, promptBytes);
      textByHandle.set(promptHandleId, promptText);
      records.set(promptHandleId, record);
      return {
        promptHandleId,
        inputHandleIds: [],
        enclaveNonce: randomUUID(),
        pinnedSignerKeyId: '',
        revokedSignerKeyIds: new Set<string>(),
        seenConsentIds: new Set<string>(),
      };
    },
    resolveRecords: async () => new Map(records),
  };
}
