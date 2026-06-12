/**
 * Known-answer test vectors for HKDF conversation key derivation.
 * All platforms must produce identical output for these inputs.
 */
export const CONVERSATION_KEY_TEST = {
  description: 'Conversation key from chat root via HKDF-SHA256',
  input: {
    chatRootHex: 'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd',
    convSaltHex: '1122334455667788112233445566778811223344556677881122334455667788',
    info: 'conv_key',
  },
  expected: {
    convKeyHex: '02668e03858954b24897b432755dc9a9cfa4fabaa310e7523998a3958077c81e',
  },
};

export const MESSAGE_KEY_TEST = {
  description: 'Message key from chat root via HKDF-SHA256',
  input: {
    chatRootHex: 'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd',
    convSaltHex: '1122334455667788112233445566778811223344556677881122334455667788',
    info: 'msg_key',
  },
  expected: {
    msgKeyHex: '77e6e87116c8ed7958e5864e88840d06e11933fb756feb272a183e57b67183e3',
  },
};
