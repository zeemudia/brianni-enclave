import { describe, expect, it } from 'vitest';

import type { ToolCallLedgerEntry, ToolResultFrame } from '@calypso/chat-types';

import {
  sanitiseBridgeReason,
  sanitiseBridgeResultForDispatch,
} from '../bridge-result-sanitiser';

// Mutation-hardening for the bridge result sanitiser. The bridge carries a
// CLIENT-fulfilled tool result back into the enclave; a hostile or buggy client
// reason string must never reach the model or the ledger verbatim. The mapping
// is the trust boundary: unknown/missing outcome must fail CLOSED to a controlled
// 'error', a timeout must be recognised, and the reason must be length-capped.

const baseLedger: Omit<
  ToolCallLedgerEntry,
  'id' | 'outcome' | 'reason' | 'scope' | 'approvedPath'
> = {
  invokedAt: '2026-05-13T00:00:00.000Z',
  toolName: 'folder.write',
  skillPackId: 'personal-agent.career',
  turnId: 'turn1',
};

describe('sanitiseBridgeReason', () => {
  it('returns undefined for an ok outcome (no reason for success)', () => {
    expect(sanitiseBridgeReason({ outcome: 'ok' })).toBeUndefined();
  });

  it('maps denied_by_user → BRIDGE_DENIED', () => {
    expect(sanitiseBridgeReason({ outcome: 'denied_by_user' })).toBe(
      'BRIDGE_DENIED',
    );
  });

  it('maps gateway_rejected → BRIDGE_REJECTED', () => {
    expect(sanitiseBridgeReason({ outcome: 'gateway_rejected' })).toBe(
      'BRIDGE_REJECTED',
    );
  });

  it('maps a bare error → BRIDGE_ERROR', () => {
    expect(sanitiseBridgeReason({ outcome: 'error', reason: 'stack trace' })).toBe(
      'BRIDGE_ERROR',
    );
  });

  it('maps an UNKNOWN outcome → BRIDGE_ERROR (fail closed, not passthrough)', () => {
    expect(sanitiseBridgeReason({ outcome: 'WUT' })).toBe('BRIDGE_ERROR');
    expect(sanitiseBridgeReason({ outcome: undefined })).toBe('BRIDGE_ERROR');
    expect(sanitiseBridgeReason({ outcome: 42 })).toBe('BRIDGE_ERROR');
  });

  it('recognises a TIMEOUT only on an error outcome with a timeout-shaped reason', () => {
    // Kills `result.outcome === 'error'` flip + the timeout regex + the
    // BRIDGE_TIMEOUT literal: each of "timeout"/"timed out"/"aborted" maps to
    // BRIDGE_TIMEOUT, but ONLY when the outcome is 'error'.
    expect(
      sanitiseBridgeReason({ outcome: 'error', reason: 'request timeout after 30s' }),
    ).toBe('BRIDGE_TIMEOUT');
    expect(
      sanitiseBridgeReason({ outcome: 'error', reason: 'the call timed out' }),
    ).toBe('BRIDGE_TIMEOUT');
    expect(
      sanitiseBridgeReason({ outcome: 'error', reason: 'operation aborted' }),
    ).toBe('BRIDGE_TIMEOUT');
  });

  it('does NOT treat a timeout-shaped reason as a timeout when the outcome is gateway_rejected', () => {
    // The `outcome === 'error' && RE.test(...)` AND-guard: a gateway_rejected
    // result whose reason mentions "timeout" must still map to BRIDGE_REJECTED,
    // not BRIDGE_TIMEOUT. Kills `&&`→`||` on line 34.
    expect(
      sanitiseBridgeReason({
        outcome: 'gateway_rejected',
        reason: 'timeout in the upstream policy',
      }),
    ).toBe('BRIDGE_REJECTED');
  });

  it('requires a WORD-boundary timeout token (substring inside a word is not a timeout)', () => {
    // BRIDGE_TIMEOUT_RE uses \b...\b — "timeouts-disabled" or "abortedly" must
    // NOT match, so a non-timeout error stays BRIDGE_ERROR.
    expect(
      sanitiseBridgeReason({ outcome: 'error', reason: 'notimeoutshere' }),
    ).toBe('BRIDGE_ERROR');
  });

  it('treats a missing error reason as a non-timeout (?? "" default)', () => {
    // `result.reason ?? ''` — when reason is undefined the regex tests '' and
    // must not match, so a reason-less error is BRIDGE_ERROR not BRIDGE_TIMEOUT.
    expect(sanitiseBridgeReason({ outcome: 'error' })).toBe('BRIDGE_ERROR');
  });

  it('truncates the reason to at most 64 characters', () => {
    // All mapped reasons are short constants, but the slice cap is load-bearing
    // for forward-compat — assert no mapped reason exceeds the cap, and that the
    // cap is actually applied (length stays bounded).
    for (const outcome of ['denied_by_user', 'gateway_rejected', 'error'] as const) {
      const r = sanitiseBridgeReason({ outcome });
      expect(r).toBeDefined();
      expect((r as string).length).toBeLessThanOrEqual(64);
    }
  });
});

describe('sanitiseBridgeResultForDispatch', () => {
  it('passes through an ok result and attaches resultJson when provided', () => {
    const r = sanitiseBridgeResultForDispatch(
      { invocationId: 'inv-ok', outcome: 'ok' } as unknown as ToolResultFrame,
      baseLedger,
      'folder/Career',
      '/abs/career',
      { wrote: true },
    );
    expect(r.outcome).toBe('ok');
    expect(r.invocationId).toBe('inv-ok');
    expect((r as { resultJson?: unknown }).resultJson).toEqual({ wrote: true });
    expect(r.ledgerEntry.outcome).toBe('ok');
    expect(r.ledgerEntry.reason).toBeNull();
    expect(r.ledgerEntry.scope).toBe('folder/Career');
    expect(r.ledgerEntry.approvedPath).toBe('/abs/career');
  });

  it('OMITS resultJson for an ok result when okResultJson is undefined', () => {
    // Kills `okResultJson === undefined ? {} : { resultJson }` flip — an
    // undefined result must NOT add a `resultJson: undefined` key.
    const r = sanitiseBridgeResultForDispatch(
      { invocationId: 'inv-ok2', outcome: 'ok' } as unknown as ToolResultFrame,
      baseLedger,
      'folder/Career',
      null,
    );
    expect(r.outcome).toBe('ok');
    expect('resultJson' in r).toBe(false);
  });

  it('maps a denied_by_user bridge result to a controlled denial', () => {
    const r = sanitiseBridgeResultForDispatch(
      {
        invocationId: 'inv-d',
        outcome: 'denied_by_user',
        reason: 'user said no with PII: jane@example.com',
      } as unknown as ToolResultFrame,
      baseLedger,
      'folder/Career',
      null,
    );
    expect(r.outcome).toBe('denied_by_user');
    expect(r.reason).toBe('BRIDGE_DENIED');
    expect(r.ledgerEntry.outcome).toBe('denied_by_user');
    expect(r.ledgerEntry.reason).toBe('BRIDGE_DENIED');
    // The hostile/PII reason from the client never reaches the dispatch reason.
    expect(r.reason).not.toContain('example.com');
  });

  it('maps a gateway_rejected bridge result to BRIDGE_REJECTED', () => {
    const r = sanitiseBridgeResultForDispatch(
      {
        invocationId: 'inv-g',
        outcome: 'gateway_rejected',
        reason: 'OUT_OF_SCOPE internal detail',
      } as unknown as ToolResultFrame,
      baseLedger,
      'folder/Career',
      null,
    );
    expect(r.outcome).toBe('gateway_rejected');
    expect(r.reason).toBe('BRIDGE_REJECTED');
    expect(r.ledgerEntry.reason).toBe('BRIDGE_REJECTED');
  });

  it('maps an error+timeout bridge result to BRIDGE_TIMEOUT', () => {
    const r = sanitiseBridgeResultForDispatch(
      {
        invocationId: 'inv-t',
        outcome: 'error',
        reason: 'fetch timed out after 30000ms',
      } as unknown as ToolResultFrame,
      baseLedger,
      'folder/Career',
      null,
    );
    expect(r.outcome).toBe('error');
    expect(r.reason).toBe('BRIDGE_TIMEOUT');
    expect(r.ledgerEntry.reason).toBe('BRIDGE_TIMEOUT');
  });

  it('carries the invocationId through unchanged on the non-ok path', () => {
    const r = sanitiseBridgeResultForDispatch(
      { invocationId: 'inv-keep', outcome: 'error' } as unknown as ToolResultFrame,
      baseLedger,
      'folder/Career',
      null,
    );
    expect(r.invocationId).toBe('inv-keep');
    // Non-ok path preserves the base ledger fields too.
    expect(r.ledgerEntry.toolName).toBe('folder.write');
    expect(r.ledgerEntry.turnId).toBe('turn1');
  });
});
