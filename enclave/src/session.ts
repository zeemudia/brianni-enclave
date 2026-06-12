import {
  generateKeyPairSync,
  sign,
  webcrypto,
  type KeyObject,
} from "node:crypto";
import { zeroBuffer } from "./crypto";
import {
  finaliseDreamEnvelopes as finaliseDreamEnvelopeState,
  type DreamFinaliseItem,
} from "./dream/envelope-sign";
import type { DreamFinaliseResult, UnsignedEnvelope } from "./dream/types";
import type { MemoryMutationEnvelope } from "@calypso/chat-types";

const subtle = webcrypto.subtle;

/**
 * R8-H1 cache for signed memory.write finalisations under the agent loop.
 *
 * Lifecycle:
 *  1. Agent loop finalises a memory.write (DREAM_FINALISE handler) → entry
 *     parked here keyed by (agentTurnId, invocationId), pendingClientAck:true.
 *  2. Client durably persists the signed envelope via saveMemory + ships
 *     POST /v1/agent/:sessionId/tool-result-ack with ackContentHash.
 *  3a. ACK with matching contentHash → entry deleted. Subsequent replay
 *      hits an absent entry → INVOCATION_ALREADY_CONSUMED.
 *  3b. ACK with mismatched contentHash → entry preserved (legitimate ACK
 *      may still arrive). The mismatch is reported back to the server.
 *  4. Pre-ACK replay of the reverse-channel POST → entry returned
 *      verbatim (same signed bytes) so the client recovers from network
 *      drops without a second signing operation.
 *  5. Expiry (5 min default) → entry dropped. Replay then maps to
 *      INVOCATION_ALREADY_CONSUMED (client must re-run the agent turn).
 *  6. zeroSession / clearAgentTurn → bulk drop.
 */
export const MEMORY_WRITE_ACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface SignedFinalisationEntry {
  signedEnvelope: MemoryMutationEnvelope;
  signature: string;
  contentHash: string;
  recordSerialisedHash: string;
  signedAt: number;
  pendingClientAck: boolean;
  /**
   * Codex R4 finding #2: the canonical envelope bytes (base64) that the
   * client uses to verify the Ed25519 signature. Stashed alongside the
   * signed envelope so a TOOL_RESULT replay can rebuild the exact same
   * memory_write_signed chunk the client would have received over the
   * dropped SSE stream — deterministically, byte-identical.
   */
  signedBlobB64: string;
}

export type SignedFinalisationAckOutcome = 'ok' | 'mismatch' | 'absent';

// Node's webcrypto.CryptoKey and the global CryptoKey diverge in TS 6.
// The enclave runs exclusively in Node, so we alias the Node type.
type NodeCryptoKey = webcrypto.CryptoKey;

/** Ensure ArrayBuffer backing for SubtleCrypto arguments. */
function asBufferSource(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data) as Uint8Array<ArrayBuffer>;
}

interface SessionEntry {
  key: NodeCryptoKey;
  keyMaterial: Uint8Array;
  signingPrivateKey: KeyObject | null;
  signingPublicKeyRaw: Uint8Array;
  inFlightUnsignedEnvelopes: Map<string, Map<number, UnsignedEnvelope>>;
  /** R8-H1: per-(agentTurnId, invocationId) cache of signed memory.write finalisations. */
  signedFinalisationCache: Map<string, Map<string, SignedFinalisationEntry>>;
  createdAt: number;
  /**
   * R11 Finding B (Codex): the session must outlive the
   * MEMORY_WRITE_ACK_TIMEOUT_MS retry window of every cached signed
   * finalisation. Without this, a memory.write signed late in a long
   * turn loses its replay cache when the session TTL expires before
   * its own retry window. Tracks the latest (signedAt +
   * MEMORY_WRITE_ACK_TIMEOUT_MS) across all cache entries; the session
   * is kept alive until max(createdAt+SESSION_TTL_MS, latestCacheExpiry).
   */
  latestCacheExpiry: number;
}

export interface AttestationResult {
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  timestamp: string;
}

interface AttestedKeypair {
  publicKey: NodeCryptoKey;
  publicKeyRaw: Uint8Array;
  /** Nulled on disposal so the OpenSSL-held key becomes GC-reclaimable. */
  privateKey: NodeCryptoKey | null;
  signingPrivateKey: KeyObject | null;
  signingPublicKeyRaw: Uint8Array;
  createdAt: number;
}

export type SessionZeroedListener = (sessionId: string) => void;

export class EnclaveSessionManager {
  private attestedKeypairs = new Map<string, AttestedKeypair>();

  private sessions = new Map<string, SessionEntry>();
  private readonly SESSION_TTL_MS = 5 * 60 * 1000;
  private readonly KEYPAIR_TTL_MS = 5 * 60 * 1000;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Subscribers fired AFTER a session has been wiped from the local
   * map. Used by ToolResultReassembler (and any future per-session
   * state holder) to drop their state on the same path. Listeners must
   * not throw; errors are caught and logged.
   */
  private sessionZeroedListeners: SessionZeroedListener[] = [];

  constructor() {
    // Background sweep every 60s — zeroes expired sessions and keypairs
    // that were never consumed (e.g. client disconnected after key exchange).
    // unref() so this timer doesn't prevent process exit.
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((err) => {
        console.error("[enclave] Session sweep failed:", err);
      });
    }, 60_000);
    this.sweepTimer.unref();
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      // R11 Finding B (Codex): sweep honours both the standard TTL and
      // the cache-extended expiry, matching getSessionEntry().
      const sessionTtlExpiry = entry.createdAt + this.SESSION_TTL_MS;
      const effectiveExpiry = Math.max(sessionTtlExpiry, entry.latestCacheExpiry);
      if (now > effectiveExpiry) {
        await this.zeroSession(id);
      }
    }
    await this.cleanupExpiredKeypairs();
  }

  async handleAttestation(nonce: Uint8Array): Promise<AttestationResult> {
    // Clean up only EXPIRED keypairs — active keypairs from concurrent clients
    // must survive until their key exchange completes.
    await this.cleanupExpiredKeypairs();

    const keyPair = await subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      // NON-extractable: no code path can ever export the private scalar.
      // Node provides no API to zero WebCrypto/OpenSSL-held key material
      // (CryptoKey and KeyObject have no destroy()), so disposal drops the
      // reference (zeroAttestedPrivateKey) and relies on GC within the
      // 5-min KEYPAIR_TTL_MS. deriveBits works on non-extractable keys.
      false,
      ["deriveBits"],
    );

    const publicKeyRaw = new Uint8Array(
      await subtle.exportKey("raw", keyPair.publicKey),
    );

    const pubKeyB64 = Buffer.from(publicKeyRaw).toString("base64");
    const signingKeypair = generateKeyPairSync("ed25519");
    const signingPublicKeyRaw = exportEd25519PublicKeyRaw(
      signingKeypair.publicKey,
    );
    this.attestedKeypairs.set(pubKeyB64, {
      publicKey: keyPair.publicKey,
      publicKeyRaw,
      privateKey: keyPair.privateKey,
      signingPrivateKey: signingKeypair.privateKey,
      signingPublicKeyRaw,
      createdAt: Date.now(),
    });

    return {
      ephemeralPublicKey: publicKeyRaw,
      nonce,
      timestamp: new Date().toISOString(),
    };
  }

  async handleKeyExchange(
    clientPublicKeyRaw: Uint8Array,
    sessionId: string,
    clientKeyExchangeNonce: Uint8Array,
    teePubKeyB64: string,
  ): Promise<{
    sessionId: string;
    teeKeyExchangeNonce: Uint8Array;
    signingPublicKey: Uint8Array;
  }> {
    const attestedKeypair = this.attestedKeypairs.get(teePubKeyB64);
    if (!attestedKeypair) {
      throw new Error(
        "No attestation keypair found for the specified TEE public key",
      );
    }
    this.attestedKeypairs.delete(teePubKeyB64);
    const ecdhPrivateKey = attestedKeypair.privateKey;
    if (!ecdhPrivateKey) {
      throw new Error("Attestation keypair already disposed");
    }

    try {
      if (this.sessions.has(sessionId)) {
        await this.zeroSession(sessionId);
      }

      const teeKeyExchangeNonce = webcrypto.getRandomValues(new Uint8Array(32));

      const clientPubKey = await subtle.importKey(
        "raw",
        asBufferSource(clientPublicKeyRaw),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );

      const sharedBits = await subtle.deriveBits(
        { name: "ECDH", public: clientPubKey },
        ecdhPrivateKey,
        256,
      );

      const salt = new Uint8Array(64);
      salt.set(clientKeyExchangeNonce, 0);
      salt.set(teeKeyExchangeNonce, 32);

      const hkdfKey = await subtle.importKey("raw", sharedBits, "HKDF", false, [
        "deriveKey",
        "deriveBits",
      ]);

      const sessionKeyBits = new Uint8Array(
        await subtle.deriveBits(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt,
            info: new TextEncoder().encode("brianni-tee-session-v1"),
          },
          hkdfKey,
          256,
        ),
      );

      const sessionKey = await subtle.importKey(
        "raw",
        sessionKeyBits,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );

      this.sessions.set(sessionId, {
        key: sessionKey,
        keyMaterial: sessionKeyBits,
        signingPrivateKey: attestedKeypair.signingPrivateKey,
        signingPublicKeyRaw: new Uint8Array(
          attestedKeypair.signingPublicKeyRaw,
        ),
        inFlightUnsignedEnvelopes: new Map(),
        signedFinalisationCache: new Map(),
        createdAt: Date.now(),
        latestCacheExpiry: 0,
      });
      this.zeroAttestedPrivateKey(attestedKeypair);

      zeroBuffer(new Uint8Array(sharedBits));

      return {
        sessionId,
        teeKeyExchangeNonce,
        signingPublicKey: new Uint8Array(attestedKeypair.signingPublicKeyRaw),
      };
    } catch (err) {
      this.zeroAttestedPrivateKey(attestedKeypair);
      throw err;
    }
  }

  async getSessionKey(sessionId: string): Promise<NodeCryptoKey> {
    return (await this.getSessionEntry(sessionId)).key;
  }

  async signEnvelope(
    sessionId: string,
    canonicalJson: string,
  ): Promise<Uint8Array> {
    const entry = await this.getSessionEntry(sessionId);
    if (!entry.signingPrivateKey) {
      throw new Error(`Session signing key not found or expired: ${sessionId}`);
    }
    return new Uint8Array(
      sign(null, Buffer.from(canonicalJson, "utf8"), entry.signingPrivateKey),
    );
  }

  async storeUnsignedEnvelopes(
    sessionId: string,
    dreamSessionId: string,
    entries: Array<[number, UnsignedEnvelope]>,
  ): Promise<void> {
    const entry = await this.getSessionEntry(sessionId);
    entry.inFlightUnsignedEnvelopes.set(dreamSessionId, new Map(entries));
  }

  async finaliseDreamEnvelopes(
    sessionId: string,
    dreamSessionId: string,
    items: DreamFinaliseItem[],
  ): Promise<DreamFinaliseResult[]> {
    const entry = await this.getSessionEntry(sessionId);
    return finaliseDreamEnvelopeState({
      state: entry,
      dreamSessionId,
      items,
      signEnvelope: (canonical) => this.signEnvelope(sessionId, canonical),
    });
  }

  async clearDreamSession(
    sessionId: string,
    dreamSessionId: string,
  ): Promise<void> {
    const entry = await this.getSessionEntry(sessionId);
    entry.inFlightUnsignedEnvelopes.delete(dreamSessionId);
    if (entry.inFlightUnsignedEnvelopes.size === 0) {
      await this.zeroSession(sessionId);
    }
  }

  // ---- R8-H1: signed memory.write finalisation cache (agent loop) ----

  async cacheSignedFinalisation(
    sessionId: string,
    agentTurnId: string,
    invocationId: string,
    entry: SignedFinalisationEntry,
  ): Promise<void> {
    const session = await this.getSessionEntry(sessionId);
    let inner = session.signedFinalisationCache.get(agentTurnId);
    if (!inner) {
      inner = new Map();
      session.signedFinalisationCache.set(agentTurnId, inner);
    }
    inner.set(invocationId, entry);
    // R11 Finding B (Codex): keep the session alive at least
    // MEMORY_WRITE_ACK_TIMEOUT_MS past this signing event so the cache
    // can do its job. Without this the session TTL (5 min from key
    // exchange) can evict the cache before the ACK retry window.
    const cacheExpiresAt = entry.signedAt + MEMORY_WRITE_ACK_TIMEOUT_MS;
    if (cacheExpiresAt > session.latestCacheExpiry) {
      session.latestCacheExpiry = cacheExpiresAt;
    }
  }

  async lookupSignedFinalisation(
    sessionId: string,
    agentTurnId: string,
    invocationId: string,
  ): Promise<SignedFinalisationEntry | null> {
    const session = await this.getSessionEntry(sessionId);
    const inner = session.signedFinalisationCache.get(agentTurnId);
    if (!inner) return null;
    const entry = inner.get(invocationId);
    if (!entry) return null;
    if (Date.now() - entry.signedAt > MEMORY_WRITE_ACK_TIMEOUT_MS) {
      inner.delete(invocationId);
      if (inner.size === 0) {
        session.signedFinalisationCache.delete(agentTurnId);
      }
      return null;
    }
    return entry;
  }

  async ackSignedFinalisation(
    sessionId: string,
    agentTurnId: string,
    invocationId: string,
    ackContentHash: string,
  ): Promise<{ outcome: SignedFinalisationAckOutcome }> {
    const session = await this.getSessionEntry(sessionId);
    const inner = session.signedFinalisationCache.get(agentTurnId);
    if (!inner) return { outcome: 'absent' };
    const entry = inner.get(invocationId);
    if (!entry) return { outcome: 'absent' };
    // R9-H1: mismatched ACK must NOT delete the cache entry. The
    // legitimate ACK (with the right contentHash) may still arrive, and a
    // benign replay of the reverse-channel POST in the meantime must
    // still recover the originally signed bytes deterministically.
    if (entry.contentHash !== ackContentHash) {
      return { outcome: 'mismatch' };
    }
    inner.delete(invocationId);
    if (inner.size === 0) {
      session.signedFinalisationCache.delete(agentTurnId);
    }
    return { outcome: 'ok' };
  }

  async clearAgentTurn(
    sessionId: string,
    agentTurnId: string,
  ): Promise<void> {
    const session = await this.getSessionEntry(sessionId);
    session.signedFinalisationCache.delete(agentTurnId);
  }

  private async getSessionEntry(sessionId: string): Promise<SessionEntry> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      // SESSION_EXPIRED prefix: the wire error_code mapping keys off this
      // token (sessionId itself is host-known plaintext, never secret).
      throw new Error(`SESSION_EXPIRED: session not found: ${sessionId}`);
    }
    // R11 Finding B (Codex): the effective session expiry is the LATER
    // of the standard 5-min TTL and the latest pending
    // signed-finalisation cache expiry. A memory.write that signs late
    // in a long turn must still have its full
    // MEMORY_WRITE_ACK_TIMEOUT_MS to drive ACK / replay-recovery, even
    // if the underlying session key-exchange happened 5 min ago.
    const now = Date.now();
    const sessionTtlExpiry = entry.createdAt + this.SESSION_TTL_MS;
    const effectiveExpiry = Math.max(sessionTtlExpiry, entry.latestCacheExpiry);
    if (now > effectiveExpiry) {
      await this.zeroSession(sessionId);
      throw new Error(`SESSION_EXPIRED: ${sessionId}`);
    }
    return entry;
  }

  async zeroSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      zeroBuffer(entry.keyMaterial);
      zeroBuffer(entry.signingPublicKeyRaw);
      entry.inFlightUnsignedEnvelopes.clear();
      entry.signedFinalisationCache.clear();
      entry.signingPrivateKey = null;
      this.sessions.delete(sessionId);
      // Fire AFTER the local wipe so listeners observe a consistent
      // "session no longer exists" view of getSessionEntry().
      for (const listener of this.sessionZeroedListeners) {
        try {
          listener(sessionId);
        } catch (err) {
          console.error('[enclave] sessionZeroed listener threw:', err);
        }
      }
    }
  }

  /**
   * Register a callback fired after every successful zeroSession. Used
   * by ToolResultReassembler so partial chunk buffers are wiped on the
   * same path as session keys + signed-finalisation caches. Returns an
   * unsubscribe function (helpful for test teardown).
   */
  registerOnZeroed(listener: SessionZeroedListener): () => void {
    this.sessionZeroedListeners.push(listener);
    return () => {
      const idx = this.sessionZeroedListeners.indexOf(listener);
      if (idx >= 0) this.sessionZeroedListeners.splice(idx, 1);
    };
  }

  /**
   * Clean up expired keypairs. Keypairs within TTL are preserved so
   * concurrent clients can complete their key exchange after attestation.
   */
  async cleanupExpiredKeypairs(): Promise<void> {
    const now = Date.now();
    for (const [key, kp] of this.attestedKeypairs) {
      if (now - kp.createdAt > this.KEYPAIR_TTL_MS) {
        this.zeroAttestedPrivateKey(kp);
        zeroBuffer(kp.publicKeyRaw);
        zeroBuffer(kp.signingPublicKeyRaw);
        kp.signingPrivateKey = null;
        this.attestedKeypairs.delete(key);
      }
    }
  }

  /**
   * Dispose of the consumed ECDH private key. Node provides no API to zero
   * WebCrypto/OpenSSL-held private key material (CryptoKey and KeyObject
   * have no destroy()), so the strongest available disposal is: the key is
   * generated NON-extractable (no code path can copy the scalar out) and
   * the last reference is dropped here, making the underlying EVP_PKEY
   * GC-reclaimable. Residual lifetime is bounded by GC lag, on top of the
   * 5-min KEYPAIR_TTL_MS the keypair lives at most anyway.
   *
   * (A previous version exported a PKCS8 copy and zeroed THAT copy — pure
   * theater: the OpenSSL-held original was untouched and the key had to be
   * extractable to allow it. Do not reintroduce that pattern.)
   */
  private zeroAttestedPrivateKey(kp: AttestedKeypair): void {
    kp.privateKey = null;
  }

  /**
   * Zero ALL keypairs. Called during shutdown or explicit rotation.
   */
  async rotateAttestation(): Promise<void> {
    for (const [key, kp] of this.attestedKeypairs) {
      this.zeroAttestedPrivateKey(kp);
      zeroBuffer(kp.publicKeyRaw);
      zeroBuffer(kp.signingPublicKeyRaw);
      kp.signingPrivateKey = null;
      this.attestedKeypairs.delete(key);
    }
  }
}

function exportEd25519PublicKeyRaw(publicKey: KeyObject): Uint8Array {
  const der = publicKey.export({ format: "der", type: "spki" });
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const bytes = Buffer.isBuffer(der) ? der : Buffer.from(der);
  if (
    bytes.length !== prefix.length + 32 ||
    !bytes.subarray(0, prefix.length).equals(prefix)
  ) {
    throw new Error("Unexpected Ed25519 public key DER encoding");
  }
  return new Uint8Array(bytes.subarray(prefix.length));
}
