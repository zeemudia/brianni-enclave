import { readFileSync } from "node:fs";

export const VALID_NITRO_FIXTURE = {
  pcr0: "00".repeat(48),
  pcr8: "11".repeat(48),
  nonce: "nonce_1",
  publicKeyId: "render_key_1",
  notBefore: "2026-05-19T07:59:00.000Z",
  notAfter: "2026-05-19T08:05:00.000Z",
} as const;

export type NitroFixtureName =
  | "valid"
  | "bad-signature"
  | "missing-pcr0"
  | "missing-pcr8"
  | "mutated-nonce"
  | "expired-leaf";

export function fixtureNitroRootBundle(
  name: "valid" | "wrong-root" | "untrusted-signing-ca" = "valid",
) {
  return {
    awsNitroRootCaPem: readFixture(`${name === "wrong-root" ? "wrong-root" : "root"}.pem`).toString("utf8"),
    trustedSigningCaPems: [
      readFixture(`${name === "untrusted-signing-ca" ? "untrusted-signing-ca" : "signing-ca"}.pem`).toString("utf8"),
    ],
  };
}

export function fixtureNitroDocument(name: NitroFixtureName = "valid"): Uint8Array {
  return readFixture(`${name}.cose`);
}

function readFixture(name: string): Buffer {
  return readFileSync(new URL(`./nitro-attestation/${name}`, import.meta.url));
}
