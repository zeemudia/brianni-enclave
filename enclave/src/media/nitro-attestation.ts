import { X509Certificate, createVerify } from "node:crypto";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";

export interface NitroRootBundle {
  awsNitroRootCaPem: string;
  trustedSigningCaPems: readonly string[];
}

export interface VerifiedNitroDocument {
  pcr0: string;
  pcr8: string;
  nonce: string;
  publicKeyId: string;
  notBefore: string;
  notAfter: string;
}

interface CoseSign1Document {
  protectedHeader: Uint8Array;
  unprotectedHeader: unknown;
  payload: Uint8Array;
  signature: Uint8Array;
}

interface ParsedNitroPayload {
  pcrs: Record<number, string>;
  nonce: string;
  publicKeyId: string;
  timestampMs: number;
  certificateDer: Uint8Array;
  caBundleDer: Uint8Array[];
}

export function verifyNitroAttestationDocument(input: {
  rawDocument: Uint8Array;
  rootBundle: NitroRootBundle;
}): { ok: true; document: VerifiedNitroDocument } | { ok: false; reason: string } {
  try {
    const cose = decodeCoseSign1(input.rawDocument);
    const payload = parseNitroAttestationPayload(cose.payload);
    if (!payload.pcrs[0] || !payload.pcrs[8]) return { ok: false, reason: "RENDER_ATTESTATION_PCR_MISSING" };
    const chain = verifyNitroCertificateChain({
      certificateDer: payload.certificateDer,
      caBundleDer: payload.caBundleDer,
      awsNitroRootCaPem: input.rootBundle.awsNitroRootCaPem,
      trustedSigningCaPems: input.rootBundle.trustedSigningCaPems,
      at: new Date(payload.timestampMs),
    });
    if (!chain.ok) return { ok: false, reason: chain.reason };
    if (!verifyCoseSign1Signature(cose, chain.leaf)) {
      return { ok: false, reason: "RENDER_ATTESTATION_SIGNATURE_INVALID" };
    }
    return {
      ok: true,
      document: {
        pcr0: payload.pcrs[0],
        pcr8: payload.pcrs[8],
        nonce: payload.nonce,
        publicKeyId: payload.publicKeyId,
        notBefore: chain.leaf.validFrom,
        notAfter: chain.leaf.validTo,
      },
    };
  } catch {
    return { ok: false, reason: "RENDER_ATTESTATION_MALFORMED" };
  }
}

function decodeCoseSign1(rawDocument: Uint8Array): CoseSign1Document {
  const decoded = decodeCbor(rawDocument);
  if (!Array.isArray(decoded) || decoded.length !== 4) {
    throw new Error("RENDER_ATTESTATION_MALFORMED_COSE");
  }
  const [protectedHeader, unprotectedHeader, payload, signature] = decoded;
  if (
    !(protectedHeader instanceof Uint8Array) ||
    !(payload instanceof Uint8Array) ||
    !(signature instanceof Uint8Array)
  ) {
    throw new Error("RENDER_ATTESTATION_MALFORMED_COSE");
  }
  return { protectedHeader, unprotectedHeader, payload, signature };
}

function parseNitroAttestationPayload(payloadBytes: Uint8Array): ParsedNitroPayload {
  const payload = decodeCbor(payloadBytes) as {
    timestamp?: number;
    pcrs?: Map<number, Uint8Array> | Record<string, Uint8Array>;
    certificate?: Uint8Array;
    cabundle?: Uint8Array[];
    nonce?: Uint8Array;
    user_data?: Uint8Array;
  };
  if (
    !payload.timestamp ||
    !payload.pcrs ||
    !payload.certificate ||
    !payload.cabundle ||
    !payload.nonce ||
    !payload.user_data
  ) {
    throw new Error("RENDER_ATTESTATION_MALFORMED_PAYLOAD");
  }
  const pcrEntries =
    payload.pcrs instanceof Map
      ? [...payload.pcrs.entries()]
      : Object.entries(payload.pcrs).map(
          ([key, value]) => [Number(key), value] as const,
        );
  const userData = JSON.parse(Buffer.from(payload.user_data).toString("utf8")) as {
    publicKeyId?: string;
  };
  if (!userData.publicKeyId) throw new Error("RENDER_ATTESTATION_PUBLIC_KEY_MISSING");
  return {
    pcrs: Object.fromEntries(
      pcrEntries.map(([index, value]) => [index, Buffer.from(value).toString("hex")]),
    ),
    nonce: Buffer.from(payload.nonce).toString("utf8"),
    publicKeyId: userData.publicKeyId,
    timestampMs: payload.timestamp,
    certificateDer: payload.certificate,
    caBundleDer: payload.cabundle,
  };
}

function verifyNitroCertificateChain(input: {
  certificateDer: Uint8Array;
  caBundleDer: Uint8Array[];
  awsNitroRootCaPem: string;
  trustedSigningCaPems: readonly string[];
  at: Date;
}):
  | { ok: true; leaf: X509Certificate }
  | { ok: false; reason: "RENDER_ATTESTATION_SIGNATURE_INVALID" } {
  const leaf = new X509Certificate(input.certificateDer);
  const intermediates = input.caBundleDer.map((der) => new X509Certificate(der));
  const root = new X509Certificate(input.awsNitroRootCaPem);
  const signingCaFingerprints = new Set(
    input.trustedSigningCaPems.map((pem) => new X509Certificate(pem).fingerprint256),
  );
  const chain = [leaf, ...intermediates, root];
  const at = input.at.getTime();
  if (
    chain.some(
      (cert) => Date.parse(cert.validFrom) > at || Date.parse(cert.validTo) < at,
    )
  ) {
    return { ok: false, reason: "RENDER_ATTESTATION_SIGNATURE_INVALID" };
  }
  if (
    !intermediates.some((cert) => signingCaFingerprints.has(cert.fingerprint256))
  ) {
    return { ok: false, reason: "RENDER_ATTESTATION_SIGNATURE_INVALID" };
  }
  for (let index = 0; index < chain.length - 1; index += 1) {
    if (!chain[index].verify(chain[index + 1].publicKey)) {
      return { ok: false, reason: "RENDER_ATTESTATION_SIGNATURE_INVALID" };
    }
  }
  return { ok: true, leaf };
}

function verifyCoseSign1Signature(cose: CoseSign1Document, leaf: X509Certificate): boolean {
  const sigStructure = encodeCbor([
    "Signature1",
    cose.protectedHeader,
    new Uint8Array(),
    cose.payload,
  ]);
  const verifier = createVerify("sha384");
  verifier.update(sigStructure);
  verifier.end();
  return verifier.verify(leaf.publicKey, derEncodeEcdsaSignature(cose.signature));
}

function derEncodeEcdsaSignature(rawSignature: Uint8Array): Buffer {
  const half = rawSignature.length / 2;
  const r = derInteger(rawSignature.slice(0, half));
  const s = derInteger(rawSignature.slice(half));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

function derInteger(bytes: Uint8Array): Buffer {
  const source = Buffer.from(bytes);
  const firstNonZero = source.findIndex((byte) => byte !== 0);
  const trimmed = firstNonZero === -1 ? Buffer.from([0]) : source.subarray(firstNonZero);
  const value = trimmed[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
  return Buffer.concat([Buffer.from([0x02, value.length]), value]);
}
