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

  // --- L87: record must be a non-null object -------------------------------
  it('rejects a null record', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const ok = await verifyMediaProvenance({
      record: null as unknown as MediaProvenanceRecordLike,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
    });
    expect(ok).toBe(false);
  });

  it('rejects an undefined record', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const ok = await verifyMediaProvenance({
      record: undefined as unknown as MediaProvenanceRecordLike,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
    });
    expect(ok).toBe(false);
  });

  it('rejects a non-object record (typeof !== object)', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const ok = await verifyMediaProvenance({
      record: 'not-a-record' as unknown as MediaProvenanceRecordLike,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
    });
    expect(ok).toBe(false);
  });

  // --- L88: provenancePublicKey.byteLength must be exactly 32 --------------
  // The boundary mutant (!== 32 vs <32 / >32 / <=32 / etc.) dies because both
  // 31 and 33 must be rejected and exactly-32 (the happy-path test) accepts.
  it('rejects a 31-byte provenance public key (one short of 32)', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: new Uint8Array(31).fill(1),
      now,
    });
    expect(ok).toBe(false);
  });

  it('rejects a 33-byte provenance public key (one over 32)', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: new Uint8Array(33).fill(1),
      now,
    });
    expect(ok).toBe(false);
  });

  it('rejects an empty (0-byte) provenance public key', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: new Uint8Array(0),
      now,
    });
    expect(ok).toBe(false);
  });

  // --- L91-92: Number.isNaN(createdAtMs) -----------------------------------
  it('rejects a record whose createdAt is unparseable (NaN)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    // Signed over the bad-date unsigned form, so the signature itself is
    // valid: only the NaN createdAt guard can be what rejects it.
    const record = makeRecord(bytes, privateKey, { createdAt: 'not-a-date' });
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
    });
    expect(ok).toBe(false);
  });

  // --- L93-94: TTL expiry boundary (now > expiresAtMs) ----------------------
  // createdAt + ttlSeconds*1000 is the exact expiry instant. These three cases
  // straddle it to kill `>` -> `>=`, `<`, `!=`, and the *1000 / + arithmetic
  // mutants: == expiry stays valid, expiry+1 fails, well-within passes.
  describe('TTL expiry boundary', () => {
    const createdAt = new Date('2026-06-13T12:00:00.000Z');
    const ttlSeconds = 3600;
    const expiresAtMs = createdAt.getTime() + ttlSeconds * 1000;

    it('accepts when now is exactly the expiry instant (boundary inclusive)', async () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const record = makeRecord(bytes, privateKey, {
        createdAt: createdAt.toISOString(),
        ttlSeconds,
      });
      const ok = await verifyMediaProvenance({
        record,
        bytes,
        provenancePublicKey: rawPublicKey(publicKey),
        now: expiresAtMs,
      });
      expect(ok).toBe(true);
    });

    it('rejects when now is one millisecond past the expiry instant', async () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const record = makeRecord(bytes, privateKey, {
        createdAt: createdAt.toISOString(),
        ttlSeconds,
      });
      const ok = await verifyMediaProvenance({
        record,
        bytes,
        provenancePublicKey: rawPublicKey(publicKey),
        now: expiresAtMs + 1,
      });
      expect(ok).toBe(false);
    });

    it('accepts when now is well within the ttl window', async () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const record = makeRecord(bytes, privateKey, {
        createdAt: createdAt.toISOString(),
        ttlSeconds,
      });
      const ok = await verifyMediaProvenance({
        record,
        bytes,
        provenancePublicKey: rawPublicKey(publicKey),
        now: createdAt.getTime() + 1000, // 1s in
      });
      expect(ok).toBe(true);
    });
  });

  // --- L97-98: sha256 binding ----------------------------------------------
  it('rejects when the record sha256 field does not match the actual bytes', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    // Override sha256 to a valid-hex but wrong digest, and sign over that
    // unsigned form so the signature is valid: only the sha256 binding rejects.
    const wrongSha = '0'.repeat(64);
    const record = makeRecord(bytes, privateKey, { sha256: wrongSha });
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
    });
    expect(ok).toBe(false);
  });

  // --- L103-104: base64ToBytes(signature) returns null on bad base64 -------
  it('rejects a record whose signature is not valid base64 (atob throws)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record: { ...record, signature: '@@@@' }, // invalid base64 chars
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
    });
    expect(ok).toBe(false);
  });

  // --- L119-131: default SubtleCrypto path with a fresh valid signature ----
  // Distinct from the file-level happy path; explicitly no ed25519Verify so the
  // crypto.subtle.importKey/verify branch stays exercised end-to-end.
  it('verifies via the default SubtleCrypto path (no injected verifier)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
      // ed25519Verify deliberately omitted.
    });
    expect(ok).toBe(true);
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

  // --- L109-117: a stub that ignores crypto and returns true → overall true.
  // Proves the injected verifier's return value (not SubtleCrypto) decides the
  // result: a record signed by an UNRELATED key still passes because the stub
  // says true. Kills mutants that drop the injected branch or ignore its value.
  it('returns true whenever the injected verifier returns true (stub overrides crypto)', async () => {
    const signing = generateKeyPairSync('ed25519');
    const unrelated = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, signing.privateKey);
    const stub = vi.fn(() => true);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      // Wrong key for the signature, yet the stub forces a pass.
      provenancePublicKey: rawPublicKey(unrelated.publicKey),
      now,
      ed25519Verify: stub,
    });
    expect(ok).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('supports an async injected verifier that resolves true / false', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const raw = rawPublicKey(publicKey);

    const okTrue = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: raw,
      now,
      ed25519Verify: async () => true,
    });
    expect(okTrue).toBe(true);

    const okFalse = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: raw,
      now,
      ed25519Verify: async () => false,
    });
    expect(okFalse).toBe(false);
  });

  it('fails closed when the injected verifier rejects (async throw)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: rawPublicKey(publicKey),
      now,
      ed25519Verify: async () => {
        throw new Error('async primitive failure');
      },
    });
    expect(ok).toBe(false);
  });

  // Pin the EXACT bytes handed to the injected verifier: raw 32-byte key,
  // the decoded 64-byte signature, and the canonical message — compared to an
  // independently-computed canonical() of the unsigned record. Kills mutants
  // that pass SPKI-wrapped key, undecoded signature, or a non-canonical message.
  it('passes the raw key, decoded signature, and canonical message bytes verbatim', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const record = makeRecord(bytes, privateKey);
    const raw = rawPublicKey(publicKey);
    const { signature, ...unsigned } = record;
    const expectedSig = Uint8Array.from(Buffer.from(signature, 'base64'));
    const expectedMsg = new TextEncoder().encode(canonical(unsigned));

    let capturedKey: Uint8Array | undefined;
    let capturedSig: Uint8Array | undefined;
    let capturedMsg: Uint8Array | undefined;
    const ok = await verifyMediaProvenance({
      record,
      bytes,
      provenancePublicKey: raw,
      now,
      ed25519Verify: (k, s, m) => {
        capturedKey = k;
        capturedSig = s;
        capturedMsg = m;
        return ed25519.verify(s, m, k);
      },
    });
    expect(ok).toBe(true);
    expect(Buffer.from(capturedKey!).toString('hex')).toBe(
      Buffer.from(raw).toString('hex'),
    );
    expect(capturedKey!.byteLength).toBe(32);
    expect(Buffer.from(capturedSig!).toString('hex')).toBe(
      Buffer.from(expectedSig).toString('hex'),
    );
    expect(Buffer.from(capturedMsg!).toString('hex')).toBe(
      Buffer.from(expectedMsg).toString('hex'),
    );
    // The canonical message is the sorted-key unsigned record (no signature).
    expect(new TextDecoder().decode(capturedMsg!)).not.toContain('signature');
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

  // --- L145: userData null OR byteLength === 0 -----------------------------
  it('returns null for a null userData', () => {
    expect(extractMediaProvenancePublicKey(null)).toBeNull();
  });

  it('returns null for a zero-length userData buffer', () => {
    expect(extractMediaProvenancePublicKey(new Uint8Array(0))).toBeNull();
  });

  // --- L152: field missing / not a string / empty string ------------------
  it('returns null when the provenance field is missing', () => {
    const userData = new TextEncoder().encode(
      JSON.stringify({ somethingElse: 'x' }),
    );
    expect(extractMediaProvenancePublicKey(userData)).toBeNull();
  });

  it('returns null when the provenance field is not a string', () => {
    const userData = new TextEncoder().encode(
      JSON.stringify({ mediaProvenancePublicKey: 12345 }),
    );
    expect(extractMediaProvenancePublicKey(userData)).toBeNull();
  });

  it('returns null when the provenance field is an empty string', () => {
    const userData = new TextEncoder().encode(
      JSON.stringify({ mediaProvenancePublicKey: '' }),
    );
    expect(extractMediaProvenancePublicKey(userData)).toBeNull();
  });

  // --- L153-154: decoded bytes null (bad base64) OR length != 32 ----------
  it('returns null when the field is not valid base64 (atob throws)', () => {
    const userData = new TextEncoder().encode(
      JSON.stringify({ mediaProvenancePublicKey: '@@@@' }),
    );
    expect(extractMediaProvenancePublicKey(userData)).toBeNull();
  });

  it('returns null when the decoded key is shorter than 32 bytes', () => {
    const userData = new TextEncoder().encode(
      JSON.stringify({
        mediaProvenancePublicKey: Buffer.from(new Uint8Array(31).fill(9))
          .toString('base64'),
      }),
    );
    expect(extractMediaProvenancePublicKey(userData)).toBeNull();
  });

  it('returns null when the decoded key is longer than 32 bytes', () => {
    const userData = new TextEncoder().encode(
      JSON.stringify({
        mediaProvenancePublicKey: Buffer.from(new Uint8Array(33).fill(9))
          .toString('base64'),
      }),
    );
    expect(extractMediaProvenancePublicKey(userData)).toBeNull();
  });

  // --- L155: a valid 32-byte base64 returns the EXACT decoded bytes -------
  it('returns the exact 32 decoded bytes for a valid base64 key', () => {
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = i; // distinct content, not all-equal
    const userData = new TextEncoder().encode(
      JSON.stringify({
        mediaProvenancePublicKey: Buffer.from(raw).toString('base64'),
      }),
    );
    const extracted = extractMediaProvenancePublicKey(userData);
    expect(extracted).not.toBeNull();
    expect(extracted!.byteLength).toBe(32);
    expect(Buffer.from(extracted!).toString('hex')).toBe(
      Buffer.from(raw).toString('hex'),
    );
  });
});
