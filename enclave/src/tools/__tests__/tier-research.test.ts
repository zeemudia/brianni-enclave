/**
 * Tests for the `research.ask` tool handler (Task 2C.1).
 *
 * Each test builds a real ToolGateway with a stub ClientBridge and dispatches
 * a `research.ask` frame, verifying the three-layer outbound-question control:
 *
 *   Layer 1 — Schema reject (RESEARCH_QUERY_INVALID)
 *   Layer 2 — Egress-taint backstop (RESEARCH_QUESTION_TAINTED)
 *   Layer 3 — User-approval round-trip (RESEARCH_QUERY_DECLINED)
 *   Happy path / RESEARCH_UNAVAILABLE
 */

import { describe, it, expect, vi } from 'vitest';

import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  SkillPack,
  ToolInvocationFrame,
  ToolResultFrame,
} from '@calypso/chat-types';

import {
  ToolGateway,
  type ClientBridge,
  type ToolGatewayDeps,
} from '../index';

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** Minimal ClientBridge stub — no real bridge calls needed for most tests. */
function makeClientBridge(
  overrides: Partial<ClientBridge> = {},
): ClientBridge {
  return {
    invokeClient: vi.fn().mockResolvedValue({
      invocationId: 'x',
      outcome: 'ok',
      resultJson: {},
    } as ToolResultFrame),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ToolGatewayDeps> = {}): ToolGatewayDeps {
  return {
    clientBridge: makeClientBridge(),
    userId: 'user-test-001',
    sessionId: 'session-test-001',
    ...overrides,
  };
}

/** The claims agent skill pack — includes research.ask in toolScopes. */
const claimsPack: SkillPack = {
  id: 'personal-agent.claims',
  version: 1,
  displayName: 'Claims Advocate',
  description: 'Cross-pack claims advocate.',
  systemPromptBlock: 'You are Calypso Claims Advocate.',
  toolScopes: [
    'research.ask',
    'memory.list',
    'memory.read',
    'folder.list',
    'folder.read',
    'file.read',
  ],
  // crossPackNamespaces drives the F3 policy web.fetch guard — any pack that
  // declares this field is a cross-pack pack and is forbidden raw web.fetch.
  crossPackNamespaces: ['money', 'health'],
  capabilitySuiteIds: ['text'],
  defaultNamespace: 'default',
  linkedFolderScopes: {},
  uiHints: { icon: 'default', accentToken: 'accent-default' },
};

/** Build a minimal research.ask ToolInvocationFrame. */
function makeFrame(args: Record<string, unknown>): ToolInvocationFrame {
  return {
    invocationId: `inv-${Math.random().toString(36).slice(2)}`,
    agentTurnId: 'turn-test-001',
    toolName: 'research.ask',
    args,
  };
}

const TURN_ID = 'turn-test-001';

// ─── fake ChatProcessor for happy-path test ────────────────────────────────────

/**
 * Build a multi-invocation fake ChatProcessor.
 * Each element of `scripts` is the token stream for one provider call.
 */
function mkProvider(scripts: string[][]): ChatProcessor {
  let invocation = 0;
  return {
    async *streamChat(_messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const tokens = scripts[invocation] ?? [];
      invocation += 1;
      for (let i = 0; i < tokens.length; i++) {
        const isLast = i === tokens.length - 1;
        yield {
          id: `chunk_${invocation}_${i}`,
          choices: [
            {
              delta: { content: tokens[i] },
              finish_reason: isLast ? 'stop' : null,
            },
          ],
        };
      }
    },
  };
}

// ─── tests ─────────────────────────────────────────────────────────────────────

describe('research.ask — Layer 1: schema reject', () => {
  it('rejects a frame with an unknown key (strict schema)', async () => {
    const gw = new ToolGateway(makeDeps());
    const frame = makeFrame({
      question: 'x',
      memberId: '48213', // not in ResearchQuerySchema → strict() rejects it
    });
    const res = await gw.dispatch(frame, claimsPack, TURN_ID);

    expect(res.outcome).toBe('gateway_rejected');
    expect(res.reason).toBe('RESEARCH_QUERY_INVALID');
  });

  it('rejects a frame missing the required question field', async () => {
    const gw = new ToolGateway(makeDeps());
    const frame = makeFrame({ insurer: 'Aetna' }); // question is required
    const res = await gw.dispatch(frame, claimsPack, TURN_ID);

    expect(res.outcome).toBe('gateway_rejected');
    expect(res.reason).toBe('RESEARCH_QUERY_INVALID');
  });
});

describe('research.ask — Layer 2: egress-taint backstop', () => {
  it('rejects a query whose compiled string reproduces harvested private content', async () => {
    const gw = new ToolGateway(makeDeps());

    // Simulate what happened during the parent agent's private-doc reads:
    // the egress-taint ledger harvested the policy record text.
    // 'policy AB-99812-Z member Jane Doe' normalises to
    // 'policyab99812zmemberjanedoe' (27 chars), producing grams like
    // 'policyab99812zmember' (20 chars) that the compiled query must reproduce.
    // Uses the __egressTaintForTest() accessor (rename-safe test seam).
    const ej = gw.__egressTaintForTest();
    ej.addText('policy AB-99812-Z member Jane Doe');
    ej.markPrivateReadObserved();

    // The compiled query for { question: "deadline for policy AB-99812-Z member Jane" }
    // normalises to 'deadlineforpolicyab99812zmemberjane' which contains the
    // gram 'policyab99812zmember' harvested above → tainted.
    const frame = makeFrame({
      question: 'deadline for policy AB-99812-Z member Jane',
    });
    const res = await gw.dispatch(frame, claimsPack, TURN_ID);

    expect(res.outcome).toBe('gateway_rejected');
    expect(res.reason).toBe('RESEARCH_QUESTION_TAINTED');
  });
});

describe('research.ask — Layer 3: user-approval round-trip', () => {
  it('rejects when approveQuery returns false', async () => {
    const bridge = makeClientBridge({
      approveQuery: vi.fn().mockResolvedValue(false),
    });
    const gw = new ToolGateway(makeDeps({ clientBridge: bridge }));

    const frame = makeFrame({
      insurer: 'Aetna',
      question: 'out-of-network ER appeal deadline 2026',
    });
    const res = await gw.dispatch(frame, claimsPack, TURN_ID);

    // C1: user explicitly declining → denied_by_user (not gateway_rejected)
    // so the ledger/audit distinguishes "user declined" from "policy blocked".
    expect(res.outcome).toBe('denied_by_user');
    expect(res.reason).toBe('RESEARCH_QUERY_DECLINED');
    expect(res.ledgerEntry.outcome).toBe('denied_by_user');
    expect(bridge.approveQuery).toHaveBeenCalledOnce();
  });

  it('rejects (fail-closed) when approveQuery is absent', async () => {
    // ClientBridge without approveQuery — the optional method is undefined.
    // Fail-closed: no approval channel → denied_by_user (the user implicitly
    // declined by having no approval channel configured).
    const bridge: ClientBridge = {
      invokeClient: vi.fn().mockResolvedValue({
        invocationId: 'x',
        outcome: 'ok',
        resultJson: {},
      } as ToolResultFrame),
      // approveQuery deliberately omitted
    };
    const gw = new ToolGateway(makeDeps({ clientBridge: bridge }));

    const frame = makeFrame({
      question: 'out-of-network ER appeal deadline 2026',
    });
    const res = await gw.dispatch(frame, claimsPack, TURN_ID);

    expect(res.outcome).toBe('denied_by_user');
    expect(res.reason).toBe('RESEARCH_QUERY_DECLINED');
    expect(res.ledgerEntry.outcome).toBe('denied_by_user');
  });
});

describe('research.ask — RESEARCH_UNAVAILABLE', () => {
  it('rejects when researchProviderFactory is absent (even with approval)', async () => {
    const bridge = makeClientBridge({
      approveQuery: vi.fn().mockResolvedValue(true),
    });
    const gw = new ToolGateway(
      makeDeps({
        clientBridge: bridge,
        researchProviderFactory: undefined, // explicitly absent
      }),
    );

    const frame = makeFrame({
      insurer: 'Aetna',
      question: 'out-of-network ER appeal deadline 2026',
    });
    const res = await gw.dispatch(frame, claimsPack, TURN_ID);

    expect(res.outcome).toBe('gateway_rejected');
    expect(res.reason).toBe('RESEARCH_UNAVAILABLE');
  });
});

// ─── Task 2C.2: explicit claims-pack web.fetch guard ─────────────────────────
//
// The claims pack never has web.fetch in its toolScopes (Task 2A.2), so an
// isToolInScope check would already return OUT_OF_SCOPE. Task 2C.2 adds a
// MORE-SPECIFIC backstop placed BEFORE that check so the reason string is
// unambiguous: WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK, not the generic OUT_OF_SCOPE.
// This test proves the specific guard fires (not the fallback), and that the
// bridge is never invoked.

describe('claims pack — explicit web.fetch guard (Task 2C.2)', () => {
  it('rejects web.fetch with WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK (not OUT_OF_SCOPE) for the claims pack', async () => {
    const bridge = makeClientBridge();
    // Use a claims-pack fixture with crossPackNamespaces set (matching the real
    // claims pack), to confirm the policy guard fires BEFORE the generic
    // OUT_OF_SCOPE check. The pack deliberately has no 'web.fetch' in toolScopes.
    const claimsPackFixture: SkillPack = {
      ...claimsPack,
      id: 'personal-agent.claims',
      crossPackNamespaces: ['money', 'health'],
      toolScopes: [
        'research.ask',
        'memory.list',
        'memory.read',
        'folder.list',
        'folder.read',
        'file.read',
        // deliberately no 'web.fetch' — same as real claims pack
      ],
    };

    const gw = new ToolGateway(makeDeps({ clientBridge: bridge }));

    const webFetchFrame: ToolInvocationFrame = {
      invocationId: 'inv-claims-webfetch-001',
      agentTurnId: TURN_ID,
      toolName: 'web.fetch',
      args: { url: 'https://example.com/plans', query: 'deductible' },
    };

    const res = await gw.dispatch(webFetchFrame, claimsPackFixture, TURN_ID);

    // Must be gateway_rejected with the specific claims reason, NOT OUT_OF_SCOPE.
    expect(res.outcome).toBe('gateway_rejected');
    expect(res.reason).toBe('WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK');
    expect(res.reason).not.toBe('OUT_OF_SCOPE');

    // The bridge must never be invoked (no actual fetch happened).
    expect(bridge.invokeClient).not.toHaveBeenCalled();
  });
});

describe('research.ask — happy path', () => {
  it('returns UNTRUSTED_RESEARCH_RESULT with answer and sources', async () => {
    // Provider: round 1 emits a web.fetch for a public URL; round 2 emits
    // the answer prose after the tool result is reinjected.
    const fetchUrl = 'https://example.gov/aetna-er-appeal-2026';
    const webFetchTool = JSON.stringify({
      invocationId: 'inv-fetch-1',
      toolName: 'web.fetch',
      args: { url: fetchUrl, query: 'ER appeal deadline' },
    });

    const fakeProvider = mkProvider([
      [`<tool>${webFetchTool}</tool>`],
      ['Aetna out-of-network ER appeals must be filed within 180 days.'],
    ]);

    // The bridge handles web.fetch calls from the research subagent.
    const bridge = makeClientBridge({
      approveQuery: vi.fn().mockResolvedValue(true),
      invokeClient: vi.fn().mockImplementation(async (f: ToolInvocationFrame) => ({
        invocationId: f.invocationId,
        outcome: 'ok',
        resultJson: {
          status: 200,
          bodyText:
            'Aetna PPO: ER out-of-network claims may be appealed within 180 days of denial.',
        },
      })),
    });

    const gw = new ToolGateway(
      makeDeps({
        clientBridge: bridge,
        researchProviderFactory: () => fakeProvider,
      }),
    );

    const frame = makeFrame({
      insurer: 'Aetna',
      question: 'out-of-network ER appeal deadline 2026',
    });
    const res = await gw.dispatch(frame, claimsPack, TURN_ID);

    expect(res.outcome).toBe('ok');

    // The resultJson must be an UNTRUSTED_RESEARCH_RESULT wrapper.
    const rj = res.resultJson as {
      kind: string;
      note: string;
      answer: string;
      sources: string[];
    };
    expect(JSON.stringify(rj)).toContain('UNTRUSTED_RESEARCH_RESULT');
    expect(rj.kind).toBe('UNTRUSTED_RESEARCH_RESULT');
    expect(typeof rj.note).toBe('string');
    expect(rj.note.length).toBeGreaterThan(0);

    // answer must be present (the model's prose from the second round).
    expect(typeof rj.answer).toBe('string');
    expect(rj.answer.length).toBeGreaterThan(0);

    // sources must be present (array — may be empty if provider didn't emit URL events).
    expect(Array.isArray(rj.sources)).toBe(true);
  });
});
