/**
 * F6 regression — provider registry replay / anti-rollback hardening.
 *
 * The provider registry is fetched at enclave boot from a host-controlled
 * vsock broker. Previously the enclave verified an Ed25519 signature over the
 * providers ARRAY only, with no version binding and no anti-rollback floor —
 * so a compromised host could replay ANY previously-signed registry (e.g. one
 * routing to a since-deprecated/compromised provider endpoint) while the
 * enclave still presented the current pinned PCR0.
 *
 * The fix:
 *   1. Sign the canonical `{ version, providers }` envelope (not just the
 *      providers array), binding the version to the signature.
 *   2. Reject any registry whose version is below MIN_REGISTRY_VERSION, a
 *      constant baked into the measured enclave image.
 *
 * These tests use ephemeral keypairs so they don't depend on the production
 * registry-signing key (which is held offline and re-signs providers.json in
 * the new envelope format at the next PCR0 rotation).
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  loadAndVerifyRegistry,
  canonicalRegistrySigningInput,
  MIN_REGISTRY_VERSION,
} from '../providers/registry';

// Minimal provider with no capability metadata (skips capability validation,
// which is exercised separately in provider-capabilities-registry.test.ts).
const PROVIDERS = [
  {
    id: 'openai',
    adapter: 'openai_v1',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    models: [{ id: 'gpt-4o', displayName: 'GPT-4o' }],
  },
];

function makeKeypair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function signEnvelope(version: number, providers: unknown, privateKey: string): string {
  return sign(null, canonicalRegistrySigningInput(version, providers), privateKey).toString(
    'base64',
  );
}

function signProvidersOnly(providers: unknown, privateKey: string): string {
  // The legacy (vulnerable) signing scheme: signature over the providers
  // array alone, version unbound.
  return sign(null, Buffer.from(JSON.stringify(providers)), privateKey).toString('base64');
}

describe('provider registry — full-envelope signing + anti-rollback (F6)', () => {
  it('accepts a registry whose { version, providers } envelope is validly signed', () => {
    const { publicKey, privateKey } = makeKeypair();
    const reg = {
      version: MIN_REGISTRY_VERSION,
      providers: PROVIDERS,
      signature: signEnvelope(MIN_REGISTRY_VERSION, PROVIDERS, privateKey),
    };
    expect(() => loadAndVerifyRegistry(reg, publicKey)).not.toThrow();
  });

  it('REJECTS a registry signed over the providers array only (legacy format)', () => {
    const { publicKey, privateKey } = makeKeypair();
    const reg = {
      version: MIN_REGISTRY_VERSION,
      providers: PROVIDERS,
      signature: signProvidersOnly(PROVIDERS, privateKey),
    };
    expect(() => loadAndVerifyRegistry(reg, publicKey)).toThrow('INVALID_REGISTRY_SIGNATURE');
  });

  // NOTE: this asserts the floor MECHANISM (versions strictly below the baked
  // floor are rejected). It does NOT claim broad replay protection at the
  // shipped floor value — at MIN_REGISTRY_VERSION=1 nothing below the floor
  // exists, so practical anti-rollback only kicks in once an operator advances
  // the floor on rotation. See the MIN_REGISTRY_VERSION doc comment.
  it('REJECTS a registry whose version is below the baked floor', () => {
    const { publicKey, privateKey } = makeKeypair();
    const oldVersion = MIN_REGISTRY_VERSION - 1;
    const reg = {
      version: oldVersion,
      providers: PROVIDERS,
      signature: signEnvelope(oldVersion, PROVIDERS, privateKey),
    };
    expect(() => loadAndVerifyRegistry(reg, publicKey)).toThrow('REGISTRY_VERSION_BELOW_MINIMUM');
  });

  it('REJECTS a non-integer / missing version', () => {
    const { publicKey, privateKey } = makeKeypair();
    const reg = {
      version: 'one' as unknown as number,
      providers: PROVIDERS,
      // Sign whatever bytes — it never gets that far; version validation runs first.
      signature: signEnvelope(MIN_REGISTRY_VERSION, PROVIDERS, privateKey),
    };
    expect(() => loadAndVerifyRegistry(reg, publicKey)).toThrow('INVALID_REGISTRY_VERSION');
  });

  it('verifies regardless of object key insertion order (canonical serialization)', () => {
    const { publicKey, privateKey } = makeKeypair();
    // Same provider data as PROVIDERS, but every object's keys are in a
    // different insertion order. With a raw JSON.stringify the signed bytes
    // would differ and verification would fail; a canonical (recursively
    // sorted-key) serialization makes signer/verifier byte-equal regardless
    // of key order, so this must still verify.
    const providersReordered = [
      {
        models: [{ displayName: 'GPT-4o', id: 'gpt-4o' }],
        apiKeyEnvVar: 'OPENAI_API_KEY',
        baseUrl: 'https://api.openai.com/v1',
        adapter: 'openai_v1',
        id: 'openai',
      },
    ];
    const signature = signEnvelope(MIN_REGISTRY_VERSION, PROVIDERS, privateKey);
    const reg = { version: MIN_REGISTRY_VERSION, providers: providersReordered, signature };
    expect(() => loadAndVerifyRegistry(reg, publicKey)).not.toThrow();
  });

  it('REJECTS a forged version bump — the signature binds the version', () => {
    const { publicKey, privateKey } = makeKeypair();
    // Attacker holds an old registry validly signed at MIN_REGISTRY_VERSION
    // and relabels it with a higher version to clear a future floor. Because
    // the version is inside the signed envelope, the signature no longer
    // matches the relabelled version.
    const reg = {
      version: MIN_REGISTRY_VERSION + 5,
      providers: PROVIDERS,
      signature: signEnvelope(MIN_REGISTRY_VERSION, PROVIDERS, privateKey),
    };
    expect(() => loadAndVerifyRegistry(reg, publicKey)).toThrow('INVALID_REGISTRY_SIGNATURE');
  });
});
