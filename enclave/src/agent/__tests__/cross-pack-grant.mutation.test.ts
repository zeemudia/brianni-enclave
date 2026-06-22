import { describe, expect, it } from 'vitest';

import {
  computeGrantCommitment,
  type CrossPackGrantBody,
} from '@calypso/chat-types';

import {
  resolveCrossPackGrant,
  type ResolvedCrossPackGrant,
} from '../cross-pack-grant';

// Mutation-hardening supplement for the cross-pack grant authoriser. The
// existing cross-pack-grant.test.ts covers commitment/expiry/caps; this file
// pins the SHORT-CIRCUIT guards (no-envelope, non-claims pack) as observable,
// the expiry boundary (strict >=), and the crossPackNamespaces fallback arm.

function assertOk(
  r: ResolvedCrossPackGrant,
): asserts r is Extract<ResolvedCrossPackGrant, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got reject: ${r.reason}`);
}

const CLAIMS = {
  id: 'personal-agent.claims',
  defaultNamespace: 'default',
  crossPackNamespaces: ['default', 'work', 'money', 'health'],
} as const;

const CLAIMS_NO_CROSS = {
  id: 'personal-agent.claims',
  defaultNamespace: 'work',
} as const;

const body: CrossPackGrantBody = {
  namespaces: ['money', 'health'],
  folderIds: ['f1'],
  documentIds: [],
  nonce: 'nonce-abcd',
};

function envelopeAt(expiresAt: number, over: Record<string, unknown> = {}) {
  return {
    grantId: 'g1',
    commit: computeGrantCommitment(body, { mode: 'jit', expiresAt }),
    healthVerified: true,
    mode: 'jit' as const,
    expiresAt,
    ...over,
  };
}

describe('resolveCrossPackGrant — guard short-circuits as observable behaviour', () => {
  it('a present envelope WIDENS scope on a claims pack (so the no-envelope guard is observable)', () => {
    // With the real `if (!input.envelope) return single()` an envelope must
    // produce the widened set; mutating the guard to `if (false)` would still
    // widen here, but the contrasting no-envelope case below collapses to a
    // single namespace — together they pin the guard.
    const future = Date.now() + 60_000;
    const r = resolveCrossPackGrant({
      pack: CLAIMS,
      envelope: envelopeAt(future),
      body,
      now: Date.now(),
    });
    assertOk(r);
    expect(new Set(r.namespaces)).toEqual(new Set(['money', 'health']));
  });

  it('an undefined envelope COLLAPSES to the single default namespace', () => {
    const r = resolveCrossPackGrant({
      pack: CLAIMS,
      envelope: undefined,
      body,
      now: Date.now(),
    });
    assertOk(r);
    expect([...r.namespaces]).toEqual(['default']);
    expect(r.folderIds.size).toBe(0);
    expect(r.documentIds.size).toBe(0);
  });

  it('purpose binding: a NON-claims pack collapses even with a valid envelope', () => {
    // Kills `if (input.pack.id !== CLAIMS_PACK_ID) return single()` → `false`.
    const future = Date.now() + 60_000;
    const r = resolveCrossPackGrant({
      pack: { id: 'personal-agent.career', defaultNamespace: 'work' },
      envelope: envelopeAt(future),
      body,
      now: Date.now(),
    });
    assertOk(r);
    expect([...r.namespaces]).toEqual(['work']); // grant inert off-claims
    expect(r.folderIds.size).toBe(0);
  });

  it('purpose binding: a non-claims pack that DOES list crossPackNamespaces still collapses (no widening)', () => {
    // Hardens `@52`: a non-claims pack that could otherwise widen (it lists
    // crossPackNamespaces that intersect the grant) MUST stay single because the
    // grant is purpose-bound to the claims pack. The previous test used a pack
    // whose empty crossPackNamespaces masked the guard; this one would widen to
    // ['money'] if the purpose-binding guard were dropped.
    const future = Date.now() + 60_000;
    const moneyBody: CrossPackGrantBody = {
      namespaces: ['money'],
      folderIds: ['f1'],
      documentIds: [],
      nonce: 'nonce-money',
    };
    const r = resolveCrossPackGrant({
      pack: {
        id: 'personal-agent.career',
        defaultNamespace: 'work',
        crossPackNamespaces: ['work', 'money'],
      },
      envelope: {
        grantId: 'gm',
        commit: computeGrantCommitment(moneyBody, {
          mode: 'jit',
          expiresAt: future,
        }),
        healthVerified: true,
        mode: 'jit' as const,
        expiresAt: future,
      },
      body: moneyBody,
      now: Date.now(),
    });
    assertOk(r);
    expect([...r.namespaces]).toEqual(['work']); // collapsed, NOT widened to money
    expect(r.folderIds.size).toBe(0); // no folder access from an inert grant
  });

  it('expiry is STRICT: exactly-at-expiry is rejected, one ms before is accepted', () => {
    // Kills `now >= expiresAt` → `now > expiresAt`. At now === expiresAt the
    // real code rejects (>=); a `>` mutant would accept the expired grant.
    const now = 1_000_000;
    const atExpiry = resolveCrossPackGrant({
      pack: CLAIMS,
      envelope: envelopeAt(now),
      body,
      now,
    });
    expect(atExpiry.ok).toBe(false);
    if (atExpiry.ok) throw new Error('unreachable');
    expect(atExpiry.reason).toBe('GRANT_EXPIRED');

    const oneMsBefore = resolveCrossPackGrant({
      pack: CLAIMS,
      envelope: envelopeAt(now + 1),
      body,
      now,
    });
    expect(oneMsBefore.ok).toBe(true);
  });

  it('falls back to [defaultNamespace] when the claims pack has no crossPackNamespaces', () => {
    // Covers the `crossPackNamespaces ?? [input.pack.defaultNamespace]` arm
    // (previously NoCoverage). The body asks for money/health; with no
    // crossPackNamespaces the allowed set is just [defaultNamespace='work'], so
    // both requested namespaces are filtered out → collapse to single default.
    const future = Date.now() + 60_000;
    const r = resolveCrossPackGrant({
      pack: CLAIMS_NO_CROSS,
      envelope: envelopeAt(future),
      body,
      now: Date.now(),
    });
    assertOk(r);
    expect([...r.namespaces]).toEqual(['work']);
  });

  it('allows a requested namespace that DOES sit in the no-cross fallback default (and widens folderIds)', () => {
    // Pins `crossPackNamespaces ?? [input.pack.defaultNamespace]` (kills
    // `?? []`): the body requests the pack's own defaultNamespace WITH a folder.
    // With the real `[defaultNamespace]` fallback the namespace is admitted and
    // the grant WIDENS (folderIds populated). A `?? []` mutant would filter the
    // namespace out → collapse to single() → folderIds EMPTY. The folderId
    // assertion is the discriminator.
    const future = Date.now() + 60_000;
    const workBody: CrossPackGrantBody = {
      namespaces: ['work'],
      folderIds: ['fw1'],
      documentIds: [],
      nonce: 'nonce-work',
    };
    const r = resolveCrossPackGrant({
      pack: CLAIMS_NO_CROSS,
      envelope: {
        grantId: 'gw',
        commit: computeGrantCommitment(workBody, {
          mode: 'jit',
          expiresAt: future,
        }),
        healthVerified: true,
        mode: 'jit' as const,
        expiresAt: future,
      },
      body: workBody,
      now: Date.now(),
    });
    assertOk(r);
    expect([...r.namespaces]).toEqual(['work']);
    expect([...r.folderIds]).toEqual(['fw1']); // widened, not collapsed
  });
});
