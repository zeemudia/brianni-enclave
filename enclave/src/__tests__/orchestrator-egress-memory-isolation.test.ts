import { describe, expect, it, vi } from 'vitest';
import type {
  AgentSubtask,
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  ModelCapability,
  SkillPack,
  ToolInvocationFrame,
  ToolName,
  ToolResultFrame,
} from '@calypso/chat-types';

import {
  EGRESS_CAPABLE_TOOLS,
  originalMessagesForWorker,
  runOrchestrator,
  type RunOrchestratorDeps,
} from '../orchestrator/executor';
import { ToolGateway } from '../tools';

// A distinctive private-derived canary that st_read emits as its output. It then
// lives in orchestrator working memory tagged with subtaskId 'st_read'. The
// egress (web.fetch) worker must NEVER see it; a non-egress dependent (st_report)
// legitimately may.
const CANARY = 'NIGHTJAR-CANARY-7741-PRIVATE-DERIVED-PHRASE';

function mkPack(scopes: SkillPack['toolScopes']): SkillPack {
  return {
    id: 'personal-agent.default',
    version: 1,
    displayName: 'Default',
    description: 'General',
    defaultNamespace: 'default',
    systemPromptBlock: 'You are Calypso.',
    toolScopes: scopes,
    capabilitySuiteIds: ['text'],
    linkedFolderScopes: {},
    uiHints: { icon: 'default', accentToken: 'accent-default' },
  };
}

const pack = mkPack(['folder.list', 'folder.read', 'file.read', 'web.fetch']);

const models: ModelCapability[] = [
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

// Planner that echoes a read -> fetch -> report plan. st_fetch declares a
// dependency on the private read (the "dependency-carry" shape); the planner
// normalization strips that dep, but execution order still runs st_read before
// st_fetch, so the EXECUTOR must keep st_read's memory out of st_fetch.
const READ_FETCH_REPORT_PLAN = `{
  "planId": "plan_iso",
  "title": "Read then fetch then report",
  "summary": "Read a private file, fetch a public page, then write a short report.",
  "subtasks": [
    {
      "id": "st_read",
      "title": "Read private file",
      "objective": "Read the private file and note its canary value.",
      "kind": "file_inspection",
      "requiredCapabilities": ["general_reasoning"],
      "allowedTools": ["folder.read", "file.read"],
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

// A fetch -> report plan with NO private-read subtask. Used to prove the egress
// isolation also covers private-derived content that rides in the conversation
// HISTORY (originalMessages) rather than in orchestrator working memory — e.g.
// the refine flow's includePrivateDerivedPriorAnswer carry-forward.
const FETCH_REPORT_PLAN = `{
  "planId": "plan_refine_iso",
  "title": "Fetch then report",
  "summary": "Fetch a public page, then write a short report.",
  "subtasks": [
    {
      "id": "st_fetch",
      "title": "Fetch public page",
      "objective": "Fetch the public URL and report the HTTP status.",
      "kind": "research",
      "requiredCapabilities": ["research"],
      "allowedTools": ["web.fetch"],
      "dependsOn": [],
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
      "dependsOn": [],
      "producesArtifact": true,
      "risk": "low"
    }
  ]
}`;

function planner(planJson: string): ChatProcessor {
  return {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const prompt = messages.at(-1)?.content ?? '';
      const tag = prompt.match(/<plan id="([^"]+)">/)?.[1] ?? 'planner_test';
      yield {
        id: 'chunk',
        choices: [
          {
            delta: { content: `<plan id="${tag}">\n${planJson}\n</plan>` },
            finish_reason: null,
          },
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

describe('orchestrator egress memory isolation', () => {
  it('keeps private-read-derived working memory out of a web.fetch worker, while a non-egress dependent still sees it', async () => {
    const fetchWorkerInbound: string[] = [];
    const reportWorkerInbound: string[] = [];

    const invokeClient = vi.fn(
      async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => ({
        invocationId: frame.invocationId,
        outcome: 'ok',
        resultJson: { status: 200, bodyText: 'Example Domain.' },
      }),
    );
    const gw = new ToolGateway({ clientBridge: { invokeClient } });

    // One worker per subtask, dispatched by subtask title in the prompt.
    const workerFactory = (): ChatProcessor => ({
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        const text = lastUserContent(messages);

        // st_read: emit the canary as its answer (no tool call needed — folder
        // reads are not gated as required). It flows verbatim into working
        // memory (<=1800 chars) tagged subtaskId 'st_read'.
        if (/Subtask: Read private file/.test(text)) {
          yield {
            id: 'c',
            choices: [
              {
                delta: { content: `The file canary is ${CANARY}.` },
                finish_reason: null,
              },
            ],
          };
          return;
        }

        // st_fetch (web.fetch-only): capture the full inbound context, then emit
        // the required web.fetch call so the subtask completes 'done'.
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
            choices: [
              { delta: { content: 'The page returned 200.' }, finish_reason: null },
            ],
          };
          return;
        }

        // st_report (no tools, depends on st_read): capture inbound context and
        // emit a benign answer.
        if (/Subtask: Report/.test(text)) {
          reportWorkerInbound.push(messages.map((m) => m.content).join('\n'));
          yield {
            id: 'c',
            choices: [
              { delta: { content: 'Report written.' }, finish_reason: null },
            ],
          };
          return;
        }

        yield { id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: null }] };
      },
    });

    const deps: RunOrchestratorDeps = {
      agentTurnId: 'turn_iso',
      gateway: gw,
      pack,
      plannerProvider: planner(READ_FETCH_REPORT_PLAN),
      workerProviderFactory: workerFactory,
      plannerModel: 'gpt-5.5',
      summaryModel: 'gpt-5.5',
      models,
      enabledGatewayTools: pack.toolScopes,
      enabledEndpointFamilies: ['chat'],
      messages: [
        {
          role: 'user' as const,
          // Mentions reading a linked-folder file AND fetching, so the
          // fetch-only single-subtask override does NOT apply and the genuine
          // multi-step plan drives the run.
          content:
            'Read my private notes file from the linked Documents folder, then fetch https://example.com and write a short report.',
        },
      ],
      requestContext: {
        // These fixtures read the linked Documents folder; since the
        // 2026-06-12 fix the planner refuses folder tools for folderless
        // workspaces, so the folder must exist for the plan to validate.
        linkedFolders: [
          { folderId: 'fld_docs', displayName: 'Documents', status: 'granted' as const },
        ],
        writePermissionMode: 'always_ask' as const,
      },
      workerTimeoutMs: 5_000,
      summaryTimeoutMs: 5_000,
    };

    const events = await collect(runOrchestrator(deps));

    // The plan really drove this run as a read -> fetch -> report split (the
    // private dep on st_fetch was stripped by planner normalization).
    const planEvent = events.find(
      (e) =>
        e &&
        typeof e === 'object' &&
        (e as { kind?: string }).kind === 'orchestrator-plan',
    ) as { plan: { subtasks: { id: string; allowedTools: string[]; dependsOn: string[] }[] } } | undefined;
    const fetchSubtask = planEvent?.plan.subtasks.find((s) => s.id === 'st_fetch');
    expect(fetchSubtask?.allowedTools).toEqual(['web.fetch']);
    expect(fetchSubtask?.dependsOn).toEqual([]); // private dep stripped

    // Both downstream workers actually ran.
    expect(fetchWorkerInbound.length).toBeGreaterThan(0);
    expect(reportWorkerInbound.length).toBeGreaterThan(0);

    // CORE ASSERTION: the egress (web.fetch) worker NEVER received the
    // private-read-derived canary in its model context.
    for (const inbound of fetchWorkerInbound) {
      expect(inbound).not.toContain(CANARY);
    }

    // POSITIVE CONTROL: a non-egress dependent (st_report) DID receive st_read's
    // memory — proving the canary genuinely propagated and the filter is
    // specifically excluding it from the egress worker, not globally absent.
    expect(reportWorkerInbound.join('\n')).toContain(CANARY);
  });

  it('blocks the read -> no-tool relay -> web.fetch laundering path (runtime taint)', async () => {
    // Adversarial plan with NO malformed deps: a no-tool relay subtask runs
    // after a private read (seeing it via global memory) and re-emits it, then
    // a web.fetch subtask runs. The relay is private-read-derived only at
    // RUNTIME (no private tool, no declared dep), so a static classification
    // would let its summary reach the fetch worker.
    const relayInbound: string[] = [];
    const fetchInbound: string[] = [];

    const invokeClient = vi.fn(
      async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => ({
        invocationId: frame.invocationId,
        outcome: 'ok',
        resultJson: { status: 200, bodyText: 'Example Domain.' },
      }),
    );
    const gw = new ToolGateway({ clientBridge: { invokeClient } });

    const workerFactory = (): ChatProcessor => ({
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        const text = lastUserContent(messages);

        if (/Subtask: Read private file/.test(text)) {
          yield {
            id: 'c',
            choices: [
              {
                delta: { content: `The file canary is ${CANARY}.` },
                finish_reason: null,
              },
            ],
          };
          return;
        }

        // Relay (no tools): launder whatever private memory it was shown back
        // into its own summary.
        if (/Subtask: Relay/.test(text)) {
          relayInbound.push(messages.map((m) => m.content).join('\n'));
          const sawCanary = text.includes(CANARY);
          yield {
            id: 'c',
            choices: [
              {
                delta: {
                  content: sawCanary
                    ? `Relaying what I saw: ${CANARY}`
                    : 'Nothing to relay.',
                },
                finish_reason: null,
              },
            ],
          };
          return;
        }

        if (/Subtask: Fetch public page/.test(text)) {
          const sawToolResult = messages.some(
            (m) => m.role === 'user' && /Tool result — web\.fetch/.test(m.content),
          );
          if (!sawToolResult) {
            fetchInbound.push(messages.map((m) => m.content).join('\n'));
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
            choices: [
              { delta: { content: 'The page returned 200.' }, finish_reason: null },
            ],
          };
          return;
        }

        yield { id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: null }] };
      },
    });

    const relayPlan = `{
      "planId": "plan_relay",
      "title": "Read, relay, fetch",
      "summary": "Read a private file, relay a note, then fetch a public page.",
      "subtasks": [
        {
          "id": "st_read",
          "title": "Read private file",
          "objective": "Read the private file and note its canary value.",
          "kind": "file_inspection",
          "requiredCapabilities": ["general_reasoning"],
          "allowedTools": ["folder.read", "file.read"],
          "dependsOn": [],
          "producesArtifact": false,
          "risk": "low"
        },
        {
          "id": "st_relay",
          "title": "Relay",
          "objective": "Write a brief note about the run.",
          "kind": "writing",
          "requiredCapabilities": ["writing"],
          "allowedTools": [],
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
          "dependsOn": [],
          "producesArtifact": false,
          "risk": "low"
        }
      ]
    }`;

    const deps: RunOrchestratorDeps = {
      agentTurnId: 'turn_relay',
      gateway: gw,
      pack,
      plannerProvider: planner(relayPlan),
      workerProviderFactory: workerFactory,
      plannerModel: 'gpt-5.5',
      summaryModel: 'gpt-5.5',
      models,
      enabledGatewayTools: pack.toolScopes,
      enabledEndpointFamilies: ['chat'],
      messages: [
        {
          role: 'user' as const,
          content:
            'Read my private notes file from the linked Documents folder, then fetch https://example.com and write a short note.',
        },
      ],
      requestContext: {
        // These fixtures read the linked Documents folder; since the
        // 2026-06-12 fix the planner refuses folder tools for folderless
        // workspaces, so the folder must exist for the plan to validate.
        linkedFolders: [
          { folderId: 'fld_docs', displayName: 'Documents', status: 'granted' as const },
        ],
        writePermissionMode: 'always_ask' as const,
      },
      workerTimeoutMs: 5_000,
      summaryTimeoutMs: 5_000,
    };

    await collect(runOrchestrator(deps));

    // The relay genuinely saw (and laundered) the private canary...
    expect(relayInbound.length).toBeGreaterThan(0);
    expect(relayInbound.join('\n')).toContain(CANARY);
    // ...but the web.fetch worker received NEITHER the read's nor the relay's
    // private-derived memory. Runtime taint marked the relay private-derived.
    expect(fetchInbound.length).toBeGreaterThan(0);
    for (const inbound of fetchInbound) {
      expect(inbound).not.toContain(CANARY);
    }
  });

  it('keeps a private-derived prior ASSISTANT message (refine carry-forward) out of a web.fetch worker', async () => {
    // The refine flow deliberately carries a prior private-read-derived assistant
    // answer forward in the message history (includePrivateDerivedPriorAnswer).
    // That content rides in originalMessages, NOT working memory, so the
    // working-memory filter alone does not stop it reaching an egress worker.
    const fetchWorkerInbound: string[] = [];
    const reportWorkerInbound: string[] = [];

    const invokeClient = vi.fn(
      async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => ({
        invocationId: frame.invocationId,
        outcome: 'ok',
        resultJson: { status: 200, bodyText: 'Example Domain.' },
      }),
    );
    const gw = new ToolGateway({ clientBridge: { invokeClient } });

    const workerFactory = (): ChatProcessor => ({
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        const text = lastUserContent(messages);

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
            choices: [
              { delta: { content: 'The page returned 200.' }, finish_reason: null },
            ],
          };
          return;
        }

        if (/Subtask: Report/.test(text)) {
          reportWorkerInbound.push(messages.map((m) => m.content).join('\n'));
          yield {
            id: 'c',
            choices: [
              { delta: { content: 'Report written.' }, finish_reason: null },
            ],
          };
          return;
        }

        yield { id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: null }] };
      },
    });

    const deps: RunOrchestratorDeps = {
      agentTurnId: 'turn_refine_iso',
      gateway: gw,
      pack,
      plannerProvider: planner(FETCH_REPORT_PLAN),
      workerProviderFactory: workerFactory,
      plannerModel: 'gpt-5.5',
      summaryModel: 'gpt-5.5',
      models,
      enabledGatewayTools: pack.toolScopes,
      enabledEndpointFamilies: ['chat'],
      messages: [
        { role: 'user' as const, content: 'Earlier: summarise my private medical note.' },
        { role: 'assistant' as const, content: `Summary of your note: ${CANARY}` },
        {
          role: 'user' as const,
          // "synthesise" keeps this off the deterministic fetch-only single-subtask
          // override so the genuine fetch -> report split drives the run.
          content: 'Now fetch https://example.com and synthesise a short report.',
        },
      ],
      requestContext: {
        linkedFolders: [],
        writePermissionMode: 'always_ask' as const,
      },
      workerTimeoutMs: 5_000,
      summaryTimeoutMs: 5_000,
    };

    await collect(runOrchestrator(deps));

    expect(fetchWorkerInbound.length).toBeGreaterThan(0);
    expect(reportWorkerInbound.length).toBeGreaterThan(0);

    // CORE ASSERTION: the egress (web.fetch) worker NEVER received the
    // private-derived prior assistant answer that rode in originalMessages.
    for (const inbound of fetchWorkerInbound) {
      expect(inbound).not.toContain(CANARY);
    }

    // POSITIVE CONTROL: a non-egress worker (st_report) DID still receive the
    // conversation history, proving the canary genuinely propagated and the
    // filter specifically excludes it from the egress worker.
    expect(reportWorkerInbound.join('\n')).toContain(CANARY);
  });

  it('keeps a private datum from a PRIOR user turn out of a web.fetch worker', async () => {
    // A prior user turn can itself contain privately pasted text (claim/medical
    // detail). Forwarding every user turn would still leak it to the egress
    // worker; only the latest user turn (the current public request) should
    // reach it. A non-egress dependent still sees the full history.
    const fetchWorkerInbound: string[] = [];
    const reportWorkerInbound: string[] = [];

    const invokeClient = vi.fn(
      async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => ({
        invocationId: frame.invocationId,
        outcome: 'ok',
        resultJson: { status: 200, bodyText: 'Example Domain.' },
      }),
    );
    const gw = new ToolGateway({ clientBridge: { invokeClient } });

    const workerFactory = (): ChatProcessor => ({
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        const text = lastUserContent(messages);

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
            choices: [
              { delta: { content: 'The page returned 200.' }, finish_reason: null },
            ],
          };
          return;
        }

        if (/Subtask: Report/.test(text)) {
          reportWorkerInbound.push(messages.map((m) => m.content).join('\n'));
          yield {
            id: 'c',
            choices: [
              { delta: { content: 'Report written.' }, finish_reason: null },
            ],
          };
          return;
        }

        yield { id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: null }] };
      },
    });

    const deps: RunOrchestratorDeps = {
      agentTurnId: 'turn_prior_user_iso',
      gateway: gw,
      pack,
      plannerProvider: planner(FETCH_REPORT_PLAN),
      workerProviderFactory: workerFactory,
      plannerModel: 'gpt-5.5',
      summaryModel: 'gpt-5.5',
      models,
      enabledGatewayTools: pack.toolScopes,
      enabledEndpointFamilies: ['chat'],
      messages: [
        {
          role: 'user' as const,
          content: `Earlier I pasted my private detail: ${CANARY}.`,
        },
        { role: 'assistant' as const, content: 'Understood.' },
        {
          role: 'user' as const,
          // "synthesise" keeps this off the deterministic fetch-only single-subtask
          // override so the genuine fetch -> report split drives the run.
          content: 'Now fetch https://example.com and synthesise a short report.',
        },
      ],
      requestContext: {
        linkedFolders: [],
        writePermissionMode: 'always_ask' as const,
      },
      workerTimeoutMs: 5_000,
      summaryTimeoutMs: 5_000,
    };

    await collect(runOrchestrator(deps));

    expect(fetchWorkerInbound.length).toBeGreaterThan(0);
    expect(reportWorkerInbound.length).toBeGreaterThan(0);

    // CORE ASSERTION: the egress (web.fetch) worker NEVER received the private
    // datum that rode in the PRIOR user turn.
    for (const inbound of fetchWorkerInbound) {
      expect(inbound).not.toContain(CANARY);
    }

    // POSITIVE CONTROL: a non-egress worker (st_report) DID still receive the
    // full conversation history, proving the datum genuinely propagated.
    expect(reportWorkerInbound.join('\n')).toContain(CANARY);
  });
});

describe('orchestrator egress bridge (consent-gated private-read -> web)', () => {
  // Reuses READ_FETCH_REPORT_PLAN: st_read (private) emits CANARY into working
  // memory; st_fetch (web.fetch-only) is denied it by isolation. The bridge
  // offers the user the candidate datum; approval crosses it, denial does not.
  function bridgeWorkerFactory(fetchInbound: string[]): () => ChatProcessor {
    return () => ({
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        const text = lastUserContent(messages);
        if (/Subtask: Read private file/.test(text)) {
          yield { id: 'c', choices: [{ delta: { content: `The file canary is ${CANARY}.` }, finish_reason: null }] };
          return;
        }
        if (/Subtask: Fetch public page/.test(text)) {
          const sawToolResult = messages.some(
            (m) => m.role === 'user' && /Tool result — web\.fetch/.test(m.content),
          );
          if (!sawToolResult) {
            fetchInbound.push(messages.map((m) => m.content).join('\n'));
            yield {
              id: 'c',
              choices: [{ delta: { content: '<tool>{"toolName":"web.fetch","args":{"url":"https://example.com/","query":"status"}}</tool>' }, finish_reason: null }],
            };
            return;
          }
          yield { id: 'c', choices: [{ delta: { content: 'The page returned 200.' }, finish_reason: null }] };
          return;
        }
        yield { id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: null }] };
      },
    });
  }

  function bridgeDeps(
    fetchInbound: string[],
    awaitEgressPromotion: RunOrchestratorDeps['awaitEgressPromotion'],
  ): RunOrchestratorDeps {
    const invokeClient = vi.fn(
      async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => ({
        invocationId: frame.invocationId,
        outcome: 'ok',
        resultJson: { status: 200, bodyText: 'Example Domain.' },
      }),
    );
    return {
      agentTurnId: 'turn_bridge',
      gateway: new ToolGateway({ clientBridge: { invokeClient } }),
      pack,
      plannerProvider: planner(READ_FETCH_REPORT_PLAN),
      workerProviderFactory: bridgeWorkerFactory(fetchInbound),
      plannerModel: 'gpt-5.5',
      summaryModel: 'gpt-5.5',
      models,
      enabledGatewayTools: pack.toolScopes,
      enabledEndpointFamilies: ['chat'],
      messages: [
        {
          role: 'user' as const,
          content:
            'Read my private notes file from the linked Documents folder, then fetch https://example.com and write a short report.',
        },
      ],
      requestContext: {
        linkedFolders: [{ folderId: 'fld_docs', displayName: 'Documents', status: 'granted' as const }],
        writePermissionMode: 'always_ask' as const,
      },
      awaitEgressPromotion,
      workerTimeoutMs: 5_000,
      summaryTimeoutMs: 5_000,
    };
  }

  it('APPROVED: the user-promoted private datum crosses into the web.fetch worker', async () => {
    const fetchInbound: string[] = [];
    const seenCandidates: Array<{ id: string; content: string }> = [];
    const approve: RunOrchestratorDeps['awaitEgressPromotion'] = async (payload) => {
      for (const c of payload.candidates) seenCandidates.push({ id: c.id, content: c.content });
      return { approvedIds: payload.candidates.map((c) => c.id) };
    };

    await collect(runOrchestrator(bridgeDeps(fetchInbound, approve)));

    // The bridge offered the private-derived datum as a candidate...
    expect(seenCandidates.some((c) => c.content.includes(CANARY))).toBe(true);
    // ...and once approved it reached the egress worker's context.
    expect(fetchInbound.length).toBeGreaterThan(0);
    expect(fetchInbound.join('\n')).toContain(CANARY);
  });

  it('DENIED: the datum never crosses and the worker gets an honest decline note (no frozen running)', async () => {
    const fetchInbound: string[] = [];
    const deny: RunOrchestratorDeps['awaitEgressPromotion'] = async () => ({ approvedIds: [] });

    await collect(runOrchestrator(bridgeDeps(fetchInbound, deny)));

    expect(fetchInbound.length).toBeGreaterThan(0);
    // Isolation holds: the private datum did NOT cross.
    expect(fetchInbound.join('\n')).not.toContain(CANARY);
    // The worker is told to answer honestly rather than dead-end.
    expect(fetchInbound.join('\n')).toContain('could not look it up');
  });

  it('FAIL-CLOSED: an absent promotion channel denies (no datum crosses)', async () => {
    const fetchInbound: string[] = [];
    // No awaitEgressPromotion wired at all.
    await collect(runOrchestrator(bridgeDeps(fetchInbound, undefined)));
    expect(fetchInbound.join('\n')).not.toContain(CANARY);
  });
});

describe('originalMessagesForWorker — egress workers never receive prior assistant/tool history', () => {
  // Trust boundary = "this worker can reach the public internet", keyed on the
  // production EGRESS_CAPABLE_TOOLS set, NOT the literal string 'web.fetch'.
  // Drive the sweep from the REAL set (imported, not a parallel copy) so a future
  // network-reaching tool ADDED to the set is automatically covered here. The
  // explicit membership assertions below catch the inverse — a tool REMOVED from
  // the set — so both drift directions re-fail this test.
  const EGRESS_TOOLS: ToolName[] = Array.from(EGRESS_CAPABLE_TOOLS);

  it('keeps the known egress paths in the set (web.fetch + research.ask)', () => {
    expect(EGRESS_CAPABLE_TOOLS.has('web.fetch')).toBe(true);
    expect(EGRESS_CAPABLE_TOOLS.has('research.ask')).toBe(true);
  });

  const history: ChatMessage[] = [
    { role: 'user', content: 'Earlier: summarise my private medical note.' },
    { role: 'assistant', content: `Summary of your note: ${CANARY}` },
    { role: 'user', content: 'Now look this up.' },
  ];

  const mkSubtask = (allowedTools: ToolName[]): AgentSubtask => ({
    id: 'st',
    title: 'subtask',
    objective: 'do the thing',
    kind: 'research',
    requiredCapabilities: ['research'],
    allowedTools,
    dependsOn: [],
    producesArtifact: false,
    risk: 'low',
  });

  it.each(EGRESS_TOOLS)(
    'strips non-user history (incl. private-derived assistant turns) for egress tool "%s"',
    (tool) => {
      const out = originalMessagesForWorker(history, mkSubtask([tool]));
      expect(out.every((m) => m.role === 'user')).toBe(true);
      expect(out.map((m) => m.content).join('\n')).not.toContain(CANARY);
    },
  );

  // A PRIOR user turn can itself hold privately pasted data (e.g. claim/medical
  // text the user typed directly into an earlier message). Keeping every user
  // turn would still forward that to an egress worker, which could copy it into
  // an outbound URL/query. The structural boundary is the LATEST user turn only —
  // the current public request the worker is told to act on.
  const priorUserTurnHistory: ChatMessage[] = [
    { role: 'user', content: `Earlier I pasted my private detail: ${CANARY}.` },
    { role: 'assistant', content: 'Understood.' },
    { role: 'user', content: 'Now fetch the public status page.' },
  ];

  it.each(EGRESS_TOOLS)(
    'forwards ONLY the latest user turn for egress tool "%s" (prior user turns can hold pasted private data)',
    (tool) => {
      const out = originalMessagesForWorker(
        priorUserTurnHistory,
        mkSubtask([tool]),
      );
      expect(out).toEqual([
        { role: 'user', content: 'Now fetch the public status page.' },
      ]);
      expect(out.map((m) => m.content).join('\n')).not.toContain(CANARY);
    },
  );

  it('preserves the full history for a non-egress (private-read) worker', () => {
    const out = originalMessagesForWorker(history, mkSubtask(['folder.read', 'file.read']));
    expect(out).toEqual(history);
    expect(out.map((m) => m.content).join('\n')).toContain(CANARY);
  });

  it('strips history when an egress tool is mixed with non-egress tools in one subtask', () => {
    const out = originalMessagesForWorker(history, mkSubtask(['file.read', 'research.ask']));
    expect(out.every((m) => m.role === 'user')).toBe(true);
    expect(out.map((m) => m.content).join('\n')).not.toContain(CANARY);
  });
});
