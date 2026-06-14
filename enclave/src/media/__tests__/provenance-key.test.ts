import { describe, expect, it } from "vitest";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  deriveProvenanceSigner,
  buildProvenanceUserData,
  PROVENANCE_USER_DATA_FIELD,
} from "../provenance-key";

const SECRET_A = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex",
);
const SECRET_B = Buffer.from(
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  "hex",
);

describe("deriveProvenanceSigner", () => {
  it("is deterministic across calls for the same media-root secret (stable across boots)", () => {
    const a = deriveProvenanceSigner(SECRET_A);
    const b = deriveProvenanceSigner(SECRET_A);
    expect(a.publicKeyB64).toEqual(b.publicKeyB64);
    expect(Buffer.from(a.publicKeyRaw).toString("hex")).toEqual(
      Buffer.from(b.publicKeyRaw).toString("hex"),
    );
  });

  it("derives a different keypair for a different secret", () => {
    const a = deriveProvenanceSigner(SECRET_A);
    const b = deriveProvenanceSigner(SECRET_B);
    expect(a.publicKeyB64).not.toEqual(b.publicKeyB64);
  });

  it("exposes a 32-byte raw Ed25519 public key", () => {
    const { publicKeyRaw } = deriveProvenanceSigner(SECRET_A);
    expect(publicKeyRaw.byteLength).toBe(32);
  });

  it("sign/verify round-trips and rejects a tampered signature", () => {
    const { signer } = deriveProvenanceSigner(SECRET_A);
    const canonical = '{"a":1,"b":"two"}';
    const sig = signer.sign(canonical);
    expect(signer.verify(canonical, sig)).toBe(true);
    expect(signer.verify(canonical + "x", sig)).toBe(false);
    const tampered = Buffer.from(sig, "base64");
    tampered[0] ^= 0xff;
    expect(signer.verify(canonical, tampered.toString("base64"))).toBe(false);
  });

  it("the published raw public key actually verifies signatures from the derived signer (so a client can verify with the attested key)", () => {
    const { signer, publicKeyRaw } = deriveProvenanceSigner(SECRET_A);
    const canonical = '{"handleId":"mh_abc","kind":"image"}';
    const sig = signer.sign(canonical);
    // Reconstruct an Ed25519 public KeyObject from the published raw bytes and
    // verify the signature standalone — this is exactly what the client does.
    const pub = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKeyRaw),
      ]),
      format: "der",
      type: "spki",
    });
    const ok = cryptoVerify(
      null,
      Buffer.from(canonical, "utf8"),
      pub,
      Buffer.from(sig, "base64"),
    );
    expect(ok).toBe(true);
  });
});

describe("buildProvenanceUserData", () => {
  it("encodes a compact JSON envelope carrying the base64 raw public key", () => {
    const { publicKeyRaw, publicKeyB64 } = deriveProvenanceSigner(SECRET_A);
    const userData = buildProvenanceUserData(publicKeyRaw);
    const parsed = JSON.parse(userData.toString("utf8"));
    expect(parsed.v).toBe(1);
    expect(parsed[PROVENANCE_USER_DATA_FIELD]).toBe(publicKeyB64);
    // NSM user_data is capped at 1024 bytes; ours must be comfortably under.
    expect(userData.byteLength).toBeLessThan(256);
  });
});
