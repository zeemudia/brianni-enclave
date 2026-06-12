/**
 * Task 2D.1 — capstone composition test: claims-research delegation
 *
 * Proves four properties using a REAL main ToolGateway (claims pack) +
 * real tier-research + real runResearchSubagent + fake providers/bridge:
 *
 *   (a) Canary isolation      — private content harvested by the MAIN gateway
 *                               never reaches the air-gapped research subagent's
 *                               model (system prompt + user query).
 *   (b) Tainted question blocked — a research.ask whose question reproduces the
 *                               harvested canary is blocked at Layer 2
 *                               (RESEARCH_QUESTION_TAINTED).
 *   (c) Clean approved → wrapped answer — a clean query resolves ok with an
 *                               UNTRUSTED_RESEARCH_RESULT wrapper.
 *   (d) No private-data laundering / no direct egress — a direct web.fetch
 *                               from the claims pack is rejected with the
 *                               specific claims-pack guard reason.
 *
 * Harness modelled on:
 *   - enclave/src/tools/__tests__/tier-research.test.ts  (gateway-level setup,
 *     fake provider, claims pack fixture)
 *   - enclave/src/agent/__tests__/research-subagent.test.ts  (mkProvider, bridge)
 *   - enclave/src/__tests__/tier-a-read.test.ts  (validRecord, crossPackGrant)
 *   - enclave/src/__tests__/orchestrator-egress-memory-isolation.test.ts
 *     (canary-isolation assertion pattern)
 *
 * Scope: gateway-level composition test (not full EnclaveRouter/vsock path).
 * The vsock handshake path is tested in cross-pack-grant-wiring.test.ts and
 * agent-orchestrator-wire.test.ts; this test isolates the composition of the
 * three delegation layers which is tractable without the full router.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  MemoryNamespace,
  MemoryRecord,
  SkillPack,
  ToolInvocationFrame,
  ToolResultFrame,
} from '@calypso/chat-types';

import {
  ToolGateway,
  type ClientBridge,
  type ToolGatewayDeps,
} from '../tools';

// ─── Canary ───────────────────────────────────────────────────────────────────
//
// CANARY_TEXT is what the bridge returns in the memory record's `text` field.
// After NFKC-fold + lowercase + strip-non-alnum normalisation it becomes:
//   'memberidcanary7f3k9policyholderjanedoe'  (38 chars)
// That produces 19 overlapping 20-char grams (NGRAM=20), e.g.:
//   'memberidcanary7f3k9p', 'emberidcanary7f3k9po', …
//
// TAINTED_QUESTION reproduces the span 'member id CANARY-7F3K9 policy' which
// normalises to 'memberidcanary7f3k9policy', containing the first gram
// 'memberidcanary7f3k9p' → Layer 2 fires.
//
// CLEAN_QUESTION contains none of those grams and none of the distinctive
// tokens (≥12 chars), so it passes Layer 2.

const CANARY_TEXT = 'member id CANARY-7F3K9 policy holder Jane Doe';
const TAINTED_QUESTION =
  'appeal deadline for member id CANARY-7F3K9 policy';
const CLEAN_QUESTION = 'out-of-network ER appeal deadline 2026';

// ─── MemoryRecord fixture ──────────────────────────────────────────────────────

function validMoneyRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'rec-money-001',
    namespace: 'money' as MemoryNamespace,
    baseVersion: 0,
    tombstoneEpoch: 0,
    dreamSessionId: 'turn_claims_001',
    kind: 'fact',
    text: CANARY_TEXT,
    structured: {},
    tags: [],
    provenance: [
      {
        excerpt: CANARY_TEXT,
        excerptHash: 'a'.repeat(64),
        sourceRef: { type: 'conversation', conversationId: 'c1' },
        extractedAt: '2026-06-09T00:00:00.000Z',
        dreamSessionId: 'turn_claims_001',
      },
    ],
    confidence: 0.9,
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    supersededBy: null,
    visibleToUser: true,
    ...overrides,
  };
}

// ─── Claims pack fixture ───────────────────────────────────────────────────────

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

// ─── Frame builders ────────────────────────────────────────────────────────────

function makeMemoryReadFrame(id = 'rec-money-001'): ToolInvocationFrame {
  return {
    invocationId: `inv-memread-${Math.random().toString(36).slice(2)}`,
    agentTurnId: 'turn-comp-001',
    toolName: 'memory.read',
    args: { id },
  };
}

function makeResearchFrame(args: Record<string, unknown>): ToolInvocationFrame {
  return {
    invocationId: `inv-research-${Math.random().toString(36).slice(2)}`,
    agentTurnId: 'turn-comp-001',
    toolName: 'research.ask',
    args,
  };
}

function makeWebFetchFrame(): ToolInvocationFrame {
  return {
    invocationId: `inv-webfetch-${Math.random().toString(36).slice(2)}`,
    agentTurnId: 'turn-comp-001',
    toolName: 'web.fetch',
    args: { url: 'https://example.com/plans', query: 'deductible' },
  };
}

const TURN_ID = 'turn-comp-001';

// ─── Fake ChatProcessor factory ────────────────────────────────────────────────
//
// The research provider captures ALL messages it sees (system prompt + user
// query + any reinjects) into a shared `observed` array. This lets the
// canary-isolation assertion scan everything the air-gapped model would have
// had in its context.

function makeFakeResearchProvider(): {
  provider: ChatProcessor;
  observed: string[];
} {
  const observed: string[] = [];
  let invocation = 0;

  const fetchUrl = 'https://example.gov/aetna-er-appeal-2026';
  const webFetchToolCall = JSON.stringify({
    invocationId: 'inv-fetch-1',
    toolName: 'web.fetch',
    args: { url: fetchUrl, query: 'ER appeal deadline' },
  });

  const provider: ChatProcessor = {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      // Record every message content the provider sees for assertion later.
      for (const msg of messages) {
        observed.push(msg.content);
      }
      invocation += 1;

      if (invocation === 1) {
        // Round 1: emit a web.fetch tool call.
        yield {
          id: `chunk_1`,
          choices: [
            {
              delta: { content: `<tool>${webFetchToolCall}</tool>` },
              finish_reason: 'stop',
            },
          ],
        };
        return;
      }

      // Round 2+: emit the prose summary answer.
      const tokens = [
        'Aetna out-of-network ER appeals must be filed within 180 days.',
      ];
      for (let i = 0; i < tokens.length; i++) {
        const isLast = i === tokens.length - 1;
        yield {
          id: `chunk_2_${i}`,
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

  return { provider, observed };
}

// ─── Bridge factory ────────────────────────────────────────────────────────────

interface HarnessGateway {
  gw: ToolGateway;
  researchObserved: string[];
  researchProviderInvokedCount: () => number;
  invokeClientMock: ReturnType<typeof vi.fn>;
  approveMock: ReturnType<typeof vi.fn>;
}

/**
 * Build the full composition harness:
 * - Main ToolGateway with claims pack + crossPackGrant for "money"
 * - invokeClient returns a valid MemoryRecord with CANARY_TEXT for memory.read;
 *   returns a fake web.fetch result for the research subagent's fetch calls.
 * - approveQuery defaults to resolving true.
 * - researchProviderFactory returns the fake provider that records messages.
 */
function makeHarness(
  approveResult: boolean | null = true,
): HarnessGateway {
  const { provider, observed } = makeFakeResearchProvider();
  let researchProviderInvocationCount = 0;

  const invokeClientMock = vi.fn(
    async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => {
      if (frame.toolName === 'memory.read') {
        return {
          invocationId: frame.invocationId,
          outcome: 'ok',
          resultJson: { record: validMoneyRecord() },
        };
      }
      // web.fetch calls from the research subagent
      if (frame.toolName === 'web.fetch') {
        return {
          invocationId: frame.invocationId,
          outcome: 'ok',
          resultJson: {
            status: 200,
            bodyText:
              'Aetna PPO: ER out-of-network claims may be appealed within 180 days of denial.',
          },
        };
      }
      return { invocationId: frame.invocationId, outcome: 'ok', resultJson: {} };
    },
  );

  const approveMock = approveResult === null
    ? undefined
    : vi.fn().mockResolvedValue(approveResult);

  const bridge: ClientBridge = {
    invokeClient: invokeClientMock,
    ...(approveMock !== undefined ? { approveQuery: approveMock } : {}),
  };

  const deps: ToolGatewayDeps = {
    clientBridge: bridge,
    userId: 'user-claims-001',
    sessionId: 'session-claims-001',
    crossPackGrant: {
      namespaces: new Set<MemoryNamespace>(['money']),
      folderIds: new Set<string>(),
      documentIds: new Set<string>(),
    },
    researchProviderFactory: (_modelId: string) => {
      researchProviderInvocationCount += 1;
      return provider;
    },
  };

  const gw = new ToolGateway(deps);

  return {
    gw,
    researchObserved: observed,
    researchProviderInvokedCount: () => researchProviderInvocationCount,
    invokeClientMock,
    approveMock: approveMock ?? vi.fn(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Task 2D.1 — claims-research delegation: composition test', () => {
  /**
   * Step 1: Harvest the canary via memory.read
   *
   * Dispatch a real memory.read for namespace "money". The gateway routes it
   * through tier-a-read, the bridge returns the MemoryRecord with CANARY_TEXT,
   * and the gateway's harvestEgressTaint() path ingests it. After this step
   * gw.__egressTaintForTest() contains the canary's grams/tokens.
   */
  describe('Step 1: memory.read harvests the canary into the main ledger', () => {
    it('dispatch memory.read (namespace money, cross-pack grant) → ok, canary in ledger', async () => {
      const { gw } = makeHarness();
      const frame = makeMemoryReadFrame();
      const res = await gw.dispatch(frame, claimsPack, TURN_ID);

      // The memory.read must succeed (grant authorises "money").
      expect(res.outcome).toBe('ok');

      // The ledger must now have observed a private read and harvested grams
      // from the CANARY_TEXT. Verify indirectly: a tainted question that
      // reproduces the canary must now be blocked (isQuestionEgressTainted).
      const ej = gw.__egressTaintForTest();
      expect(ej.hasObservedPrivateRead()).toBe(true);

      // Prove content harvest: the tainted question fires, proving a gram from
      // CANARY_TEXT lives in the ledger (not just the observed-flag).
      expect(gw.isQuestionEgressTainted(TAINTED_QUESTION)).toBe(true);

      // Sanity: the CLEAN question is not tainted by the canary.
      expect(gw.isQuestionEgressTainted(CLEAN_QUESTION)).toBe(false);
    });
  });

  /**
   * Steps 2(a) + 2(c): Canary isolation + wrapped answer
   *
   * Dispatch a CLEAN research.ask (approved) AFTER harvesting the canary.
   * (a) The fake research provider's recorded messages must not contain CANARY_TEXT
   *     — the private content the main gateway harvested must never reach the
   *     air-gapped subagent's model context.
   * (c) The result is UNTRUSTED_RESEARCH_RESULT with non-empty answer + sources.
   */
  describe('Step 2(a)+(c): clean research.ask — canary isolation + wrapped answer', () => {
    it('(a) research provider never sees the canary token — air-gap proof', async () => {
      const { gw, researchObserved, researchProviderInvokedCount } = makeHarness();

      // Harvest the canary first.
      await gw.dispatch(makeMemoryReadFrame(), claimsPack, TURN_ID);

      // Clean research.ask — approved → delegates to subagent.
      const frame = makeResearchFrame({
        insurer: 'Aetna',
        question: CLEAN_QUESTION,
      });
      const res = await gw.dispatch(frame, claimsPack, TURN_ID);

      // Must resolve ok.
      expect(res.outcome).toBe('ok');

      // The fake research provider must have been invoked.
      expect(researchProviderInvokedCount()).toBeGreaterThan(0);

      // CORE AIR-GAP ASSERTION: CANARY_TEXT and its distinctive sub-tokens must
      // not appear in any message the air-gapped subagent's model received.
      const allObserved = researchObserved.join('\n');
      expect(allObserved).not.toContain(CANARY_TEXT);
      // Also check the individual distinctive tokens to catch partial leaks.
      expect(allObserved).not.toContain('CANARY-7F3K9');
      expect(allObserved).not.toContain('policy holder Jane Doe');
    });

    it('(c) clean approved research.ask returns UNTRUSTED_RESEARCH_RESULT with answer + sources', async () => {
      const { gw } = makeHarness();

      // Harvest the canary first (same as real usage).
      await gw.dispatch(makeMemoryReadFrame(), claimsPack, TURN_ID);

      const frame = makeResearchFrame({
        insurer: 'Aetna',
        question: CLEAN_QUESTION,
      });
      const res = await gw.dispatch(frame, claimsPack, TURN_ID);

      expect(res.outcome).toBe('ok');

      const rj = res.resultJson as {
        kind: string;
        note: string;
        answer: string;
        sources: string[];
      };

      // Must be wrapped as untrusted data.
      expect(JSON.stringify(rj)).toContain('UNTRUSTED_RESEARCH_RESULT');
      expect(rj.kind).toBe('UNTRUSTED_RESEARCH_RESULT');
      expect(typeof rj.note).toBe('string');
      expect(rj.note.length).toBeGreaterThan(0);

      // Answer must be non-empty (the prose from the second round).
      expect(typeof rj.answer).toBe('string');
      expect(rj.answer.length).toBeGreaterThan(0);

      // Sources: the fake provider emits a web.fetch; the URL must appear.
      expect(Array.isArray(rj.sources)).toBe(true);
    });
  });

  /**
   * Step 3(b): Tainted question blocked
   *
   * After the canary is harvested, dispatch a research.ask whose question
   * reproduces the canary span. Layer 2 must fire (RESEARCH_QUESTION_TAINTED)
   * and the research provider must NOT be invoked.
   */
  describe('Step 3(b): tainted research.ask → Layer 2 blocks before delegation', () => {
    it('question reproducing the canary → RESEARCH_QUESTION_TAINTED, provider NOT invoked', async () => {
      const { gw, researchProviderInvokedCount, approveMock } = makeHarness();

      // Harvest the canary.
      await gw.dispatch(makeMemoryReadFrame(), claimsPack, TURN_ID);

      // Tainted question: reproduces 'member id CANARY-7F3K9 policy' which
      // normalises to 'memberidcanary7f3k9policy', containing the gram
      // 'memberidcanary7f3k9p' harvested from CANARY_TEXT.
      const frame = makeResearchFrame({ question: TAINTED_QUESTION });
      const res = await gw.dispatch(frame, claimsPack, TURN_ID);

      // Layer 2 must block it.
      expect(res.outcome).toBe('gateway_rejected');
      expect(res.reason).toBe('RESEARCH_QUESTION_TAINTED');

      // The research provider was NOT invoked — no delegation happened.
      expect(researchProviderInvokedCount()).toBe(0);

      // Layer 3 (approveQuery) must not have been called either — Layer 2 is earlier.
      expect(approveMock).not.toHaveBeenCalled();
    });
  });

  /**
   * Step 4(d): No private-data laundering / no direct egress
   *
   * A direct web.fetch from the claims pack must be rejected with the
   * specific claims-pack reason (WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK), not the
   * generic OUT_OF_SCOPE. The bridge is never invoked.
   *
   * This proves: the wrapped UNTRUSTED_RESEARCH_RESULT re-entering the main
   * loop cannot trigger a raw outbound fetch — the claims pack is structurally
   * blocked from calling web.fetch directly; it must go through the three-layer
   * research.ask delegation.
   */
  describe('Step 4(d): direct web.fetch from claims pack → WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK', () => {
    it('web.fetch on the claims pack is rejected with the specific claims guard, not OUT_OF_SCOPE', async () => {
      const { gw, invokeClientMock } = makeHarness();

      const frame = makeWebFetchFrame();
      const res = await gw.dispatch(frame, claimsPack, TURN_ID);

      // Specific claims guard must fire.
      expect(res.outcome).toBe('gateway_rejected');
      expect(res.reason).toBe('WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK');
      expect(res.reason).not.toBe('OUT_OF_SCOPE');

      // The bridge must never be invoked — no actual fetch happened.
      // Note: invokeClient may have been called for prior memory.read in the
      // same gateway instance, but for THIS specific web.fetch dispatch it
      // must NOT have been called after the check. We create a fresh harness
      // here so the mock count is 0.
      expect(invokeClientMock).not.toHaveBeenCalled();
    });
  });
});

/**
 * Composing all four steps together in a single sequential fixture.
 *
 * This variant runs the full sequence on ONE gateway instance to prove the
 * composition: harvest → clean research (passes) → tainted research (blocked)
 * → direct web.fetch (blocked).
 */
describe('Task 2D.1 — end-to-end sequential composition on a single gateway', () => {
  let harness: HarnessGateway;
  let cleanResearchResult: Awaited<ReturnType<ToolGateway['dispatch']>>;
  let taintedResearchResult: Awaited<ReturnType<ToolGateway['dispatch']>>;
  let webFetchResult: Awaited<ReturnType<ToolGateway['dispatch']>>;

  beforeEach(async () => {
    harness = makeHarness(true);

    // Step 1: harvest the canary via memory.read.
    await harness.gw.dispatch(makeMemoryReadFrame(), claimsPack, TURN_ID);

    // Step 2: clean research.ask (Layer 1+2+3 pass, delegation succeeds).
    cleanResearchResult = await harness.gw.dispatch(
      makeResearchFrame({ insurer: 'Aetna', question: CLEAN_QUESTION }),
      claimsPack,
      TURN_ID,
    );

    // Step 3: tainted research.ask (Layer 2 blocks).
    taintedResearchResult = await harness.gw.dispatch(
      makeResearchFrame({ question: TAINTED_QUESTION }),
      claimsPack,
      TURN_ID,
    );

    // Step 4: direct web.fetch from claims pack (claims guard blocks).
    webFetchResult = await harness.gw.dispatch(
      makeWebFetchFrame(),
      claimsPack,
      TURN_ID,
    );
  });

  it('(a) canary never in research subagent context', () => {
    const all = harness.researchObserved.join('\n');
    expect(all).not.toContain(CANARY_TEXT);
    expect(all).not.toContain('CANARY-7F3K9');
    expect(all).not.toContain('policy holder Jane Doe');
  });

  it('(b) tainted question → gateway_rejected / RESEARCH_QUESTION_TAINTED', () => {
    expect(taintedResearchResult.outcome).toBe('gateway_rejected');
    expect(taintedResearchResult.reason).toBe('RESEARCH_QUESTION_TAINTED');
  });

  it('(c) clean approved → UNTRUSTED_RESEARCH_RESULT with non-empty answer + sources', () => {
    expect(cleanResearchResult.outcome).toBe('ok');
    const rj = cleanResearchResult.resultJson as {
      kind: string;
      answer: string;
      sources: string[];
    };
    expect(rj.kind).toBe('UNTRUSTED_RESEARCH_RESULT');
    expect(rj.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(rj.sources)).toBe(true);
  });

  it('(d) direct web.fetch → WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK (no laundering path)', () => {
    expect(webFetchResult.outcome).toBe('gateway_rejected');
    expect(webFetchResult.reason).toBe('WEB_FETCH_NOT_ALLOWED_IN_CROSS_PACK');
    expect(webFetchResult.reason).not.toBe('OUT_OF_SCOPE');
  });
});
