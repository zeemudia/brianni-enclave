/**
 * Nitro Enclave attestation document verifier.
 *
 * Verifies the COSE_Sign1 attestation document returned by the NSM hardware:
 *   1. Decodes the COSE_Sign1 structure (CBOR)
 *   2. Extracts the certificate chain from the payload
 *   3. Verifies each certificate in the chain back to the pinned AWS Nitro root CA,
 *      including its notBefore/notAfter validity window
 *   4. Verifies the COSE_Sign1 ECDSA-P384 signature using the leaf certificate
 *   5. Extracts and returns the verified PCRs, nonce, and public key
 *
 * Cryptographic operations use SubtleCrypto (available via react-native-quick-crypto).
 *
 * Validated against attestation documents produced by real Nitro hardware.
 */
import { decodeCBOR, encodeCBOR, type CBORValue } from './cbor';

// ---------------------------------------------------------------------------
// AWS Nitro Enclaves Root CA (P-384, SHA-384)
// https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip
// ---------------------------------------------------------------------------

const AWS_NITRO_ROOT_CA_DER = (() => {
  // DER bytes of AWS Nitro Enclaves Root G1, base64-encoded.
  // Canonical source: https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip
  // Subject: CN=aws.nitro-enclaves, O=Amazon, OU=AWS, C=US
  // Valid: 2019-10-28 → 2049-10-28 (30 years)
  // Algorithm: ECDSA P-384 with SHA-384
  // Stryker disable all: Mutating pinned certificate bytes only corrupts the
  // trust-anchor fixture during the baseline run; verifier logic remains mutable.
  const b64 =
    'MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL' +
    'MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD' +
    'VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4' +
    'MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL' +
    'DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG' +
    'BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb' +
    '48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE' +
    'h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF' +
    'R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC' +
    'MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW' +
    'rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N' +
    'IwLz3/Y=';
  // Stryker restore all
  return fromBase64(b64);
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface NitroVerifyResult {
  pcrs: { PCR0: string; PCR1: string; PCR2: string };
  nonce: Uint8Array;
  publicKey: Uint8Array | null;
  userData: Uint8Array | null;
  moduleId: string;
  timestamp: number;
}

export interface NitroVerifyOptions {
  /**
   * Time (ms since epoch) at which certificate notBefore/notAfter validity
   * is evaluated. Defaults to Date.now().
   *
   * Injectable ONLY so tests can verify RECORDED attestation documents —
   * whose ~3h-lived leaf certificates are long expired — at a pinned time.
   * Real call sites (apps/{web,mobile}/lib/tee/attestation.ts) MUST use the
   * default; pinning a fixed time in production would defeat expiry.
   */
  verificationTimeMs?: number;
}

/**
 * Verify a Nitro attestation document.
 *
 * @param attestationDocBase64 - Base64-encoded COSE_Sign1 document from NSM
 * @param options - Optional verification-time override (tests only)
 * @returns Verified claims from the attestation document
 * @throws If any verification step fails
 */
export async function verifyNitroAttestation(
  attestationDocBase64: string,
  options: NitroVerifyOptions = {},
): Promise<NitroVerifyResult> {
  // The production trust anchor is ALWAYS the pinned AWS Nitro Root G1. This is
  // the only entry the package barrel (src/index.ts) exports, and it gives the
  // caller no way to override the root — so attestation verification cannot be
  // weakened through the public API. The trust-anchor-injectable core below is
  // for the hermetic test suite only.
  return verifyNitroAttestationWithTrustAnchor(
    attestationDocBase64,
    AWS_NITRO_ROOT_CA_DER,
    options,
  );
}

/**
 * Trust-anchor-injectable verification core.
 *
 * ⚠️ Exported for the hermetic test suite ONLY and deliberately NOT re-exported
 * from the package barrel (`src/index.ts`). Production consumers import
 * `verifyNitroAttestation`, which hard-codes the pinned AWS Nitro root, so the
 * trust anchor can never be overridden through the package's public API. This
 * seam exists so tests can drive a synthetic-but-cryptographically-valid chain
 * (rooted at a throwaway test CA) all the way through COSE-signature
 * verification, PCR extraction, and result assembly — paths a real AWS-rooted
 * document exercises but which are otherwise unreachable without live Nitro
 * hardware (the leaf must chain to AWS's root, whose private key we do not
 * hold). Mirrors the tests-only `verificationTimeMs` option and the enclave's
 * own injectable-root verifier. See docs/quality/mutation-triage/nitro-verify.md.
 */
export async function verifyNitroAttestationWithTrustAnchor(
  attestationDocBase64: string,
  trustAnchorDER: Uint8Array,
  options: NitroVerifyOptions = {},
): Promise<NitroVerifyResult> {
  const verificationTimeMs = options.verificationTimeMs ?? Date.now();
  const docBytes = fromBase64(attestationDocBase64);

  // Step 1: Decode COSE_Sign1 = [protected, unprotected, payload, signature]
  // NSM returns this WITHOUT the CBOR tag 18 — just a raw 4-element array.
  const cose = decodeCBOR(docBytes);
  if (!Array.isArray(cose) || cose.length !== 4) {
    throw new Error('Invalid attestation document: expected COSE_Sign1 array with 4 elements');
  }

  const [protectedHeader, , payloadBytes, signature] = cose as [
    Uint8Array,
    CBORValue,
    Uint8Array,
    Uint8Array,
  ];

  if (
    !(protectedHeader instanceof Uint8Array) ||
    !(payloadBytes instanceof Uint8Array) ||
    !(signature instanceof Uint8Array)
  ) {
    throw new Error(
      'Invalid COSE_Sign1: expected byte strings for protected, payload, and signature',
    );
  }

  // Step 2: Decode the payload to extract claims
  const payload = decodeCBOR(payloadBytes);
  if (!(payload instanceof Map)) {
    throw new Error('Invalid attestation payload: expected CBOR map');
  }

  const certificate = payload.get('certificate');
  const cabundle = payload.get('cabundle');
  const pcrsMap = payload.get('pcrs');
  const nonce = payload.get('nonce');
  const publicKey = payload.get('public_key');
  const userData = payload.get('user_data');
  const moduleId = payload.get('module_id');
  const timestamp = payload.get('timestamp');

  if (!(certificate instanceof Uint8Array)) {
    throw new Error('Attestation payload missing certificate');
  }
  if (!Array.isArray(cabundle)) {
    throw new Error('Attestation payload missing cabundle');
  }
  if (!(pcrsMap instanceof Map)) {
    throw new Error('Attestation payload missing pcrs');
  }

  // M2 error-handling-audit — structural fail-closed checks BEFORE the
  // expensive crypto. A document missing required claims can never verify;
  // the old behaviour substituted lenient defaults (PCR0 = '', nonce =
  // empty) which produced a success-shaped result. PCR0 = '' is especially
  // dangerous: the dev attestation bypass skips exactly the pin comparison
  // that would have caught it.
  //
  // Required: PCR0/1/2 (always measured by the NSM) and nonce (Calypso
  // always requests attestation with a nonce; a doc without one cannot
  // prove freshness). Legitimately optional NSM fields: public_key and
  // user_data (only present when the enclave passes them to NSM Attest) —
  // callers that need public_key check it themselves. module_id/timestamp
  // remain lenient ('' / 0): a 0 timestamp fails closed at both app call
  // sites' freshness checks.
  for (const index of [0, 1, 2]) {
    if (!(pcrsMap.get(index) instanceof Uint8Array)) {
      throw new Error(`Attestation payload missing PCR${index}`);
    }
  }
  if (!(nonce instanceof Uint8Array) || nonce.length === 0) {
    throw new Error('Attestation payload missing nonce');
  }

  // Step 3: Verify the certificate chain
  // Chain order: cabundle[0] = closest to root, cabundle[last] = closest to leaf
  // Then the leaf certificate signs the COSE_Sign1.
  const certChain = [
    ...cabundle.map((c) => {
      if (!(c instanceof Uint8Array)) throw new Error('Invalid certificate in cabundle');
      return c;
    }),
    certificate,
  ];
  await verifyCertificateChain(certChain, verificationTimeMs, trustAnchorDER);

  // Step 4: Verify the COSE_Sign1 signature using the leaf certificate
  await verifyCOSESignature(protectedHeader, payloadBytes, signature, certificate);

  // Step 5: Extract verified PCRs
  const pcrs = extractPCRs(pcrsMap);

  return {
    pcrs,
    // nonce was structurally validated above — present, non-empty bstr.
    nonce,
    // public_key / user_data are legitimately optional NSM fields.
    publicKey: publicKey instanceof Uint8Array ? publicKey : null,
    userData: userData instanceof Uint8Array ? userData : null,
    moduleId: typeof moduleId === 'string' ? moduleId : '',
    timestamp: typeof timestamp === 'number' ? timestamp : 0,
  };
}

// ---------------------------------------------------------------------------
// Certificate chain verification
// ---------------------------------------------------------------------------

/**
 * Verify a certificate chain from root to leaf.
 *
 * certChain[0] should be signed by the pinned root CA.
 * Each subsequent cert is signed by the one before it.
 *
 * Each certificate's notBefore/notAfter validity window is checked against
 * verificationTimeMs before its signature is verified — Nitro leaf certs
 * live ~3 hours, so an expired-but-once-valid document must not verify.
 *
 * Uses SubtleCrypto for ECDSA-P384 + SHA-384 signature verification.
 */
export async function verifyCertificateChain(
  certChain: Uint8Array[],
  verificationTimeMs: number,
  trustAnchorDER: Uint8Array = AWS_NITRO_ROOT_CA_DER,
): Promise<void> {
  if (certChain.length === 0) {
    throw new Error('Empty certificate chain');
  }

  // Start with the (pinned, by default) root CA as the trust anchor
  let issuerSPKI = extractSPKI(trustAnchorDER);

  for (let i = 0; i < certChain.length; i++) {
    const certDER = certChain[i];

    const { notBefore, notAfter } = parseCertValidity(certDER);
    if (verificationTimeMs < notBefore) {
      throw new Error(
        `Certificate ${i} not yet valid: notBefore=${new Date(notBefore).toISOString()}`,
      );
    }
    if (verificationTimeMs > notAfter) {
      throw new Error(
        `Certificate ${i} expired: notAfter=${new Date(notAfter).toISOString()}`,
      );
    }

    const { tbs, signatureBytes } = parseCertificateSignature(certDER);

    // Import the issuer's public key and verify the certificate's signature
    const issuerKey = await crypto.subtle.importKey(
      'spki',
      asBuffer(issuerSPKI),
      { name: 'ECDSA', namedCurve: 'P-384' },
      false,
      ['verify'],
    );

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-384' },
      issuerKey,
      asBuffer(signatureBytes),
      asBuffer(tbs),
    );

    if (!valid) {
      throw new Error(`Certificate chain verification failed at cert ${i}`);
    }

    // This cert's SPKI becomes the issuer for the next cert
    issuerSPKI = extractSPKI(certDER);
  }
}

// ---------------------------------------------------------------------------
// COSE_Sign1 signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the COSE_Sign1 signature.
 *
 * Sig_structure = CBOR(["Signature1", protected, b"", payload])
 * Verify with ECDSA P-384 + SHA-384 using the leaf cert's public key.
 */
export async function verifyCOSESignature(
  protectedHeader: Uint8Array,
  payloadBytes: Uint8Array,
  signature: Uint8Array,
  leafCertDER: Uint8Array,
): Promise<void> {
  // Build the COSE Sig_structure
  const sigStructure: CBORValue[] = [
    'Signature1',
    protectedHeader,
    new Uint8Array(0), // external_aad (empty)
    payloadBytes,
  ];
  const sigStructureBytes = encodeCBOR(sigStructure);

  // Extract the public key from the leaf certificate
  const leafSPKI = extractSPKI(leafCertDER);
  const leafKey = await crypto.subtle.importKey(
    'spki',
    asBuffer(leafSPKI),
    { name: 'ECDSA', namedCurve: 'P-384' },
    false,
    ['verify'],
  );

  // COSE uses raw (r||s) signature format, same as SubtleCrypto's default
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-384' },
    leafKey,
    asBuffer(signature),
    asBuffer(sigStructureBytes),
  );

  if (!valid) {
    throw new Error(
      'COSE_Sign1 signature verification failed — attestation document may be forged',
    );
  }
}

// ---------------------------------------------------------------------------
// Minimal DER/ASN.1 parsing for X.509 certificates
// ---------------------------------------------------------------------------

/**
 * Parse a DER tag+length and return the content offset and length.
 */
export function parseDERTL(
  data: Uint8Array,
  offset: number,
): { contentOffset: number; contentLength: number; totalLength: number } {
  if (offset >= data.length) throw new Error('DER: unexpected end of data');

  // Skip tag byte
  let pos = offset + 1;

  // Parse length
  const firstLenByte = data[pos++];
  let contentLength: number;
  if (firstLenByte < 0x80) {
    contentLength = firstLenByte;
  } else {
    const numLenBytes = firstLenByte & 0x7f;
    contentLength = 0;
    for (let i = 0; i < numLenBytes; i++) {
      contentLength = (contentLength << 8) | data[pos++];
    }
  }

  return {
    contentOffset: pos,
    contentLength,
    totalLength: pos - offset + contentLength,
  };
}

/**
 * Extract the SubjectPublicKeyInfo (SPKI) from a DER-encoded X.509 certificate.
 *
 * Certificate structure:
 *   SEQUENCE {
 *     tbsCertificate SEQUENCE {
 *       version [0] EXPLICIT ...,
 *       serialNumber INTEGER,
 *       signature AlgorithmIdentifier,
 *       issuer Name,
 *       validity Validity,
 *       subject Name,
 *       subjectPublicKeyInfo SubjectPublicKeyInfo  <-- this is what we want
 *     }
 *     ...
 *   }
 */
export function extractSPKI(certDER: Uint8Array): Uint8Array {
  // Outer SEQUENCE (Certificate)
  const cert = parseDERTL(certDER, 0);
  // TBSCertificate SEQUENCE
  const tbs = parseDERTL(certDER, cert.contentOffset);
  let pos = tbs.contentOffset;

  // version [0] EXPLICIT — context-specific, constructed (tag 0xA0)
  if (certDER[pos] === 0xa0) {
    const ver = parseDERTL(certDER, pos);
    pos += ver.totalLength;
  }

  // serialNumber INTEGER
  const serial = parseDERTL(certDER, pos);
  pos += serial.totalLength;

  // signature AlgorithmIdentifier SEQUENCE
  const sigAlg = parseDERTL(certDER, pos);
  pos += sigAlg.totalLength;

  // issuer Name SEQUENCE
  const issuer = parseDERTL(certDER, pos);
  pos += issuer.totalLength;

  // validity SEQUENCE
  const validity = parseDERTL(certDER, pos);
  pos += validity.totalLength;

  // subject Name SEQUENCE
  const subject = parseDERTL(certDER, pos);
  pos += subject.totalLength;

  // subjectPublicKeyInfo SEQUENCE — this is what we need
  const spki = parseDERTL(certDER, pos);
  return certDER.slice(pos, pos + spki.totalLength);
}

/**
 * Extract the validity window (notBefore/notAfter, ms since epoch) from a
 * DER-encoded X.509 certificate. Walks the same TBS field skeleton as
 * extractSPKI, stopping at the validity SEQUENCE:
 *
 *   Validity ::= SEQUENCE { notBefore Time, notAfter Time }
 */
export function parseCertValidity(certDER: Uint8Array): {
  notBefore: number;
  notAfter: number;
} {
  // Outer SEQUENCE (Certificate)
  const cert = parseDERTL(certDER, 0);
  // TBSCertificate SEQUENCE
  const tbs = parseDERTL(certDER, cert.contentOffset);
  let pos = tbs.contentOffset;

  // version [0] EXPLICIT — context-specific, constructed (tag 0xA0)
  if (certDER[pos] === 0xa0) {
    pos += parseDERTL(certDER, pos).totalLength;
  }
  // serialNumber INTEGER
  pos += parseDERTL(certDER, pos).totalLength;
  // signature AlgorithmIdentifier SEQUENCE
  pos += parseDERTL(certDER, pos).totalLength;
  // issuer Name SEQUENCE
  pos += parseDERTL(certDER, pos).totalLength;

  // validity SEQUENCE { notBefore Time, notAfter Time }
  const validity = parseDERTL(certDER, pos);
  let vPos = validity.contentOffset;
  const notBefore = parseDERTime(certDER, vPos);
  vPos += notBefore.totalLength;
  const notAfter = parseDERTime(certDER, vPos);

  return { notBefore: notBefore.timeMs, notAfter: notAfter.timeMs };
}

/**
 * Parse an X.509 Time value: UTCTime (tag 0x17, YYMMDDHHMMSSZ, RFC 5280
 * year pivot 1950/2049) or GeneralizedTime (tag 0x18, YYYYMMDDHHMMSSZ).
 * RFC 5280 mandates seconds and the Z suffix for both forms.
 */
export function parseDERTime(
  data: Uint8Array,
  offset: number,
): { timeMs: number; totalLength: number } {
  const tag = data[offset];
  const tl = parseDERTL(data, offset);
  const text = String.fromCharCode(
    ...data.slice(tl.contentOffset, tl.contentOffset + tl.contentLength),
  );

  let iso: string;
  if (tag === 0x17) {
    if (!/^\d{12}Z$/.test(text)) {
      throw new Error(`Invalid UTCTime in certificate validity: ${text}`);
    }
    const yy = parseInt(text.slice(0, 2), 10);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    iso = `${year}-${text.slice(2, 4)}-${text.slice(4, 6)}T${text.slice(6, 8)}:${text.slice(8, 10)}:${text.slice(10, 12)}Z`;
  } else if (tag === 0x18) {
    if (!/^\d{14}Z$/.test(text)) {
      throw new Error(`Invalid GeneralizedTime in certificate validity: ${text}`);
    }
    iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}Z`;
  } else {
    throw new Error(
      `Unsupported time tag in certificate validity: 0x${tag.toString(16)}`,
    );
  }

  const timeMs = Date.parse(iso);
  if (Number.isNaN(timeMs)) {
    throw new Error(`Unparseable certificate validity time: ${text}`);
  }
  return { timeMs, totalLength: tl.totalLength };
}

/**
 * Extract the TBSCertificate bytes and the signature value from a DER-encoded X.509 certificate.
 *
 * The TBS (To Be Signed) portion is what the issuer's signature covers.
 * The signature is a BIT STRING containing the ECDSA signature.
 */
export function parseCertificateSignature(certDER: Uint8Array): {
  tbs: Uint8Array;
  signatureBytes: Uint8Array;
} {
  // Outer SEQUENCE
  const cert = parseDERTL(certDER, 0);
  let pos = cert.contentOffset;

  // TBSCertificate SEQUENCE — the signed portion
  const tbs = parseDERTL(certDER, pos);
  const tbsBytes = certDER.slice(pos, pos + tbs.totalLength);
  pos += tbs.totalLength;

  // signatureAlgorithm AlgorithmIdentifier SEQUENCE
  const sigAlg = parseDERTL(certDER, pos);
  pos += sigAlg.totalLength;

  // signatureValue BIT STRING
  const sigBitString = parseDERTL(certDER, pos);
  // BIT STRING has a leading "unused bits" byte (usually 0x00)
  const sigContent = certDER.slice(
    sigBitString.contentOffset + 1,
    sigBitString.contentOffset + sigBitString.contentLength,
  );

  // The signature is DER-encoded (SEQUENCE { INTEGER r, INTEGER s }).
  // SubtleCrypto expects raw (r||s) format for ECDSA. Convert.
  const rawSig = derSignatureToRaw(sigContent, 48); // P-384 = 48 bytes per component

  return { tbs: tbsBytes, signatureBytes: rawSig };
}

/**
 * Convert a DER-encoded ECDSA signature to raw (r||s) format.
 * DER: SEQUENCE { INTEGER r, INTEGER s }
 * Raw: r (padded to componentSize) || s (padded to componentSize)
 */
export function derSignatureToRaw(derSig: Uint8Array, componentSize: number): Uint8Array {
  // Parse outer SEQUENCE
  const seq = parseDERTL(derSig, 0);
  let pos = seq.contentOffset;

  // Parse r INTEGER
  const rTL = parseDERTL(derSig, pos);
  let rBytes = derSig.slice(rTL.contentOffset, rTL.contentOffset + rTL.contentLength);
  pos += rTL.totalLength;

  // Parse s INTEGER
  const sTL = parseDERTL(derSig, pos);
  let sBytes = derSig.slice(sTL.contentOffset, sTL.contentOffset + sTL.contentLength);

  // Strip leading zero padding (DER integers are signed)
  if (rBytes[0] === 0 && rBytes.length > componentSize) rBytes = rBytes.slice(1);
  if (sBytes[0] === 0 && sBytes.length > componentSize) sBytes = sBytes.slice(1);

  // Pad to componentSize
  const raw = new Uint8Array(componentSize * 2);
  raw.set(rBytes, componentSize - rBytes.length);
  raw.set(sBytes, componentSize * 2 - sBytes.length);
  return raw;
}

// ---------------------------------------------------------------------------
// PCR extraction
// ---------------------------------------------------------------------------

export function extractPCRs(pcrsMap: Map<CBORValue, CBORValue>): {
  PCR0: string;
  PCR1: string;
  PCR2: string;
} {
  // M2 error-handling-audit — fail closed on a missing/non-bstr PCR.
  // The structural check in verifyNitroAttestation already enforces this
  // before any crypto runs; this duplicate throw is defence-in-depth so
  // no future refactor can reintroduce the PCR0 = '' lenient default.
  const getPCR = (index: number): string => {
    const value = pcrsMap.get(index);
    if (!(value instanceof Uint8Array)) {
      throw new Error(`Attestation payload missing PCR${index}`);
    }
    return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  return {
    PCR0: getPCR(0),
    PCR1: getPCR(1),
    PCR2: getPCR(2),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Ensure a Uint8Array has an ArrayBuffer (not SharedArrayBuffer) backing.
 * TypeScript 5.9+ distinguishes Uint8Array<ArrayBuffer> from Uint8Array<ArrayBufferLike>,
 * and SubtleCrypto requires the former. Sliced Uint8Arrays may have SharedArrayBuffer.
 */
function asBuffer(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data) as Uint8Array<ArrayBuffer>;
}
