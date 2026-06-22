/**
 * Certificate validity (notBefore/notAfter) enforcement in the attestation
 * chain verifier.
 *
 * Real Nitro attestation chains cannot be synthesized in tests (the leaf
 * must chain to the pinned AWS root, whose private key we obviously do not
 * hold), so these tests build minimal-but-structurally-valid DER certificates
 * and assert against the ORDER of failures: a cert outside its validity
 * window must fail with a validity error BEFORE signature verification is
 * attempted, while an in-window cert must pass the validity gate and fail
 * only at chain-signature verification (proving the gate does not
 * over-reject).
 *
 * Verification time is injectable (verificationTimeMs) so any future
 * RECORDED attestation fixtures — whose ~3h-lived leaf certs are expired by
 * the time tests run — can pin a fixed verification time. Real call sites
 * (apps/{web,mobile}/lib/tee/attestation.ts) use the default: Date.now().
 */
import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { verifyNitroAttestation } from '../nitro-verify';
import { encodeCBOR, type CBORValue } from '../cbor';

// ---------------------------------------------------------------------------
// Minimal DER builders
// ---------------------------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  if (content.length < 0x80) {
    return concat(new Uint8Array([tag, content.length]), content);
  }
  if (content.length < 0x100) {
    return concat(new Uint8Array([tag, 0x81, content.length]), content);
  }
  return concat(
    new Uint8Array([tag, 0x82, content.length >> 8, content.length & 0xff]),
    content,
  );
}

const derSeq = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts));
const derInt = (value: number) => tlv(0x02, new Uint8Array([value]));

function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

/** UTCTime (tag 0x17): YYMMDDHHMMSSZ — valid for years 1950-2049. */
function utcTime(iso: string): Uint8Array {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const yy = pad(d.getUTCFullYear() % 100);
  return tlv(
    0x17,
    ascii(
      `${yy}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`,
    ),
  );
}

/** GeneralizedTime (tag 0x18): YYYYMMDDHHMMSSZ — required for years >= 2050. */
function generalizedTime(iso: string): Uint8Array {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return tlv(
    0x18,
    ascii(
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`,
    ),
  );
}

/**
 * Build a minimal DER certificate with the exact TBS field skeleton the
 * verifier's parser walks (version, serial, sigAlg, issuer, validity,
 * subject, SPKI) and a structurally-parseable (but cryptographically
 * garbage) ECDSA signature BIT STRING.
 */
function makeCertDER(notBefore: Uint8Array, notAfter: Uint8Array): Uint8Array {
  const version = tlv(0xa0, derInt(2));
  const serial = derInt(1);
  const sigAlg = derSeq();
  const issuer = derSeq();
  const validity = derSeq(notBefore, notAfter);
  const subject = derSeq();
  const spki = derSeq();
  const tbs = derSeq(version, serial, sigAlg, issuer, validity, subject, spki);
  // BIT STRING: unused-bits byte + DER SEQUENCE { INTEGER r, INTEGER s }
  const fakeEcdsaSig = derSeq(
    tlv(0x02, new Uint8Array(48).fill(1)),
    tlv(0x02, new Uint8Array(48).fill(2)),
  );
  const sigBitString = tlv(0x03, concat(new Uint8Array([0x00]), fakeEcdsaSig));
  return derSeq(tbs, derSeq(), sigBitString);
}

// ---------------------------------------------------------------------------
// Minimal COSE_Sign1 attestation document builder
// ---------------------------------------------------------------------------

/** CBOR map header for < 24 entries, entries spliced as raw encoded bytes. */
function cborMapRaw(entries: Array<[CBORValue, Uint8Array]>): Uint8Array {
  return concat(
    new Uint8Array([0xa0 | entries.length]),
    ...entries.flatMap(([k, rawValue]) => [encodeCBOR(k), rawValue]),
  );
}

function makeAttestationDocB64(certDER: Uint8Array): string {
  const pcr = new Uint8Array(48).fill(7);
  const pcrsMap = cborMapRaw([
    [0, encodeCBOR(pcr)],
    [1, encodeCBOR(pcr)],
    [2, encodeCBOR(pcr)],
  ]);
  const payload = cborMapRaw([
    ['certificate', encodeCBOR(certDER)],
    ['cabundle', encodeCBOR([])],
    ['pcrs', pcrsMap],
    // M2 structural validation requires a non-empty nonce before the cert
    // chain is examined — these tests target the validity gate beyond it.
    ['nonce', encodeCBOR(new Uint8Array(32).fill(9))],
  ]);
  const cose = encodeCBOR([
    new Uint8Array([0xa0]), // protected header (empty map, bytes)
    null, // unprotected header
    payload,
    new Uint8Array(96).fill(3), // signature (never reached in these tests)
  ]);
  return Buffer.from(cose).toString('base64');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const NOT_BEFORE = '2026-06-01T00:00:00Z';
const NOT_AFTER = '2026-06-02T00:00:00Z';
const IN_WINDOW = Date.parse('2026-06-01T12:00:00Z');
const AFTER_WINDOW = Date.parse('2026-06-10T00:00:00Z');
const BEFORE_WINDOW = Date.parse('2026-05-01T00:00:00Z');

describe('certificate validity enforcement', () => {
  const doc = makeAttestationDocB64(makeCertDER(utcTime(NOT_BEFORE), utcTime(NOT_AFTER)));

  it('rejects an EXPIRED certificate (verification time after notAfter)', async () => {
    await expect(
      verifyNitroAttestation(doc, { verificationTimeMs: AFTER_WINDOW }),
    ).rejects.toThrow(/expired/i);
  });

  it('rejects a NOT-YET-VALID certificate (verification time before notBefore)', async () => {
    await expect(
      verifyNitroAttestation(doc, { verificationTimeMs: BEFORE_WINDOW }),
    ).rejects.toThrow(/not yet valid/i);
  });

  it('passes the validity gate for an in-window verification time (fails only at chain signature)', async () => {
    // The synthetic cert cannot chain to the pinned AWS root, so the verify
    // MUST fail — but at the signature step, NOT the validity step. This
    // proves the date gate does not over-reject in-window documents.
    await expect(
      verifyNitroAttestation(doc, { verificationTimeMs: IN_WINDOW }),
    ).rejects.toThrow(/chain verification failed at cert 0/i);
  });

  it('defaults to real time: a long-expired certificate is rejected without options', async () => {
    const oldDoc = makeAttestationDocB64(
      makeCertDER(utcTime('2020-01-01T00:00:00Z'), utcTime('2021-01-01T00:00:00Z')),
    );
    await expect(verifyNitroAttestation(oldDoc)).rejects.toThrow(/expired/i);
  });

  it('parses GeneralizedTime validity fields (post-2049 notAfter)', async () => {
    const genDoc = makeAttestationDocB64(
      makeCertDER(
        generalizedTime('2026-06-01T00:00:00Z'),
        generalizedTime('2055-01-01T00:00:00Z'),
      ),
    );
    // In-window → must reach (and fail at) chain-signature verification.
    await expect(
      verifyNitroAttestation(genDoc, { verificationTimeMs: IN_WINDOW }),
    ).rejects.toThrow(/chain verification failed at cert 0/i);
  });

  it('rejects a certificate whose validity field is not a recognized time encoding', async () => {
    // OCTET STRING (0x04) where a UTCTime/GeneralizedTime belongs.
    const badDoc = makeAttestationDocB64(
      makeCertDER(tlv(0x04, ascii('260601000000Z')), utcTime(NOT_AFTER)),
    );
    await expect(
      verifyNitroAttestation(badDoc, { verificationTimeMs: IN_WINDOW }),
    ).rejects.toThrow(/validity/i);
  });

  // --- Mutation hardening: validity-window boundary exactness --------------

  it('treats notBefore as INCLUSIVE (verification time == notBefore is valid)', async () => {
    // Kills `verificationTimeMs < notBefore` -> `<=`: at the exact lower edge
    // the cert is still valid and must reach (and fail at) chain signature,
    // NOT be rejected as not-yet-valid.
    await expect(
      verifyNitroAttestation(doc, { verificationTimeMs: Date.parse(NOT_BEFORE) }),
    ).rejects.toThrow(/chain verification failed at cert 0/i);
  });

  it('treats notAfter as INCLUSIVE (verification time == notAfter is valid)', async () => {
    // Kills `verificationTimeMs > notAfter` -> `>=`: at the exact upper edge
    // the cert is still valid (not yet expired).
    await expect(
      verifyNitroAttestation(doc, { verificationTimeMs: Date.parse(NOT_AFTER) }),
    ).rejects.toThrow(/chain verification failed at cert 0/i);
  });

  it('rejects one millisecond before notBefore', async () => {
    await expect(
      verifyNitroAttestation(doc, { verificationTimeMs: Date.parse(NOT_BEFORE) - 1 }),
    ).rejects.toThrow(/not yet valid/i);
  });

  it('rejects one millisecond after notAfter', async () => {
    await expect(
      verifyNitroAttestation(doc, { verificationTimeMs: Date.parse(NOT_AFTER) + 1 }),
    ).rejects.toThrow(/expired/i);
  });

  // --- Mutation hardening: UTCTime two-digit-year pivot (RFC 5280) ---------

  it('maps a UTCTime year >= 50 to the 1900s (pivot), not the 2000s', async () => {
    // notBefore yy=80 -> 1980, notAfter yy=95 -> 1995. Verified IN-WINDOW in
    // 1990. Kills the `yy >= 50 ? 1900 + yy : 2000 + yy` pivot mutants: if the
    // century were chosen wrongly the years become 2080/2095 and a 1990
    // verification time would be reported "not yet valid" instead of reaching
    // (and failing at) chain signature.
    const pivotDoc = makeAttestationDocB64(
      makeCertDER(utcTime('1980-06-01T00:00:00Z'), utcTime('1995-06-01T00:00:00Z')),
    );
    await expect(
      verifyNitroAttestation(pivotDoc, {
        verificationTimeMs: Date.parse('1990-06-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/chain verification failed at cert 0/i);
  });
});
