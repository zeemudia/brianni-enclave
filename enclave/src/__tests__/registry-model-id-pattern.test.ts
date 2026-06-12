/**
 * Defense-in-depth — `customModel.modelIdPattern` from the provider registry
 * is compiled with `new RegExp()` at custom-model lookup. The registry is
 * Ed25519-signed, so a hostile pattern requires a compromised signing
 * pipeline — but the enclave must still refuse to compile anything outside a
 * trivially-safe subset (anchored, no groups, no alternation, no escapes, no
 * unbounded quantifiers) so a malicious pattern can neither backtrack
 * catastrophically (ReDoS) nor smuggle surprising matches.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  loadAndVerifyRegistry,
  validateModelIdPattern,
  canonicalRegistrySigningInput,
  MIN_REGISTRY_VERSION,
} from '../providers/registry';

// The three patterns shipped in the committed providers.json — these MUST
// remain accepted or the enclave will refuse its own registry at boot.
const PRODUCTION_PATTERNS = [
  '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
  '^claude-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
  '^gemini-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
];

describe('validateModelIdPattern', () => {
  it('accepts every pattern shipped in the committed providers.json', () => {
    for (const pattern of PRODUCTION_PATTERNS) {
      expect(() => validateModelIdPattern(pattern)).not.toThrow();
    }
  });

  it('rejects patterns that are not anchored with ^...$', () => {
    expect(() => validateModelIdPattern('gpt-4o')).toThrow(/anchored/i);
    expect(() => validateModelIdPattern('^gpt-4o')).toThrow(/anchored/i);
    expect(() => validateModelIdPattern('gpt-4o$')).toThrow(/anchored/i);
  });

  it('rejects groups, alternation, escapes, and unbounded quantifiers', () => {
    // Groups + nested quantifiers are the classic ReDoS shape.
    expect(() => validateModelIdPattern('^(a+)+$')).toThrow();
    expect(() => validateModelIdPattern('^(?:gpt|claude)-x$')).toThrow();
    expect(() => validateModelIdPattern('^a|b$')).toThrow();
    expect(() => validateModelIdPattern('^a\\d+$')).toThrow();
    expect(() => validateModelIdPattern('^a*$')).toThrow();
    expect(() => validateModelIdPattern('^a+$')).toThrow();
    expect(() => validateModelIdPattern('^a?$')).toThrow();
  });

  it('rejects non-string, empty, and overlong patterns', () => {
    expect(() => validateModelIdPattern(42 as unknown as string)).toThrow();
    expect(() => validateModelIdPattern('')).toThrow();
    expect(() => validateModelIdPattern(`^${'a'.repeat(200)}$`)).toThrow(/length/i);
  });

  it('rejects whitelisted-character patterns that do not compile', () => {
    // Unbalanced character class — passes the character whitelist but is not
    // a valid RegExp; must be rejected at load, not throw at lookup time.
    expect(() => validateModelIdPattern('^[A-Z$')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Load-time enforcement: a SIGNED registry carrying an unsafe pattern must
// still be rejected by loadAndVerifyRegistry (defense-in-depth against a
// compromised signing pipeline).
// ---------------------------------------------------------------------------

function makeKeypair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function providersWithPattern(modelIdPattern: string) {
  return [
    {
      id: 'openai',
      adapter: 'openai_v1',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnvVar: 'OPENAI_API_KEY',
      customModel: { enabled: true, modelIdPattern },
      models: [{ id: 'gpt-4o', displayName: 'GPT-4o' }],
    },
  ];
}

function signedRegistry(providers: unknown, privateKey: string) {
  return {
    version: MIN_REGISTRY_VERSION,
    providers,
    signature: sign(
      null,
      canonicalRegistrySigningInput(MIN_REGISTRY_VERSION, providers),
      privateKey,
    ).toString('base64'),
  };
}

describe('loadAndVerifyRegistry — modelIdPattern validation', () => {
  it('accepts a signed registry with a production-shaped pattern', () => {
    const { publicKey, privateKey } = makeKeypair();
    const reg = signedRegistry(providersWithPattern(PRODUCTION_PATTERNS[0]), privateKey);
    expect(() => loadAndVerifyRegistry(reg, publicKey)).not.toThrow();
  });

  it('REJECTS a validly-signed registry carrying an unsafe pattern', () => {
    const { publicKey, privateKey } = makeKeypair();
    const reg = signedRegistry(providersWithPattern('^(a+)+$'), privateKey);
    expect(() => loadAndVerifyRegistry(reg, publicKey)).toThrow(/modelIdPattern/);
  });

  it('REJECTS a validly-signed registry carrying an unanchored pattern', () => {
    const { publicKey, privateKey } = makeKeypair();
    const reg = signedRegistry(providersWithPattern('gpt-.{0,10}'), privateKey);
    expect(() => loadAndVerifyRegistry(reg, publicKey)).toThrow(/modelIdPattern/);
  });
});
