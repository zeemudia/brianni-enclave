/**
 * Hermetic synthetic Nitro attestation builder for the nitro-verify unit suite.
 *
 * A REAL Nitro attestation document chains its ~3h-lived leaf certificate to
 * AWS's Nitro Enclaves Root G1, whose private key we obviously do not hold, so
 * the COSE-signature / PCR-extraction / result-assembly paths of the verifier
 * cannot be exercised by any document that the verifier accepts against its
 * PINNED root. To reach those paths hermetically, the tests build a
 * cryptographically-valid chain rooted at a throwaway TEST CA and drive it
 * through the verifier's internal trust-anchor seam
 * (`verifyNitroAttestationWithTrustAnchor`, which is NOT exported from the
 * package barrel — production always uses the pinned AWS root).
 *
 * Keys + signatures are minted with `node:crypto` (available under Vitest); the
 * X.509 / COSE byte structures are assembled by hand so the bytes match exactly
 * what the verifier's minimal DER parser walks. This mirrors the enclave's own
 * `generate-fixtures.mjs`, kept in-package and deterministic-per-run.
 */
import {
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';
import { Buffer } from 'node:buffer';
import { encodeCBOR, type CBORValue } from '../../cbor';

// ---------------------------------------------------------------------------
// DER helpers
// ---------------------------------------------------------------------------

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** DER TLV with a minimal definite-length encoding. */
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  if (content.length < 0x80) {
    return concatBytes(new Uint8Array([tag, content.length]), content);
  }
  if (content.length < 0x100) {
    return concatBytes(new Uint8Array([tag, 0x81, content.length]), content);
  }
  return concatBytes(
    new Uint8Array([tag, 0x82, content.length >> 8, content.length & 0xff]),
    content,
  );
}

export const derSeq = (...parts: Uint8Array[]) => tlv(0x30, concatBytes(...parts));
export const derInt = (value: number) => tlv(0x02, new Uint8Array([value]));

function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

/** UTCTime (tag 0x17): YYMMDDHHMMSSZ. */
export function utcTime(iso: string): Uint8Array {
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

// ---------------------------------------------------------------------------
// Key + signature helpers (node:crypto, P-384 / SHA-384)
// ---------------------------------------------------------------------------

export interface TestKey {
  privateKey: KeyObject;
  /** SubjectPublicKeyInfo DER — spliced verbatim into a cert's TBS. */
  spkiDER: Uint8Array;
}

export function genP384Key(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  return {
    privateKey,
    spkiDER: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
  };
}

/** DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) over SHA-384(message). */
function derSignSha384(message: Uint8Array, key: KeyObject): Uint8Array {
  return new Uint8Array(nodeSign('sha384', message, key));
}

/** Convert a DER ECDSA signature to raw r||s (48-byte components, P-384). */
export function derToRawSig(der: Uint8Array): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('bad DER seq');
  if (der[offset] & 0x80) {
    offset += 1 + (der[offset] & 0x7f);
  } else {
    offset += 1;
  }
  if (der[offset++] !== 0x02) throw new Error('bad DER int r');
  const rLen = der[offset++];
  let r = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset++] !== 0x02) throw new Error('bad DER int s');
  const sLen = der[offset++];
  let s = der.slice(offset, offset + sLen);
  if (r[0] === 0x00 && r.length > 48) r = r.slice(1);
  if (s[0] === 0x00 && s.length > 48) s = s.slice(1);
  const raw = new Uint8Array(96);
  raw.set(r, 48 - r.length);
  raw.set(s, 96 - s.length);
  return raw;
}

export function rawSignSha384(message: Uint8Array, key: KeyObject): Uint8Array {
  return derToRawSig(derSignSha384(message, key));
}

// ---------------------------------------------------------------------------
// X.509 cert assembly (matches the verifier's TBS field skeleton exactly)
// ---------------------------------------------------------------------------

export interface CertSpec {
  subjectSpkiDER: Uint8Array;
  issuerKey: KeyObject;
  notBefore: string;
  notAfter: string;
}

/**
 * Build a DER cert whose TBS is `version, serial, sigAlg, issuer, validity,
 * subject, SPKI` and whose signatureValue is a real ECDSA-P384/SHA-384
 * signature by `issuerKey` over the TBS bytes.
 */
export function makeSignedCert(spec: CertSpec): Uint8Array {
  const version = tlv(0xa0, derInt(2));
  const serial = derInt(1);
  const sigAlg = derSeq();
  const issuer = derSeq();
  const validity = derSeq(utcTime(spec.notBefore), utcTime(spec.notAfter));
  const subject = derSeq();
  const tbs = derSeq(version, serial, sigAlg, issuer, validity, subject, spec.subjectSpkiDER);
  const derSig = derSignSha384(tbs, spec.issuerKey);
  const sigBitString = tlv(0x03, concatBytes(new Uint8Array([0x00]), derSig));
  return derSeq(tbs, derSeq(), sigBitString);
}

// ---------------------------------------------------------------------------
// COSE_Sign1 attestation assembly
// ---------------------------------------------------------------------------

/**
 * CBOR map header (< 24 entries) with raw-encoded values spliced in.
 *
 * nitro-verify's minimal `encodeCBOR` cannot encode a `Map` (the production
 * verifier only ever decodes maps, never encodes them), so map payloads are
 * assembled here from a hand-written map header + raw value bytes.
 */
export function cborMapRaw(entries: Array<[CBORValue, Uint8Array]>): Uint8Array {
  return concatBytes(
    new Uint8Array([0xa0 | entries.length]),
    ...entries.flatMap(([k, rawValue]) => [encodeCBOR(k), rawValue]),
  );
}

/**
 * A COSE protected header is a bstr wrapping a serialized header map. The
 * verifier never decodes it — it binds the raw bytes into the Sig_structure —
 * so any fixed byte string serves. We use an empty-map encoding (0xa0).
 */
export const PROTECTED_HEADER = new Uint8Array([0xa0]);

export interface AttestationSpec {
  /** Root CA = the trust anchor the seam is given. */
  rootKey?: TestKey;
  /** Window for the leaf/intermediate certs. */
  notBefore?: string;
  notAfter?: string;
  /** PCR0/1/2 bytes (default distinct fills). */
  pcr0?: Uint8Array;
  pcr1?: Uint8Array;
  pcr2?: Uint8Array;
  nonce?: Uint8Array;
  /** Optional NSM fields; omit to exercise the null/''/0 result fallbacks. */
  publicKey?: Uint8Array;
  userData?: Uint8Array;
  moduleId?: string;
  timestamp?: number;
  /** When true, corrupt the COSE signature so signature verification fails. */
  tamperCoseSignature?: boolean;
}

export interface BuiltAttestation {
  /** Base64 COSE_Sign1 document, fed to the verifier. */
  docB64: string;
  /** DER of the test root CA — passed as the seam's trust anchor. */
  rootDER: Uint8Array;
  /** A verification time inside the cert window. */
  verificationTimeMs: number;
  rootKey: TestKey;
  expected: {
    pcr0Hex: string;
    pcr1Hex: string;
    pcr2Hex: string;
  };
}

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Build a complete, cryptographically-valid two-link chain
 * (root → signing CA → leaf) and a COSE_Sign1 attestation signed by the leaf.
 */
export function buildValidAttestation(spec: AttestationSpec = {}): BuiltAttestation {
  const notBefore = spec.notBefore ?? '2026-06-01T00:00:00Z';
  const notAfter = spec.notAfter ?? '2026-06-02T00:00:00Z';
  const verificationTimeMs = Date.parse('2026-06-01T12:00:00Z');

  const rootKey = spec.rootKey ?? genP384Key();
  const signingKey = genP384Key();
  const leafKey = genP384Key();

  // Root self-issued cert (only its SPKI is read, via the trust anchor).
  const rootDER = makeSignedCert({
    subjectSpkiDER: rootKey.spkiDER,
    issuerKey: rootKey.privateKey,
    notBefore: '2026-01-01T00:00:00Z',
    notAfter: '2030-01-01T00:00:00Z',
  });
  const signingDER = makeSignedCert({
    subjectSpkiDER: signingKey.spkiDER,
    issuerKey: rootKey.privateKey,
    notBefore,
    notAfter,
  });
  const leafDER = makeSignedCert({
    subjectSpkiDER: leafKey.spkiDER,
    issuerKey: signingKey.privateKey,
    notBefore,
    notAfter,
  });

  const pcr0 = spec.pcr0 ?? new Uint8Array(48).fill(0xa0);
  const pcr1 = spec.pcr1 ?? new Uint8Array(48).fill(0xb1);
  const pcr2 = spec.pcr2 ?? new Uint8Array(48).fill(0xc2);
  const nonce = spec.nonce ?? new Uint8Array(32).fill(9);

  const pcrsMap = cborMapRaw([
    [0, encodeCBOR(pcr0)],
    [1, encodeCBOR(pcr1)],
    [2, encodeCBOR(pcr2)],
  ]);

  const payloadEntries: Array<[CBORValue, Uint8Array]> = [
    ['certificate', encodeCBOR(leafDER)],
    ['cabundle', encodeCBOR([signingDER])],
    ['pcrs', pcrsMap],
    ['nonce', encodeCBOR(nonce)],
  ];
  if (spec.publicKey !== undefined) payloadEntries.push(['public_key', encodeCBOR(spec.publicKey)]);
  if (spec.userData !== undefined) payloadEntries.push(['user_data', encodeCBOR(spec.userData)]);
  if (spec.moduleId !== undefined) payloadEntries.push(['module_id', encodeCBOR(spec.moduleId)]);
  if (spec.timestamp !== undefined) payloadEntries.push(['timestamp', encodeCBOR(spec.timestamp)]);
  const payloadBytes = cborMapRaw(payloadEntries);

  // COSE Sig_structure = ["Signature1", protected, external_aad(empty), payload]
  const protectedHeader = PROTECTED_HEADER;
  const sigStructure = encodeCBOR([
    'Signature1',
    protectedHeader,
    new Uint8Array(0),
    payloadBytes,
  ]);
  let signature = rawSignSha384(sigStructure, leafKey.privateKey);
  if (spec.tamperCoseSignature) {
    signature = signature.slice();
    signature[0] ^= 0xff;
  }

  // unprotected header (index 1) is ignored by the verifier -> use null.
  const cose = encodeCBOR([protectedHeader, null, payloadBytes, signature]);

  return {
    docB64: Buffer.from(cose).toString('base64'),
    rootDER,
    verificationTimeMs,
    rootKey,
    expected: { pcr0Hex: hex(pcr0), pcr1Hex: hex(pcr1), pcr2Hex: hex(pcr2) },
  };
}

export { encodeCBOR };
export type { CBORValue };
