#!/usr/bin/env node
/**
 * Deterministic Nitro attestation fixture generator.
 *
 * Produces fixture files used by `nitro-attestation.test.ts` and
 * `render-attestation.test.ts`. Mints a small EC P-384 trust chain
 * (root, signing CA, untrusted signing CA, "wrong root", and leaf),
 * builds a captured-style COSE_Sign1 attestation payload (timestamp,
 * PCRs, certificate, ca bundle, nonce, user_data), then writes:
 *
 *   - `root.pem`                       — AWS Nitro root CA (test stand-in)
 *   - `wrong-root.pem`                 — different root that should not verify the chain
 *   - `signing-ca.pem`                 — trusted intermediate signing CA
 *   - `untrusted-signing-ca.pem`       — intermediate whose fingerprint is not allowlisted
 *   - `valid.cose`                     — valid COSE_Sign1 attestation
 *   - `bad-signature.cose`             — same payload but signature bytes mutated
 *   - `missing-pcr0.cose`              — payload with PCR 0 removed
 *   - `missing-pcr8.cose`              — payload with PCR 8 removed
 *   - `mutated-nonce.cose`             — payload with a different nonce
 *   - `expired-leaf.cose`              — leaf whose validity is fully in the past
 *
 * Plus `checksums.json` so unintended fixture drift is visible in diffs.
 */
import 'reflect-metadata';
import { createHash, createPrivateKey, generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as x509 from '@peculiar/x509';
import { encode as encodeCbor } from 'cbor-x';

const cryptoProvider = webcrypto;

const moduleDir = dirname(fileURLToPath(import.meta.url));

x509.cryptoProvider.set(cryptoProvider);

const FIXED_NOW = new Date('2026-05-19T08:00:00.000Z');
const LEAF_NOT_BEFORE = new Date('2026-05-19T07:59:00.000Z');
const LEAF_NOT_AFTER = new Date('2026-05-19T08:05:00.000Z');
const EXPIRED_LEAF_NOT_BEFORE = new Date('2025-01-01T00:00:00.000Z');
const EXPIRED_LEAF_NOT_AFTER = new Date('2025-01-02T00:00:00.000Z');

async function generateEcdsaCertificate({
  subject,
  issuerPrivateKey,
  issuerCert,
  isCa,
  notBefore,
  notAfter,
}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-384',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pkcs8 = createPrivateKey(privateKey).export({ type: 'pkcs8', format: 'der' });
  const subjectPublicKeyDer = Buffer.from(
    publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64',
  );

  const importedPublic = await cryptoProvider.subtle.importKey(
    'spki',
    subjectPublicKeyDer,
    { name: 'ECDSA', namedCurve: 'P-384' },
    true,
    ['verify'],
  );
  const importedSigningKey = issuerPrivateKey
    ? await cryptoProvider.subtle.importKey(
        'pkcs8',
        issuerPrivateKey,
        { name: 'ECDSA', namedCurve: 'P-384' },
        false,
        ['sign'],
      )
    : await cryptoProvider.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'ECDSA', namedCurve: 'P-384' },
        false,
        ['sign'],
      );

  const extensions = [
    new x509.BasicConstraintsExtension(isCa, isCa ? 2 : undefined, true),
    new x509.KeyUsagesExtension(
      isCa
        ? x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign
        : x509.KeyUsageFlags.digitalSignature,
      true,
    ),
  ];

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: Buffer.from(createHash('sha256').update(subject).digest()).slice(0, 8).toString('hex'),
    notBefore,
    notAfter,
    subject,
    issuer: issuerCert ? issuerCert.subject : subject,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
    publicKey: importedPublic,
    signingKey: importedSigningKey,
    extensions,
  });

  return { cert, privateKeyPkcs8: pkcs8 };
}

async function main() {
  const root = await generateEcdsaCertificate({
    subject: 'CN=Calypso Test Nitro Root CA',
    isCa: true,
    notBefore: new Date('2026-01-01T00:00:00.000Z'),
    notAfter: new Date('2030-01-01T00:00:00.000Z'),
  });
  const wrongRoot = await generateEcdsaCertificate({
    subject: 'CN=Calypso Wrong Root CA',
    isCa: true,
    notBefore: new Date('2026-01-01T00:00:00.000Z'),
    notAfter: new Date('2030-01-01T00:00:00.000Z'),
  });
  const signingCa = await generateEcdsaCertificate({
    subject: 'CN=Calypso Test Nitro Signing CA',
    issuerPrivateKey: root.privateKeyPkcs8,
    issuerCert: root.cert,
    isCa: true,
    notBefore: new Date('2026-01-01T00:00:00.000Z'),
    notAfter: new Date('2030-01-01T00:00:00.000Z'),
  });
  const untrustedSigningCa = await generateEcdsaCertificate({
    subject: 'CN=Calypso Untrusted Nitro Signing CA',
    issuerPrivateKey: root.privateKeyPkcs8,
    issuerCert: root.cert,
    isCa: true,
    notBefore: new Date('2026-01-01T00:00:00.000Z'),
    notAfter: new Date('2030-01-01T00:00:00.000Z'),
  });

  const leaf = await generateEcdsaCertificate({
    subject: 'CN=Calypso Test Nitro Render Leaf',
    issuerPrivateKey: signingCa.privateKeyPkcs8,
    issuerCert: signingCa.cert,
    isCa: false,
    notBefore: LEAF_NOT_BEFORE,
    notAfter: LEAF_NOT_AFTER,
  });
  const expiredLeaf = await generateEcdsaCertificate({
    subject: 'CN=Calypso Test Nitro Render Leaf (expired)',
    issuerPrivateKey: signingCa.privateKeyPkcs8,
    issuerCert: signingCa.cert,
    isCa: false,
    notBefore: EXPIRED_LEAF_NOT_BEFORE,
    notAfter: EXPIRED_LEAF_NOT_AFTER,
  });

  writeFileSync(resolve(moduleDir, 'root.pem'), root.cert.toString('pem') + '\n');
  writeFileSync(resolve(moduleDir, 'wrong-root.pem'), wrongRoot.cert.toString('pem') + '\n');
  writeFileSync(resolve(moduleDir, 'signing-ca.pem'), signingCa.cert.toString('pem') + '\n');
  writeFileSync(
    resolve(moduleDir, 'untrusted-signing-ca.pem'),
    untrustedSigningCa.cert.toString('pem') + '\n',
  );

  const pcr0 = Buffer.from('00'.repeat(48), 'hex');
  const pcr8 = Buffer.from('11'.repeat(48), 'hex');
  const pcrsMap = new Map([
    [0, pcr0],
    [8, pcr8],
  ]);

  function buildPayloadBytes({ pcrs, nonce }) {
    return encodeCbor({
      timestamp: FIXED_NOW.getTime(),
      pcrs,
      certificate: Buffer.from(leaf.cert.rawData),
      cabundle: [Buffer.from(signingCa.cert.rawData)],
      nonce: Buffer.from(nonce, 'utf8'),
      user_data: Buffer.from(JSON.stringify({ publicKeyId: 'render_key_1' }), 'utf8'),
    });
  }

  function buildExpiredPayloadBytes() {
    return encodeCbor({
      timestamp: EXPIRED_LEAF_NOT_AFTER.getTime() + 60_000,
      pcrs: pcrsMap,
      certificate: Buffer.from(expiredLeaf.cert.rawData),
      cabundle: [Buffer.from(signingCa.cert.rawData)],
      nonce: Buffer.from('nonce_1', 'utf8'),
      user_data: Buffer.from(JSON.stringify({ publicKeyId: 'render_key_1' }), 'utf8'),
    });
  }

  function rawEcdsaSig(message, signingKeyPem) {
    // Sign the message with sha384 and convert DER ECDSA to raw r||s.
    const derSig = sign('sha384', message, createPrivateKey(signingKeyPem));
    // Parse minimal DER: 0x30 len 0x02 lenR R 0x02 lenS S
    const view = Buffer.from(derSig);
    let offset = 0;
    if (view[offset++] !== 0x30) throw new Error('bad DER seq');
    if (view[offset] & 0x80) {
      const lenBytes = view[offset++] & 0x7f;
      offset += lenBytes;
    } else {
      offset += 1;
    }
    if (view[offset++] !== 0x02) throw new Error('bad DER int r');
    const rLen = view[offset++];
    let r = view.subarray(offset, offset + rLen);
    offset += rLen;
    if (view[offset++] !== 0x02) throw new Error('bad DER int s');
    const sLen = view[offset++];
    let s = view.subarray(offset, offset + sLen);
    // Strip leading 0x00 padding
    if (r[0] === 0x00 && r.length > 48) r = r.subarray(1);
    if (s[0] === 0x00 && s.length > 48) s = s.subarray(1);
    // Left-pad to 48 bytes (P-384)
    function pad(b) {
      if (b.length === 48) return b;
      if (b.length > 48) throw new Error('component too long');
      const out = Buffer.alloc(48);
      b.copy(out, 48 - b.length);
      return out;
    }
    return Buffer.concat([pad(r), pad(s)]);
  }

  function buildCose(payloadBytes, signingKeyPem, { mutateSignature = false } = {}) {
    // COSE_Sign1: ["Signature1", protected, externalAAD = bstr(0), payload]
    // protected header: { 1: -35 } (ES384, alg)
    const protectedHeader = encodeCbor(new Map([[1, -35]]));
    const sigStructure = encodeCbor([
      'Signature1',
      protectedHeader,
      new Uint8Array(),
      payloadBytes,
    ]);
    let signature = rawEcdsaSig(sigStructure, signingKeyPem);
    if (mutateSignature) {
      signature = Buffer.from(signature);
      signature[0] ^= 0xff;
    }
    return encodeCbor([protectedHeader, new Map(), payloadBytes, signature]);
  }

  const leafPrivateKeyPem = Buffer.from(leaf.privateKeyPkcs8).toString('base64');
  const leafPem =
    '-----BEGIN PRIVATE KEY-----\n' +
    leafPrivateKeyPem.match(/.{1,64}/g).join('\n') +
    '\n-----END PRIVATE KEY-----\n';

  const expiredLeafPem =
    '-----BEGIN PRIVATE KEY-----\n' +
    Buffer.from(expiredLeaf.privateKeyPkcs8)
      .toString('base64')
      .match(/.{1,64}/g)
      .join('\n') +
    '\n-----END PRIVATE KEY-----\n';

  const validPayloadBytes = buildPayloadBytes({ pcrs: pcrsMap, nonce: 'nonce_1' });
  const missingPcr0PayloadBytes = buildPayloadBytes({
    pcrs: new Map([[8, pcr8]]),
    nonce: 'nonce_1',
  });
  const missingPcr8PayloadBytes = buildPayloadBytes({
    pcrs: new Map([[0, pcr0]]),
    nonce: 'nonce_1',
  });
  const expiredPayloadBytes = buildExpiredPayloadBytes();

  // "Mutated nonce" fixture: take the valid signed COSE bytes, then flip the
  // nonce inside the payload. The signature no longer matches, so the
  // verifier must reject it as a signature mismatch.
  const validCose = buildCose(validPayloadBytes, leafPem);
  const mutatedNonceCose = Buffer.from(validCose);
  const nonceMarker = Buffer.from('nonce_1', 'utf8');
  const nonceOffset = mutatedNonceCose.indexOf(nonceMarker);
  if (nonceOffset < 0) throw new Error('could not locate nonce in COSE bytes');
  Buffer.from('xxx_xxx', 'utf8').copy(mutatedNonceCose, nonceOffset);

  const fixtures = [
    ['valid.cose', validCose],
    ['bad-signature.cose', buildCose(validPayloadBytes, leafPem, { mutateSignature: true })],
    ['missing-pcr0.cose', buildCose(missingPcr0PayloadBytes, leafPem)],
    ['missing-pcr8.cose', buildCose(missingPcr8PayloadBytes, leafPem)],
    ['mutated-nonce.cose', mutatedNonceCose],
    ['expired-leaf.cose', buildCose(expiredPayloadBytes, expiredLeafPem)],
  ];

  const checksums = {};
  for (const [name, bytes] of fixtures) {
    writeFileSync(resolve(moduleDir, name), bytes);
    checksums[name] = createHash('sha256').update(bytes).digest('hex');
  }
  for (const name of [
    'root.pem',
    'wrong-root.pem',
    'signing-ca.pem',
    'untrusted-signing-ca.pem',
  ]) {
    checksums[name] = createHash('sha256')
      .update(readFileSync(resolve(moduleDir, name)))
      .digest('hex');
  }
  writeFileSync(
    resolve(moduleDir, 'checksums.json'),
    JSON.stringify(checksums, null, 2) + '\n',
  );

  console.log('Wrote Nitro attestation fixtures with checksums:');
  console.log(JSON.stringify(checksums, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
