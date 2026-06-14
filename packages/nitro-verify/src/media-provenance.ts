/**
 * Client-side media-provenance verification.
 *
 * The enclave signs every generated image with an Ed25519 provenance key that
 * is HKDF-derived from a KMS-released, PCR0-gated media-root secret — stable
 * across boots and transitively rooted in the attestation chain. The raw
 * public key is published in the session attestation `user_data`
 * (see {@link extractMediaProvenancePublicKey}); having verified the
 * attestation document and pinned its PCR0, a client can verify that an image
 * was produced by THAT attested enclave by checking its provenance signature
 * against the published key.
 *
 * This module is deliberately dependency-free (no zod / chat-types) so it stays
 * lean for the React Native client. It reconstructs the same canonical form the
 * enclave signs (sorted-key JSON.stringify) and verifies with SubtleCrypto
 * (Ed25519), available via react-native-quick-crypto.
 */

/** The user_data JSON field carrying the base64 raw Ed25519 public key. */
export const MEDIA_PROVENANCE_USER_DATA_FIELD = 'mediaProvenancePublicKey';

// SPKI DER prefix for a bare Ed25519 public key (RFC 8410); prepend to the 32
// raw key bytes to get an importable SPKI key (SubtleCrypto 'raw' import is not
// uniformly available across runtimes, but 'spki' is).
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * The verifiable subset of a media provenance record. Field names + types
 * mirror @calypso/chat-types `MediaProvenanceRecord`; kept structural here so
 * nitro-verify carries no schema dependency.
 */
export interface MediaProvenanceRecordLike {
  handleId: string;
  kind: string;
  origin: string;
  providerVisible: boolean;
  sourceHandleIds: string[];
  createdBy: string;
  createdAt: string;
  ttlSeconds: number;
  byteSize: number;
  sha256: string;
  signature: string;
}

export interface VerifyMediaProvenanceInput {
  record: MediaProvenanceRecordLike;
  bytes: Uint8Array;
  /** Raw 32-byte Ed25519 public key, e.g. from extractMediaProvenancePublicKey. */
  provenancePublicKey: Uint8Array;
  /** Verification time (ms since epoch). Defaults to Date.now(). */
  now?: number;
  /**
   * Optional Ed25519 verify primitive over the RAW 32-byte public key, RAW
   * signature, and the canonical message bytes. When provided it REPLACES the
   * SubtleCrypto path entirely.
   *
   * The clients inject `@noble/curves/ed25519` here — the same audited
   * implementation react-native-quick-crypto already uses internally — so
   * media-provenance verification never depends on the host runtime shipping
   * Ed25519 in its WebCrypto `subtle` (Chrome only added it in ~137; older
   * mobile WebViews / RN runtimes may lack it). nitro-verify itself stays
   * dependency-free: the default path below uses SubtleCrypto (Node + modern
   * browsers), and any thrown/false result still fails closed.
   */
  ed25519Verify?: (
    publicKey: Uint8Array,
    signature: Uint8Array,
    message: Uint8Array,
  ) => boolean | Promise<boolean>;
}

/**
 * Verify a generated image's provenance against the attestation-pinned key.
 * Returns false (never throws) on any failure: bad shape, sha256 mismatch,
 * expired ttl, or signature failure.
 */
export async function verifyMediaProvenance(
  input: VerifyMediaProvenanceInput,
): Promise<boolean> {
  try {
    const { record, bytes, provenancePublicKey } = input;
    const now = input.now ?? Date.now();

    if (!record || typeof record !== 'object') return false;
    if (provenancePublicKey.byteLength !== 32) return false;

    // ttl: the record must not be expired.
    const createdAtMs = Date.parse(record.createdAt);
    if (Number.isNaN(createdAtMs)) return false;
    const expiresAtMs = createdAtMs + record.ttlSeconds * 1000;
    if (now > expiresAtMs) return false;

    // The signed record is bound to the exact bytes via sha256.
    const actualSha = await sha256Hex(bytes);
    if (actualSha !== record.sha256) return false;

    // Reconstruct the canonical unsigned form the enclave signed.
    const { signature, ...unsigned } = record;
    const canonicalBytes = new TextEncoder().encode(canonicalise(unsigned));
    const signatureBytes = base64ToBytes(signature);
    if (!signatureBytes) return false;

    // Client-injected primitive (noble) takes the raw key directly — no SPKI
    // wrapping, no SubtleCrypto Ed25519 dependency. A throw is caught below and
    // fails closed.
    if (input.ed25519Verify) {
      return Boolean(
        await input.ed25519Verify(
          provenancePublicKey,
          signatureBytes,
          canonicalBytes,
        ),
      );
    }

    const key = await crypto.subtle.importKey(
      'spki',
      asBuffer(concat(ED25519_SPKI_PREFIX, provenancePublicKey)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      asBuffer(signatureBytes),
      asBuffer(canonicalBytes),
    );
  } catch {
    return false;
  }
}

/**
 * Extract the raw 32-byte Ed25519 provenance public key from the attestation
 * `user_data` (the bytes returned as NitroVerifyResult.userData). Returns null
 * if user_data is absent, not JSON, or missing the key field.
 */
export function extractMediaProvenancePublicKey(
  userData: Uint8Array | null,
): Uint8Array | null {
  if (!userData || userData.byteLength === 0) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(userData)) as Record<
      string,
      unknown
    >;
    const b64 = parsed[MEDIA_PROVENANCE_USER_DATA_FIELD];
    if (typeof b64 !== 'string' || b64.length === 0) return null;
    const raw = base64ToBytes(b64);
    if (!raw || raw.byteLength !== 32) return null;
    return raw;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalise(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asBuffer(bytes));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function asBuffer(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data) as Uint8Array<ArrayBuffer>;
}
