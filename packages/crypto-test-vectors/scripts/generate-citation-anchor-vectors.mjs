import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";

const cryptoImpl = globalThis.crypto ?? webcrypto;

const encoder = new TextEncoder();
const SALT = "brianni:citation-anchor-hmac:salt:v1";
const INFO = "brianni:citation-anchor-hmac:v1";

function hex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function hkdf(ikm) {
  const baseKey = await cryptoImpl.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await cryptoImpl.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(SALT),
        info: encoder.encode(INFO),
      },
      baseKey,
      256,
    ),
  );
}

async function hmac(keyBytes, message) {
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await cryptoImpl.subtle.sign("HMAC", key, encoder.encode(message)),
  );
}

const cases = [
  {
    name: "ascii-span",
    conversationKeyHex:
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    content: "The verified source says yes.",
    startIndex: 4,
    endIndex: 19,
  },
  {
    name: "astral-plane-valid-span",
    conversationKeyHex:
      "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
    content: "Launch \u{1F680} confirmed",
    startIndex: 7,
    endIndex: 9,
  },
];

const vectors = [];
for (const item of cases) {
  const conversationKey = Uint8Array.from(
    Buffer.from(item.conversationKeyHex, "hex"),
  );
  const anchorKey = await hkdf(conversationKey);
  const substring = item.content.slice(item.startIndex, item.endIndex);
  const messageBytes = encoder.encode(substring);
  const mac = await hmac(anchorKey, substring);
  vectors.push({
    ...item,
    salt: SALT,
    info: INFO,
    len: 32,
    substring,
    utf8MessageHex: hex(messageBytes),
    anchorKeyHex: hex(anchorKey),
    hmacSha256Hex: hex(mac),
    anchorTextHash: base64url(mac),
  });
}

vectors.push({
  name: "surrogate-splitting-boundary-rejected",
  content: "A \u{1F680} launch",
  startIndex: 2,
  endIndex: 3,
  rejectedBeforeHmac: true,
  reason: "surrogate_boundary",
});

vectors.push({
  name: "lone-surrogate-in-range-rejected",
  content: "bad \\ud83d range",
  startIndex: 4,
  endIndex: 10,
  rejectedBeforeHmac: true,
  reason: "malformed_utf16",
});

const out = resolve(
  "packages/crypto-test-vectors/src/citation-anchor-vectors.json",
);
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${out}`);
