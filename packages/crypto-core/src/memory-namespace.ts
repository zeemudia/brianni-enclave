import { MEMORY_NAMESPACES, type MemoryNamespace } from '@calypso/chat-types';

import { deriveKey } from './hkdf';

const NAMESPACE_INFO_PREFIX = 'calypso/memory/v1/namespace:';
const NAMESPACE_SALT_PREFIX = 'calypso/memory/v1/salt:';
const NAMESPACE_KEY_LENGTH = 32;

export async function deriveNamespaceKey(
  chatRootKey: Uint8Array,
  namespace: MemoryNamespace,
): Promise<Uint8Array> {
  if ((namespace as unknown) === 'ghost') {
    throw new Error('INVARIANT VIOLATION: ghost is not a memory namespace');
  }
  if (!(MEMORY_NAMESPACES as readonly string[]).includes(namespace as string)) {
    throw new Error(`INVARIANT VIOLATION: "${namespace}" is not a valid memory namespace`);
  }

  const saltBytes = new TextEncoder().encode(`${NAMESPACE_SALT_PREFIX}${namespace}`);
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', saltBytes));

  return deriveKey(
    chatRootKey,
    salt,
    `${NAMESPACE_INFO_PREFIX}${namespace}`,
    NAMESPACE_KEY_LENGTH,
  );
}
