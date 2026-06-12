/**
 * Envelope round-trip consistency vectors.
 * Verify that wrap/unwrap and verification blob behave correctly
 * across all platforms.
 */
export const ENVELOPE_VECTORS = [
  {
    description: 'Chat root wrap/unwrap with known passphrase',
    input: {
      chatRootHex: 'aabbccdd'.repeat(8), // 32 bytes
      passphrase: 'test-passphrase-long-enough-32ch',
      wrapSaltHex: '1122334455667788'.repeat(4), // 32 bytes
    },
    expected: {
      verificationConstant: 'BRIANNI_CHAT_ROOT_VERIFIED_v1',
    },
  },
];
