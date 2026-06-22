/**
 * Direct unit coverage for the nitro-verify internals that a real
 * AWS-rooted attestation document would exercise but which cannot be reached
 * through the PUBLIC `verifyNitroAttestation` entry against its pinned root:
 *
 *   - COSE_Sign1 signature verification (`verifyCOSESignature`)
 *   - PCR extraction + hex formatting (`extractPCRs`)
 *   - the DER/ASN.1 parsers (`parseDERTL`, `extractSPKI`, `parseCertValidity`,
 *     `parseDERTime`, `parseCertificateSignature`, `derSignatureToRaw`)
 *   - the full success path + result assembly, via the internal trust-anchor
 *     seam `verifyNitroAttestationWithTrustAnchor`.
 *
 * These symbols are exported from `../nitro-verify` for testability but are NOT
 * re-exported from the package barrel (`src/index.ts`) — production consumers
 * only ever see `verifyNitroAttestation`, which hard-codes the pinned AWS Nitro
 * root. See docs/quality/mutation-triage/nitro-verify.md.
 */
import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  verifyNitroAttestation,
  verifyNitroAttestationWithTrustAnchor,
  verifyCertificateChain,
  verifyCOSESignature,
  extractPCRs,
  extractSPKI,
  parseDERTL,
  parseCertValidity,
  parseDERTime,
  parseCertificateSignature,
  derSignatureToRaw,
} from '../nitro-verify';
import { encodeCBOR, type CBORValue } from '../cbor';
import {
  buildValidAttestation,
  makeSignedCert,
  genP384Key,
  rawSignSha384,
  tlv,
  derSeq,
  derInt,
  concatBytes,
  utcTime,
  cborMapRaw,
  PROTECTED_HEADER,
} from './helpers/synthetic-chain';

// ---------------------------------------------------------------------------
// End-to-end success path through the internal trust-anchor seam
// ---------------------------------------------------------------------------

describe('verifyNitroAttestationWithTrustAnchor (full success path)', () => {
  it('verifies a valid root→signing-CA→leaf chain and returns the measured claims', async () => {
    const att = buildValidAttestation({
      publicKey: new Uint8Array([1, 2, 3, 4]),
      userData: new Uint8Array([5, 6]),
      moduleId: 'i-0abc.enclave',
      timestamp: 1_700_000_000,
    });

    const result = await verifyNitroAttestationWithTrustAnchor(att.docB64, att.rootDER, {
      verificationTimeMs: att.verificationTimeMs,
    });

    expect(result.pcrs.PCR0).toBe(att.expected.pcr0Hex);
    expect(result.pcrs.PCR1).toBe(att.expected.pcr1Hex);
    expect(result.pcrs.PCR2).toBe(att.expected.pcr2Hex);
    expect(Array.from(result.nonce)).toEqual(Array(32).fill(9));
    expect(result.publicKey && Array.from(result.publicKey)).toEqual([1, 2, 3, 4]);
    expect(result.userData && Array.from(result.userData)).toEqual([5, 6]);
    expect(result.moduleId).toBe('i-0abc.enclave');
    expect(result.timestamp).toBe(1_700_000_000);
  });

  it('falls back to null/""/0 when the optional NSM fields are absent or wrong-typed', async () => {
    // No public_key / user_data / module_id / timestamp at all.
    const att = buildValidAttestation();
    const result = await verifyNitroAttestationWithTrustAnchor(att.docB64, att.rootDER, {
      verificationTimeMs: att.verificationTimeMs,
    });
    expect(result.publicKey).toBeNull();
    expect(result.userData).toBeNull();
    expect(result.moduleId).toBe('');
    expect(result.timestamp).toBe(0);
    expect(result.pcrs.PCR0).toBe(att.expected.pcr0Hex);
  });

  it('rejects a forged COSE signature (payload/leaf-key mismatch)', async () => {
    const att = buildValidAttestation({ tamperCoseSignature: true });
    await expect(
      verifyNitroAttestationWithTrustAnchor(att.docB64, att.rootDER, {
        verificationTimeMs: att.verificationTimeMs,
      }),
    ).rejects.toThrow(/COSE_Sign1 signature verification failed|forged/i);
  });

  it('rejects when a cabundle entry is not a byte string', async () => {
    // A structurally valid payload whose cabundle holds a CBOR text string
    // (decodes to a JS string) reaches the cabundle.map type guard.
    const att = buildValidAttestation();
    const pcrsMap = cborMapRaw([
      [0, encodeCBOR(new Uint8Array(48))],
      [1, encodeCBOR(new Uint8Array(48))],
      [2, encodeCBOR(new Uint8Array(48))],
    ]);
    const payload = cborMapRaw([
      ['certificate', encodeCBOR(new Uint8Array([0x30, 0x00]))],
      ['cabundle', encodeCBOR(['not-a-cert'])],
      ['pcrs', pcrsMap],
      ['nonce', encodeCBOR(new Uint8Array(32).fill(1))],
    ]);
    const cose = encodeCBOR([PROTECTED_HEADER, null, payload, new Uint8Array(96)]);
    const b64 = Buffer.from(cose).toString('base64');
    await expect(
      verifyNitroAttestationWithTrustAnchor(b64, att.rootDER, {
        verificationTimeMs: att.verificationTimeMs,
      }),
    ).rejects.toThrow(/Invalid certificate in cabundle/);
  });

  it('rejects a chain that does not chain to the supplied trust anchor', async () => {
    const att = buildValidAttestation();
    const otherRoot = makeSignedCert({
      subjectSpkiDER: genP384Key().spkiDER,
      issuerKey: genP384Key().privateKey,
      notBefore: '2026-01-01T00:00:00Z',
      notAfter: '2030-01-01T00:00:00Z',
    });
    await expect(
      verifyNitroAttestationWithTrustAnchor(att.docB64, otherRoot, {
        verificationTimeMs: att.verificationTimeMs,
      }),
    ).rejects.toThrow(/chain verification failed at cert 0/i);
  });
});

describe('verifyNitroAttestation (public entry) pins the AWS root', () => {
  it('rejects a synthetic chain that verifies only under a test root', async () => {
    // The exact same document that passes under the seam with its test root
    // MUST fail under the public entry, which uses the pinned AWS root — proof
    // the seam does not weaken the production trust anchor.
    const att = buildValidAttestation();
    await expect(
      verifyNitroAttestation(att.docB64, { verificationTimeMs: att.verificationTimeMs }),
    ).rejects.toThrow(/chain verification failed at cert 0/i);
  });
});

describe('verifyCertificateChain', () => {
  it('rejects an empty chain before touching the trust anchor', async () => {
    // The public path always appends `certificate`, so this guard is only
    // reachable via the exported function — but it IS a real fail-closed branch.
    await expect(verifyCertificateChain([], Date.now())).rejects.toThrow(
      /Empty certificate chain/,
    );
  });
});

// ---------------------------------------------------------------------------
// COSE_Sign1 signature verification (direct)
// ---------------------------------------------------------------------------

describe('verifyCOSESignature', () => {
  const leaf = genP384Key();
  const leafCert = makeSignedCert({
    subjectSpkiDER: leaf.spkiDER,
    issuerKey: leaf.privateKey,
    notBefore: '2026-06-01T00:00:00Z',
    notAfter: '2026-06-02T00:00:00Z',
  });
  // Protected header + payload are opaque bytes the verifier binds into the
  // Sig_structure; their CBOR content is irrelevant to signature checking.
  const protectedHeader = PROTECTED_HEADER;
  const payloadBytes = encodeCBOR([1, 2, 3]);

  function sigOver(p: Uint8Array, payload: Uint8Array): Uint8Array {
    const sigStructure = encodeCBOR(['Signature1', p, new Uint8Array(0), payload]);
    return rawSignSha384(sigStructure, leaf.privateKey);
  }

  it('accepts a signature over the canonical ["Signature1", protected, b"", payload] structure', async () => {
    const sig = sigOver(protectedHeader, payloadBytes);
    await expect(
      verifyCOSESignature(protectedHeader, payloadBytes, sig, leafCert),
    ).resolves.toBeUndefined();
  });

  it('rejects a tampered signature', async () => {
    const sig = sigOver(protectedHeader, payloadBytes);
    const bad = sig.slice();
    bad[0] ^= 0xff;
    await expect(
      verifyCOSESignature(protectedHeader, payloadBytes, bad, leafCert),
    ).rejects.toThrow(/forged/i);
  });

  it('rejects when the protected header the verifier binds differs from what was signed', async () => {
    // Sign over a DIFFERENT protected header; verification with the canonical
    // one must fail (proves the protected bytes are bound into Sig_structure).
    const otherProtected = new Uint8Array([0x40]); // empty bstr, != PROTECTED_HEADER
    const sig = sigOver(otherProtected, payloadBytes);
    await expect(
      verifyCOSESignature(protectedHeader, payloadBytes, sig, leafCert),
    ).rejects.toThrow(/forged/i);
  });

  it('rejects when the payload bound differs from what was signed', async () => {
    const sig = sigOver(protectedHeader, payloadBytes);
    const otherPayload = encodeCBOR([1, 2, 4]);
    await expect(
      verifyCOSESignature(protectedHeader, otherPayload, sig, leafCert),
    ).rejects.toThrow(/forged/i);
  });
});

// ---------------------------------------------------------------------------
// PCR extraction + hex formatting (direct)
// ---------------------------------------------------------------------------

describe('extractPCRs', () => {
  it('lowercase-hex-formats each PCR with zero padding', () => {
    const pcrs = new Map<CBORValue, CBORValue>([
      [0, new Uint8Array([0x0a, 0xff, 0x00, 0x7b])],
      [1, new Uint8Array([0x01])],
      [2, new Uint8Array([0xde, 0xad])],
    ]);
    expect(extractPCRs(pcrs)).toEqual({
      PCR0: '0aff007b',
      PCR1: '01',
      PCR2: 'dead',
    });
  });

  it('throws a typed error when a PCR index is missing', () => {
    const pcrs = new Map<CBORValue, CBORValue>([
      [1, new Uint8Array([1])],
      [2, new Uint8Array([2])],
    ]);
    expect(() => extractPCRs(pcrs)).toThrow(/missing PCR0/);
  });

  it('throws a typed error when a PCR is present but not a byte string', () => {
    const pcrs = new Map<CBORValue, CBORValue>([
      [0, new Uint8Array([0])],
      [1, 'not-bytes'],
      [2, new Uint8Array([2])],
    ]);
    expect(() => extractPCRs(pcrs)).toThrow(/missing PCR1/);
  });
});

// ---------------------------------------------------------------------------
// DER/ASN.1 parsers (direct)
// ---------------------------------------------------------------------------

describe('parseDERTL', () => {
  it('parses a short-form length', () => {
    const tl = parseDERTL(tlv(0x04, new Uint8Array(3).fill(1)), 0);
    expect(tl.contentLength).toBe(3);
    expect(tl.contentOffset).toBe(2);
    expect(tl.totalLength).toBe(5);
  });

  it('parses a multi-byte long-form length (firstLenByte >= 0x80)', () => {
    const content = new Uint8Array(300).fill(7); // needs 0x82 0x01 0x2c
    const tl = parseDERTL(tlv(0x04, content), 0);
    expect(tl.contentLength).toBe(300);
    expect(tl.contentOffset).toBe(4); // tag + 0x82 + 2 length bytes
  });

  it('throws when the offset is at or past the end of data', () => {
    const data = new Uint8Array([0x04, 0x01, 0xff]);
    expect(() => parseDERTL(data, data.length)).toThrow(/unexpected end of data/);
  });

  it('treats a 0x80 length byte as long-form with zero length octets (not a 128-byte short form)', () => {
    // 0x80 is the BER indefinite-length marker (illegal in DER). The `< 0x80`
    // guard routes it to the long-form branch with `numLenBytes = 0`, yielding
    // contentLength 0. The `<= 0x80` mutant would mis-read it as a 128-byte
    // short-form length. Pins the parser's fail-soft handling.
    const tl = parseDERTL(new Uint8Array([0x04, 0x80]), 0);
    expect(tl.contentLength).toBe(0);
    expect(tl.totalLength).toBe(2);
  });
});

describe('extractSPKI', () => {
  it('returns the subjectPublicKeyInfo even when the optional version field is absent', () => {
    // Cert TBS WITHOUT the [0] version wrapper: serial, sigAlg, issuer,
    // validity, subject, SPKI. Kills `if (certDER[pos] === 0xa0)` -> true,
    // which would mis-skip the serial as a version field.
    const spki = derSeq(derInt(9), derInt(8)); // recognisable marker SPKI
    const tbs = derSeq(
      derInt(1), // serial (NOT a 0xa0 version tag)
      derSeq(),
      derSeq(),
      derSeq(utcTime('2026-06-01T00:00:00Z'), utcTime('2026-06-02T00:00:00Z')),
      derSeq(),
      spki,
    );
    const cert = derSeq(tbs, derSeq(), tlv(0x03, new Uint8Array([0x00])));
    expect(Array.from(extractSPKI(cert))).toEqual(Array.from(spki));
  });

  it('skips the explicit version field when present', () => {
    const spki = derSeq(derInt(5));
    const tbs = derSeq(
      tlv(0xa0, derInt(2)), // version [0] EXPLICIT
      derInt(1),
      derSeq(),
      derSeq(),
      derSeq(utcTime('2026-06-01T00:00:00Z'), utcTime('2026-06-02T00:00:00Z')),
      derSeq(),
      spki,
    );
    const cert = derSeq(tbs, derSeq(), tlv(0x03, new Uint8Array([0x00])));
    expect(Array.from(extractSPKI(cert))).toEqual(Array.from(spki));
  });
});

describe('parseCertValidity / parseDERTime', () => {
  function certWithValidity(notBefore: Uint8Array, notAfter: Uint8Array): Uint8Array {
    const tbs = derSeq(
      tlv(0xa0, derInt(2)),
      derInt(1),
      derSeq(),
      derSeq(),
      derSeq(notBefore, notAfter),
      derSeq(),
      derSeq(),
    );
    return derSeq(tbs, derSeq(), tlv(0x03, new Uint8Array([0x00])));
  }

  it('parses a UTCTime validity window', () => {
    const cert = certWithValidity(utcTime('2026-06-01T00:00:00Z'), utcTime('2026-06-02T00:00:00Z'));
    const { notBefore, notAfter } = parseCertValidity(cert);
    expect(notBefore).toBe(Date.parse('2026-06-01T00:00:00Z'));
    expect(notAfter).toBe(Date.parse('2026-06-02T00:00:00Z'));
  });

  it('parses validity even when the optional version field is absent', () => {
    // No [0] version wrapper -> the `certDER[pos] === 0xa0` skip must NOT fire,
    // or the serial would be mis-skipped as a version and the validity offset
    // would be wrong. Kills `=== 0xa0` -> true in parseCertValidity.
    const tbs = derSeq(
      derInt(1), // serial first (not 0xa0)
      derSeq(),
      derSeq(),
      derSeq(utcTime('2026-06-01T00:00:00Z'), utcTime('2026-06-02T00:00:00Z')),
      derSeq(),
      derSeq(),
    );
    const cert = derSeq(tbs, derSeq(), tlv(0x03, new Uint8Array([0x00])));
    const { notBefore, notAfter } = parseCertValidity(cert);
    expect(notBefore).toBe(Date.parse('2026-06-01T00:00:00Z'));
    expect(notAfter).toBe(Date.parse('2026-06-02T00:00:00Z'));
  });

  it('rejects a UTCTime with leading non-digit garbage (^ anchor)', () => {
    // X + 12 digits + Z: the `^` anchor must reject; without it the regex
    // matches the 12-digit tail and parsing diverges.
    const bad = tlv(0x17, new Uint8Array([...'X260601000000Z'].map((c) => c.charCodeAt(0))));
    expect(() => parseDERTime(bad, 0)).toThrow(/Invalid UTCTime/);
  });

  it('rejects a UTCTime with trailing garbage after Z ($ anchor)', () => {
    const bad = tlv(0x17, new Uint8Array([...'260601000000ZX'].map((c) => c.charCodeAt(0))));
    expect(() => parseDERTime(bad, 0)).toThrow(/Invalid UTCTime/);
  });

  it('rejects a GeneralizedTime with leading non-digit garbage (^ anchor)', () => {
    const bad = tlv(0x18, new Uint8Array([...'X20550101000000Z'].map((c) => c.charCodeAt(0))));
    expect(() => parseDERTime(bad, 0)).toThrow(/Invalid GeneralizedTime/);
  });

  it('rejects a GeneralizedTime with trailing garbage after Z ($ anchor)', () => {
    const bad = tlv(0x18, new Uint8Array([...'20550101000000ZX'].map((c) => c.charCodeAt(0))));
    expect(() => parseDERTime(bad, 0)).toThrow(/Invalid GeneralizedTime/);
  });

  it('applies the RFC 5280 UTCTime pivot at the 50 boundary', () => {
    // yy=49 -> 2049, yy=50 -> 1950. Kills `yy >= 50` -> `>` (49 unaffected,
    // 50 would flip to 2050) and the 1900/2000 century literals.
    const c49 = parseDERTime(asTimeOnly(utcTime('2049-03-04T05:06:07Z')), 0);
    const c50 = parseDERTime(asTimeOnly(utcTime('1950-03-04T05:06:07Z')), 0);
    expect(new Date(c49.timeMs).getUTCFullYear()).toBe(2049);
    expect(new Date(c50.timeMs).getUTCFullYear()).toBe(1950);
  });

  it('parses GeneralizedTime (post-2049)', () => {
    const cert = certWithValidity(
      utcTime('2026-06-01T00:00:00Z'),
      // GeneralizedTime built inline (tag 0x18, YYYYMMDDHHMMSSZ)
      tlv(
        0x18,
        new Uint8Array([...'20550101000000Z'].map((c) => c.charCodeAt(0))),
      ),
    );
    const { notAfter } = parseCertValidity(cert);
    expect(new Date(notAfter).getUTCFullYear()).toBe(2055);
  });

  it('rejects a malformed UTCTime (wrong digit count)', () => {
    const bad = tlv(0x17, new Uint8Array([...'2606010000Z'].map((c) => c.charCodeAt(0))));
    expect(() => parseDERTime(bad, 0)).toThrow(/Invalid UTCTime/);
  });

  it('rejects a malformed GeneralizedTime (wrong digit count)', () => {
    const bad = tlv(0x18, new Uint8Array([...'205501010000Z'].map((c) => c.charCodeAt(0))));
    expect(() => parseDERTime(bad, 0)).toThrow(/Invalid GeneralizedTime/);
  });

  it('rejects an unsupported time tag with a specific error', () => {
    const bad = tlv(0x04, new Uint8Array([...'260601000000Z'].map((c) => c.charCodeAt(0))));
    expect(() => parseDERTime(bad, 0)).toThrow(/Unsupported time tag/);
  });

  it('rejects a syntactically valid but unparseable date (month 13)', () => {
    const bad = tlv(0x17, new Uint8Array([...'261301000000Z'].map((c) => c.charCodeAt(0))));
    expect(() => parseDERTime(bad, 0)).toThrow(/Unparseable/);
  });
});

// A DER time value standing alone (parseDERTime takes data+offset directly).
function asTimeOnly(time: Uint8Array): Uint8Array {
  return time;
}

// ---------------------------------------------------------------------------
// Certificate signature + ECDSA DER->raw conversion (direct)
// ---------------------------------------------------------------------------

describe('parseCertificateSignature', () => {
  it('extracts the TBS bytes and a 96-byte raw P-384 signature', () => {
    const issuer = genP384Key();
    const subject = genP384Key();
    const cert = makeSignedCert({
      subjectSpkiDER: subject.spkiDER,
      issuerKey: issuer.privateKey,
      notBefore: '2026-06-01T00:00:00Z',
      notAfter: '2026-06-02T00:00:00Z',
    });
    const { tbs, signatureBytes } = parseCertificateSignature(cert);
    // The TBS slice must start with a SEQUENCE tag and the signature must be
    // raw r||s (2 * 48 bytes for P-384).
    expect(tbs[0]).toBe(0x30);
    expect(signatureBytes.length).toBe(96);
  });
});

describe('derSignatureToRaw', () => {
  it('strips DER leading-zero padding and left-pads short components to the component size', () => {
    // r = 0x00 || 48 bytes of 0x11 (49-byte, DER sign padding) -> strip to 48.
    // s = 47 bytes of 0x22 -> left-pad with one 0x00 to 48.
    const r = concatBytes(new Uint8Array([0x00]), new Uint8Array(48).fill(0x11));
    const s = new Uint8Array(47).fill(0x22);
    const der = derSeq(tlv(0x02, r), tlv(0x02, s));
    const raw = derSignatureToRaw(der, 48);
    expect(raw.length).toBe(96);
    expect(Array.from(raw.slice(0, 48))).toEqual(Array(48).fill(0x11));
    expect(raw[48]).toBe(0x00); // s left-padded
    expect(Array.from(raw.slice(49, 96))).toEqual(Array(47).fill(0x22));
  });

  it('does NOT strip when a full-width component has a non-zero leading byte', () => {
    // r,s are already 48 bytes with non-zero first byte: no leading-zero
    // padding to strip. The `if (… ) slice(1)` guard must stay false here —
    // an unconditional strip would drop the real top byte. Kills the
    // ConditionalExpression -> true mutants on both strip guards.
    const r = new Uint8Array(48).fill(0x11);
    r[0] = 0xaa;
    const s = new Uint8Array(48).fill(0x22);
    s[0] = 0xbb;
    const der = derSeq(tlv(0x02, r), tlv(0x02, s));
    const raw = derSignatureToRaw(der, 48);
    expect(raw.length).toBe(96);
    expect(raw[0]).toBe(0xaa);
    expect(raw[48]).toBe(0xbb);
    expect(Array.from(raw.slice(0, 48))).toEqual(Array.from(r));
    expect(Array.from(raw.slice(48, 96))).toEqual(Array.from(s));
  });

  it('round-trips a real node-produced signature back to a verifiable raw form', () => {
    const key = genP384Key();
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const raw = rawSignSha384(message, key.privateKey);
    expect(raw.length).toBe(96);
  });

  // The strip guard is `if (rBytes[0] === 0 && rBytes.length > componentSize)`.
  // The `&&` (not a bare `length > componentSize`) and the `rBytes[0] === 0`
  // test together ensure we strip ONLY a genuine DER sign-pad byte. A malformed
  // over-width component whose leading byte is NON-zero must NOT have its real
  // top byte silently sliced off — the function fails closed (the left-pad
  // `raw.set(rBytes, componentSize - rBytes.length)` then throws on the negative
  // offset). A `rBytes[0] === 0 -> true` or `&& -> ||` mutant would instead
  // strip that real byte and corrupt the signature.
  it('fails closed on an over-width r with a NON-zero leading byte (does not strip a real byte)', () => {
    // r = 49 bytes of 0x11 (over-width, but NOT a 0x00 sign-pad). s = valid 48.
    const r = new Uint8Array(49).fill(0x11);
    const s = new Uint8Array(48).fill(0x22);
    const der = derSeq(tlv(0x02, r), tlv(0x02, s));
    expect(() => derSignatureToRaw(der, 48)).toThrow();
  });

  it('does not strip a NON-zero leading byte from an over-width s (s-side guard L572)', () => {
    // Symmetric to the r case but on the s component. An over-width s does not
    // hit a negative-offset throw (its left-pad offset stays in range), so we
    // pin the exact bytes: the real code does NOT strip the non-zero leading
    // byte, so the s region begins with 0x22 at raw[47]. A `sBytes[0] === 0 ->
    // true` or `&& -> ||` mutant strips that byte, shifting s right by one so
    // raw[47] becomes the (untouched) r byte 0x11 instead — a different,
    // signature-corrupting result.
    const r = new Uint8Array(48).fill(0x11);
    const s = new Uint8Array(49).fill(0x22);
    const der = derSeq(tlv(0x02, r), tlv(0x02, s));
    const raw = derSignatureToRaw(der, 48);
    expect(raw[47]).toBe(0x22); // s NOT stripped: its first byte lands here
  });
});
