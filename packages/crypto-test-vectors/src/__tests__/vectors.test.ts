import { describe, it, expect } from 'vitest';
import { deriveKey } from '@calypso/crypto-core/hkdf';
import { CONVERSATION_KEY_TEST, MESSAGE_KEY_TEST } from '../conversation-vectors';

describe('Cross-platform crypto test vectors', () => {
  it('should produce expected conversation key from known inputs', async () => {
    const result = await deriveKey(
      Buffer.from(CONVERSATION_KEY_TEST.input.chatRootHex, 'hex'),
      Buffer.from(CONVERSATION_KEY_TEST.input.convSaltHex, 'hex'),
      CONVERSATION_KEY_TEST.input.info,
      32,
    );
    expect(Buffer.from(result).toString('hex'))
      .toBe(CONVERSATION_KEY_TEST.expected.convKeyHex);
  });

  it('should produce expected message key from known inputs', async () => {
    const result = await deriveKey(
      Buffer.from(MESSAGE_KEY_TEST.input.chatRootHex, 'hex'),
      Buffer.from(MESSAGE_KEY_TEST.input.convSaltHex, 'hex'),
      MESSAGE_KEY_TEST.input.info,
      32,
    );
    expect(Buffer.from(result).toString('hex'))
      .toBe(MESSAGE_KEY_TEST.expected.msgKeyHex);
  });
});
