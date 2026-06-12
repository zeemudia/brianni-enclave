import { writeFileSync } from 'node:fs';

const ROOT_HEX = '6c61727279d0fae7e8c4f01b6c87f29ce42cd2c00f6113d8d31bf06b0e2dc92e';
const NAMESPACES = ['default', 'work', 'money', 'health', 'relationships'];
const NAMESPACE_INFO_PREFIX = 'calypso/memory/v1/namespace:';
const NAMESPACE_SALT_PREFIX = 'calypso/memory/v1/salt:';

function hexToBytes(hex) {
  return Uint8Array.from(hex.match(/.{2}/g).map((x) => parseInt(x, 16)));
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveNamespaceKey(chatRootKey, namespace) {
  const saltBytes = new TextEncoder().encode(`${NAMESPACE_SALT_PREFIX}${namespace}`);
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', saltBytes));
  const baseKey = await crypto.subtle.importKey('raw', chatRootKey, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode(`${NAMESPACE_INFO_PREFIX}${namespace}`),
    },
    baseKey,
    256,
  );

  return new Uint8Array(bits);
}

const root = hexToBytes(ROOT_HEX);
const vectors = [];

for (const namespace of NAMESPACES) {
  const key = await deriveNamespaceKey(root, namespace);
  vectors.push({
    namespace,
    expectedKeyHex: bytesToHex(key),
  });
}

writeFileSync(
  new URL('../../crypto-test-vectors/memory-namespace.vectors.json', import.meta.url),
  `${JSON.stringify(
    {
      info: 'Locked parity vectors for deriveNamespaceKey. DO NOT hand-edit; regenerate from generate-memory-namespace-vectors.mjs.',
      chatRootHex: ROOT_HEX,
      vectors,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${vectors.length} vectors`);
