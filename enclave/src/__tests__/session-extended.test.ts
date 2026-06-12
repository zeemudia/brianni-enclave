import { describe, it, expect, beforeEach } from 'vitest';
import { EnclaveSessionManager } from '../session';
import { webcrypto } from 'node:crypto';

describe('EnclaveSessionManager — rotateAttestation and edge cases', () => {
  let manager: EnclaveSessionManager;

  beforeEach(() => {
    manager = new EnclaveSessionManager();
  });

  describe('rotateAttestation', () => {
    it('supports concurrent keypairs from multiple clients', async () => {
      // Create two attestation keypairs (simulating concurrent clients)
      const nonce1 = webcrypto.getRandomValues(new Uint8Array(32));
      const result1 = await manager.handleAttestation(nonce1);

      const nonce2 = webcrypto.getRandomValues(new Uint8Array(32));
      const result2 = await manager.handleAttestation(nonce2);

      const clientKP = await webcrypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
      );
      const clientPubRaw = new Uint8Array(
        await webcrypto.subtle.exportKey('raw', clientKP.publicKey),
      );
      const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));

      // Both keys should be usable (concurrent-safe: non-expired keys survive)
      const oldTeePubB64 = Buffer.from(result1.ephemeralPublicKey).toString('base64');
      const ack1 = await manager.handleKeyExchange(
        clientPubRaw, 'sess-1', clientNonce, oldTeePubB64,
      );
      expect(ack1.sessionId).toBe('sess-1');

      const newTeePubB64 = Buffer.from(result2.ephemeralPublicKey).toString('base64');
      const ack2 = await manager.handleKeyExchange(
        clientPubRaw, 'sess-2', clientNonce, newTeePubB64,
      );
      expect(ack2.sessionId).toBe('sess-2');
    });

    it('explicit rotateAttestation clears all keypairs', async () => {
      const nonce = webcrypto.getRandomValues(new Uint8Array(32));
      const result = await manager.handleAttestation(nonce);

      // Explicit rotation deletes ALL keypairs (used during shutdown)
      await manager.rotateAttestation();

      const clientKP = await webcrypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
      );
      const clientPubRaw = new Uint8Array(
        await webcrypto.subtle.exportKey('raw', clientKP.publicKey),
      );
      const teePubB64 = Buffer.from(result.ephemeralPublicKey).toString('base64');
      await expect(
        manager.handleKeyExchange(clientPubRaw, 'sess', new Uint8Array(32), teePubB64),
      ).rejects.toThrow(/No attestation keypair found/);
    });
  });

  describe('session expiry', () => {
    it('throws on expired session', async () => {
      const nonce = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult = await manager.handleAttestation(nonce);
      const teePubB64 = Buffer.from(attestResult.ephemeralPublicKey).toString('base64');

      const clientKP = await webcrypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
      );
      const clientPubRaw = new Uint8Array(
        await webcrypto.subtle.exportKey('raw', clientKP.publicKey),
      );
      const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));

      await manager.handleKeyExchange(clientPubRaw, 'sess-ttl', clientNonce, teePubB64);

      // Hack the createdAt to simulate expiry
      const sessions = (manager as any).sessions;
      const entry = sessions.get('sess-ttl');
      entry.createdAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago (TTL is 5 min)

      await expect(manager.getSessionKey('sess-ttl')).rejects.toThrow(/expired/i);

      // After expiry, session should be cleaned up
      await expect(manager.getSessionKey('sess-ttl')).rejects.toThrow(/not.*found|expired/i);
    });
  });

  describe('handleKeyExchange edge cases', () => {
    it('replaces existing session with same ID', async () => {
      const nonce = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult = await manager.handleAttestation(nonce);
      const teePubB64 = Buffer.from(attestResult.ephemeralPublicKey).toString('base64');

      const clientKP1 = await webcrypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
      );
      const clientPub1 = new Uint8Array(
        await webcrypto.subtle.exportKey('raw', clientKP1.publicKey),
      );
      const nonce1 = webcrypto.getRandomValues(new Uint8Array(32));

      // First key exchange
      await manager.handleKeyExchange(clientPub1, 'dup-session', nonce1, teePubB64);
      const key1 = await manager.getSessionKey('dup-session');

      // New attestation for second exchange
      const nonce3 = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult2 = await manager.handleAttestation(nonce3);
      const teePubB64_2 = Buffer.from(attestResult2.ephemeralPublicKey).toString('base64');

      const clientKP2 = await webcrypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
      );
      const clientPub2 = new Uint8Array(
        await webcrypto.subtle.exportKey('raw', clientKP2.publicKey),
      );
      const nonce2 = webcrypto.getRandomValues(new Uint8Array(32));

      // Second key exchange with same session ID — should replace
      await manager.handleKeyExchange(clientPub2, 'dup-session', nonce2, teePubB64_2);
      const key2 = await manager.getSessionKey('dup-session');

      // Keys should be different CryptoKey objects
      expect(key1).not.toBe(key2);
    });

    it('throws when attestation keypair not found', async () => {
      const clientKP = await webcrypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
      );
      const clientPubRaw = new Uint8Array(
        await webcrypto.subtle.exportKey('raw', clientKP.publicKey),
      );
      const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));

      await expect(
        manager.handleKeyExchange(clientPubRaw, 'sess', clientNonce, 'nonexistent-key-b64'),
      ).rejects.toThrow(/No attestation keypair found/);
    });
  });

  describe('zeroSession', () => {
    it('is idempotent — calling twice does not throw', async () => {
      const nonce = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult = await manager.handleAttestation(nonce);
      const teePubB64 = Buffer.from(attestResult.ephemeralPublicKey).toString('base64');

      const clientKP = await webcrypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
      );
      const clientPubRaw = new Uint8Array(
        await webcrypto.subtle.exportKey('raw', clientKP.publicKey),
      );
      const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));

      await manager.handleKeyExchange(clientPubRaw, 'sess-zero', clientNonce, teePubB64);

      await manager.zeroSession('sess-zero');
      // Second call should not throw
      await expect(manager.zeroSession('sess-zero')).resolves.not.toThrow();
    });

    it('zeroes the key material buffer', async () => {
      const nonce = webcrypto.getRandomValues(new Uint8Array(32));
      const attestResult = await manager.handleAttestation(nonce);
      const teePubB64 = Buffer.from(attestResult.ephemeralPublicKey).toString('base64');

      const clientKP = await webcrypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
      );
      const clientPubRaw = new Uint8Array(
        await webcrypto.subtle.exportKey('raw', clientKP.publicKey),
      );
      const clientNonce = webcrypto.getRandomValues(new Uint8Array(32));

      await manager.handleKeyExchange(clientPubRaw, 'sess-mat', clientNonce, teePubB64);

      // Get reference to keyMaterial before zeroing
      const sessions = (manager as any).sessions;
      const entry = sessions.get('sess-mat');
      const keyMaterial = entry.keyMaterial;

      await manager.zeroSession('sess-mat');

      // keyMaterial should be zeroed
      expect(keyMaterial.every((b: number) => b === 0)).toBe(true);
    });
  });
});
