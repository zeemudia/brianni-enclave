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

const pack = mkPack(['web.fetch']);

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

function planner(planJson: string): ChatProcessor {
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

// A worker that, on seeing a "Fetch" objective, emits a web.fetch tool call,
// and once the tool result is reinjected into ITS OWN loop, answers by quoting
// the HTTP status and body it actually received. This models the robust
// single-subtask "Fetch and answer" shape where the {status, bodyText} payload
// is reinjected into the same worker loop.
function fetchThenAnswerWorker(): ChatProcessor {
  return {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const toolResultMessage = [...messages]
        .reverse()
        .find(
          (m) => m.role === 'user' && /Tool result — web\.fetch/.test(m.content),
        );
      if (!toolResultMessage) {
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
      // Quote the status + body straight out of the reinjected tool result so
      // the assertion can verify the real payload reached the answer.
      const status = toolResultMessage.content.match(/"status":\s*(\d+)/)?.[1] ?? '???';
      const sawBody = /Example Domain/.test(toolResultMessage.content);
      yield {
        id: 'c',
        choices: [
          {
            delta: {
              content: `The page returned HTTP status ${status}.${sawBody ? ' It is the Example Domain placeholder page.' : ''}`,
            },
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

// A lossy split the model planner sometimes emits for a fetch request. The
// dependent "Report" step has NO tools and depends on the fetch step's working
// memory. Before the fix this shape silently loses the {status, bodyText}.
const TWO_STEP_PLAN = `{
  "planId": "plan_1",
  "title": "Fetch and report",
  "summary": "Fetch the URL then report the HTTP status and summary.",
  "subtasks": [
    {
      "id": "st_fetch",
      "title": "Fetch URL",
      "objective": "Fetch the page and capture the HTTP status and page text.",
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
      "objective": "Report the HTTP status and a summary of the fetched page.",
      "kind": "writing",
      "requiredCapabilities": ["writing"],
      "allowedTools": [],
      "dependsOn": ["st_fetch"],
      "producesArtifact": true,
      "risk": "low"
    }
  ]
}`;

function orchestratorTextFor(
  events: unknown[],
  predicate?: (e: { subtaskId: string; role: string }) => boolean,
): string {
  return events
    .filter(
      (e): e is { kind: string; subtaskId: string; role: string; text: string } =>
        !!e &&
        typeof e === 'object' &&
        (e as { kind?: string }).kind === 'orchestrator-text',
    )
    .filter((e) => (predicate ? predicate(e) : true))
    .map((e) => e.text)
    .join('');
}

function progressFor(events: unknown[], subtaskId: string): string[] {
  return events
    .filter(
      (e): e is { kind: string; subtaskId: string; status: string } =>
        !!e &&
        typeof e === 'object' &&
        (e as { kind?: string }).kind === 'orchestrator-progress' &&
        (e as { subtaskId?: string }).subtaskId === subtaskId,
    )
    .map((e) => e.status);
}

describe('web.fetch orchestrator', () => {
  it('forces the single-subtask Fetch-and-answer shape for a web-fetch request, even when the planner proposes a lossy two-step split, and surfaces HTTP status + content', async () => {
    // Client bridge stands in for client → server /v1/agent/web-fetch:
    // it returns exactly { status, bodyText } like the server route.
    const invokeClient = vi.fn(
      async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => ({
        invocationId: frame.invocationId,
        outcome: 'ok',
        resultJson: {
          status: 200,
          bodyText:
            '<!doctype html><title>Example Domain</title><body>Example Domain. This domain is for use in illustrative examples.</body>',
        },
      }),
    );
    const gw = new ToolGateway({ clientBridge: { invokeClient } });

    const deps: RunOrchestratorDeps = {
      agentTurnId: 'turn_1',
      gateway: gw,
      pack,
      // The planner WOULD return the lossy split, but the orchestrator must
      // override it with the deterministic single-subtask shape for fetch.
      plannerProvider: planner(TWO_STEP_PLAN),
      workerProviderFactory: () => fetchThenAnswerWorker(),
      plannerModel: 'gpt-5.5',
      summaryModel: 'gpt-5.5',
      models,
      enabledGatewayTools: pack.toolScopes,
      enabledEndpointFamilies: ['chat'],
      messages: [
        {
          role: 'user' as const,
          content: 'Fetch https://example.com and report the HTTP status and summarise it.',
        },
      ],
      requestContext: { linkedFolders: [], writePermissionMode: 'always_ask' as const },
      workerTimeoutMs: 5_000,
      summaryTimeoutMs: 5_000,
    };

    const events = await collect(runOrchestrator(deps));

    // The fetch actually happened.
    expect(invokeClient).toHaveBeenCalledTimes(1);
    expect(invokeClient.mock.calls[0][0].toolName).toBe('web.fetch');

    // Plan was forced onto the single "Fetch and answer" subtask (st_single),
    // NOT the lossy st_fetch/st_report split.
    const planEvent = events.find(
      (e) => e && typeof e === 'object' && (e as { kind?: string }).kind === 'orchestrator-plan',
    ) as { plan: { subtasks: { id: string }[] } } | undefined;
    expect(planEvent?.plan.subtasks).toHaveLength(1);
    expect(planEvent?.plan.subtasks[0].id).toBe('st_single');

    // The single subtask completes 'done', never error/blocked.
    expect(progressFor(events, 'st_single')).toContain('done');
    expect(progressFor(events, 'st_single')).not.toContain('error');

    // The final artifact text contains the REAL HTTP status + content derived
    // from the {status, bodyText} tool result — the whole point of the fix.
    const finalText = orchestratorTextFor(events);
    expect(finalText).toContain('200');
    expect(finalText).toMatch(/Example Domain/i);
  });

  it('carries the web.fetch {status, bodyText} digest across the subtask boundary into a dependent report step', async () => {
    // This drives a genuine two-step plan (the user text deliberately avoids
    // fetch keywords so the single-subtask override does NOT apply), exercising
    // the cross-boundary tool-result carry on its own.
    const invokeClient = vi.fn(
      async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => ({
        invocationId: frame.invocationId,
        outcome: 'ok',
        resultJson: {
          status: 200,
          bodyText: 'Example Domain. Illustrative examples only.',
        },
      }),
    );
    const gw = new ToolGateway({ clientBridge: { invokeClient } });

    // Step 1 worker: emit web.fetch, then a terse prose summary that
    // DELIBERATELY omits the status/body (mirrors the lossy-prose failure).
    // Step 2 worker (Report): has no tools; it must read the status + body out
    // of the orchestrator working-memory block and surface them.
    const workerFactory = (): ChatProcessor => ({
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const text = lastUser?.content ?? '';
        const sawToolResult = messages.some(
          (m) => m.role === 'user' && /Tool result — web\.fetch/.test(m.content),
        );
        // Report step: echo whatever the orchestrator memory block carried.
        if (/Subtask: Report/.test(text)) {
          const memoryMatch = text.match(/HTTP status (\d+)/);
          const status = memoryMatch?.[1] ?? 'unknown';
          const sawBody = /Example Domain/.test(text);
          yield {
            id: 'c',
            choices: [
              {
                delta: {
                  content: `Report: the fetch returned HTTP status ${status}.${sawBody ? ' Body referenced Example Domain.' : ''}`,
                },
                finish_reason: null,
              },
            ],
          };
          return;
        }
        // Fetch step: emit the tool call, then a status-free prose summary.
        if (!sawToolResult) {
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
          choices: [{ delta: { content: 'Done.' }, finish_reason: null }],
        };
      },
    });

    const deps: RunOrchestratorDeps = {
      agentTurnId: 'turn_2',
      gateway: gw,
      pack,
      plannerProvider: planner(TWO_STEP_PLAN),
      workerProviderFactory: workerFactory,
      plannerModel: 'gpt-5.5',
      summaryModel: 'gpt-5.5',
      models,
      enabledGatewayTools: pack.toolScopes,
      enabledEndpointFamilies: ['chat'],
      messages: [
        {
          role: 'user' as const,
          // No "fetch"/URL keywords → single-subtask override does NOT apply,
          // so the genuine two-step plan drives the orchestrator.
          content: 'Look up the example page and then write a report about it.',
        },
      ],
      requestContext: { linkedFolders: [], writePermissionMode: 'always_ask' as const },
      workerTimeoutMs: 5_000,
      summaryTimeoutMs: 5_000,
    };

    const events = await collect(runOrchestrator(deps));

    // Sanity: the two-step plan really drove this run.
    const planEvent = events.find(
      (e) => e && typeof e === 'object' && (e as { kind?: string }).kind === 'orchestrator-plan',
    ) as { plan: { subtasks: { id: string }[] } } | undefined;
    expect(planEvent?.plan.subtasks.map((s) => s.id)).toEqual(['st_fetch', 'st_report']);

    expect(invokeClient).toHaveBeenCalledTimes(1);
    expect(progressFor(events, 'st_fetch')).toContain('done');
    expect(progressFor(events, 'st_report')).toContain('done');

    // The dependent Report step received the {status, bodyText} via working
    // memory, despite the fetch worker's prose omitting it. Without fix (b) the
    // status would be 'unknown' and the body reference absent.
    const reportText = orchestratorTextFor(
      events,
      (e) => e.subtaskId === 'st_report',
    );
    expect(reportText).toContain('200');
    expect(reportText).toMatch(/Example Domain/i);
  });

  it('does NOT let a worker that skips the required web.fetch call silently succeed', async () => {
    const invokeClient = vi.fn(
      async (frame: ToolInvocationFrame): Promise<ToolResultFrame> => ({
        invocationId: frame.invocationId,
        outcome: 'ok',
        resultJson: { status: 200, bodyText: 'Example Domain.' },
      }),
    );
    const gw = new ToolGateway({ clientBridge: { invokeClient } });

    // Worker that talks about fetching but never emits a <tool> call — the
    // observed flaky live behaviour.
    const noToolWorker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        yield {
          id: 'c',
          choices: [
            { delta: { content: 'I will fetch the page now.' }, finish_reason: null },
          ],
        };
      },
    };

    const deps: RunOrchestratorDeps = {
      agentTurnId: 'turn_3',
      gateway: gw,
      pack,
      plannerProvider: planner(TWO_STEP_PLAN),
      workerProviderFactory: () => noToolWorker,
      plannerModel: 'gpt-5.5',
      summaryModel: 'gpt-5.5',
      models,
      enabledGatewayTools: pack.toolScopes,
      enabledEndpointFamilies: ['chat'],
      messages: [
        {
          role: 'user' as const,
          content: 'Fetch https://example.com and report the HTTP status and summarise it.',
        },
      ],
      requestContext: { linkedFolders: [], writePermissionMode: 'always_ask' as const },
      workerTimeoutMs: 5_000,
      summaryTimeoutMs: 5_000,
    };

    const events = await collect(runOrchestrator(deps));

    // No fetch happened (the worker emitted no tool call).
    expect(invokeClient).not.toHaveBeenCalled();

    // The single fetch subtask (st_single after the override) must NOT report
    // 'done' — a worker scoped to a required read tool that emits no tool call
    // is surfaced as an error, not a silent success.
    const statuses = progressFor(events, 'st_single');
    expect(statuses).toContain('error');
    expect(statuses).not.toContain('done');
  });
});
