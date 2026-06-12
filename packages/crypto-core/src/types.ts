export interface EncryptResult {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

export interface WrappedRoot {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}
