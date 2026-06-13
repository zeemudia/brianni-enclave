import { describe, expect, it, vi } from 'vitest';
import {
  OrchestratorLedgerEntrySchema,
  OrchestratorProgressEventSchema,
  type ChatChunk,
  type ChatMessage,
  type ChatProcessor,
  type ModelCapability,
  type ModelRouteDecision,
  type SkillPack,
} from '@calypso/chat-types';

import {
  runOrchestrator,
  type RunOrchestratorDeps,
} from '../orchestrator/executor';
import { toProgressChunk } from '../orchestrator/events';
import {
  ProviderHealth,
  buildAttemptModelIds,
} from '../orchestrator/provider-health';
import {
  ProviderError,
  classifyProviderHttpError,
  normaliseProviderError,
} from '../providers/errors';
import { ToolGateway } from '../tools';

// B5 — Provider fallback exhaustion (docs/launch/agent-capability-verification.md §3).
// Gap-closers only; single-reroute success paths, Retry-After handling and
// post-output no-retry behaviour are already covered in
// orchestrator-executor.test.ts, and rate-limit cooldown ordering in
// orchestrator-provider-health.test.ts.
//
// Covered here:
//  1. Simultaneous exhaustion: EVERY candidate provider rate-limited → every
//     candidate is still attempted (availability-biased), the subtask fails
//     with a typed user-visible error, dependents skip, and the PLAN terminates
//     with a clean `done` — no hang, no silent partial success.
//  2. Whole-plan routing exhaustion: every subtask unroutable →
//     NO_MODEL_FOR_SUBTASK:<id> per subtask, zero provider calls, plan ends.
//  3. Distinct handling of timeout vs rate-limit vs auth-failed in candidate
//     ordering (only rate_limit cools a provider) and in the user-visible
//     retry detail (REROUTE vs TIMEOUT_RETRY vs ERROR_RETRY).
//  4. Regression guard for the 2026-06-11 provider_rerouted activity fix: the
//     enclave's reroute signal string and the shared ledger action the client
//     mints from it must stay in lockstep.

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

const pack = mkPack([
  'folder.list',
  'folder.read',
  'file.read',
  'doc.draft',
  'folder.write',
]);

const models: ModelCapability[] = [
  {
    modelId: 'gpt-5.5',
    providerId: 'openai',
    strengths: ['writing', 'long_context', 'general_reasoning'],
    strengthQuality: [{ strength: 'writing', tier: 'frontier' }],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier: 'high',
    latencyTier: 'standard',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
    maxContextTokens: 1050000,
  },
  {
    modelId: 'gpt-5.4-mini',
    providerId: 'openai',
    strengths: ['fast_reasoning', 'structured_extraction', 'classification'],
    strengthQuality: [{ strength: 'fast_reasoning', tier: 'strong' }],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier: 'low',
    latencyTier: 'fast',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
    maxContextTokens: 400000,
  },
];

function anthropicWritingModel(): ModelCapability {
  return {
    modelId: 'claude-opus-4-7',
    providerId: 'anthropic',
    strengths: ['writing', 'general_reasoning'],
    strengthQuality: [{ strength: 'writing', tier: 'frontier' }],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier: 'high',
    latencyTier: 'standard',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
    maxContextTokens: 200_000,
  };
}

function processor(text: string): ChatProcessor {
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      yield {
        id: 'chunk',
        choices: [{ delta: { content: text }, finish_reason: null }],
      };
    },
  };
}

function throwingProcessor(error: Error): ChatProcessor {
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      throw error;
    },
  };
}

// Never yields and never settles: forces the worker watchdog timeout path.
function hangingProcessor(): ChatProcessor {
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      await new Promise<never>(() => {});
      yield {
        id: 'unreachable',
        choices: [{ delta: { content: 'unreachable' }, finish_reason: null }],
      };
    },
  };
}

function plannerProcessor(planJson: string): ChatProcessor {
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

function collectEvents<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  return (async () => {
    const out: T[] = [];
    for await (const event of generator) out.push(event);
    return out;
  })();
}

function gateway(clientBridge = vi.fn()): ToolGateway {
  return new ToolGateway({ clientBridge: { invokeClient: clientBridge } });
}

function rateLimitError(providerId: 'openai' | 'anthropic'): ProviderError {
  return new ProviderError({
    providerId,
    providerName: providerId === 'openai' ? 'OpenAI' : 'Anthropic',
    status: 429,
    kind: 'rate_limit',
    retryAfterMs: 60_000,
  });
}

function baseDeps(overrides: Partial<RunOrchestratorDeps> = {}): RunOrchestratorDeps {
  return {
    agentTurnId: 'turn_1',
    gateway: gateway(),
    pack,
    plannerProvider: plannerProcessor(`{
      "planId": "plan_1",
      "title": "Application materials",
      "summary": "Read files and draft.",
      "subtasks": [
        {
          "id": "st_1",
          "title": "Draft",
          "objective": "Draft the letter.",
          "kind": "writing",
          "requiredCapabilities": ["writing"],
          "allowedTools": ["doc.draft"],
          "dependsOn": [],
          "producesArtifact": true,
          "risk": "medium"
        }
      ]
    }`),
    workerProviderFactory: () => processor('Draft complete.'),
    plannerModel: 'gpt-5.5',
    summaryModel: 'gpt-5.4-mini',
    models,
    enabledGatewayTools: pack.toolScopes,
    enabledEndpointFamilies: ['chat'],
    messages: [{ role: 'user' as const, content: 'Write an application letter.' }],
    requestContext: {
      linkedFolders: [
        {
          folderId: 'fld_test',
          displayName: 'Documents',
          status: 'granted' as const,
        },
      ],
      writePermissionMode: 'always_ask' as const,
    },
    ...overrides,
  };
}

describe('provider fallback exhaustion (B5)', () => {
  // Spec note: when every candidate is cooling SIMULTANEOUSLY the orchestrator
  // is deliberately availability-biased (provider-health.ts falls back to the
  // known candidate list rather than refusing to try) — so exhaustion here
  // means "every candidate attempted, every attempt rate-limited". The subtask
  // then fails with the provider's typed, fixed-format error message (not
  // NO_MODEL_FOR_SUBTASK, which is the routing-time capability dead-end tested
  // below). What B5 requires either way: typed user-visible error, dependents
  // skipped, plan reaches `done` (no hang), nothing reports silent success.
  it('fails the subtask with a typed error and terminates the plan when every provider is rate-limited at once', async () => {
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          nowMs: () => 1_000,
          models: [...models, anthropicWritingModel()],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Draft then derive",
            "summary": "Draft the letter, then derive a snippet.",
            "subtasks": [
              {
                "id": "st_draft",
                "title": "Draft",
                "objective": "Draft the letter.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": ["doc.draft"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "medium"
              },
              {
                "id": "st_code",
                "title": "Derive snippet",
                "objective": "Turn the draft into a snippet.",
                "kind": "code",
                "requiredCapabilities": ["code"],
                "allowedTools": [],
                "dependsOn": ["st_draft"],
                "producesArtifact": false,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return throwingProcessor(
              rateLimitError(
                modelId.startsWith('claude') ? 'anthropic' : 'openai',
              ),
            );
          },
        }),
      ),
    );

    // Every candidate across all providers was attempted: primary, the
    // cross-provider fallback, then (with both providers cooling) the
    // availability-biased same-provider fallback.
    expect(calls).toEqual(['gpt-5.5', 'claude-opus-4-7', 'gpt-5.4-mini']);

    // A reroute activity event fired before each surviving fresh attempt.
    const rerouteIndices = events
      .map((event, index) =>
        event.kind === 'orchestrator-progress' &&
        event.subtaskId === 'st_draft' &&
        event.status === 'blocked' &&
        event.detail === 'ORCHESTRATOR_PROVIDER_REROUTE'
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    expect(rerouteIndices).toHaveLength(2);

    // The subtask fails with the typed, fixed-format provider error — a
    // user-visible detail that carries no payload-derived content.
    const errorIndex = events.findIndex(
      (event) =>
        event.kind === 'orchestrator-progress' &&
        event.subtaskId === 'st_draft' &&
        event.status === 'error',
    );
    expect(errorIndex).toBeGreaterThan(rerouteIndices[1]!);
    const errorEvent = events[errorIndex];
    if (
      errorEvent?.kind !== 'orchestrator-progress' ||
      errorEvent.status !== 'error'
    ) {
      throw new Error('expected an orchestrator-progress error event');
    }
    expect(errorEvent.detail).toBe('OpenAI API error: 429');
    // …and the error chunk the client receives is schema-valid as emitted.
    const parsed = OrchestratorProgressEventSchema.parse(
      toProgressChunk(errorEvent),
    );
    expect(parsed._type).toBe('orchestrator_progress');

    // No silent partial success: the dependent skips, neither subtask reaches
    // 'done', and no worker text was ever streamed.
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_code',
        status: 'skipped',
        detail: 'Skipped because an earlier subtask failed.',
      }),
    );
    expect(
      events.filter(
        (event) =>
          event.kind === 'orchestrator-progress' &&
          (event.subtaskId === 'st_draft' || event.subtaskId === 'st_code') &&
          event.status === 'done',
      ),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.kind === 'orchestrator-text'),
    ).toHaveLength(0);

    // No hang: the generator completed (collectEvents resolved within the test
    // timeout) and the plan terminated with a clean done frame.
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('fails immediately with the typed error and emits NO reroute event when there is no candidate to reroute to', async () => {
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          nowMs: () => 1_000,
          // Single-model catalog: the route has no fallback candidates.
          models: [models[0]!],
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return throwingProcessor(rateLimitError('openai'));
          },
        }),
      ),
    );

    expect(calls).toEqual(['gpt-5.5']);
    // The activity feed must not claim a reroute that never happened.
    expect(events).not.toContainEqual(
      expect.objectContaining({ detail: 'ORCHESTRATOR_PROVIDER_REROUTE' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_1',
        status: 'error',
        detail: 'OpenAI API error: 429',
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('terminates a fully unroutable plan with a NO_MODEL_FOR_SUBTASK error per subtask and zero provider calls', async () => {
    const workerProviderFactory = vi.fn(() => processor('never used'));
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          workerProviderFactory,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Two images",
            "summary": "Generate two images.",
            "subtasks": [
              {
                "id": "st_a",
                "title": "Create image A",
                "objective": "Generate image A.",
                "kind": "image",
                "requiredCapabilities": ["image_generation"],
                "allowedTools": [],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              },
              {
                "id": "st_b",
                "title": "Create image B",
                "objective": "Generate image B.",
                "kind": "image",
                "requiredCapabilities": ["image_generation"],
                "allowedTools": ["doc.draft"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
        }),
      ),
    );

    // Both subtasks dead-end at routing with their own typed NO_MODEL error.
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_a',
        status: 'error',
        detail: 'NO_MODEL_FOR_SUBTASK:st_a',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_b',
        status: 'error',
        detail: 'NO_MODEL_FOR_SUBTASK:st_b',
      }),
    );
    // Nothing succeeded silently and no worker call was ever dispatched.
    expect(
      events.filter(
        (event) =>
          event.kind === 'orchestrator-progress' && event.status === 'done',
      ),
    ).toHaveLength(0);
    expect(workerProviderFactory).not.toHaveBeenCalled();
    // The plan still terminates cleanly instead of hanging on the dead ends.
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });
});

describe('distinct timeout / rate-limit / auth handling in candidate ordering (B5)', () => {
  const healthModels: ModelCapability[] = [
    healthModel('gpt-5.5', 'openai'),
    healthModel('gpt-5.4', 'openai'),
    healthModel('claude-opus-4-7', 'anthropic'),
    healthModel('gemini-3.1-pro-preview', 'google'),
  ];
  const route: ModelRouteDecision = {
    subtaskId: 'st_1',
    modelId: 'gpt-5.5',
    providerId: 'openai',
    reason: 'test',
    fallbackModelIds: [
      'claude-opus-4-7',
      'gemini-3.1-pro-preview',
      'gpt-5.4',
    ],
  };

  function healthModel(modelId: string, providerId: string): ModelCapability {
    return {
      modelId,
      providerId,
      strengths: ['general_reasoning'],
      strengthQuality: [],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 200_000,
    };
  }

  it('cools only the rate-limited provider: auth and timeout failures never demote a candidate', () => {
    const authError = classifyProviderHttpError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 401,
    });
    const timeoutError = normaliseProviderError(
      new Error('request timed out'),
      'google',
      'Google',
    );
    const rateLimit = classifyProviderHttpError({
      providerId: 'anthropic',
      providerName: 'Anthropic',
      status: 429,
      retryAfterMs: 60_000,
    });

    // Normalisation keeps the three failure classes distinct.
    expect(authError.kind).toBe('auth');
    expect(timeoutError.kind).toBe('transient');
    expect(rateLimit.kind).toBe('rate_limit');

    const health = new ProviderHealth();
    health.mark(authError, 1_000);
    health.mark(timeoutError, 1_000);
    health.mark(rateLimit, 1_000);

    expect(health.isCooling('openai', 2_000)).toBe(false);
    expect(health.isCooling('google', 2_000)).toBe(false);
    expect(health.isCooling('anthropic', 2_000)).toBe(true);

    // Only the rate-limited provider's model is demoted to the tail; the
    // auth-failed and timed-out providers keep their original positions.
    expect(buildAttemptModelIds(route, healthModels, health, 2_000, 4)).toEqual([
      'gpt-5.5',
      'gemini-3.1-pro-preview',
      'gpt-5.4',
      'claude-opus-4-7',
    ]);
  });

  it('surfaces a worker timeout as ORCHESTRATOR_WORKER_TIMEOUT_RETRY, never as a provider reroute', async () => {
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          models: [...models, anthropicWritingModel()],
          workerTimeoutMs: 25,
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return modelId === 'gpt-5.5'
              ? hangingProcessor()
              : processor('Recovered on fallback.');
          },
        }),
      ),
    );

    expect(calls).toEqual(['gpt-5.5', 'claude-opus-4-7']);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_1',
        status: 'blocked',
        detail: 'ORCHESTRATOR_WORKER_TIMEOUT_RETRY',
      }),
    );
    // A timeout is not a rate limit: it must not mint a provider_rerouted
    // activity row on the client.
    expect(events).not.toContainEqual(
      expect.objectContaining({ detail: 'ORCHESTRATOR_PROVIDER_REROUTE' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_1', status: 'done' }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('surfaces an auth failure as ORCHESTRATOR_WORKER_ERROR_RETRY, never as a provider reroute', async () => {
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          models: [...models, anthropicWritingModel()],
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return modelId === 'gpt-5.5'
              ? throwingProcessor(
                  new ProviderError({
                    providerId: 'openai',
                    providerName: 'OpenAI',
                    status: 401,
                    kind: 'auth',
                  }),
                )
              : processor('Recovered on fallback.');
          },
        }),
      ),
    );

    expect(calls).toEqual(['gpt-5.5', 'claude-opus-4-7']);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_1',
        status: 'blocked',
        detail: 'ORCHESTRATOR_WORKER_ERROR_RETRY',
      }),
    );
    // An auth failure must not claim "switched to a backup provider" — the
    // key is broken, not the capacity.
    expect(events).not.toContainEqual(
      expect.objectContaining({ detail: 'ORCHESTRATOR_PROVIDER_REROUTE' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_1', status: 'done' }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });
});

describe('provider_rerouted activity contract (2026-06-11 regression guard)', () => {
  // The client (CalypsoTaskWorkspace, web + mobile) matches the literal
  // progress detail 'ORCHESTRATOR_PROVIDER_REROUTE' and mints an
  // OrchestratorLedgerEntry with action 'provider_rerouted' — the calm
  // "Switched to a backup provider" activity row added 2026-06-11. Renaming
  // either string would break the activity feed silently, so this locks both
  // ends of the wire contract from the enclave side.
  it('emits the exact reroute detail the client maps to a provider_rerouted ledger entry', async () => {
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          models: [...models, anthropicWritingModel()],
          workerProviderFactory: (modelId) =>
            modelId === 'gpt-5.5'
              ? throwingProcessor(rateLimitError('openai'))
              : processor('Draft complete on fallback.'),
        }),
      ),
    );

    const reroute = events.find(
      (event) =>
        event.kind === 'orchestrator-progress' &&
        event.detail === 'ORCHESTRATOR_PROVIDER_REROUTE',
    );
    if (reroute?.kind !== 'orchestrator-progress') {
      throw new Error('expected a reroute progress event');
    }
    expect(reroute.status).toBe('blocked');
    expect(reroute.subtaskId).toBe('st_1');

    // The event survives the wire mapping verbatim and is schema-valid, so
    // the client's literal `detail === 'ORCHESTRATOR_PROVIDER_REROUTE'` match
    // still fires.
    const chunk = OrchestratorProgressEventSchema.parse(toProgressChunk(reroute));
    expect(chunk).toMatchObject({
      _type: 'orchestrator_progress',
      status: 'blocked',
      detail: 'ORCHESTRATOR_PROVIDER_REROUTE',
    });

    // And the shared schema still carries the ledger action the client mints
    // from that detail.
    const entry = OrchestratorLedgerEntrySchema.parse({
      id: 'turn_1:plan_1:st_1:provider_rerouted:1',
      planId: 'plan_1',
      subtaskId: 'st_1',
      action: 'provider_rerouted',
      label: 'Switched to a backup provider to keep going',
      status: 'running',
      createdAt: new Date().toISOString(),
    });
    expect(entry.action).toBe('provider_rerouted');
  });
});
