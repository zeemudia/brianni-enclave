import { describe, expect, it, vi } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  ModelCapability,
  SkillPack,
  ToolInvocationFrame,
  ToolResultFrame,
} from '@calypso/chat-types';

import {
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
        linkedFolders: [],
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
        linkedFolders: [],
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
});
