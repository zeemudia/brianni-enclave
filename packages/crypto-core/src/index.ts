export { encrypt, decrypt } from './aead';
export { deriveKey } from './hkdf';
export { deriveNamespaceKey } from './memory-namespace';

export { generateMnemonic, validateMnemonic, mnemonicToEntropy, entropyToMnemonic, isBip39Word } from './mnemonic';
export type { EncryptResult, WrappedRoot } from './types';

export * from './biometric-key';
export * from './seed-wrapper';
export * from './verification-blob';
export * from './sorted-json';
