/**
 * Chunked tool-result reassembly.
 *
 * The single-frame TOOL_RESULT path caps at MAX_TOOL_RESULT_PLAINTEXT_BYTES
 * (200 KB) because the vsock envelope ceiling (512 KB) leaves only ~280 KB
 * for the inner plaintext once AES-GCM + base64 + the outer JSON wrapper
 * have all expanded. The spec §7.1 promise of 5 MB per file is achieved by
 * having the client split large payloads into multiple ~200 KB plaintext
 * frames, each posted to /v1/agent/:sessionId/tool-result independently,
 * and reassembled here inside the enclave.
 *
 * Wire shape (locked decision — wrapper-on-every-chunk):
 *
 *   // Chunk i (encrypted inner JSON)
 *   {
 *     agentTurnId, invocationId,
 *     _chunk: { index: i, total: N },
 *     partB64: "<base64 of slice i of the full single-frame inner JSON bytes>"
 *   }
 *
 *   // After all N chunks reassemble (Buffer.concat of partB64 decodes):
 *   {
 *     agentTurnId, invocationId,
 *     outcome, resultJson?, resultB64?, reason?
 *   }
 *
 * The reassembled bytes are byte-identical to what the single-frame path
 * would have decrypted — so the resolver-dispatch path is shared. Absence
 * of `_chunk` on the decrypted payload signals the single-frame path.
 *
 * Locked invariants:
 *   - Server stays blind to chunk markers (they live inside the encrypted body).
 *   - Reassembly state is keyed by (sessionId, agentTurnId, invocationId)
 *     — the same triple-key the resolver index uses, so two concurrent
 *     invocations in one turn cannot collide.
 *   - Out-of-order chunk arrival is supported (`parts` is a Map<index, Buffer>).
 *   - Reassembly buffers are wiped on the same `zeroSession` path that
 *     wipes other per-session state. EnclaveSessionManager exposes
 *     `registerOnZeroed` so this module hooks in without leaking the
 *     wipe responsibility to callers.
 *   - Hard caps: total parts ≤ MAX_TOOL_RESULT_CHUNKS, reassembled bytes ≤
 *     MAX_REASSEMBLED_TOOL_RESULT_BYTES.
 *   - GC sweep drops buffers whose lastTouched > REASSEMBLY_BUFFER_TTL_MS.
 *     On drop, if a resolver is still waiting on the triple-key, it is
 *     resolved with outcome:'error' / reason:'TOOL_RESULT_REASSEMBLY_TIMEOUT'
 *     (mirroring the existing per-invocation timeout path).
 */

import { MAX_REASSEMBLED_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_CHUNKS } from '../tools/file-allowlist';
import { zeroBuffer } from '../crypto';

/** Default lifetime for a partial reassembly buffer with no new chunks. */
export const REASSEMBLY_BUFFER_TTL_MS = 60_000;

/** Default sweep interval. */
export const REASSEMBLY_SWEEP_INTERVAL_MS = 30_000;

/**
 * How long after a successful finalise() we remember the triple-key so
 * a duplicate POST (HTTP retry because the 204 response to the FINAL
 * chunk was lost in transit) short-circuits as a no-op success without
 * allocating a fresh phantom entry that would consume a slot in the
 * per-turn / per-session caps for `REASSEMBLY_BUFFER_TTL_MS` (60 s).
 */
export const REASSEMBLY_FINALISED_LRU_TTL_MS = 30_000;

/**
 * Maximum simultaneous in-flight reassembly entries per (sessionId,
 * agentTurnId). Caps the memory footprint a single misbehaving client
 * can pin within ONE agent turn — 16 × 8 MiB = 128 MiB worst case.
 */
export const MAX_INFLIGHT_REASSEMBLIES_PER_TURN = 16;

/**
 * Maximum simultaneous in-flight reassembly entries per sessionId
 * across ALL agent turns. Bounds the cross-turn aggregation surface
 * an authenticated misbehaving client could otherwise exploit by
 * opening many concurrent turns within one session. 32 × 8 MiB =
 * 256 MiB worst case per session, independent of how many turns the
 * client tries to open.
 */
export const MAX_INFLIGHT_REASSEMBLIES_PER_SESSION = 32;

export type ReassemblyTimeoutHandler = (key: ReassemblyKey) => void;

export interface ReassemblyKey {
  sessionId: string;
  agentTurnId: string;
  invocationId: string;
}

export interface ChunkInput {
  sessionId: string;
  agentTurnId: string;
  invocationId: string;
  index: number;
  total: number;
  partB64: string;
}

export type AddChunkResult =
  | {
      status: 'pending';
      /**
       * Codex MEDIUM "duplicate chunks can keep agent invocations alive
       * indefinitely" — discriminate genuinely-new bytes from
       * retransmits of bytes we already have. The wire-level caller
       * (enclave/src/index.ts) only refreshes the per-invocation
       * timeout when `accepted !== false`, so a hostile client cannot
       * pin one invocation forever by replaying a single chunk.
       *
       * `undefined` (omitted) on this field is treated as `true` for
       * back-compat with callers that haven't been updated yet.
       */
      accepted?: boolean;
    }
  | { status: 'complete'; reassembled: Buffer }
  | {
      /**
       * Triple-key was finalised within REASSEMBLY_FINALISED_LRU_TTL_MS
       * and this chunk is a duplicate POST after the original 204
       * response was lost. Caller should return 204 to the client (the
       * resolver was already dispatched) but MUST NOT re-dispatch.
       */
      status: 'already-finalised';
    }
  | {
      status: 'rejected';
      error_code:
        | 'TOOL_RESULT_REASSEMBLY_INVALID'
        | 'TOOL_RESULT_REASSEMBLY_TOO_LARGE'
        | 'TOOL_RESULT_REASSEMBLY_TOO_MANY';
      message: string;
    };

interface ReassemblyEntry {
  total: number;
  parts: Map<number, Buffer>;
  receivedBytes: number;
  lastTouched: number;
}

export class ToolResultReassembler {
  private entries = new Map<string, ReassemblyEntry>();
  /**
   * Triple-keys that finalised recently — short-circuits HTTP retries
   * of the final chunk so a lost-203 doesn't allocate a phantom entry
   * and consume a slot in the per-turn / per-session caps.
   * Value = expiry timestamp (ms). Cleared by the same sweep().
   */
  private recentlyFinalised = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onTimeout: ReassemblyTimeoutHandler | null;
  private readonly ttlMs: number;
  private readonly finalisedLruTtlMs: number;

  constructor(opts: {
    onTimeout?: ReassemblyTimeoutHandler;
    /** Test seam — shorter TTLs make timeout coverage cheap. */
    ttlMs?: number;
    /** Test seam — shorten the recently-finalised LRU window. */
    finalisedLruTtlMs?: number;
    /** Test seam — disables the background sweep (manual call only). */
    sweepIntervalMs?: number | null;
  } = {}) {
    this.onTimeout = opts.onTimeout ?? null;
    this.ttlMs = opts.ttlMs ?? REASSEMBLY_BUFFER_TTL_MS;
    this.finalisedLruTtlMs =
      opts.finalisedLruTtlMs ?? REASSEMBLY_FINALISED_LRU_TTL_MS;
    const interval = opts.sweepIntervalMs === undefined
      ? REASSEMBLY_SWEEP_INTERVAL_MS
      : opts.sweepIntervalMs;
    if (interval !== null) {
      this.sweepTimer = setInterval(() => this.sweep(), interval);
      this.sweepTimer.unref();
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // Zero any remaining in-flight buffers — stop() is an explicit
    // teardown path (process shutdown, test teardown) and leaving
    // decrypted plaintext sitting in heap with no GC sweep would
    // contradict the same memory-hygiene contract the per-entry
    // cleanup paths honour. The recently-finalised LRU holds only
    // triple-key strings (no plaintext) but we drop it too so a
    // fresh start has no carried-over state.
    for (const entry of this.entries.values()) {
      zeroEntry(entry);
    }
    this.entries.clear();
    this.recentlyFinalised.clear();
  }

  /**
   * Accept one chunk. Returns:
   *   - `pending`: more chunks expected.
   *   - `complete`: this was the final missing chunk; `reassembled` carries
   *     the concatenated bytes (in index order). The entry is removed
   *     from internal state before returning.
   *   - `rejected`: hard reject — invalid envelope, total too large, or
   *     bytes-budget exceeded. Caller should surface as CHAT_ERROR.
   */
  addChunk(input: ChunkInput): AddChunkResult {
    const { sessionId, agentTurnId, invocationId, index, total, partB64 } = input;

    // Triple-key is encoded as `${sessionId}::${agentTurnId}::${invocationId}`
    // and split on `::` by clearForSession / clearForTurn / parseKey. A
    // value containing `::` would collide across triple-keys and would
    // break onTimeout key parsing (parseKey returns null for >3 parts).
    // An empty identifier produces an ambiguous prefix-match collision
    // and dispatches downstream against `''` invocations, leaving the
    // failure to surface as UNSOLICITED_TOOL_RESULT — clearer to reject
    // here with a specific error.
    // Reject rather than try to escape — production IDs are UUIDs/ULIDs
    // and never legitimately contain `::` or are empty.
    if (
      sessionId.length === 0 ||
      agentTurnId.length === 0 ||
      invocationId.length === 0
    ) {
      return {
        status: 'rejected',
        error_code: 'TOOL_RESULT_REASSEMBLY_INVALID',
        message: 'identifier must be non-empty',
      };
    }
    if (
      sessionId.includes('::') ||
      agentTurnId.includes('::') ||
      invocationId.includes('::')
    ) {
      return {
        status: 'rejected',
        error_code: 'TOOL_RESULT_REASSEMBLY_INVALID',
        message: 'identifier may not contain "::"',
      };
    }

    if (!Number.isInteger(total) || total < 1 || total > MAX_TOOL_RESULT_CHUNKS) {
      return {
        status: 'rejected',
        error_code: 'TOOL_RESULT_REASSEMBLY_INVALID',
        message: `total must be 1..${MAX_TOOL_RESULT_CHUNKS}, got ${total}`,
      };
    }
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      return {
        status: 'rejected',
        error_code: 'TOOL_RESULT_REASSEMBLY_INVALID',
        message: `index out of range: ${index} (total=${total})`,
      };
    }
    if (typeof partB64 !== 'string' || partB64.length === 0) {
      return {
        status: 'rejected',
        error_code: 'TOOL_RESULT_REASSEMBLY_INVALID',
        message: 'partB64 missing or empty',
      };
    }

    // Recently-finalised short-circuit: a duplicate POST after the
    // 204 response was lost in transit must NOT allocate a fresh
    // entry (which would consume a slot in the per-turn / per-session
    // caps and could starve legitimate new invocations under a retry
    // storm). The caller treats `already-finalised` as a 204 success
    // — the original dispatch has already happened.
    const candidateKey = keyFor(sessionId, agentTurnId, invocationId);
    const finalisedExpiry = this.recentlyFinalised.get(candidateKey);
    if (finalisedExpiry !== undefined && finalisedExpiry > Date.now()) {
      return { status: 'already-finalised' };
    }

    let partBytes: Buffer;
    try {
      // Buffer.from(b64, 'base64') is lenient — accepts garbage after
      // padding — but the bytes are derived from session-key-decrypted
      // plaintext, so the threat model is "buggy client", not "hostile
      // attacker post-encryption". A round-trip canonical check is
      // unnecessary noise here; concatenation byte-equality on the
      // final JSON.parse is what enforces correctness.
      partBytes = Buffer.from(partB64, 'base64');
    } catch {
      return {
        status: 'rejected',
        error_code: 'TOOL_RESULT_REASSEMBLY_INVALID',
        message: 'partB64 not valid base64',
      };
    }

    // Reuse the candidateKey computed above for the recently-finalised
    // check — it's the same triple-key.
    const key = candidateKey;
    let entry = this.entries.get(key);
    if (!entry) {
      // Cap concurrent in-flight reassemblies at two scopes so a
      // misbehaving client cannot pin arbitrary memory either by
      // spamming invocationIds within one turn or by opening many
      // parallel turns within one session. The O(N) scan is fine at
      // MVP scale (entries per process bounded by the per-session cap
      // × small number of sessions); a per-prefix counter Map would
      // make this O(1) but is overkill until traffic justifies it.
      const turnPrefix = `${sessionId}::${agentTurnId}::`;
      const sessionPrefix = `${sessionId}::`;
      let turnInflight = 0;
      let sessionInflight = 0;
      for (const existingKey of this.entries.keys()) {
        if (existingKey.startsWith(sessionPrefix)) {
          sessionInflight += 1;
          if (existingKey.startsWith(turnPrefix)) turnInflight += 1;
        }
      }
      if (turnInflight >= MAX_INFLIGHT_REASSEMBLIES_PER_TURN) {
        zeroBuffer(partBytes);
        return {
          status: 'rejected',
          error_code: 'TOOL_RESULT_REASSEMBLY_TOO_MANY',
          message: `in-flight reassemblies per turn exceed ${MAX_INFLIGHT_REASSEMBLIES_PER_TURN}`,
        };
      }
      if (sessionInflight >= MAX_INFLIGHT_REASSEMBLIES_PER_SESSION) {
        zeroBuffer(partBytes);
        return {
          status: 'rejected',
          error_code: 'TOOL_RESULT_REASSEMBLY_TOO_MANY',
          message: `in-flight reassemblies per session exceed ${MAX_INFLIGHT_REASSEMBLIES_PER_SESSION}`,
        };
      }
      entry = {
        total,
        parts: new Map(),
        receivedBytes: 0,
        lastTouched: Date.now(),
      };
      this.entries.set(key, entry);
    } else if (entry.total !== total) {
      // Two chunks of the same triple-key reporting different totals is a
      // protocol violation; drop the entry to fail closed (a future stale
      // chunk cannot resurrect it). Zero buffered parts first — they
      // carry decrypted file plaintext.
      zeroEntry(entry);
      this.entries.delete(key);
      return {
        status: 'rejected',
        error_code: 'TOOL_RESULT_REASSEMBLY_INVALID',
        message: `total mismatch: previous=${entry.total}, this=${total}`,
      };
    }

    // Replay of the same index with the same bytes is a no-op (network
    // retry of an in-flight POST). Mismatched bytes for the same index
    // is a protocol violation.
    const existing = entry.parts.get(index);
    if (existing) {
      if (existing.equals(partBytes)) {
        // Idempotent retransmit — drop the duplicate plaintext copy.
        zeroBuffer(partBytes);
        // Codex MEDIUM — do NOT bump `entry.lastTouched` on a pure
        // retransmit. Combined with `accepted: false` on the return,
        // this means a stream of duplicates can neither extend the
        // TTL sweep nor the per-invocation resolver timer. The TTL
        // sweep still uses `lastTouched` as freshness — by leaving
        // it untouched, a duplicate-flood entry ages out normally.
        return entry.parts.size === entry.total
          ? this.finalise(key, entry)
          : { status: 'pending', accepted: false };
      }
      zeroBuffer(partBytes);
      zeroEntry(entry);
      this.entries.delete(key);
      return {
        status: 'rejected',
        error_code: 'TOOL_RESULT_REASSEMBLY_INVALID',
        message: `byte mismatch on retransmitted index ${index}`,
      };
    }

    const projected = entry.receivedBytes + partBytes.length;
    if (projected > MAX_REASSEMBLED_TOOL_RESULT_BYTES) {
      zeroBuffer(partBytes);
      zeroEntry(entry);
      this.entries.delete(key);
      return {
        status: 'rejected',
        error_code: 'TOOL_RESULT_REASSEMBLY_TOO_LARGE',
        message: `reassembled bytes would exceed ${MAX_REASSEMBLED_TOOL_RESULT_BYTES}`,
      };
    }

    entry.parts.set(index, partBytes);
    entry.receivedBytes = projected;
    entry.lastTouched = Date.now();

    if (entry.parts.size === entry.total) {
      return this.finalise(key, entry);
    }
    return { status: 'pending' };
  }

  /**
   * Discard any partial buffers for the given session. Wired into
   * EnclaveSessionManager.zeroSession so reassembly state is cleared on
   * the same wipe path as session keys and signed-finalisation caches.
   */
  clearForSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        const entry = this.entries.get(key);
        if (entry) zeroEntry(entry);
        this.entries.delete(key);
      }
    }
    for (const key of [...this.recentlyFinalised.keys()]) {
      if (key.startsWith(prefix)) this.recentlyFinalised.delete(key);
    }
  }

  /**
   * Discard any partial buffers for one (sessionId, agentTurnId) pair.
   * Aligns with the AGENT_REQUEST stream-teardown cleanup that scrubs
   * outstandingInvocations / preRegisteredResolverPromises for the same
   * prefix.
   */
  clearForTurn(sessionId: string, agentTurnId: string): void {
    const prefix = `${sessionId}::${agentTurnId}::`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        const entry = this.entries.get(key);
        if (entry) zeroEntry(entry);
        this.entries.delete(key);
      }
    }
    for (const key of [...this.recentlyFinalised.keys()]) {
      if (key.startsWith(prefix)) this.recentlyFinalised.delete(key);
    }
  }

  /**
   * Drop buffers whose lastTouched is older than the TTL. Each dropped
   * key fires the timeout callback so the agent loop can resolve the
   * pending resolver with TOOL_RESULT_REASSEMBLY_TIMEOUT.
   *
   * Exposed for tests (which set `sweepIntervalMs: null` and call this
   * directly to advance the clock deterministically).
   */
  sweep(now: number = Date.now()): void {
    // Expire recently-finalised LRU entries. Cheap — bounded by
    // MAX_INFLIGHT_REASSEMBLIES_PER_SESSION × number of sessions in
    // the LRU window.
    for (const [key, expiry] of this.recentlyFinalised) {
      if (expiry <= now) {
        this.recentlyFinalised.delete(key);
      }
    }
    for (const [key, entry] of this.entries) {
      if (now - entry.lastTouched > this.ttlMs) {
        zeroEntry(entry);
        this.entries.delete(key);
        if (this.onTimeout) {
          const parsed = parseKey(key);
          if (parsed) {
            try {
              this.onTimeout(parsed);
            } catch (err) {
              console.error(
                '[enclave] tool-result reassembly timeout callback failed:',
                err,
              );
            }
          }
        }
      }
    }
  }

  /** Test seam — observe internal state. */
  __sizeForTest(): number {
    return this.entries.size;
  }

  /**
   * Test seam — returns the underlying part Buffers (live references)
   * for one triple-key, so tests can verify the byte-wipe contract on
   * cleanup paths (zeroEntry / stop / clearForSession / sweep). Returns
   * null if the entry no longer exists.
   */
  __peekPartsForTest(
    sessionId: string,
    agentTurnId: string,
    invocationId: string,
  ): Buffer[] | null {
    const entry = this.entries.get(keyFor(sessionId, agentTurnId, invocationId));
    if (!entry) return null;
    return [...entry.parts.values()];
  }

  private finalise(key: string, entry: ReassemblyEntry): AddChunkResult {
    const ordered: Buffer[] = [];
    for (let i = 0; i < entry.total; i += 1) {
      const part = entry.parts.get(i);
      if (!part) {
        // Defensive: parts.size === total but a non-contiguous index is
        // missing. Cannot happen given the index range check above, but
        // guard anyway.
        zeroEntry(entry);
        this.entries.delete(key);
        return {
          status: 'rejected',
          error_code: 'TOOL_RESULT_REASSEMBLY_INVALID',
          message: `missing part at index ${i}`,
        };
      }
      ordered.push(part);
    }
    const reassembled = Buffer.concat(ordered);
    // Concat copies bytes into a fresh allocation; the original parts
    // are now safe to wipe. Caller is responsible for zeroing the
    // returned `reassembled` buffer after JSON.parse — see the
    // `if (reassembled) zeroBuffer(reassembled)` in the TOOL_RESULT
    // handler's finally{} block.
    zeroEntry(entry);
    this.entries.delete(key);
    // Stamp this triple-key into the recently-finalised LRU so a
    // duplicate HTTP retry of the final chunk (because the original
    // 204 was lost) short-circuits as `already-finalised` instead of
    // allocating a phantom entry.
    this.recentlyFinalised.set(key, Date.now() + this.finalisedLruTtlMs);
    return { status: 'complete', reassembled };
  }
}

/** Zero every chunk plaintext in the entry. */
function zeroEntry(entry: ReassemblyEntry): void {
  for (const part of entry.parts.values()) {
    zeroBuffer(part);
  }
  entry.parts.clear();
  entry.receivedBytes = 0;
}

function keyFor(
  sessionId: string,
  agentTurnId: string,
  invocationId: string,
): string {
  return `${sessionId}::${agentTurnId}::${invocationId}`;
}

function parseKey(key: string): ReassemblyKey | null {
  const parts = key.split('::');
  if (parts.length !== 3) return null;
  const [sessionId, agentTurnId, invocationId] = parts;
  return { sessionId, agentTurnId, invocationId };
}
