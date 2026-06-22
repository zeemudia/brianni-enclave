import { describe, expect, it } from 'vitest';

import { deriveNamespaceKey } from '../memory-namespace';
import vectors from '../../../crypto-test-vectors/memory-namespace.vectors.json';

type MemoryNamespace = Parameters<typeof deriveNamespaceKey>[1];

const CHAT_ROOT_HEX =
  '6c61727279d0fae7e8c4f01b6c87f29ce42cd2c00f6113d8d31bf06b0e2dc92e';
const VALID_NAMESPACES = new Set<MemoryNamespace>([
  'default',
  'work',
  'money',
  'health',
  'relationships',
]);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('deriveNamespaceKey', () => {
  it('rejects "ghost" at runtime as layer 2 of the fail-closed invariant', async () => {
    const root = hexToBytes(CHAT_ROOT_HEX);

    await expect(deriveNamespaceKey(root, 'ghost' as never)).rejects.toThrow(
      /INVARIANT VIOLATION: ghost is not a memory namespace/i,
    );
  });

  it('rejects empty and arbitrary strings', async () => {
    const root = hexToBytes(CHAT_ROOT_HEX);

    for (const bad of ['', 'finance', ' default', 'DEFAULT']) {
      await expect(deriveNamespaceKey(root, bad as never)).rejects.toThrow(
        `INVARIANT VIOLATION: "${bad}" is not a valid memory namespace`,
      );
    }
  });

  it('matches the locked parity vectors for every valid namespace', async () => {
    const root = hexToBytes(CHAT_ROOT_HEX);

    for (const v of vectors.vectors) {
      expect(VALID_NAMESPACES.has(v.namespace as MemoryNamespace)).toBe(true);
      const k = await deriveNamespaceKey(root, v.namespace as MemoryNamespace);

      expect(bytesToHex(k)).toBe(v.expectedKeyHex);
    }
  });

  it('produces distinct keys for distinct namespaces', async () => {
    const root = hexToBytes(CHAT_ROOT_HEX);
    const seen = new Set<string>();

    for (const ns of ['default', 'work', 'money', 'health', 'relationships'] as const) {
      seen.add(bytesToHex(await deriveNamespaceKey(root, ns)));
    }

    expect(seen.size).toBe(5);
  });
});
