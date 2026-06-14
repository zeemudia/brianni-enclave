/**
 * Attestation-rooted media provenance key derivation.
 *
 * The media provenance signer must be STABLE across enclave boots so a client
 * can pin "images signed by this enclave identity" — an ephemeral per-boot key
 * cannot be verified across sessions. We derive a deterministic Ed25519 keypair
 * from a KMS-released, PCR0-gated media-root secret (delivered in the same
 * attested keys blob as the provider keys). Because only a genuine, unmodified
 * enclave (matching the pinned PCR0) can decrypt that secret, the derived
 * signing identity is transitively rooted in the attestation chain.
 *
 * The raw public key is published in the session attestation `user_data` (see
 * nsm.ts / index.ts ATTESTATION_RESPONSE) so the client binds it to the
 * attested PCR0 and verifies image provenance signatures against it
 * (packages/nitro-verify).
 */
import {
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { ProvenanceSigner } from "./provenance";

// HKDF domain-separation labels. Fixed strings — changing either rotates the
// derived signing identity, so they are part of the (versioned) provenance
// contract and must not change without a coordinated client update.
const HKDF_SALT = Buffer.from("calypso/media-provenance/v1/salt", "utf8");
const HKDF_INFO = Buffer.from("calypso/media-provenance/v1/ed25519", "utf8");
const ED25519_SEED_BYTES = 32;

// PKCS8 DER prefix for a bare Ed25519 private key seed (RFC 8410). Prepending
// this to the 32-byte HKDF-derived seed yields a parseable PKCS8 key.
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
// SPKI DER prefix for a bare Ed25519 public key (RFC 8410). Prepending this to
// the 32 raw public-key bytes yields a parseable SPKI key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The user_data JSON field carrying the base64 raw Ed25519 public key. */
export const PROVENANCE_USER_DATA_FIELD = "mediaProvenancePublicKey";

export interface DerivedProvenanceSigner {
  signer: ProvenanceSigner;
  /** Raw 32-byte Ed25519 public key. */
  publicKeyRaw: Uint8Array;
  /** Base64 of the raw 32-byte public key (what is published in user_data). */
  publicKeyB64: string;
}

/**
 * HKDF-derive a stable Ed25519 provenance signer from the media-root secret.
 * Deterministic: the same secret always yields the same keypair.
 */
export function deriveProvenanceSigner(
  mediaRootSecret: Uint8Array,
): DerivedProvenanceSigner {
  const seed = Buffer.from(
    hkdfSync(
      "sha256",
      mediaRootSecret,
      HKDF_SALT,
      HKDF_INFO,
      ED25519_SEED_BYTES,
    ),
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const publicKeyRaw = rawEd25519PublicKey(publicKey);
  const publicKeyB64 = Buffer.from(publicKeyRaw).toString("base64");

  const signer: ProvenanceSigner = {
    sign: (canonical: string): string =>
      cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString(
        "base64",
      ),
    verify: (canonical: string, signatureB64: string): boolean => {
      try {
        return cryptoVerify(
          null,
          Buffer.from(canonical, "utf8"),
          publicKey,
          Buffer.from(signatureB64, "base64"),
        );
      } catch {
        return false;
      }
    },
  };

  return { signer, publicKeyRaw, publicKeyB64 };
}

/**
 * Build the compact JSON envelope published in the attestation `user_data`.
 * Versioned so the client can evolve the format; carries the base64 raw key.
 */
export function buildProvenanceUserData(publicKeyRaw: Uint8Array): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      [PROVENANCE_USER_DATA_FIELD]: Buffer.from(publicKeyRaw).toString("base64"),
    }),
    "utf8",
  );
}

function rawEd25519PublicKey(publicKey: KeyObject): Uint8Array {
  // SPKI for Ed25519 is the 12-byte prefix + the 32 raw key bytes; slice them.
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Uint8Array.prototype.slice.call(spki, ED25519_SPKI_PREFIX.length);
}
