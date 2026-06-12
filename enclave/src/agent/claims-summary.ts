/**
 * CLAIMS_SUMMARY flush helper (Phase 4 audit, hardening).
 *
 * The cross-pack claims advocate emits ONE encrypted CLAIMS_SUMMARY audit frame
 * carrying the two facts that exist ONLY inside the enclave for a claims run:
 * which memory namespaces were ACTUALLY read ("exercised") and which URLs the
 * air-gapped research subagent fetched. Privacy policy §19 + DPIA addendum §5.5
 * promise an audit receipt is stored "after each claims task" — UNQUALIFIED on
 * success — so the summary MUST reach the client on EVERY terminal exit of the
 * AGENT_REQUEST orchestrator loop, not only the clean `done` path:
 *
 *   - clean completion  → flushed just before AGENT_DONE,
 *   - error terminal    → flushed just before the agent error frame,
 *   - pump throw / abort → flushed from the pump teardown (finally) as a backstop.
 *
 * Without the backstop a run that read memory and/or issued web egress and THEN
 * errored/aborted would leave the client (and therefore the only party able to
 * read plaintext) with no audit record of a run that actually touched data —
 * permanently lost, because the server is deliberately blind to plaintext.
 *
 * INVARIANTS this helper enforces, so callers cannot regress them:
 *   - Claims-only: a no-op unless `isClaimsRun` — non-claims runs emit nothing.
 *   - At most once per run: the first SUCCESSFUL flush sets a latch; later calls
 *     (e.g. the teardown backstop firing after `done`/error already flushed) are
 *     no-ops. A flush that throws before emitting does NOT latch, so a later
 *     terminal can retry rather than the run losing its audit frame.
 *   - Encrypted under the session key: the payload is sealed with the SAME
 *     `encryptChunk` mechanism every other agent frame uses, so the relaying
 *     host/server only ever forwards opaque ciphertext (server-blindness). The
 *     namespace set / URLs are NEVER emitted in plaintext.
 *
 * Tracking is unchanged: this helper only READS the live gateway getters at
 * flush time — it never records anything. A flush after an error therefore
 * reports exactly what the run accumulated before failing (the common
 * partial-then-failed case).
 */
import type { webcrypto } from 'node:crypto';
import type { MemoryNamespace } from '@calypso/chat-types';
import { encodeFrame, MSG } from '../vsock';

/** The two enclave-only facts carried by a CLAIMS_SUMMARY frame. */
export interface ClaimsSummaryPayload {
  exercisedNamespaces: readonly MemoryNamespace[];
  fetchedUrls: readonly string[];
}

export interface ClaimsSummaryFlusherDeps {
  /** True only when a real cross-pack grant widened scope (a claims run). */
  isClaimsRun: boolean;
  /** Session key the frame body is sealed under (server-blindness). */
  sessionKey: webcrypto.CryptoKey;
  /** Reads the LIVE exercised-namespace set at flush time. */
  getExercisedNamespaces: () => readonly MemoryNamespace[];
  /** Reads the LIVE research-fetched-URL set at flush time. */
  getFetchedUrls: () => readonly string[];
  /** The session-key AEAD used by every other agent frame. */
  encryptChunk: (
    sessionKey: webcrypto.CryptoKey,
    plaintext: Buffer,
  ) => Promise<Buffer>;
  /** Sink for the encoded CLAIMS_SUMMARY frame (the outbound queue). */
  pushFrame: (frame: Buffer) => void;
}

export interface ClaimsSummaryFlusher {
  /**
   * Emit the CLAIMS_SUMMARY frame iff this is a claims run and it has not
   * already been emitted for this run. Safe to call from every terminal exit
   * point; only the first call for a claims run produces a frame.
   *
   * @returns true if a frame was emitted by THIS call, false otherwise.
   */
  flush: () => Promise<boolean>;
  /** Test/introspection: whether a frame has already been emitted this run. */
  hasFlushed: () => boolean;
}

/**
 * Build a single-use-per-run CLAIMS_SUMMARY flusher. One instance is created per
 * AGENT_REQUEST and shared across every terminal exit point of the loop so the
 * once-latch is honoured no matter which path fires (or fires first).
 */
export function createClaimsSummaryFlusher(
  deps: ClaimsSummaryFlusherDeps,
): ClaimsSummaryFlusher {
  let flushed = false;

  return {
    hasFlushed: () => flushed,
    async flush(): Promise<boolean> {
      // Non-claims runs emit NOTHING — preserves the existing absence-of-frame
      // invariant for ordinary agent runs.
      if (!deps.isClaimsRun) return false;
      // At most once per run: a terminal case (done/error) and the teardown
      // backstop may BOTH call flush(); only the first SUCCESSFUL emit wins.
      if (flushed) return false;

      const payload: ClaimsSummaryPayload = {
        exercisedNamespaces: deps.getExercisedNamespaces(),
        fetchedUrls: deps.getFetchedUrls(),
      };
      // Sealed under the session key — the host/server forwards only ciphertext.
      const encrypted = await deps.encryptChunk(
        deps.sessionKey,
        Buffer.from(JSON.stringify(payload)),
      );
      deps.pushFrame(encodeFrame(MSG.CLAIMS_SUMMARY, encrypted));
      // Latch ONLY after a successful emit ("first SUCCESSFUL emission wins").
      // If encryptChunk / pushFrame throws, `flushed` stays false so a later
      // terminal (the error case or the teardown backstop) can retry, rather
      // than a transient first-attempt failure permanently dropping the audit
      // frame. The AGENT_REQUEST terminals call flush() sequentially (never
      // concurrently), so there is no check-then-set re-entrancy window here.
      flushed = true;
      return true;
    },
  };
}
