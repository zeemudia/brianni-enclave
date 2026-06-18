import { describe, expect, it, vi } from 'vitest';
import {
  AgentTaskPlanSchema,
  type ChatChunk,
  type ChatMessage,
  type ChatProcessor,
  type ModelCapability,
  type SkillPack,
  type ToolInvocationFrame,
} from '@calypso/chat-types';

import {
  DEFAULT_WRITE_SUBTASK_TIMEOUT_MS,
  runOrchestrator,
  type RunOrchestratorDeps,
} from '../orchestrator/executor';
import { ProviderError } from '../providers/errors';
import type { ProviderResponseLike } from '../usage-report';
import { ToolGateway } from '../tools';
import { BinaryWorkItemManager } from '../tools/binary-work-items';

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

function meteredProcessor(
  text: string,
  response: ProviderResponseLike,
): ChatProcessor {
  return {
    async *streamChat(): AsyncGenerator<ChatChunk, ProviderResponseLike> {
      yield {
        id: 'chunk',
        choices: [{ delta: { content: text }, finish_reason: null }],
      };
      return response;
    },
  };
}

function chunkingProcessor(chunks: string[]): ChatProcessor {
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      for (const [index, text] of chunks.entries()) {
        yield {
          id: `chunk_${index}`,
          choices: [{ delta: { content: text }, finish_reason: null }],
        };
      }
    },
  };
}

function throwingProcessor(error = new Error('worker failed')): ChatProcessor {
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      throw error;
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

function meteredPlannerProcessor(
  planJson: string,
  response: ProviderResponseLike,
): ChatProcessor {
  return {
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk, ProviderResponseLike> {
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
      return response;
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function gateway(clientBridge = vi.fn()): ToolGateway {
  return new ToolGateway({ clientBridge: { invokeClient: clientBridge } });
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
    // A granted folder by default: most fixtures exercise folder.write plans,
    // and since the 2026-06-12 fix the planner refuses folder-dependent tools
    // for folderless workspaces. No-folder behaviour is tested explicitly in
    // orchestrator-planner.test.ts.
    requestContext: {
      linkedFolders: [
        {
          folderId: 'fld_test',
          displayName: 'Documents',
          status: 'granted' as const,
        },
      ],
      writePermissionMode: 'always_ask' as const,
      connectedConnectors: [],
      connectorModeEchoes: [],
    },
    ...overrides,
  };
}

describe('runOrchestrator', () => {
  it('emits plan, progress, worker text, and done', async () => {
    const events = await collectEvents(runOrchestrator(baseDeps()));

    expect(events.some((event) => event.kind === 'orchestrator-plan')).toBe(true);
    expect(events.some((event) => event.kind === 'orchestrator-progress')).toBe(true);
    expect(events.some((event) => event.kind === 'orchestrator-text')).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('honest media-gen degrade emits a fixed message WITHOUT a worker substitute (no fabricated SVG) — H2', async () => {
    // "make me a poster image" with image.generate NOT scoped triggers the
    // honest degrade. A worker that WOULD fabricate an SVG/spec as its text
    // answer must be bypassed entirely — the empty tool scope stops a SAVED
    // fake, but only skipping the worker stops a fabricated text substitute
    // (prompt-only enforcement is not enough — Codex review H2).
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          messages: [
            {
              role: 'user' as const,
              content: 'make me a poster image for the bake sale',
            },
          ],
          workerProviderFactory: () =>
            processor(
              '<svg><rect width="10" height="10"/></svg> Here is your poster.',
            ),
        }),
      ),
    );
    const dump = JSON.stringify(events);
    // The worker is bypassed: its fabricated SVG/text never reaches the user.
    expect(dump).not.toContain('<svg');
    expect(dump).not.toContain('Here is your poster');
    // The fixed honest-degrade message is emitted and the turn completes cleanly.
    expect(dump.toLowerCase()).toContain("can't generate an image");
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('emits usage events for planner, workers, and memory summaries', async () => {
    const longWorkerText = `${'A completed detail. '.repeat(120)}Final detail.`;
    let workerCalls = 0;
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          plannerProvider: meteredPlannerProcessor(
            `{
              "planId": "plan_usage",
              "title": "Usage plan",
              "summary": "Two dependent reasoning steps.",
              "subtasks": [
                {
                  "id": "st_1",
                  "title": "First",
                  "objective": "Produce detailed findings.",
                  "kind": "reasoning",
                  "requiredCapabilities": ["general_reasoning"],
                  "allowedTools": [],
                  "dependsOn": [],
                  "producesArtifact": false,
                  "risk": "low"
                },
                {
                  "id": "st_2",
                  "title": "Second",
                  "objective": "Use the findings.",
                  "kind": "writing",
                  "requiredCapabilities": ["writing"],
                  "allowedTools": [],
                  "dependsOn": ["st_1"],
                  "producesArtifact": true,
                  "risk": "low"
                }
              ]
            }`,
            {
              provider: 'openai',
              model: 'gpt-5.5',
              usage: { prompt_tokens: 30, completion_tokens: 12 },
            },
          ),
          summaryModel: 'summary-model',
          workerProviderFactory: (modelId) => {
            if (modelId === 'summary-model') {
              return meteredProcessor('Short memory summary.', {
                provider: 'openai',
                model: 'summary-model',
                usage: { prompt_tokens: 18, completion_tokens: 5 },
              });
            }
            workerCalls += 1;
            return meteredProcessor(workerCalls === 1 ? longWorkerText : 'Final answer.', {
              provider: 'openai',
              model: modelId,
              usage: { prompt_tokens: 21 + workerCalls, completion_tokens: 6 },
            });
          },
        }),
      ),
    );

    const usageEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { kind: 'usage' }> =>
        event.kind === 'usage',
    );

    expect(usageEvents.map((event) => event.routeKind)).toEqual(
      expect.arrayContaining(['agent_planner', 'agent_worker', 'agent_summary']),
    );
    expect(usageEvents.find((event) => event.routeKind === 'agent_planner')?.response).toMatchObject(
      { provider: 'openai', model: 'gpt-5.5' },
    );
    expect(usageEvents.find((event) => event.routeKind === 'agent_summary')?.response).toMatchObject(
      { provider: 'openai', model: 'summary-model' },
    );
  });

  it('enforces the provider-call budget across planner, workers, and summaries', async () => {
    const workerProviderFactory = vi.fn(() => processor('Worker done.'));
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          providerCallBudget: 3,
          workerProviderFactory,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_budget",
            "title": "Budgeted plan",
            "summary": "Two independent steps.",
            "subtasks": [
              {
                "id": "st_1",
                "title": "First step",
                "objective": "Complete the first step.",
                "kind": "reasoning",
                "requiredCapabilities": ["general_reasoning"],
                "allowedTools": [],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "medium"
              },
              {
                "id": "st_2",
                "title": "Second step",
                "objective": "Complete the second step.",
                "kind": "reasoning",
                "requiredCapabilities": ["general_reasoning"],
                "allowedTools": [],
                "dependsOn": ["st_1"],
                "producesArtifact": false,
                "risk": "medium"
              }
            ]
          }`),
        }),
      ),
    );

    expect(workerProviderFactory).toHaveBeenCalledTimes(2);
    expect(workerProviderFactory).toHaveBeenNthCalledWith(1, 'gpt-5.5');
    expect(workerProviderFactory).toHaveBeenNthCalledWith(2, 'gpt-5.4-mini');
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_2',
        status: 'error',
        detail: 'ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED',
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('does not spend summary calls on terminal subtasks without dependents', async () => {
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          providerCallBudget: 8,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_a17",
            "title": "Proof synthesis",
            "summary": "Fetch, read, synthesize, and write.",
            "subtasks": [
              {
                "id": "st_fetch",
                "title": "Fetch web",
                "objective": "Fetch https://example.com.",
                "kind": "research",
                "requiredCapabilities": ["research", "general_reasoning"],
                "allowedTools": [],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              },
              {
                "id": "st_read",
                "title": "Read folder",
                "objective": "Read the proof notes.",
                "kind": "file_inspection",
                "requiredCapabilities": ["filesystem_read", "general_reasoning"],
                "allowedTools": [],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              },
              {
                "id": "st_synthesize",
                "title": "Synthesize note",
                "objective": "Synthesize the internal note.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": [],
                "dependsOn": ["st_fetch", "st_read"],
                "producesArtifact": false,
                "risk": "low"
              },
              {
                "id": "st_write",
                "title": "Write note",
                "objective": "Write the final note.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": [],
                "dependsOn": ["st_synthesize"],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => processor('ok'),
        }),
      ),
    );

    expect(
      events.filter(
        (event) =>
          event.kind === 'orchestrator-progress' &&
          event.detail === 'ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED',
      ),
    ).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'done',
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('routes an image subtask to the image model and through the synchronous media executor (both gates open)', async () => {
    const imagePack = mkPack([...pack.toolScopes, 'image.generate']);
    const imageModel: ModelCapability = {
      modelId: 'gpt-image-test',
      providerId: 'openai',
      strengths: ['image_generation'],
      strengthQuality: [{ strength: 'image_generation', tier: 'frontier' }],
      modalities: ['text_in', 'image_out'],
      endpointFamily: 'image',
      costTier: 'high',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: ['image.generate'],
    };
    // The image subtask is now handled by the synchronous media executor, not
    // the chat worker. Provide a media stub whose image adapter records the
    // routed model id and returns bytes.
    const capturedAdapterModelIds: string[] = [];
    const media = {
      videoAdapters: {},
      imageAdapters: {
        openai: {
          generate: async (input: { modelId: string }) => {
            capturedAdapterModelIds.push(input.modelId);
            return {
              status: 'done' as const,
              imageBytes: new TextEncoder().encode('PNGDATA'),
              mimeType: 'image/png' as const,
              actualQuotaUnits: 3,
            };
          },
        },
      },
      checkpointClient: {
        load: async () => null,
        savePendingStart: async () => undefined,
        saveProviderJob: async () => undefined,
        markCancelled: async () => undefined,
        markBillingPending: async () => undefined,
        listCancelledPending: async () => [],
        listBillingPending: async () => [],
        markBillingSlaEscalated: async () => undefined,
        markTerminal: async () => undefined,
      },
      budgetClient: {
        reserve: async () => ({ ok: true as const, holdId: 'hold_img' }),
        reconcile: async () => undefined,
      },
      provenanceSigner: { sign: () => 'sig', verify: () => true },
      encryptArtifact: async (i: { bytes: Uint8Array }) => ({
        artifactId: 'art_1',
        ciphertextRef: 'ref_1',
        sha256: '0'.repeat(64),
        byteSize: i.bytes.byteLength,
      }),
      // image.generate delivers via the binary write-ACK path; the production
      // gateway threads the shared BinaryWorkItemManager. The fixture's
      // awaitBinaryWriteAck (below, on the orchestrator deps) ACKs an ok save.
      binaryWorkItems: new BinaryWorkItemManager(),
    };

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: imagePack,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Create campaign image",
            "summary": "Generate a single approved image artifact.",
            "subtasks": [
              {
                "id": "st_image",
                "title": "Generate image",
                "objective": "Create an image from the final prompt.",
                "kind": "image",
                "requiredCapabilities": ["image_generation"],
                "allowedTools": ["image.generate"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "medium",
                "media": { "operation": "image_generate", "privacyPolicy": "sanitized_only" }
              }
            ]
          }`),
          models: [...models, imageModel],
          enabledGatewayTools: imagePack.toolScopes,
          enabledEndpointFamilies: ['chat', 'image'],
          media: media as unknown as RunOrchestratorDeps['media'],
          sessionId: 'sess_img',
          // The image bytes are delivered to the (baseDeps) granted folder; the
          // client ACKs an ok save so the subtask reaches DONE.
          awaitBinaryWriteAck: async () => ({
            invocationId: 'inv',
            outcome: 'ok' as const,
            resultJson: { status: 'committed' },
          }),
        }),
      ),
    );

    // Routed to the image model and ran the media executor.
    expect(capturedAdapterModelIds[0]).toBe('gpt-image-test');
    const artifact = events.find((e) => e.kind === 'orchestrator-artifact');
    expect(artifact).toMatchObject({ artifactKind: 'image/png' });
    // Delivery went through the binary write-ACK path.
    expect(events.some((e) => e.kind === 'binary-write-request')).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('keeps production chat-only endpoint families closed for scoped media tools', async () => {
    const imagePack = mkPack([...pack.toolScopes, 'image.generate']);
    const capturedModelIds: string[] = [];
    const imageModel: ModelCapability = {
      modelId: 'gpt-image-test',
      providerId: 'openai',
      strengths: ['image_generation'],
      strengthQuality: [{ strength: 'image_generation', tier: 'frontier' }],
      modalities: ['text_in', 'image_out'],
      endpointFamily: 'image',
      costTier: 'high',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: ['image.generate'],
    };

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: imagePack,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Create campaign image",
            "summary": "Generate a single approved image artifact.",
            "subtasks": [
              {
                "id": "st_image",
                "title": "Generate image",
                "objective": "Create an image from the final prompt.",
                "kind": "image",
                "requiredCapabilities": ["image_generation"],
                "allowedTools": ["image.generate"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "medium"
              }
            ]
          }`),
          workerProviderFactory: (modelId) => {
            capturedModelIds.push(modelId);
            return processor('Image generated.');
          },
          models: [...models, imageModel],
          enabledGatewayTools: imagePack.toolScopes,
          enabledEndpointFamilies: ['chat'],
        }),
      ),
    );

    expect(capturedModelIds).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_image',
        status: 'error',
        detail: 'NO_MODEL_FOR_SUBTASK:st_image',
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('runs local video tool subtasks through the worker loop, not the provider media executor', async () => {
    const videoPack = mkPack([
      ...pack.toolScopes,
      'video.inspect',
      'video.transcribe',
      'video.transform',
    ]);
    const capturedModelIds: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: videoPack,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Inspect private video",
            "summary": "Use local tools to inspect and transcribe the video.",
            "subtasks": [
              {
                "id": "st_video_local",
                "title": "Inspect and transcribe video",
                "objective": "Use local video tools for proof-video.mp4.",
                "kind": "video",
                "requiredCapabilities": ["speech_to_text", "video_generation", "general_reasoning"],
                "allowedTools": ["video.inspect", "video.transcribe", "video.transform"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: (modelId) => {
            capturedModelIds.push(modelId);
            return processor('Video transcript ready.');
          },
          enabledGatewayTools: videoPack.toolScopes,
          enabledEndpointFamilies: ['chat'],
        }),
      ),
    );

    expect(capturedModelIds[0]).toBe('gpt-5.5');
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_video_local',
        detail: 'MEDIA_EXECUTOR_UNAVAILABLE',
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('forwards binary write requests from worker loops and waits for client ACKs', async () => {
    const imagePack = mkPack(['image.transform']);
    const tool = JSON.stringify({
      invocationId: 'inv_img',
      toolName: 'image.transform',
      args: {
        folderId: 'fld_1',
        displayName: 'Documents',
        filename: 'proof-image.png',
        outputPath: 'proof-image-calypso-800.png',
        transform: { kind: 'resize', maxWidth: 800, maxHeight: 800, format: 'png' },
      },
    });
    const capturedWorkerPrompts: ChatMessage[][] = [];
    const imageModel: ModelCapability = {
      modelId: 'gpt-image-worker',
      providerId: 'openai',
      strengths: ['general_reasoning', 'image_generation'],
      strengthQuality: [{ strength: 'general_reasoning', tier: 'strong' }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async (frame: ToolInvocationFrame) => ({
        invocationId: frame.invocationId,
        outcome: 'ok' as const,
        resultJson: {
          status: 'awaiting_client_write',
          outputPath: 'proof-image-calypso-800.png',
        },
        ledgerEntry: {
          invokedAt: new Date().toISOString(),
          toolName: frame.toolName,
          scope: 'image/proof-image.png',
          approvedPath: 'proof-image-calypso-800.png',
          outcome: 'ok' as const,
          reason: null,
          skillPackId: imagePack.id,
          turnId: 'turn_1',
        },
        clientOnlyBinaryWrite: {
          folderId: 'fld_1',
          displayName: 'Documents',
          request: {
            kind: 'binary_work_item.write_request' as const,
            agentTurnId: 'turn_1',
            invocationId: frame.invocationId,
            toolName: 'image.transform' as const,
            operationId: `image.transform:${frame.invocationId}`,
            outputId: 'out_img',
            outputPath: 'proof-image-calypso-800.png',
            sha256Hex: 'a'.repeat(64),
            byteLength: 7,
            chunkCount: 1,
          },
          chunks: [],
        },
      })),
    } as unknown as ToolGateway;
    const awaitBinaryWriteAck = vi.fn(async (payload) => ({
      invocationId: payload.request.invocationId,
      outcome: 'ok' as const,
      resultJson: {
        status: 'written',
        outputId: payload.request.outputId,
        outputPath: payload.request.outputPath,
        writtenPath: payload.request.outputPath,
      },
    }));
    const worker: ChatProcessor = {
      async *streamChat(messages): AsyncGenerator<ChatChunk> {
        capturedWorkerPrompts.push(JSON.parse(JSON.stringify(messages)));
        if (capturedWorkerPrompts.length === 1) {
          yield {
            id: 'tool',
            choices: [{ delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' }],
          };
          return;
        }
        yield {
          id: 'done',
          choices: [{ delta: { content: 'Saved the resized copy.' }, finish_reason: 'stop' }],
        };
      },
    };

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: imagePack,
          gateway,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_img",
            "title": "Resize image",
            "summary": "Resize proof image.",
            "subtasks": [
              {
                "id": "st_image",
                "title": "Resize image",
                "objective": "Create a resized copy of proof-image.png.",
                "kind": "image",
                "requiredCapabilities": ["image_generation", "general_reasoning"],
                "allowedTools": ["image.transform"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => worker,
          models: [...models, imageModel],
          enabledGatewayTools: imagePack.toolScopes,
          awaitBinaryWriteAck,
        }),
      ),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'binary-write-request',
        orchestrator: expect.objectContaining({ subtaskId: 'st_image' }),
      }),
    );
    expect(awaitBinaryWriteAck).toHaveBeenCalledTimes(1);
    expect(capturedWorkerPrompts).toHaveLength(2);
    expect(capturedWorkerPrompts[1].at(-1)?.content).toContain('written');
    expect(capturedWorkerPrompts[1].at(-1)?.content).not.toContain(
      'awaiting_client_write',
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_image',
        status: 'done',
      }),
    );
  });

  it('does not mark a terminal folder-write subtask as error when final narration times out after the write succeeded', async () => {
    const folderPack = mkPack(['folder.write']);
    const tool = JSON.stringify({
      invocationId: 'inv_write',
      toolName: 'folder.write',
      args: {
        folderId: 'fld_1',
        displayName: 'Documents',
        path: 'cascade-survival-proof-fa17800f.md',
        contentBytesB64: Buffer.from('proof written').toString('base64'),
      },
    });
    let providerCalls = 0;
    const worker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        providerCalls += 1;
        if (providerCalls === 1) {
          yield {
            id: 'tool',
            choices: [{ delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' }],
          };
          return;
        }
        await new Promise(() => undefined);
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async (frame: ToolInvocationFrame) => ({
        invocationId: frame.invocationId,
        outcome: 'ok' as const,
        resultJson: {
          writtenPath: 'cascade-survival-proof-fa17800f.md',
        },
        ledgerEntry: {
          invokedAt: new Date().toISOString(),
          toolName: 'folder.write' as const,
          scope: 'folder/Documents',
          approvedPath: 'cascade-survival-proof-fa17800f.md',
          outcome: 'ok' as const,
          reason: null,
          skillPackId: folderPack.id,
          turnId: 'turn_1',
        },
      })),
    } as unknown as ToolGateway;

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          gateway,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Write proof",
            "summary": "Write the terminal proof artifact.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Write proof file",
                "objective": "Write the final proof artifact.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => worker,
          enabledGatewayTools: folderPack.toolScopes,
          workerTimeoutMs: 5,
        }),
      ),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ledger',
        entry: expect.objectContaining({
          toolName: 'folder.write',
          outcome: 'ok',
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'error',
        detail: 'ORCHESTRATOR_WORKER_TIMEOUT',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'done',
        detail: 'ORCHESTRATOR_WORKER_TIMEOUT_AFTER_CONFIRMED_WRITE',
      }),
    );
  });

  it('gives a folder.write subtask the longer write-subtask worker timeout (generation + human-review window), not the 60s default', async () => {
    // Live 2026-06-13 regression: a folder.write subtask must generate the
    // whole artifact AND wait on the "Ask before saving" confirmation modal.
    // Under the flat 60s worker timeout, a long generation or a deliberate
    // human review trips ORCHESTRATOR_WORKER_TIMEOUT and abandons a write that
    // would have landed clean. Write subtasks must use the longer
    // write-subtask window instead. Here the worker stays quiet well past the
    // (small) standard worker timeout, then emits its write — it must survive.
    const folderPack = mkPack(['folder.write']);
    const tool = JSON.stringify({
      invocationId: 'inv_slow_write',
      toolName: 'folder.write',
      args: {
        folderId: 'fld_1',
        displayName: 'Documents',
        path: 'slow-report.md',
        contentBytesB64: Buffer.from('report body').toString('base64'),
      },
    });
    let workerCalls = 0;
    const slowWriteWorker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        workerCalls += 1;
        if (workerCalls === 1) {
          // Quiet past the standard worker timeout (30ms) — emulates a long
          // artifact / slow first token — then emit the write tool call.
          await new Promise((resolve) => setTimeout(resolve, 120));
          yield {
            id: 'tool',
            choices: [
              { delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' },
            ],
          };
        } else {
          // Continuation turn after the tool result: finish cleanly.
          yield {
            id: 'final',
            choices: [{ delta: { content: 'Saved the report.' }, finish_reason: 'stop' }],
          };
        }
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async () => ({
        invocationId: 'inv_slow_write',
        outcome: 'ok' as const,
        resultJson: { writtenPath: 'slow-report.md' },
        ledgerEntry: {
          invokedAt: new Date().toISOString(),
          toolName: 'folder.write',
          scope: 'folder/Documents',
          approvedPath: 'slow-report.md',
          outcome: 'ok' as const,
          reason: null,
          skillPackId: folderPack.id,
          turnId: 'turn_1',
        },
      })),
    } as unknown as ToolGateway;

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          gateway,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Write proof",
            "summary": "Write the terminal proof artifact.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Write proof file",
                "objective": "Write the final proof artifact.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => slowWriteWorker,
          enabledGatewayTools: folderPack.toolScopes,
          // Standard worker timeout is far below the 120ms generation delay,
          // so on the OLD flat-budget behaviour the write subtask would time
          // out before ever dispatching. The write-subtask timeout is larger.
          workerTimeoutMs: 30,
          writeSubtaskTimeoutMs: 2_000,
        }),
      ),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ledger',
        entry: expect.objectContaining({ toolName: 'folder.write', outcome: 'ok' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'done',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'error',
      }),
    );
  });

  it('defers a research.ask subtask worker timeout across the approval pause + subagent run via pendingResearchApproval (no ORCHESTRATOR_WORKER_TIMEOUT)', async () => {
    // Live 2026-06-14 reliability defect (F4): the research.ask worker subtask
    // ran under the flat 60s worker timeout, which spans BOTH the human
    // approval pause (approveQuery round-trip) AND the air-gapped subagent run
    // (now also slower because each web.fetch is a real client round-trip).
    // A slow approval tripped ORCHESTRATOR_WORKER_TIMEOUT and the research
    // subtask failed even though the subagent would have answered.
    //
    // Mirrors the folder.write deferral backstop: `pendingResearchApproval`
    // defers the timeout across the dispatch (which models gateway.dispatch
    // suspended on approveQuery + the subagent). Here the standard worker
    // timeout is TINY and no longer write-subtask window is configured, so the
    // standard timeout fires DURING the parked dispatch — and the deferral is
    // the only thing keeping the subtask alive. The dispatch then resolves ok
    // within the grace window and the subtask must SURVIVE.
    const researchPack = mkPack(['research.ask']);
    const tool = JSON.stringify({
      invocationId: 'inv_research',
      toolName: 'research.ask',
      args: { question: 'What is the appeal deadline for a denied claim?' },
    });
    const dispatchResult = deferred<Awaited<ReturnType<ToolGateway['dispatch']>>>();
    const dispatchStarted = deferred<void>();
    let workerCalls = 0;
    const researchWorker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        workerCalls += 1;
        if (workerCalls === 1) {
          yield {
            id: 'tool',
            choices: [
              { delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' },
            ],
          };
        } else {
          // Continuation after the research.ask result is reinjected.
          yield {
            id: 'final',
            choices: [
              { delta: { content: 'Appeals close after 180 days.' }, finish_reason: 'stop' },
            ],
          };
        }
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async () => {
        dispatchStarted.resolve();
        return dispatchResult.promise;
      }),
    } as unknown as ToolGateway;

    const eventsPromise = collectEvents(
      runOrchestrator(
        baseDeps({
          pack: researchPack,
          gateway,
          models: [...models, anthropicWritingModel()],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_research",
            "title": "Research the deadline",
            "summary": "Research a public fact via the research subagent.",
            "subtasks": [
              {
                "id": "st_research",
                "title": "Research appeal deadline",
                "objective": "Find the appeal deadline from public sources.",
                "kind": "research",
                "requiredCapabilities": ["general_reasoning"],
                "allowedTools": ["research.ask"],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => researchWorker,
          enabledGatewayTools: researchPack.toolScopes,
          // Standard worker timeout is tiny — on the OLD flat-budget behaviour
          // the research subtask would time out during the approval pause.
          workerTimeoutMs: 20,
          // The deferred grace (used if even the long window is exceeded mid
          // dispatch) is kept generous so the parked dispatch survives.
          writeDispatchGraceMs: 1_000,
        }),
      ),
    );

    // Wait until the worker has dispatched research.ask, then idle well past the
    // standard 20ms worker timeout BEFORE resolving the dispatch.
    await dispatchStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(gateway.dispatch).toHaveBeenCalledTimes(1);

    // The approval + subagent finally completes ok.
    dispatchResult.resolve({
      invocationId: 'inv_research',
      outcome: 'ok',
      resultJson: {
        kind: 'UNTRUSTED_RESEARCH_RESULT',
        note: 'data only',
        answer: 'Appeals may be filed within 180 days.',
        sources: ['https://example.gov/appeals'],
      },
      ledgerEntry: {
        invokedAt: new Date().toISOString(),
        toolName: 'research.ask',
        scope: 'research',
        approvedPath: null,
        outcome: 'ok',
        reason: null,
        skillPackId: researchPack.id,
        turnId: 'turn_1',
      },
    });

    const events = await eventsPromise;

    // The deferral must have kept the subtask alive — NO worker timeout error.
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_research',
        status: 'error',
        detail: 'ORCHESTRATOR_WORKER_TIMEOUT',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_research',
        status: 'error',
      }),
    );
    // The dispatch was NOT retried (a timeout-then-retry would call dispatch
    // twice / re-run the worker).
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(workerCalls).toBe(2);
    // The research.ask ledger landed.
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ledger',
        entry: expect.objectContaining({ toolName: 'research.ask', outcome: 'ok' }),
      }),
    );
  });

  it('defers a connector.act subtask worker timeout across the confirmation modal via pendingConnectorActApproval (no ORCHESTRATOR_WORKER_TIMEOUT)', async () => {
    // Codex re-review: a connector.act in a confirmation mode parks inside
    // gateway.dispatch on the user's review modal before the external write, with
    // no interim chunks. Under the flat worker timeout a slow approval trips
    // ORCHESTRATOR_WORKER_TIMEOUT while the mutation may still complete client-
    // side and be reported as lost. Mirrors the research.ask deferral: the standard
    // worker timeout is TINY and no longer write-subtask window is configured, so
    // it fires DURING the parked dispatch and only pendingConnectorActApproval
    // keeps the subtask alive; the dispatch then resolves ok and it must SURVIVE.
    const connectorPack = mkPack(['connector.act']);
    const tool = JSON.stringify({
      invocationId: 'inv_connector',
      toolName: 'connector.act',
      args: { connectorId: 'svc_1', operation: 'create_event', params: {} },
    });
    const dispatchResult = deferred<Awaited<ReturnType<ToolGateway['dispatch']>>>();
    const dispatchStarted = deferred<void>();
    let workerCalls = 0;
    const connectorWorker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        workerCalls += 1;
        if (workerCalls === 1) {
          yield {
            id: 'tool',
            choices: [
              { delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' },
            ],
          };
        } else {
          yield {
            id: 'final',
            choices: [
              { delta: { content: 'Created the calendar event.' }, finish_reason: 'stop' },
            ],
          };
        }
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async () => {
        dispatchStarted.resolve();
        return dispatchResult.promise;
      }),
    } as unknown as ToolGateway;

    const eventsPromise = collectEvents(
      runOrchestrator(
        baseDeps({
          pack: connectorPack,
          gateway,
          models: [...models, anthropicWritingModel()],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_connector",
            "title": "Create a calendar event",
            "summary": "Perform a mutating connector action with user confirmation.",
            "subtasks": [
              {
                "id": "st_connector",
                "title": "Create the event",
                "objective": "Create a calendar event on the connected service.",
                "kind": "general",
                "requiredCapabilities": ["general_reasoning"],
                "allowedTools": ["connector.act"],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => connectorWorker,
          enabledGatewayTools: connectorPack.toolScopes,
          // Tiny standard timeout — on the OLD behaviour the connector subtask
          // would time out during the confirmation pause.
          workerTimeoutMs: 20,
          writeDispatchGraceMs: 1_000,
        }),
      ),
    );

    // Wait until the worker has dispatched connector.act, then idle well past the
    // standard 20ms worker timeout BEFORE resolving the dispatch.
    await dispatchStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);

    // The user finally confirms and the external write completes ok.
    dispatchResult.resolve({
      invocationId: 'inv_connector',
      outcome: 'ok',
      resultJson: { ok: true, data: { id: 'evt_123' } },
      ledgerEntry: {
        invokedAt: new Date().toISOString(),
        toolName: 'connector.act',
        scope: 'svc_1:create_event:mode=always_ask',
        approvedPath: null,
        outcome: 'ok',
        reason: null,
        skillPackId: connectorPack.id,
        turnId: 'turn_1',
      },
    });

    const events = await eventsPromise;

    // The deferral kept the subtask alive — NO worker timeout error.
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_connector',
        status: 'error',
        detail: 'ORCHESTRATOR_WORKER_TIMEOUT',
      }),
    );
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(workerCalls).toBe(2);
    // The connector.act ledger landed.
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ledger',
        entry: expect.objectContaining({ toolName: 'connector.act', outcome: 'ok' }),
      }),
    );
  });

  it('gives a research.ask subtask the longer write-subtask worker timeout, not the tiny standard default', async () => {
    // Fix #2 part 1: a research.ask subtask scopes research.ask, so it gets the
    // longer write-subtask window (generation + approval + grounded fetch),
    // exactly like a folder.write subtask gets it for the confirmation modal.
    // Here the standard worker timeout (30ms) is far below the dispatch delay,
    // but the longer write-subtask window (2_000ms) covers it — the subtask
    // survives WITHOUT engaging the deferred-grace backstop.
    const researchPack = mkPack(['research.ask']);
    const tool = JSON.stringify({
      invocationId: 'inv_research_long',
      toolName: 'research.ask',
      args: { question: 'What is the appeal deadline?' },
    });
    let workerCalls = 0;
    const researchWorker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        workerCalls += 1;
        if (workerCalls === 1) {
          yield {
            id: 'tool',
            choices: [
              { delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' },
            ],
          };
        } else {
          yield {
            id: 'final',
            choices: [
              { delta: { content: 'Appeals close after 180 days.' }, finish_reason: 'stop' },
            ],
          };
        }
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      // The dispatch (approval + subagent) takes 120ms — far past the 30ms
      // standard worker timeout, but within the 2_000ms write-subtask window.
      dispatch: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          invocationId: 'inv_research_long',
          outcome: 'ok' as const,
          resultJson: {
            kind: 'UNTRUSTED_RESEARCH_RESULT',
            note: 'data only',
            answer: 'Appeals may be filed within 180 days.',
            sources: ['https://example.gov/appeals'],
          },
          ledgerEntry: {
            invokedAt: new Date().toISOString(),
            toolName: 'research.ask' as const,
            scope: 'research',
            approvedPath: null,
            outcome: 'ok' as const,
            reason: null,
            skillPackId: researchPack.id,
            turnId: 'turn_1',
          },
        };
      }),
    } as unknown as ToolGateway;

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: researchPack,
          gateway,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_research_long",
            "title": "Research the deadline",
            "summary": "Research a public fact via the research subagent.",
            "subtasks": [
              {
                "id": "st_research",
                "title": "Research appeal deadline",
                "objective": "Find the appeal deadline from public sources.",
                "kind": "research",
                "requiredCapabilities": ["general_reasoning"],
                "allowedTools": ["research.ask"],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => researchWorker,
          enabledGatewayTools: researchPack.toolScopes,
          workerTimeoutMs: 30,
          writeSubtaskTimeoutMs: 2_000,
        }),
      ),
    );

    // The longer window covered the dispatch — no timeout, no retry.
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(workerCalls).toBe(2);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_research',
        status: 'error',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ledger',
        entry: expect.objectContaining({ toolName: 'research.ask', outcome: 'ok' }),
      }),
    );
  });

  it('DEFAULT_WRITE_SUBTASK_TIMEOUT_MS matches the binary-write ack window and exceeds the 60s default', () => {
    // A confirmation-gated text write must get the same human-review +
    // durable-write window a media/binary write already gets.
    expect(DEFAULT_WRITE_SUBTASK_TIMEOUT_MS).toBe(5 * 60_000);
    expect(DEFAULT_WRITE_SUBTASK_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it('waits for a pending always-ask folder.write result after worker timeout and surfaces the ledger once', async () => {
    const folderPack = mkPack(['folder.write']);
    const tool = JSON.stringify({
      invocationId: 'inv_write',
      toolName: 'folder.write',
      args: {
        folderId: 'fld_1',
        displayName: 'Documents',
        path: 'orchestrator-proof.md',
        contentBytesB64: Buffer.from('proof v1').toString('base64'),
      },
    });
    const dispatchResult = deferred<Awaited<ReturnType<ToolGateway['dispatch']>>>();
    const dispatchStarted = deferred<void>();
    const calls: string[] = [];
    const worker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        yield {
          id: 'tool',
          choices: [{ delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' }],
        };
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async () => {
        dispatchStarted.resolve();
        return dispatchResult.promise;
      }),
    } as unknown as ToolGateway;

    const eventsPromise = collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          gateway,
          models: [...models, anthropicWritingModel()],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Write proof",
            "summary": "Write the terminal proof artifact.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Write proof file",
                "objective": "Write the final proof artifact.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return worker;
          },
          enabledGatewayTools: folderPack.toolScopes,
          workerTimeoutMs: 5,
          writeDispatchGraceMs: 100,
        }),
      ),
    );
    await dispatchStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toEqual(['gpt-5.5']);
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);

    dispatchResult.resolve({
      invocationId: 'late_invocation',
      outcome: 'ok',
      resultJson: { writtenPath: 'orchestrator-proof.md' },
      ledgerEntry: {
        invokedAt: new Date().toISOString(),
        toolName: 'folder.write',
        scope: 'folder/Documents',
        approvedPath: 'orchestrator-proof.md',
        outcome: 'ok',
        reason: null,
        skillPackId: folderPack.id,
        turnId: 'turn_1',
      },
    });
    const events = await eventsPromise;

    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['gpt-5.5']);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'blocked',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'error',
        detail: 'ORCHESTRATOR_WORKER_TIMEOUT_AFTER_WRITE_DISPATCH',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'error',
        detail: 'ORCHESTRATOR_WORKER_TIMEOUT_WRITE_DISPATCH_ABANDONED',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ledger',
        entry: expect.objectContaining({
          toolName: 'folder.write',
          outcome: 'ok',
          approvedPath: 'orchestrator-proof.md',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'done',
      }),
    );
  });

  it('surfaces a pending folder.write error ledger after worker timeout without rerouting', async () => {
    const folderPack = mkPack(['folder.write']);
    const tool = JSON.stringify({
      invocationId: 'inv_write',
      toolName: 'folder.write',
      args: {
        folderId: 'fld_1',
        displayName: 'Documents',
        path: 'orchestrator-proof.md',
        contentBytesB64: Buffer.from('proof v1').toString('base64'),
      },
    });
    const dispatchResult = deferred<Awaited<ReturnType<ToolGateway['dispatch']>>>();
    const dispatchStarted = deferred<void>();
    const calls: string[] = [];
    const worker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        yield {
          id: 'tool',
          choices: [{ delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' }],
        };
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async () => {
        dispatchStarted.resolve();
        return dispatchResult.promise;
      }),
    } as unknown as ToolGateway;

    const eventsPromise = collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          gateway,
          models: [...models, anthropicWritingModel()],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Write proof",
            "summary": "Write the terminal proof artifact.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Write proof file",
                "objective": "Write the final proof artifact.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return worker;
          },
          enabledGatewayTools: folderPack.toolScopes,
          workerTimeoutMs: 5,
          writeDispatchGraceMs: 100,
        }),
      ),
    );
    await dispatchStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toEqual(['gpt-5.5']);
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);

    dispatchResult.resolve({
      invocationId: 'late_invocation',
      outcome: 'error',
      reason: 'BRIDGE_ERROR',
      resultJson: { status: 'error', reason: 'BRIDGE_ERROR' },
      ledgerEntry: {
        invokedAt: new Date().toISOString(),
        toolName: 'folder.write',
        scope: 'folder/Documents',
        approvedPath: null,
        outcome: 'error',
        reason: 'BRIDGE_ERROR',
        skillPackId: folderPack.id,
        turnId: 'turn_1',
      },
    });
    const events = await eventsPromise;

    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['gpt-5.5']);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'blocked',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ledger',
        entry: expect.objectContaining({
          toolName: 'folder.write',
          outcome: 'error',
          reason: 'BRIDGE_ERROR',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'error',
        detail: 'ORCHESTRATOR_WORKER_TIMEOUT_AFTER_WRITE_DISPATCH',
      }),
    );
  });

  it('caps the deferred folder.write wait when the client bridge never returns', async () => {
    const folderPack = mkPack(['folder.write']);
    const tool = JSON.stringify({
      invocationId: 'inv_write',
      toolName: 'folder.write',
      args: {
        folderId: 'fld_1',
        displayName: 'Documents',
        path: 'orchestrator-proof.md',
        contentBytesB64: Buffer.from('proof v1').toString('base64'),
      },
    });
    const dispatchStarted = deferred<void>();
    const calls: string[] = [];
    const worker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        yield {
          id: 'tool',
          choices: [{ delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' }],
        };
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async () => {
        dispatchStarted.resolve();
        return new Promise<Awaited<ReturnType<ToolGateway['dispatch']>>>(
          () => undefined,
        );
      }),
    } as unknown as ToolGateway;

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          gateway,
          models: [...models, anthropicWritingModel()],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Write proof",
            "summary": "Write the terminal proof artifact.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Write proof file",
                "objective": "Write the final proof artifact.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return worker;
          },
          enabledGatewayTools: folderPack.toolScopes,
          workerTimeoutMs: 5,
          writeDispatchGraceMs: 5,
        }),
      ),
    );
    await dispatchStarted.promise;

    expect(calls).toEqual(['gpt-5.5']);
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'blocked',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'error',
        detail: 'ORCHESTRATOR_WORKER_TIMEOUT_WRITE_DISPATCH_ABANDONED',
      }),
    );
  });

  it('instructs folder.write workers to invoke the write tool before streaming final prose', async () => {
    const folderPack = mkPack(['folder.write']);
    let capturedWorkerPrompt = '';
    const worker: ChatProcessor = {
      async *streamChat(messages): AsyncGenerator<ChatChunk> {
        capturedWorkerPrompt = messages.at(-1)?.content ?? '';
        yield {
          id: 'chunk',
          choices: [{ delta: { content: 'Done.' }, finish_reason: null }],
        };
      },
    };

    await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Write proof",
            "summary": "Write the terminal proof artifact.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Write proof file",
                "objective": "Write the final proof artifact.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => worker,
          enabledGatewayTools: folderPack.toolScopes,
        }),
      ),
    );

    expect(capturedWorkerPrompt).toContain(
      'For folder.write subtasks, invoke folder.write before streaming final prose',
    );
    expect(capturedWorkerPrompt).toContain(
      'Do not stream the full artifact as assistant text before the write tool call',
    );
  });

  it('errors a never-written folder.write subtask but DELIVERS the suppressed text as fallback', async () => {
    // 2026-06-12 live finding 3/3b: workers generated the full deliverable
    // (2,427 and 3,392 chars seen) as suppressed pre-write text, never called
    // folder.write, and the artifact was silently discarded — the user got a
    // green banner and nothing else. Suppression remains correct on the
    // success path (the file is the deliverable); on the failure path the
    // prepared content must reach the user as subtask text.
    const folderPack = mkPack(['folder.write']);
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Write proof",
            "summary": "Write the terminal proof artifact.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Write proof file",
                "objective": "Write the final proof artifact.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => processor('I wrote the file.'),
          enabledGatewayTools: folderPack.toolScopes,
        }),
      ),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'error',
        detail: 'ORCHESTRATOR_REQUIRED_WRITE_NOT_CALLED',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'done',
      }),
    );
    const fallbackText = events
      .filter(
        (e): e is Extract<typeof e, { kind: 'orchestrator-text' }> =>
          e.kind === 'orchestrator-text' && e.subtaskId === 'st_write',
      )
      .map((e) => e.text)
      .join('');
    expect(fallbackText).toContain('I wrote the file.');
    expect(fallbackText).toContain('could not be saved');
  });

  it('does not require folder.write when another artifact tool is available for the subtask', async () => {
    const folderPack = mkPack(['doc.draft', 'folder.write']);
    const worker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        yield {
          id: 'chunk',
          choices: [{ delta: { content: 'Drafted the document.' }, finish_reason: null }],
        };
      },
    };

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Draft document",
            "summary": "Draft the requested document.",
            "subtasks": [
              {
                "id": "st_draft",
                "title": "Draft document",
                "objective": "Draft the user-facing document.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["doc.draft", "folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => worker,
          enabledGatewayTools: folderPack.toolScopes,
          workerTimeoutMs: 500,
        }),
      ),
    );

    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_draft',
        status: 'error',
        detail: 'ORCHESTRATOR_REQUIRED_WRITE_NOT_CALLED',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_draft',
        status: 'done',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-text',
        subtaskId: 'st_draft',
        text: 'Drafted the document.',
      }),
    );
  });

  it('reports a count when pre-write prose is suppressed before a successful folder.write', async () => {
    const folderPack = mkPack(['folder.write']);
    const prewrite = 'Brief note.';
    const tool = JSON.stringify({
      invocationId: 'inv_write',
      toolName: 'folder.write',
      args: {
        folderId: 'fld_1',
        displayName: 'Documents',
        path: 'orchestrator-proof.md',
        contentBytesB64: Buffer.from('proof v1').toString('base64'),
      },
    });
    let providerCalls = 0;
    const worker: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        providerCalls += 1;
        if (providerCalls > 1) return;
        yield {
          id: 'prewrite',
          choices: [{ delta: { content: prewrite }, finish_reason: null }],
        };
        yield {
          id: 'tool',
          choices: [{ delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' }],
        };
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async (frame: ToolInvocationFrame) => ({
        invocationId: frame.invocationId,
        outcome: 'ok' as const,
        resultJson: { writtenPath: 'orchestrator-proof.md' },
        ledgerEntry: {
          invokedAt: new Date().toISOString(),
          toolName: 'folder.write' as const,
          scope: 'folder/Documents',
          approvedPath: 'orchestrator-proof.md',
          outcome: 'ok' as const,
          reason: null,
          skillPackId: folderPack.id,
          turnId: 'turn_1',
        },
      })),
    } as unknown as ToolGateway;

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          gateway,
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Write proof",
            "summary": "Write the terminal proof artifact.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Write proof file",
                "objective": "Write the final proof artifact.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => worker,
          enabledGatewayTools: folderPack.toolScopes,
          workerTimeoutMs: 500,
        }),
      ),
    );

    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-text',
        subtaskId: 'st_write',
        text: prewrite,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'running',
        detail: `ORCHESTRATOR_PRE_WRITE_TEXT_SUPPRESSED:${prewrite.length}`,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ledger',
        entry: expect.objectContaining({
          toolName: 'folder.write',
          outcome: 'ok',
        }),
      }),
    );
  });

  it('can reroute a folder.write worker failure after suppressing pre-write prose', async () => {
    const folderPack = mkPack(['folder.write']);
    const tool = JSON.stringify({
      invocationId: 'inv_write',
      toolName: 'folder.write',
      args: {
        folderId: 'fld_1',
        displayName: 'Documents',
        path: 'orchestrator-proof.md',
        contentBytesB64: Buffer.from('proof v2').toString('base64'),
      },
    });
    const calls: string[] = [];
    const primary: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        yield {
          id: 'prose',
          choices: [{ delta: { content: 'Drafting the whole file first...' }, finish_reason: null }],
        };
        throw new ProviderError({
          providerId: 'openai',
          providerName: 'OpenAI',
          status: 429,
          kind: 'rate_limit',
        });
      },
    };
    const fallback: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        yield {
          id: 'tool',
          choices: [{ delta: { content: `<tool>${tool}</tool>` }, finish_reason: 'stop' }],
        };
      },
    };
    const gateway = {
      prepareInvocation: vi.fn((frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: frame,
      })),
      dispatch: vi.fn(async (frame: ToolInvocationFrame) => ({
        invocationId: frame.invocationId,
        outcome: 'ok' as const,
        resultJson: { writtenPath: 'orchestrator-proof.md' },
        ledgerEntry: {
          invokedAt: new Date().toISOString(),
          toolName: 'folder.write' as const,
          scope: 'folder/Documents',
          approvedPath: 'orchestrator-proof.md',
          outcome: 'ok' as const,
          reason: null,
          skillPackId: folderPack.id,
          turnId: 'turn_1',
        },
      })),
    } as unknown as ToolGateway;

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: folderPack,
          gateway,
          models: [...models, anthropicWritingModel()],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_write",
            "title": "Write proof",
            "summary": "Write the terminal proof artifact.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Write proof file",
                "objective": "Write the final proof artifact.",
                "kind": "writing",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": ["folder.write"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return modelId === 'gpt-5.5' ? primary : fallback;
          },
          enabledGatewayTools: folderPack.toolScopes,
        }),
      ),
    );

    expect(calls.slice(0, 2)).toEqual(['gpt-5.5', 'claude-opus-4-7']);
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'running',
        detail: 'ORCHESTRATOR_PRE_WRITE_TEXT_SUPPRESSED:32',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_write',
        status: 'blocked',
        detail: 'ORCHESTRATOR_PROVIDER_REROUTE',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'ledger',
        entry: expect.objectContaining({
          toolName: 'folder.write',
          outcome: 'ok',
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-text',
        text: 'Drafting the whole file first...',
      }),
    );
  });

  it('hands bounded working memory from one subtask to a dependent worker', async () => {
    const capturedMessages: ChatMessage[][] = [];
    const first = processor(
      'resume.pdf and openai-role.txt found; resume missing Brianni AI work',
    );
    const second: ChatProcessor = {
      async *streamChat(messages): AsyncGenerator<ChatChunk> {
        capturedMessages.push(JSON.parse(JSON.stringify(messages)));
        yield {
          id: 'chunk',
          choices: [{ delta: { content: 'Letter drafted.' }, finish_reason: null }],
        };
      },
    };
    let workerIndex = 0;
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Prepare application materials",
            "summary": "Read then write.",
            "subtasks": [
              {
                "id": "st_read",
                "title": "Read linked folder",
                "objective": "Find resume and vacancy.",
                "kind": "file_inspection",
                "requiredCapabilities": ["fast_reasoning"],
                "allowedTools": ["folder.list", "folder.read", "file.read"],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              },
              {
                "id": "st_write",
                "title": "Draft letter",
                "objective": "Write tailored application letter.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": ["doc.draft"],
                "dependsOn": ["st_read"],
                "producesArtifact": true,
                "risk": "medium"
              }
            ]
          }`),
          workerProviderFactory: () => {
            workerIndex += 1;
            return workerIndex === 1 ? first : second;
          },
        }),
      ),
    );

    expect(events.at(-1)).toMatchObject({ kind: 'done' });
    const secondPrompt = JSON.stringify(capturedMessages.at(-1));
    expect(secondPrompt).toContain('Orchestrator memory');
    expect(secondPrompt).toContain('resume missing Brianni AI work');
  });

  it('runs dependencies before dependents even when planner returns them out of order', async () => {
    const started: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Out of order",
            "summary": "Dependency sort.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Draft letter",
                "objective": "Write letter.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": ["doc.draft"],
                "dependsOn": ["st_read"],
                "producesArtifact": true,
                "risk": "medium"
              },
              {
                "id": "st_read",
                "title": "Read linked folder",
                "objective": "Read files.",
                "kind": "file_inspection",
                "requiredCapabilities": ["fast_reasoning"],
                "allowedTools": ["folder.list"],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: () => {
            return {
              async *streamChat(messages): AsyncGenerator<ChatChunk> {
                const content = messages.at(-1)?.content ?? '';
                started.push(
                  content.includes('Subtask: Read linked folder')
                    ? 'st_read'
                    : 'st_write',
                );
                yield {
                  id: 'chunk',
                  choices: [{ delta: { content: 'ok' }, finish_reason: null }],
                };
              },
            };
          },
        }),
      ),
    );

    expect(started.slice(0, 2)).toEqual(['st_read', 'st_write']);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('recovers from unknown dependencies and cycles via planner retry then single-step fallback', async () => {
    const unknownDependencyEvents = await collectEvents(
      runOrchestrator(
        baseDeps({
          agentTurnId: 'turn_unknown',
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Bad plan",
            "summary": "Bad dependency.",
            "subtasks": [
              {
                "id": "st_write",
                "title": "Draft",
                "objective": "Draft.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": ["doc.draft"],
                "dependsOn": ["st_missing"],
                "producesArtifact": true,
                "risk": "medium"
              }
            ]
          }`),
        }),
      ),
    );
    const cycleEvents = await collectEvents(
      runOrchestrator(
        baseDeps({
          agentTurnId: 'turn_cycle',
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Cycle",
            "summary": "Cycle.",
            "subtasks": [
              {
                "id": "st_a",
                "title": "A",
                "objective": "A.",
                "kind": "reasoning",
                "requiredCapabilities": ["general_reasoning"],
                "allowedTools": [],
                "dependsOn": ["st_b"],
                "producesArtifact": false,
                "risk": "low"
              },
              {
                "id": "st_b",
                "title": "B",
                "objective": "B.",
                "kind": "reasoning",
                "requiredCapabilities": ["general_reasoning"],
                "allowedTools": [],
                "dependsOn": ["st_a"],
                "producesArtifact": false,
                "risk": "low"
              }
            ]
          }`),
        }),
      ),
    );

    // The planner re-prompts once; the stub returns the same malformed plan
    // both times, so it degrades to the single-step fallback (st_single),
    // which completes — the turn no longer hard-fails with PLAN_FAILED.
    for (const events of [unknownDependencyEvents, cycleEvents]) {
      expect(events).not.toContainEqual(
        expect.objectContaining({ detail: 'ORCHESTRATOR_PLAN_FAILED' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'orchestrator-progress',
          subtaskId: 'st_single',
          status: 'done',
        }),
      );
      expect(events.at(-1)).toMatchObject({ kind: 'done' });
    }
  });

  it('falls back to a scoped memory-write subtask when the planner times out', async () => {
    const memoryPack = mkPack([
      'memory.list',
      'memory.read',
      'memory.write',
      'file.read',
      'folder.list',
      'folder.read',
      'folder.write',
    ]);
    let timeoutSignal: AbortSignal | undefined;
    const hangingPlanner: ChatProcessor = {
      async *streamChat(_messages, opts): AsyncGenerator<ChatChunk> {
        timeoutSignal = opts.signal;
        await new Promise(() => undefined);
      },
    };

    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          agentTurnId: 'turn_memory_timeout',
          pack: memoryPack,
          plannerProvider: hangingPlanner,
          plannerTimeoutMs: 1,
          enabledGatewayTools: memoryPack.toolScopes,
          messages: [
            {
              role: 'user',
              content:
                'For this proof run, remember that my synthetic tea preference is jasmine green tea. Store it as a low-sensitivity preference for future Calypso tasks, then tell me briefly what you saved.',
            },
          ],
          workerProviderFactory: () =>
            processor('Saved jasmine green tea as a low-sensitivity preference.'),
        }),
      ),
    );

    expect(timeoutSignal?.aborted).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'planner',
        status: 'blocked',
        detail: 'ORCHESTRATOR_PLANNER_TIMEOUT_FALLBACK',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ detail: 'ORCHESTRATOR_PLANNER_TIMEOUT' }),
    );

    const planEvent = events.find((event) => event.kind === 'orchestrator-plan');
    expect(planEvent).toBeDefined();
    if (!planEvent || planEvent.kind !== 'orchestrator-plan') {
      throw new Error('expected orchestrator plan event');
    }
    expect(planEvent.plan.subtasks).toHaveLength(1);
    expect(planEvent.plan.subtasks[0]).toMatchObject({
      id: 'st_memory_write',
      kind: 'tool_action',
      allowedTools: ['memory.write'],
      producesArtifact: true,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_memory_write',
        status: 'done',
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('falls back for planner provider throws but still reports cancellation', async () => {
    const throwingPlanner: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        throw new Error('planner exploded');
      },
    };
    const abortedController = new AbortController();
    abortedController.abort();

    const thrown = await collectEvents(
      runOrchestrator(baseDeps({ agentTurnId: 'turn_throw', plannerProvider: throwingPlanner })),
    );
    const cancelled = await collectEvents(
      runOrchestrator(
        baseDeps({
          agentTurnId: 'turn_cancel',
          abortSignal: abortedController.signal,
        }),
      ),
    );

    expect(thrown).toContainEqual(
      expect.objectContaining({
        subtaskId: 'planner',
        status: 'blocked',
        detail: 'ORCHESTRATOR_PLAN_FAILED_FALLBACK',
      }),
    );
    expect(thrown).not.toContainEqual(
      expect.objectContaining({
        subtaskId: 'planner',
        status: 'error',
        detail: 'ORCHESTRATOR_PLAN_FAILED',
      }),
    );
    expect(thrown).toContainEqual(
      expect.objectContaining({
        subtaskId: 'st_single',
        status: 'done',
      }),
    );
    expect(cancelled).toContainEqual(
      expect.objectContaining({ detail: 'ORCHESTRATOR_CANCELLED' }),
    );
    expect(thrown.at(-1)).toMatchObject({ kind: 'done' });
    expect(cancelled.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('reroutes a planner rate limit to another provider before using the deterministic fallback plan', async () => {
    const plannerCalls: string[] = [];
    const fallbackPlanJson = `{
      "planId": "provider_fallback_plan",
      "title": "Provider fallback plan",
      "summary": "Planned by fallback provider.",
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
    }`;
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          models: [...models, anthropicWritingModel()],
          plannerModelCandidates: ['gpt-5.5', 'claude-opus-4-7'],
          workerProviderFactory: (modelId) => {
            plannerCalls.push(modelId);
            if (plannerCalls.length === 1) {
              return throwingProcessor(new Error('OpenAI API error: 429'));
            }
            if (plannerCalls.length === 2) {
              return plannerProcessor(fallbackPlanJson);
            }
            return processor('Draft complete.');
          },
        }),
      ),
    );
    const rerouteIndex = events.findIndex(
      (event) =>
        event.kind === 'orchestrator-progress' &&
        event.detail === 'ORCHESTRATOR_PROVIDER_REROUTE',
    );
    const planIndex = events.findIndex(
      (event) => event.kind === 'orchestrator-plan',
    );

    expect(plannerCalls.slice(0, 2)).toEqual(['gpt-5.5', 'claude-opus-4-7']);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'planner',
        status: 'blocked',
        detail: 'ORCHESTRATOR_PROVIDER_REROUTE',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-plan',
        plan: expect.objectContaining({ title: 'Provider fallback plan' }),
      }),
    );
    expect(rerouteIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeGreaterThan(rerouteIndex);
  });

  it('reroutes summary generation to another provider before falling back locally', async () => {
    const downstreamMessages: ChatMessage[][] = [];
    const longText = 'completed detail '.repeat(140);
    let anthropicCalls = 0;
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          models: [...models, anthropicWritingModel()],
          summaryModelCandidates: ['gpt-5.4-mini', 'claude-opus-4-7'],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_summary",
            "title": "Summary failover",
            "summary": "Summarize first step for second step.",
            "subtasks": [
              {
                "id": "st_first",
                "title": "First",
                "objective": "Produce long intermediate text.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": [],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              },
              {
                "id": "st_second",
                "title": "Second",
                "objective": "Use the summary.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": [],
                "dependsOn": ["st_first"],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
          workerProviderFactory: (modelId) => {
            if (modelId === 'gpt-5.4-mini') {
              return throwingProcessor(new Error('OpenAI API error: 429'));
            }
            if (modelId === 'claude-opus-4-7') {
              anthropicCalls += 1;
              if (anthropicCalls === 1) {
                return processor('Summary from fallback.');
              }
            }
            return {
              async *streamChat(messages): AsyncGenerator<ChatChunk> {
                if (
                  messages.some((message) =>
                    message.content.includes('Subtask: Second'),
                  )
                ) {
                  downstreamMessages.push(messages);
                  yield {
                    id: 'chunk_second',
                    choices: [
                      { delta: { content: 'Second complete.' }, finish_reason: null },
                    ],
                  };
                  return;
                }
                yield {
                  id: 'chunk_first',
                  choices: [
                    { delta: { content: longText }, finish_reason: null },
                  ],
                };
              },
            };
          },
        }),
      ),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ detail: 'ORCHESTRATOR_PROVIDER_REROUTE' }),
    );
    expect(
      downstreamMessages.some((messages) =>
        messages.some((message) =>
          message.content.includes('Summary from fallback.'),
        ),
      ),
    ).toBe(true);
  });

  it('skips transitive dependents when a subtask cannot be routed or a worker fails', async () => {
    const routeFailureEvents = await collectEvents(
      runOrchestrator(
        baseDeps({
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Needs image",
            "summary": "Unsupported modality.",
            "subtasks": [
              {
                "id": "st_image",
                "title": "Create image",
                "objective": "Generate an image.",
                "kind": "image",
                "requiredCapabilities": ["image_generation"],
                "allowedTools": [],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              },
              {
                "id": "st_write",
                "title": "Write caption",
                "objective": "Write caption.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": ["doc.draft"],
                "dependsOn": ["st_image"],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
        }),
      ),
    );
    const clientBridge = vi.fn();
    const workerFailureEvents = await collectEvents(
      runOrchestrator(
        baseDeps({
          gateway: gateway(clientBridge),
          workerProviderFactory: () => throwingProcessor(),
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Write files",
            "summary": "Failure.",
            "subtasks": [
              {
                "id": "st_read",
                "title": "Read",
                "objective": "Read.",
                "kind": "reasoning",
                "requiredCapabilities": ["general_reasoning"],
                "allowedTools": [],
                "dependsOn": [],
                "producesArtifact": false,
                "risk": "low"
              },
              {
                "id": "st_write",
                "title": "Write",
                "objective": "Write.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": ["folder.write"],
                "dependsOn": ["st_read"],
                "producesArtifact": true,
                "risk": "medium"
              }
            ]
          }`),
        }),
      ),
    );

    // st_image fails to route. st_write is a TERMINAL writing step (nothing
    // depends on it), so D1 spares it from the skip-cascade — it runs and
    // reports the failure (with the default non-throwing worker it reaches
    // 'done') instead of leaving the user with no answer at all.
    expect(routeFailureEvents).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_image',
        status: 'error',
      }),
    );
    expect(routeFailureEvents).not.toContainEqual(
      expect.objectContaining({ subtaskId: 'st_write', status: 'skipped' }),
    );
    expect(routeFailureEvents).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_write', status: 'done' }),
    );
    // Worker-failure variant: st_read's worker throws (all workers throw here).
    // st_write (terminal writing) is NOT skipped — it runs; with the all-throwing
    // worker its own call also fails, so it errors honestly rather than vanishing.
    expect(workerFailureEvents).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_read', status: 'error' }),
    );
    expect(workerFailureEvents).not.toContainEqual(
      expect.objectContaining({ subtaskId: 'st_write', status: 'skipped' }),
    );
    expect(workerFailureEvents).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_write', status: 'running' }),
    );
    expect(clientBridge).not.toHaveBeenCalled();
    expect(routeFailureEvents.at(-1)).toMatchObject({ kind: 'done' });
    expect(workerFailureEvents.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('retries the worker on a transient provider error (not just timeout) before failing the subtask', async () => {
    // A transient provider failure (429/network) on the primary model with a
    // fallback model available previously failed the whole subtask — only
    // ORCHESTRATOR_WORKER_TIMEOUT was retryable. Since no output was emitted,
    // the orchestrator should fall back to the next model instead.
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return modelId === 'gpt-5.5'
              ? throwingProcessor(new Error('provider 429'))
              : processor('Draft complete on fallback.');
          },
        }),
      ),
    );

    // The two WORKER attempts are primary then fallback. (A later
    // gpt-5.4-mini call is the post-success memory-summary factory call.)
    expect(calls.slice(0, 2)).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_1',
        status: 'blocked',
        detail: 'ORCHESTRATOR_PROVIDER_REROUTE',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_1',
        status: 'done',
      }),
    );
    expect(
      events.filter(
        (event) =>
          event.kind === 'orchestrator-progress' &&
          event.subtaskId === 'st_1' &&
          event.status === 'error',
      ),
    ).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('reroutes a pre-output provider rate limit to a different provider', async () => {
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          models: [...models, anthropicWritingModel()],
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return modelId.startsWith('gpt-')
              ? throwingProcessor(new Error('OpenAI API error: 429'))
              : processor('Draft complete on Anthropic.');
          },
        }),
      ),
    );

    expect(calls.slice(0, 2)).toEqual(['gpt-5.5', 'claude-opus-4-7']);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_1',
        status: 'blocked',
        detail: 'ORCHESTRATOR_PROVIDER_REROUTE',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_1', status: 'done' }),
    );
  });

  it('does not reroute a 429 after worker text has streamed', async () => {
    const partialThenRateLimit: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        yield {
          id: 'chunk',
          choices: [{ delta: { content: 'partial' }, finish_reason: null }],
        };
        throw new ProviderError({
          providerId: 'openai',
          providerName: 'OpenAI',
          status: 429,
          kind: 'rate_limit',
        });
      },
    };
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          models: [...models, anthropicWritingModel()],
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return partialThenRateLimit;
          },
        }),
      ),
    );

    expect(calls).toEqual(['gpt-5.5']);
    expect(events).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_1', status: 'error' }),
    );
  });

  it('honors Retry-After from a structured provider error across later attempts', async () => {
    const now = 1_000;
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          nowMs: () => now,
          models: [...models, anthropicWritingModel()],
          workerProviderFactory: (modelId) => {
            calls.push(`${now}:${modelId}`);
            if (modelId === 'gpt-5.5' && calls.length === 1) {
              return throwingProcessor(
                new ProviderError({
                  providerId: 'openai',
                  providerName: 'OpenAI',
                  status: 429,
                  kind: 'rate_limit',
                  retryAfterMs: 10_000,
                }),
              );
            }
            return processor('Draft complete.');
          },
        }),
      ),
    );

    expect(calls[0]).toBe('1000:gpt-5.5');
    expect(calls[1]).toBe('1000:claude-opus-4-7');
    expect(events).toContainEqual(
      expect.objectContaining({ detail: 'ORCHESTRATOR_PROVIDER_REROUTE' }),
    );
  });

  it('uses ProviderError stored in error.cause for reroute classification', async () => {
    const cause = new ProviderError({
      providerId: 'openai',
      providerName: 'OpenAI',
      status: 429,
      kind: 'rate_limit',
      retryAfterMs: 10_000,
    });
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          models: [...models, anthropicWritingModel()],
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return modelId === 'gpt-5.5'
              ? throwingProcessor(
                  new Error('wrapped native-search failure', { cause }),
                )
              : processor('Draft complete.');
          },
        }),
      ),
    );

    expect(calls.slice(0, 2)).toEqual(['gpt-5.5', 'claude-opus-4-7']);
    expect(events).toContainEqual(
      expect.objectContaining({ detail: 'ORCHESTRATOR_PROVIDER_REROUTE' }),
    );
  });

  it('does not retry a worker error once output has already streamed (avoids duplicate output)', async () => {
    // If the primary model already streamed text and then threw, retrying
    // would duplicate the artifact. The subtask must fail instead.
    const partialThenThrow: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        yield {
          id: 'chunk',
          choices: [{ delta: { content: 'partial draft…' }, finish_reason: null }],
        };
        throw new Error('provider dropped mid-stream');
      },
    };
    const calls: string[] = [];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          workerProviderFactory: (modelId) => {
            calls.push(modelId);
            return partialThenThrow;
          },
        }),
      ),
    );

    expect(calls).toEqual(['gpt-5.5']); // no retry after partial output
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_1',
        status: 'error',
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('skips transitive dependents when the media executor is unavailable', async () => {
    // A routable video subtask whose media executor is not wired errored with
    // MEDIA_EXECUTOR_UNAVAILABLE but did NOT skip its dependents (unlike the
    // routing-failure path), so a dependent ran with missing input.
    const videoModel: ModelCapability = {
      modelId: 'veo-test',
      providerId: 'google',
      strengths: ['video_generation'],
      strengthQuality: [{ strength: 'video_generation', tier: 'frontier' }],
      modalities: ['text_in', 'video_out'],
      endpointFamily: 'video',
      costTier: 'high',
      latencyTier: 'slow',
      routingStatus: 'enabled',
      requiredGatewayTools: ['video.generate'],
    };
    const videoPack = mkPack([...pack.toolScopes, 'video.generate']);
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: videoPack,
          media: undefined,
          models: [...models, videoModel],
          enabledGatewayTools: videoPack.toolScopes,
          enabledEndpointFamilies: ['chat', 'video'],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Make and caption a clip",
            "summary": "Generate a clip then caption it.",
            "subtasks": [
              {
                "id": "st_video",
                "title": "Generate clip",
                "objective": "Generate a teaser clip.",
                "kind": "video",
                "requiredCapabilities": ["video_generation"],
                "allowedTools": ["video.generate"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "medium"
              },
              {
                "id": "st_caption",
                "title": "Caption clip",
                "objective": "Write a caption for the clip.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": ["doc.draft"],
                "dependsOn": ["st_video"],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
        }),
      ),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_video',
        status: 'error',
        detail: 'MEDIA_EXECUTOR_UNAVAILABLE',
      }),
    );
    // st_caption is a TERMINAL writing step → D1 spares it from the cascade so
    // the user gets a report ("couldn't caption — the clip wasn't generated")
    // instead of a silent skip. The MEDIA_EXECUTOR_UNAVAILABLE failure note is
    // in working memory, so the worker reports the failure rather than fabricating.
    expect(events).not.toContainEqual(
      expect.objectContaining({ subtaskId: 'st_caption', status: 'skipped' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_caption', status: 'done' }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('isolates a media resolver throw to the subtask: error + cascade, orchestrator survives (M6)', async () => {
    // The media branch (resolver hooks + runMediaSubtask drain) sat OUTSIDE
    // the per-subtask try/skip-cascade — a resolver throw propagated out of
    // runOrchestrator and the whole turn collapsed to AGENT_REQUEST_FAILED.
    const videoModel: ModelCapability = {
      modelId: 'veo-test',
      providerId: 'google',
      strengths: ['video_generation'],
      strengthQuality: [{ strength: 'video_generation', tier: 'frontier' }],
      modalities: ['text_in', 'video_out'],
      endpointFamily: 'video',
      costTier: 'high',
      latencyTier: 'slow',
      routingStatus: 'enabled',
      requiredGatewayTools: ['video.generate'],
    };
    const videoPack = mkPack([...pack.toolScopes, 'video.generate']);
    const media = {
      videoAdapters: {},
      checkpointClient: {},
      budgetClient: {},
      handleStore: {},
      provenanceSigner: {},
      consentVerifier: {},
      resolveProviderInput: vi
        .fn()
        .mockRejectedValue(new Error('media resolver exploded')),
    } as unknown as RunOrchestratorDeps['media'];
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: videoPack,
          media,
          models: [...models, videoModel],
          enabledGatewayTools: videoPack.toolScopes,
          enabledEndpointFamilies: ['chat', 'video'],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Make and caption a clip",
            "summary": "Generate a clip then caption it.",
            "subtasks": [
              {
                "id": "st_video",
                "title": "Generate clip",
                "objective": "Generate a teaser clip.",
                "kind": "video",
                "requiredCapabilities": ["video_generation"],
                "allowedTools": ["video.generate"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "medium"
              },
              {
                "id": "st_caption",
                "title": "Caption clip",
                "objective": "Write a caption for the clip.",
                "kind": "writing",
                "requiredCapabilities": ["writing"],
                "allowedTools": ["doc.draft"],
                "dependsOn": ["st_video"],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
        }),
      ),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'orchestrator-progress',
        subtaskId: 'st_video',
        status: 'error',
        detail: 'media resolver exploded',
      }),
    );
    // Terminal narrator survives the cascade (same contract as the
    // MEDIA_EXECUTOR_UNAVAILABLE path) and the run completes cleanly.
    expect(events).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_caption', status: 'done' }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('skips a CONSUMING dependent but spares a terminal narrator when an upstream fails (D1)', async () => {
    // Distinguishes the two cascade behaviours: a non-narration step that
    // consumes the failed artifact (st_edit, kind 'image') still skips, while the
    // final report (st_report, kind 'synthesis', terminal) survives to narrate.
    // st_gen is unroutable the same way the standalone NO_MODEL test makes it so:
    // an image model exists but its 'image' endpoint family is NOT enabled.
    const imageModel: ModelCapability = {
      modelId: 'img-test',
      providerId: 'openai',
      strengths: ['image_generation'],
      strengthQuality: [{ strength: 'image_generation', tier: 'frontier' }],
      modalities: ['text_in', 'image_out'],
      endpointFamily: 'image',
      costTier: 'high',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: ['image.generate'],
    };
    const imagePack = mkPack([
      ...pack.toolScopes,
      'image.generate',
      'image.transform',
    ]);
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          pack: imagePack,
          models: [...models, imageModel],
          enabledGatewayTools: imagePack.toolScopes,
          enabledEndpointFamilies: ['chat'],
          plannerProvider: plannerProcessor(`{
            "planId": "plan_1",
            "title": "Generate then edit then report",
            "summary": "An unroutable generation, a consuming edit, and a final report.",
            "subtasks": [
              {
                "id": "st_gen",
                "title": "Generate image",
                "objective": "Generate an image from a prompt (no enabled image model).",
                "kind": "image",
                "requiredCapabilities": ["image_generation"],
                "allowedTools": ["image.generate"],
                "dependsOn": [],
                "producesArtifact": true,
                "risk": "low"
              },
              {
                "id": "st_edit",
                "title": "Resize the image",
                "objective": "Resize the generated image.",
                "kind": "image",
                "requiredCapabilities": ["image_generation", "general_reasoning"],
                "allowedTools": ["image.transform"],
                "dependsOn": ["st_gen"],
                "producesArtifact": true,
                "risk": "low"
              },
              {
                "id": "st_report",
                "title": "Report outcome",
                "objective": "Summarise what happened.",
                "kind": "synthesis",
                "requiredCapabilities": ["writing", "general_reasoning"],
                "allowedTools": [],
                "dependsOn": ["st_edit"],
                "producesArtifact": true,
                "risk": "low"
              }
            ]
          }`),
        }),
      ),
    );

    // st_gen can't route (image.generate is a provider-only modality with no
    // enabled image model) → NO_MODEL_FOR_SUBTASK error.
    expect(events).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_gen', status: 'error' }),
    );
    // st_edit CONSUMES the missing image (kind 'image', not narration, and has a
    // dependent) → still skipped.
    expect(events).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_edit', status: 'skipped' }),
    );
    // st_report is the terminal narrator (synthesis, no dependents) → survives.
    expect(events).not.toContainEqual(
      expect.objectContaining({ subtaskId: 'st_report', status: 'skipped' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ subtaskId: 'st_report', status: 'done' }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('streams final artifact text once and splits large chunks', async () => {
    const large = 'x'.repeat(16_384);
    const events = await collectEvents(
      runOrchestrator(
        baseDeps({
          workerProviderFactory: () => chunkingProcessor([large]),
        }),
      ),
    );
    const textEvents = events.filter(
      (event) => event.kind === 'orchestrator-text',
    );

    expect(textEvents.map((event) => event.text).join('')).toBe(large);
    expect(textEvents.every((event) => event.role === 'final_artifact')).toBe(true);
    expect(textEvents.length).toBeGreaterThan(1);
  });

  it('requires producesArtifact in planner subtasks', () => {
    expect(() =>
      AgentTaskPlanSchema.parse({
        planId: 'plan_1',
        title: 'Bad plan',
        summary: 'Missing artifact flag.',
        subtasks: [
          {
            id: 'st_1',
            title: 'Draft',
            objective: 'Draft.',
            kind: 'writing',
            requiredCapabilities: ['writing'],
            allowedTools: ['doc.draft'],
            dependsOn: [],
            risk: 'low',
          },
        ],
      }),
    ).toThrow();
  });
});
