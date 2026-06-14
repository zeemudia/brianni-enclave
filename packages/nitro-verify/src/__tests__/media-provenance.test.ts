import { describe, expect, it, vi } from 'vitest';
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import {
  verifyMediaProvenance,
  extractMediaProvenancePublicKey,
  type MediaProvenanceRecordLike,
} from '../media-provenance';

const ED25519_SPKI_PREFIX_LEN = 12;

function rawPublicKey(publicKey: KeyObject): Uint8Array {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return Uint8Array.prototype.slice.call(spki, ED25519_SPKI_PREFIX_LEN);
}

// Mirror the enclave/chat-types canonicalisation (sorted keys, JSON.stringify).
function canonical(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, child]) => [k, sortKeys(child)]),
    );
  };
  return JSON.stringify(sortKeys(value));
}

function makeRecord(
  bytes: Uint8Array,
  privateKey: KeyObject,
  overrides: Partial<MediaProvenanceRecordLike> = {},
): MediaProvenanceRecordLike {
  const unsigned = {
    handleId: 'mh_testimage01',
    kind: 'image',
    origin: 'generated',
    providerVisible: true,
    sourceHandleIds: [] as string[],
    createdBy: 'gpt-image-2',
    createdAt: new Date('2026-06-13T12:00:00.000Z').toISOString(),
    ttlSeconds: 3600,
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...overrides,
  };
  const signature = cryptoSign(
    null,
    Buffer.from(canonical(unsigned), 'utf8'),
    privateKey,
  ).toString('base64');
  return { ...unsigned, signature };
}

describe('verifyMediaProvenance', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const now = new Date('2026-06-13T12:10:00.000Z').getTime();

  it('verifies a well-formed record against the attested public key', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
    });
    expect(ok).toBe(true);
  });

  it('rejects a tampered signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const sig = Buffer.from(record.signature, 'base64');
    sig[0] ^= 0xff;
    const ok = await verifyMediaProvenance({
      record: { ...record, signature: sig.toString('base64') },
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
    });
    expect(ok).toBe(false);
  });

  it('rejects a record signed by a different key (wrong attested identity)', async () => {
    const signing = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, signing.privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(other.publicKey),
      now,
    });
    expect(ok).toBe(false);
  });

  it('rejects when the bytes do not match the recorded sha256', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes: new Uint8Array([9, 9, 9]),
      provenancePublicKey: rawPublicKey(publicKey),
      now,
    });
    expect(ok).toBe(false);
  });

  it('rejects an expired record (past createdAt + ttlSeconds)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now: new Date('2026-06-13T13:30:00.000Z').getTime(), // 90 min later
    });
    expect(ok).toBe(false);
  });
});

// The clients (React Native via react-native-quick-crypto, and web) inject
// @noble/curves/ed25519 as the verify primitive instead of relying on the
// runtime's SubtleCrypto shipping Ed25519. These tests exercise that exact
// injected path against records signed by node:crypto (the enclave signer),
// proving cross-implementation compatibility (enclave node:crypto → client
// noble) without any SubtleCrypto Ed25519 involvement.
describe('verifyMediaProvenance with injected ed25519Verify (client noble path)', () => {
  const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const now = new Date('2026-06-13T12:10:00.000Z').getTime();
  // The client passes the RAW 32-byte key (extractMediaProvenancePublicKey),
  // RAW signature bytes, and the canonical message; noble verifies directly.
  const nobleVerify = (
    publicKey: Uint8Array,
    signature: Uint8Array,
    message: Uint8Array,
  ): boolean => ed25519.verify(signature, message, publicKey);

  it('verifies an enclave (node:crypto) signed record via the injected noble verifier', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
      ed25519Verify: nobleVerify,
    });
    expect(ok).toBe(true);
  });

  it('rejects a record signed by a different key via the injected verifier', async () => {
    const signing = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, signing.privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(other.publicKey),
      now,
      ed25519Verify: nobleVerify,
    });
    expect(ok).toBe(false);
  });

  it('uses the injected verifier in place of SubtleCrypto (raw key + sig + message)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const raw = rawPublicKey(publicKey);
    const spy = vi.fn(
      (
        publicKey: Uint8Array,
        signature: Uint8Array,
        message: Uint8Array,
      ): boolean => ed25519.verify(signature, message, publicKey),
    );
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: raw,
      now,
      ed25519Verify: spy,
    });
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const [calledKey, calledSig, calledMsg] = spy.mock.calls[0];
    // Raw 32-byte key (not SPKI-wrapped), raw 64-byte signature, canonical msg.
    expect(calledKey.byteLength).toBe(32);
    expect(calledSig.byteLength).toBe(64);
    expect(new TextDecoder().decode(calledMsg)).toContain('"handleId"');
  });

  it('fails closed when the injected verifier returns false', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
      ed25519Verify: () => false,
    });
    expect(ok).toBe(false);
  });

  it('fails closed when the injected verifier throws', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
      ed25519Verify: () => {
        throw new Error('verify primitive unavailable');
      },
    });
    expect(ok).toBe(false);
  });

  it('still checks sha256/ttl before the injected verifier (bytes mismatch → no verify call)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const spy = vi.fn(() => true);
    const ok = await verifyMediaProvenance({
      record,
      bytes: new Uint8Array([0, 0, 0]),
      provenancePublicKey: rawPublicKey(publicKey),
      now,
      ed25519Verify: spy,
    });
    expect(ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('extractMediaProvenancePublicKey', () => {
  it('parses the base64 raw key from the attestation user_data envelope', () => {
    const raw = new Uint8Array(32).fill(7);
    const userData = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        mediaProvenancePublicKey: Buffer.from(raw).toString('base64'),
      }),
    );
    const extracted = extractMediaProvenancePublicKey(userData);
    expect(extracted).not.toBeNull();
    expect(Buffer.from(extracted!).toString('hex')).toEqual(
      Buffer.from(raw).toString('hex'),
    );
  });

  it('returns null for absent or malformed user_data', () => {
    expect(extractMediaProvenancePublicKey(null)).toBeNull();
    expect(
      extractMediaProvenancePublicKey(new TextEncoder().encode('not json')),
    ).toBeNull();
    expect(
      extractMediaProvenancePublicKey(
        new TextEncoder().encode(JSON.stringify({ v: 1 })),
      ),
    ).toBeNull();
  });
});
