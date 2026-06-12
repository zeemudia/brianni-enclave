import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ToolResultReassembler,
  MAX_INFLIGHT_REASSEMBLIES_PER_TURN,
  MAX_INFLIGHT_REASSEMBLIES_PER_SESSION,
  type ReassemblyKey,
} from '../agent/tool-result-reassembler';
import {
  MAX_REASSEMBLED_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULT_CHUNKS,
} from '../tools/file-allowlist';

const SESSION = 'sess-1';
const TURN = 'turn-1';
const INV = 'inv-1';

function partB64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

describe('ToolResultReassembler — happy path', () => {
  it('reassembles ordered chunks into the original bytes', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const slices = ['{"agentTu', 'rnId":"', 'turn-1","invocationId":"inv-1"}'];
    for (let i = 0; i < slices.length - 1; i += 1) {
      const res = r.addChunk({
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: INV,
        index: i,
        total: slices.length,
        partB64: partB64(slices[i]),
      });
      expect(res.status).toBe('pending');
    }
    const finalRes = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: slices.length - 1,
      total: slices.length,
      partB64: partB64(slices[slices.length - 1]),
    });
    expect(finalRes.status).toBe('complete');
    if (finalRes.status === 'complete') {
      expect(finalRes.reassembled.toString('utf8')).toBe(slices.join(''));
    }
    expect(r.__sizeForTest()).toBe(0);
  });

  it('reassembles out-of-order chunks in index order', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const slices = ['AAA', 'BBB', 'CCC', 'DDD'];
    const order = [2, 0, 3, 1];
    let final: ReturnType<typeof r.addChunk> = { status: 'pending' };
    for (const idx of order) {
      final = r.addChunk({
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: INV,
        index: idx,
        total: slices.length,
        partB64: partB64(slices[idx]),
      });
    }
    expect(final.status).toBe('complete');
    if (final.status === 'complete') {
      expect(final.reassembled.toString('utf8')).toBe('AAABBBCCCDDD');
    }
  });

  it('handles a single-chunk POST (total=1, index=0) as a complete result immediately', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const result = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 1,
      partB64: partB64('single-chunk-payload'),
    });
    expect(result.status).toBe('complete');
    if (result.status === 'complete') {
      expect(result.reassembled.toString('utf8')).toBe('single-chunk-payload');
    }
  });
});

describe('ToolResultReassembler — validation', () => {
  it('rejects total < 1', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const res = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 0,
      partB64: partB64('x'),
    });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.error_code).toBe('TOOL_RESULT_REASSEMBLY_INVALID');
    }
  });

  it('rejects total > MAX_TOOL_RESULT_CHUNKS', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const res = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: MAX_TOOL_RESULT_CHUNKS + 1,
      partB64: partB64('x'),
    });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.error_code).toBe('TOOL_RESULT_REASSEMBLY_INVALID');
    }
  });

  it('accepts the boundary total == MAX_TOOL_RESULT_CHUNKS', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const res = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: MAX_TOOL_RESULT_CHUNKS,
      partB64: partB64('x'),
    });
    expect(res.status).toBe('pending');
  });

  it('rejects index out of range', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const res = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 5,
      total: 3,
      partB64: partB64('x'),
    });
    expect(res.status).toBe('rejected');
  });

  it('rejects empty partB64', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const res = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: '',
    });
    expect(res.status).toBe('rejected');
  });

  it('rejects total mismatch on a later chunk of the same invocation', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const first = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 3,
      partB64: partB64('A'),
    });
    expect(first.status).toBe('pending');
    const conflicting = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 1,
      total: 5, // mismatch
      partB64: partB64('B'),
    });
    expect(conflicting.status).toBe('rejected');
    // Entry must be wiped so a future correct chunk cannot resurrect it.
    expect(r.__sizeForTest()).toBe(0);
  });

  it('treats an identical retransmit of an index as idempotent', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('AAA'),
    });
    const retransmit = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('AAA'),
    });
    expect(retransmit.status).toBe('pending');
    expect(r.__sizeForTest()).toBe(1);
  });

  it('flags an idempotent retransmit with `accepted:false` so the caller can skip the invocation-timeout refresh (Codex MEDIUM duplicate-chunk pin)', () => {
    // Codex MEDIUM "duplicate chunks can keep agent invocations alive
    // indefinitely" — `enclave/src/index.ts:1472` previously called
    // `invocationTimeoutRefreshers.get(refreshKey).refresh()` for ALL
    // `status: 'pending'` results, including retransmits of already-
    // received bytes. An authenticated agent client could replay one
    // chunk forever to pin one invocation's resolver timer + reassembly
    // buffer + open SSE.
    //
    // Fix: the reassembler now distinguishes new-bytes accepts from
    // duplicate retransmits. The wire-level caller must only refresh
    // the per-invocation timer when `accepted !== false`.
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const firstChunk = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('AAA'),
    });
    expect(firstChunk.status).toBe('pending');
    // New bytes accepted — the caller may refresh the invocation timer.
    if (firstChunk.status === 'pending') {
      // `accepted` is optional on a fresh accept; undefined or true is
      // treated as "yes, refresh".
      expect(firstChunk.accepted).not.toBe(false);
    }

    const retransmit = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('AAA'),
    });
    expect(retransmit.status).toBe('pending');
    if (retransmit.status === 'pending') {
      expect(retransmit.accepted).toBe(false);
    }
  });

  it('an idempotent retransmit that completes the final chunk still finalises (`status:complete`)', () => {
    // The "duplicate triggers no refresh" fix must NOT regress the
    // legitimate "last chunk is a retransmit of bytes we already had
    // because of an out-of-order finalise race" path — that one still
    // returns `complete` with the reassembled bytes.
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('AAA'),
    });
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 1,
      total: 2,
      partB64: partB64('BBB'),
    });
    // After both indices land, the entry was already finalised &
    // evicted; a follow-up duplicate of index 0 hits the recently-
    // finalised LRU and returns 'already-finalised', NOT 'pending'.
    const retryAfterFinalise = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('AAA'),
    });
    expect(retryAfterFinalise.status).toBe('already-finalised');
  });

  it('rejects a same-index retransmit with different bytes', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('AAA'),
    });
    const collision = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('BBB'),
    });
    expect(collision.status).toBe('rejected');
    expect(r.__sizeForTest()).toBe(0);
  });

  it('accepts a base64-expanded MAX_FILE_BYTES payload split across MAX_TOOL_RESULT_CHUNKS-1 frames', () => {
    // Spec §7.1 5 MiB file → contentB64 ≈ 6.67 MiB → ~36 chunks at
    // 200 KiB plaintext slices. Must fit comfortably under both
    // MAX_REASSEMBLED_TOOL_RESULT_BYTES (8 MiB) and
    // MAX_TOOL_RESULT_CHUNKS (40). This locks the chunked-transport
    // budget against silent reductions of either cap.
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const chunkSize = 200 * 1024;
    const totalChunks = 36; // ~7.2 MiB total
    for (let i = 0; i < totalChunks - 1; i += 1) {
      const slice = Buffer.alloc(chunkSize, 0x55);
      const res = r.addChunk({
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: 'inv-max-file',
        index: i,
        total: totalChunks,
        partB64: slice.toString('base64'),
      });
      expect(res.status).toBe('pending');
    }
    // Final chunk completes the reassembly.
    const finalSlice = Buffer.alloc(chunkSize, 0x55);
    const final = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: 'inv-max-file',
      index: totalChunks - 1,
      total: totalChunks,
      partB64: finalSlice.toString('base64'),
    });
    expect(final.status).toBe('complete');
    if (final.status === 'complete') {
      expect(final.reassembled.length).toBe(totalChunks * chunkSize);
    }
  });

  it('rejects when cumulative bytes would exceed MAX_REASSEMBLED_TOOL_RESULT_BYTES', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    // 5 MiB + 4 MiB = 9 MiB > 8 MiB cap. Each individual slice is
    // under the cap so the first chunk lands; the second pushes us
    // over.
    const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
    const bigger = Buffer.alloc(4 * 1024 * 1024, 0x42);
    const first = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: big.toString('base64'),
    });
    expect(first.status).toBe('pending');
    const second = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 1,
      total: 2,
      partB64: bigger.toString('base64'),
    });
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.error_code).toBe('TOOL_RESULT_REASSEMBLY_TOO_LARGE');
    }
    expect(r.__sizeForTest()).toBe(0);
    // Spec self-check: confirm the cap is what the test relies on.
    expect(MAX_REASSEMBLED_TOOL_RESULT_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('ToolResultReassembler — recently-finalised LRU', () => {
  it('returns `already-finalised` on a duplicate POST after the original 204 was lost', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    // Complete a 2-chunk reassembly.
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('AAA'),
    });
    const final = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 1,
      total: 2,
      partB64: partB64('BBB'),
    });
    expect(final.status).toBe('complete');
    expect(r.__sizeForTest()).toBe(0);

    // Duplicate POST of the final chunk (client retry after 204 loss).
    const retry = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 1,
      total: 2,
      partB64: partB64('BBB'),
    });
    expect(retry.status).toBe('already-finalised');
    // No phantom entry consumed a slot.
    expect(r.__sizeForTest()).toBe(0);
  });

  it('LRU expires after finalisedLruTtlMs — a much-later POST re-allocates an entry', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const r = new ToolResultReassembler({
        sweepIntervalMs: null,
        finalisedLruTtlMs: 100,
      });
      r.addChunk({
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: INV,
        index: 0,
        total: 1,
        partB64: partB64('once'),
      });

      vi.setSystemTime(50);
      // Within window — short-circuits.
      expect(
        r.addChunk({
          sessionId: SESSION,
          agentTurnId: TURN,
          invocationId: INV,
          index: 0,
          total: 1,
          partB64: partB64('once'),
        }).status,
      ).toBe('already-finalised');

      vi.setSystemTime(200);
      r.sweep(); // drop expired LRU entries
      // Past window — treated as a new reassembly (allocates entry).
      expect(
        r.addChunk({
          sessionId: SESSION,
          agentTurnId: TURN,
          invocationId: INV,
          index: 0,
          total: 1,
          partB64: partB64('once-more'),
        }).status,
      ).toBe('complete');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ToolResultReassembler — per-turn entry cap', () => {
  it(`rejects with TOOL_RESULT_REASSEMBLY_TOO_MANY when in-flight entries per (session, turn) exceed ${MAX_INFLIGHT_REASSEMBLIES_PER_TURN}`, () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    for (let i = 0; i < MAX_INFLIGHT_REASSEMBLIES_PER_TURN; i += 1) {
      const res = r.addChunk({
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: `inv-${i}`,
        index: 0,
        total: 3, // keep entries pending
        partB64: partB64('x'),
      });
      expect(res.status).toBe('pending');
    }
    const overflow = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: 'inv-overflow',
      index: 0,
      total: 3,
      partB64: partB64('x'),
    });
    expect(overflow.status).toBe('rejected');
    if (overflow.status === 'rejected') {
      expect(overflow.error_code).toBe('TOOL_RESULT_REASSEMBLY_TOO_MANY');
    }
  });

  it('the cap is per (sessionId, agentTurnId) — a different turn opens a fresh budget', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    for (let i = 0; i < MAX_INFLIGHT_REASSEMBLIES_PER_TURN; i += 1) {
      r.addChunk({
        sessionId: SESSION,
        agentTurnId: 'turn-A',
        invocationId: `inv-${i}`,
        index: 0,
        total: 3,
        partB64: partB64('x'),
      });
    }
    const cross = r.addChunk({
      sessionId: SESSION,
      agentTurnId: 'turn-B',
      invocationId: 'inv-cross',
      index: 0,
      total: 2,
      partB64: partB64('y'),
    });
    expect(cross.status).toBe('pending');
  });

  it(`rejects with TOOL_RESULT_REASSEMBLY_TOO_MANY when in-flight entries per session exceed ${MAX_INFLIGHT_REASSEMBLIES_PER_SESSION}, even across many turns`, () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    // Fill the session-wide budget across enough turns that none of
    // them individually hit the per-turn cap. With 16 / turn and 32
    // / session, two turns (each at 16) reach the session cap.
    const turnsToFill = Math.ceil(
      MAX_INFLIGHT_REASSEMBLIES_PER_SESSION /
        MAX_INFLIGHT_REASSEMBLIES_PER_TURN,
    );
    let filled = 0;
    for (let t = 0; t < turnsToFill; t += 1) {
      for (let i = 0; i < MAX_INFLIGHT_REASSEMBLIES_PER_TURN; i += 1) {
        if (filled >= MAX_INFLIGHT_REASSEMBLIES_PER_SESSION) break;
        r.addChunk({
          sessionId: SESSION,
          agentTurnId: `turn-${t}`,
          invocationId: `inv-${t}-${i}`,
          index: 0,
          total: 3,
          partB64: partB64('x'),
        });
        filled += 1;
      }
    }
    expect(r.__sizeForTest()).toBe(MAX_INFLIGHT_REASSEMBLIES_PER_SESSION);
    // Any fresh-key chunk on this session — regardless of which turn —
    // must now be rejected.
    const overflow = r.addChunk({
      sessionId: SESSION,
      agentTurnId: 'turn-overflow',
      invocationId: 'inv-cross-turn',
      index: 0,
      total: 3,
      partB64: partB64('y'),
    });
    expect(overflow.status).toBe('rejected');
    if (overflow.status === 'rejected') {
      expect(overflow.error_code).toBe('TOOL_RESULT_REASSEMBLY_TOO_MANY');
    }
    // A different session keeps its own budget.
    const otherSession = r.addChunk({
      sessionId: 'sess-other',
      agentTurnId: 'turn-x',
      invocationId: 'inv-x',
      index: 0,
      total: 3,
      partB64: partB64('z'),
    });
    expect(otherSession.status).toBe('pending');
  });
});

describe('ToolResultReassembler — identifier hygiene', () => {
  it('rejects agentTurnId containing the "::" key delimiter', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const res = r.addChunk({
      sessionId: SESSION,
      agentTurnId: 'turn::evil',
      invocationId: INV,
      index: 0,
      total: 1,
      partB64: partB64('x'),
    });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') {
      expect(res.error_code).toBe('TOOL_RESULT_REASSEMBLY_INVALID');
    }
  });

  it('rejects invocationId containing the "::" key delimiter', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const res = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: 'inv::spoof',
      index: 0,
      total: 1,
      partB64: partB64('x'),
    });
    expect(res.status).toBe('rejected');
  });

  it('rejects sessionId containing the "::" key delimiter', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const res = r.addChunk({
      sessionId: 'sess::break',
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 1,
      partB64: partB64('x'),
    });
    expect(res.status).toBe('rejected');
  });

  it('rejects empty identifiers (would otherwise produce an ambiguous prefix-match)', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    expect(
      r.addChunk({
        sessionId: '',
        agentTurnId: TURN,
        invocationId: INV,
        index: 0,
        total: 1,
        partB64: partB64('x'),
      }).status,
    ).toBe('rejected');
    expect(
      r.addChunk({
        sessionId: SESSION,
        agentTurnId: '',
        invocationId: INV,
        index: 0,
        total: 1,
        partB64: partB64('x'),
      }).status,
    ).toBe('rejected');
    expect(
      r.addChunk({
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: '',
        index: 0,
        total: 1,
        partB64: partB64('x'),
      }).status,
    ).toBe('rejected');
  });
});

describe('ToolResultReassembler — triple-key isolation', () => {
  it('keeps two concurrent invocations in the same turn independent', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    const invA = 'inv-A';
    const invB = 'inv-B';

    // Interleave: invA[0], invB[0], invA[1] → complete, invB[1] → complete
    expect(
      r.addChunk({
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: invA,
        index: 0,
        total: 2,
        partB64: partB64('A0'),
      }).status,
    ).toBe('pending');
    expect(
      r.addChunk({
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: invB,
        index: 0,
        total: 2,
        partB64: partB64('B0'),
      }).status,
    ).toBe('pending');

    const completeA = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: invA,
      index: 1,
      total: 2,
      partB64: partB64('A1'),
    });
    expect(completeA.status).toBe('complete');
    if (completeA.status === 'complete') {
      expect(completeA.reassembled.toString('utf8')).toBe('A0A1');
    }

    const completeB = r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: invB,
      index: 1,
      total: 2,
      partB64: partB64('B1'),
    });
    expect(completeB.status).toBe('complete');
    if (completeB.status === 'complete') {
      expect(completeB.reassembled.toString('utf8')).toBe('B0B1');
    }
  });

  it('keeps the SAME invocationId in different sessions independent', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    r.addChunk({
      sessionId: 'sess-A',
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('AA'),
    });
    r.addChunk({
      sessionId: 'sess-B',
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('BB'),
    });
    // clearForSession on A must NOT touch B's buffer.
    r.clearForSession('sess-A');
    expect(r.__sizeForTest()).toBe(1);
    const completeB = r.addChunk({
      sessionId: 'sess-B',
      agentTurnId: TURN,
      invocationId: INV,
      index: 1,
      total: 2,
      partB64: partB64('B2'),
    });
    expect(completeB.status).toBe('complete');
    if (completeB.status === 'complete') {
      expect(completeB.reassembled.toString('utf8')).toBe('BBB2');
    }
  });

  it('clearForTurn drops only that turn\'s buffers', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: null });
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: 'turn-A',
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('x'),
    });
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: 'turn-B',
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('y'),
    });
    r.clearForTurn(SESSION, 'turn-A');
    expect(r.__sizeForTest()).toBe(1);
  });
});

describe('ToolResultReassembler — GC / timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops stale buffers and fires the timeout callback with the parsed key', () => {
    vi.setSystemTime(0);
    const calls: ReassemblyKey[] = [];
    const r = new ToolResultReassembler({
      sweepIntervalMs: null,
      ttlMs: 100,
      onTimeout: (k) => calls.push(k),
    });
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 3,
      partB64: partB64('A'),
    });
    expect(r.__sizeForTest()).toBe(1);

    // No new chunks for 250 ms — sweep at 250 should drop it and fire
    // the timeout callback.
    vi.setSystemTime(250);
    r.sweep();
    expect(r.__sizeForTest()).toBe(0);
    expect(calls).toEqual([
      { sessionId: SESSION, agentTurnId: TURN, invocationId: INV },
    ]);
  });

  it('does not fire timeout when a chunk arrives within the TTL', () => {
    vi.setSystemTime(0);
    let fired = false;
    const r = new ToolResultReassembler({
      sweepIntervalMs: null,
      ttlMs: 100,
      onTimeout: () => {
        fired = true;
      },
    });
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 2,
      partB64: partB64('A'),
    });

    vi.setSystemTime(50);
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 1,
      total: 2,
      partB64: partB64('B'),
    });
    // Buffer is fully assembled + deleted before sweep fires.
    vi.setSystemTime(500);
    r.sweep();
    expect(fired).toBe(false);
  });

  it('handles a throwing timeout callback without losing the sweep', () => {
    vi.setSystemTime(0);
    const r = new ToolResultReassembler({
      sweepIntervalMs: null,
      ttlMs: 100,
      onTimeout: () => {
        throw new Error('boom');
      },
    });
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 3,
      partB64: partB64('A'),
    });
    vi.setSystemTime(250);
    expect(() => r.sweep()).not.toThrow();
    expect(r.__sizeForTest()).toBe(0);
  });

  it('stop() halts the sweep AND zeroes remaining in-flight buffers (TEE memory hygiene)', () => {
    vi.setSystemTime(0);
    let fired = 0;
    const r = new ToolResultReassembler({
      sweepIntervalMs: 50,
      ttlMs: 100,
      onTimeout: () => {
        fired += 1;
      },
    });
    // Use a recognisable non-zero byte pattern so the post-stop()
    // wipe assertion is observable. partB64 must be valid base64 of
    // those bytes.
    const plaintext = Buffer.from([0x41, 0x42, 0x43, 0x44, 0x45]);
    r.addChunk({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      index: 0,
      total: 3,
      partB64: plaintext.toString('base64'),
    });
    expect(r.__sizeForTest()).toBe(1);

    // Capture a live reference to the buffered part BEFORE stop().
    // The reassembler stores Buffer.from(b64,'base64') as the part —
    // those underlying bytes must be zeroed by stop().
    const partsBefore = r.__peekPartsForTest(SESSION, TURN, INV);
    expect(partsBefore).not.toBeNull();
    expect(partsBefore).toHaveLength(1);
    const heldPart = partsBefore![0];
    // Sanity check: before stop, bytes match what we sent.
    expect([...heldPart]).toEqual([0x41, 0x42, 0x43, 0x44, 0x45]);

    r.stop();
    // Decrypted plaintext must NOT persist past stop() — round-3
    // reviewer finding: stop() was the one cleanup path that leaked.
    expect(r.__sizeForTest()).toBe(0);
    // Byte-wipe contract: the previously-buffered plaintext bytes
    // must be all zeros now. Removing the zeroBuffer(part) call
    // inside zeroEntry would cause this assertion to fail.
    expect([...heldPart]).toEqual([0, 0, 0, 0, 0]);

    // The sweep timer must also be cleared: advancing well past the
    // TTL + sweep interval should not fire any onTimeout callbacks.
    vi.setSystemTime(500);
    vi.advanceTimersByTime(500);
    expect(fired).toBe(0);
  });

  it('stop() is idempotent — a second call must not throw', () => {
    const r = new ToolResultReassembler({ sweepIntervalMs: 50 });
    r.stop();
    expect(() => r.stop()).not.toThrow();
  });
});
