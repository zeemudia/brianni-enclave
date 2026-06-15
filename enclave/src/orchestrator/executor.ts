import {
  EGRESS_TAINT_READ_TOOLS,
  type AgentRequestContext,
  type AgentSubtask,
  type AgentTaskPlan,
  type ChatMessage,
  type ChatProcessor,
  type ModelCapability,
  type ModelEndpointFamily,
  type ModelRouteDecision,
  type OrchestratorWorkingMemoryEntry,
  type SkillPack,
  type ToolCallLedgerEntry,
  type ToolName,
  type ToolResultOutcome,
} from '@calypso/chat-types';

import {
  runAgentLoop,
  type AgentLoopDeps,
  type AgentLoopEvent,
} from '../agent/loop';
import {
  escapeFences,
  stripDangerousPrefixes,
} from '../agent/tool-output-sanitizer';
import {
  ProviderError,
  normaliseProviderError,
  providerErrorFromUnknown,
} from '../providers/errors';
import { resolveProviderDisplayName } from '../providers/display-name';
import type { ProviderResponseLike } from '../usage-report';
import type { ToolGateway } from '../tools';
import type {
  OrchestratorExecutorEvent,
  OrchestratorScopedAgentLoopEvent,
} from './events';
import { runMediaSubtask, type RunMediaSubtaskDeps } from './media-executor';
import {
  HONEST_MEDIA_GEN_DEGRADE_SUBTASK_ID,
  createFallbackTaskPlan,
  createTaskPlan,
  honestMediaGenDegradeMessage,
} from './planner';
import { ProviderHealth, buildAttemptModelIds } from './provider-health';
import { selectModelForSubtask } from './router';

export const MAX_WORKING_MEMORY_CHARS = 8_000;
const MAX_ORCHESTRATOR_TEXT_CHARS = 8_000;
const MAX_SUPPRESSED_PRE_WRITE_TEXT_CHARS = 1_000;
const DEFAULT_WRITE_DISPATCH_GRACE_MS = 60_000;
/**
 * Worker timeout for a `folder.write` subtask. Unlike a read/reasoning worker
 * (which streams within seconds or it's genuinely stuck), a write worker must
 * (1) generate the entire artifact as the write tool-call argument AND then
 * (2) sit blocked on the client's "Ask before saving" confirmation modal until
 * a human approves — which sends no interim events to keep the worker "alive".
 * The flat 60s default abandons such writes as ORCHESTRATOR_WORKER_TIMEOUT even
 * when the file lands clean (live 2026-06-13 finding). Give write subtasks the
 * same human-review + durable-write window a binary/media write already gets
 * (mirrors index.ts DEFAULT_BINARY_WRITE_ACK_TIMEOUT_MS = 5 min), and the
 * matching client-invocation resolver timeout for the dispatch itself.
 */
export const DEFAULT_WRITE_SUBTASK_TIMEOUT_MS = 5 * 60_000;
const ARTIFACT_PRODUCING_TOOLS = {
  'memory.list': false,
  'memory.read': false,
  'memory.write': false,
  'file.read': false,
  'folder.list': false,
  'folder.read': false,
  'folder.write': true,
  'web.fetch': false,
  'research.ask': false,
  'email.draft': true,
  'doc.draft': true,
  'event.draft': true,
  'image.inspect': false,
  'image.ocr': false,
  'image.transform': true,
  'image.generate': true,
  'image.edit': true,
  'audio.inspect': false,
  'audio.transcribe': false,
  'audio.transform': true,
  'audio.speech': true,
  'video.inspect': false,
  'video.transcribe': false,
  'video.transform': true,
  'video.generate': true,
  'video.render': true,
  'document.edit': true,
  'pdf.edit': true,
} satisfies Record<ToolName, boolean>;

export interface RunOrchestratorDeps {
  gateway: ToolGateway;
  pack: SkillPack;
  agentTurnId: string;
  plannerProvider: ChatProcessor;
  workerProviderFactory: (modelId: string) => ChatProcessor;
  plannerModel: string;
  summaryModel: string;
  plannerModelCandidates?: readonly string[];
  summaryModelCandidates?: readonly string[];
  providerDisplayNames?: ReadonlyMap<string, string>;
  models: readonly ModelCapability[];
  enabledGatewayTools: readonly ToolName[];
  enabledEndpointFamilies: readonly ModelEndpointFamily[];
  messages: ChatMessage[];
  requestContext?: AgentRequestContext;
  /**
   * Session id the binary work item is keyed under (so an image-generate write
   * ACK round-trips to the right resolver). Optional: tests omit it and the
   * media executor defaults to '' just like the worker binary-write path.
   */
  sessionId?: string;
  awaitBinaryWriteAck?: AgentLoopDeps['awaitBinaryWriteAck'];
  awaitMemoryWriteAck?: AgentLoopDeps['awaitMemoryWriteAck'];
  /**
   * Consent-gated private-read → web egress bridge. When a web.fetch subtask is
   * denied private-derived working memory by the egress isolation, the
   * orchestrator offers the user specific datums to PROMOTE across the boundary
   * (default DENY). Returns the candidate ids the user approved; undefined / a
   * throw / an absent callback all mean DENY (fail-closed). The orchestrator
   * never auto-carries private data — only an approved datum crosses.
   */
  awaitEgressPromotion?: (payload: {
    agentTurnId: string;
    planId: string;
    subtaskId: string;
    candidates: ReadonlyArray<{ id: string; label: string; content: string }>;
  }) => Promise<{ approvedIds: string[] } | undefined>;
  abortSignal?: AbortSignal;
  providerCallBudget?: number;
  plannerTimeoutMs?: number;
  workerTimeoutMs?: number;
  /**
   * Worker timeout for folder.write subtasks (generation + human confirmation).
   * Defaults to {@link DEFAULT_WRITE_SUBTASK_TIMEOUT_MS}. Falls back to
   * workerTimeoutMs when set but writeSubtaskTimeoutMs is not, so existing tests
   * that inject only workerTimeoutMs keep driving write-subtask timing.
   */
  writeSubtaskTimeoutMs?: number;
  writeDispatchGraceMs?: number;
  summaryTimeoutMs?: number;
  nowMs?: () => number;
  media?: {
    videoAdapters: RunMediaSubtaskDeps['videoAdapters'];
    imageAdapters?: RunMediaSubtaskDeps['imageAdapters'];
    // Mints the image-generate binary write request + chunks. image.generate
    // delivers its bytes through the binary write-ACK path (see media-executor),
    // so the executor threads this + the orchestrator's awaitBinaryWriteAck +
    // requestContext linked folders into runMediaSubtask.
    binaryWorkItems?: RunMediaSubtaskDeps['binaryWorkItems'];
    checkpointClient: RunMediaSubtaskDeps['checkpointClient'];
    budgetClient: RunMediaSubtaskDeps['budgetClient'];
    handleStore?: RunMediaSubtaskDeps['handleStore'];
    provenanceSigner?: RunMediaSubtaskDeps['provenanceSigner'];
    consentVerifier?: RunMediaSubtaskDeps['consentVerifier'];
    renderBackend?: RunMediaSubtaskDeps['renderBackend'];
    renderAttestationPolicy?: RunMediaSubtaskDeps['renderAttestationPolicy'];
    verifyRenderManifestSignature?: RunMediaSubtaskDeps['verifyRenderManifestSignature'];
    resolveProviderInput?: (input: {
      plan: AgentTaskPlan;
      subtask: AgentSubtask;
      route: ModelRouteDecision;
    }) => Promise<RunMediaSubtaskDeps['providerInput']>;
    resolveCompositionSpec?: (input: {
      plan: AgentTaskPlan;
      subtask: AgentSubtask;
      route: ModelRouteDecision;
    }) => Promise<RunMediaSubtaskDeps['compositionSpec']>;
    resolveRecords?: (input: {
      plan: AgentTaskPlan;
      subtask: AgentSubtask;
      route: ModelRouteDecision;
    }) => Promise<RunMediaSubtaskDeps['recordsByHandleId']>;
    encryptArtifact: RunMediaSubtaskDeps['encryptArtifact'];
    now?: RunMediaSubtaskDeps['now'];
  };
}

export async function* runOrchestrator(
  deps: RunOrchestratorDeps,
): AsyncGenerator<
  AgentLoopEvent | OrchestratorExecutorEvent | OrchestratorScopedAgentLoopEvent
> {
  let providerCallsRemaining =
    deps.providerCallBudget === undefined
      ? Number.POSITIVE_INFINITY
      : deps.providerCallBudget;
  const consumeProviderCall = (): boolean => {
    if (providerCallsRemaining <= 0) return false;
    providerCallsRemaining -= 1;
    return true;
  };
  const providerHealth = new ProviderHealth();
  const pendingUsageEvents: Extract<AgentLoopEvent, { kind: 'usage' }>[] = [];
  const captureUsage =
    (routeKind: Extract<AgentLoopEvent, { kind: 'usage' }>['routeKind']) =>
    (response: ProviderResponseLike): void => {
      pendingUsageEvents.push({ kind: 'usage', routeKind, response });
    };
  const drainPendingUsageEvents = function* (): Generator<
    Extract<AgentLoopEvent, { kind: 'usage' }>
  > {
    while (pendingUsageEvents.length > 0) {
      yield pendingUsageEvents.shift()!;
    }
  };
  const nowMs = deps.nowMs ?? (() => Date.now());
  const userText =
    [...deps.messages].reverse().find((message) => message.role === 'user')
      ?.content ?? '';
  const plannerModelCandidates = deps.plannerModelCandidates?.length
    ? deps.plannerModelCandidates
    : [];
  const summaryModelCandidates = deps.summaryModelCandidates?.length
    ? deps.summaryModelCandidates
    : [];
  type ProviderCandidateResult<T> =
    | { kind: 'progress'; event: OrchestratorExecutorEvent }
    | { kind: 'value'; value: T };

  async function* runProviderCandidate<T>(input: {
    planId: string;
    subtaskId: string;
    label: string;
    candidates: readonly string[];
    timeoutReason: string;
    timeoutMs: number;
    run: (modelId: string, signal: AbortSignal) => Promise<T>;
  }): AsyncGenerator<ProviderCandidateResult<T>, void> {
    const modelById = new Map(
      deps.models.map((model) => [model.modelId, model]),
    );
    const attemptedModelIds = new Set<string>();
    let lastError: unknown;

    while (attemptedModelIds.size < 2) {
      const [modelId] = orderModelIdsForProviderHealth(
        input.candidates,
        deps.models,
        providerHealth,
        nowMs(),
        1,
        attemptedModelIds,
      );
      if (!modelId) break;
      attemptedModelIds.add(modelId);

      if (!consumeProviderCall()) {
        throw new Error('ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED');
      }
      try {
        const value = await withTimeout(
          (signal) => input.run(modelId, signal),
          input.timeoutMs,
          deps.abortSignal,
          input.timeoutReason,
        );
        yield { kind: 'value', value };
        return;
      } catch (error) {
        lastError = error;
        const model = modelById.get(modelId);
        const providerError =
          providerErrorFromUnknown(error) ??
          (model
            ? normaliseProviderError(
                error,
                model.providerId,
                resolveProviderDisplayName(
                  model.providerId,
                  deps.providerDisplayNames,
                ),
              )
            : null);
        if (providerError instanceof ProviderError) {
          providerHealth.mark(providerError, nowMs());
        }
        const isTerminal =
          error instanceof Error &&
          (error.message === 'ORCHESTRATOR_CANCELLED' ||
            error.message === 'ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED');
        const hasFreshAttempt =
          attemptedModelIds.size < 2 &&
          orderModelIdsForProviderHealth(
            input.candidates,
            deps.models,
            providerHealth,
            nowMs(),
            1,
            attemptedModelIds,
          ).length > 0;
        if (isTerminal || !hasFreshAttempt) throw error;
        yield {
          kind: 'progress',
          event: {
            kind: 'orchestrator-progress',
            planId: input.planId,
            subtaskId: input.subtaskId,
            status: 'blocked',
            label: input.label,
            detail:
              providerError?.kind === 'rate_limit'
                ? 'ORCHESTRATOR_PROVIDER_REROUTE'
                : `${input.timeoutReason}_RETRY`,
          },
        };
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(input.timeoutReason);
  }

  let plan: AgentTaskPlan | undefined;
  let orderedSubtasks: AgentSubtask[];

  try {
    if (plannerModelCandidates.length > 0) {
      let planned = false;
      for await (const item of runProviderCandidate({
        planId: `plan_failed_${deps.agentTurnId}`,
        subtaskId: 'planner',
        label: 'Plan task',
        candidates: plannerModelCandidates,
        timeoutReason: 'ORCHESTRATOR_PLANNER_TIMEOUT',
        timeoutMs: deps.plannerTimeoutMs ?? 20_000,
        run: (modelId, signal) =>
          createTaskPlan({
            provider: deps.workerProviderFactory(modelId),
            model: modelId,
            userText,
            toolScopes: deps.pack.toolScopes,
            linkedFolderCount: deps.requestContext?.linkedFolders?.length ?? 0,
            abortSignal: signal,
            onUsage: captureUsage('agent_planner'),
          }),
      })) {
        yield* drainPendingUsageEvents();
        if (item.kind === 'progress') {
          yield item.event;
          continue;
        }
        plan = item.value;
        planned = true;
      }
      if (!planned) throw new Error('ORCHESTRATOR_PLAN_FAILED');
    } else {
      if (!consumeProviderCall()) {
        yield {
          kind: 'orchestrator-progress',
          planId: `plan_failed_${deps.agentTurnId}`,
          subtaskId: 'planner',
          status: 'error',
          label: 'Plan task',
          detail: 'ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED',
        };
        yield { kind: 'done' };
        return;
      }
      plan = await withTimeout(
        (signal) =>
          createTaskPlan({
            provider: deps.plannerProvider,
            model: deps.plannerModel,
            userText,
            toolScopes: deps.pack.toolScopes,
            linkedFolderCount: deps.requestContext?.linkedFolders?.length ?? 0,
            abortSignal: signal,
            onUsage: captureUsage('agent_planner'),
          }),
        deps.plannerTimeoutMs ?? 20_000,
        deps.abortSignal,
        'ORCHESTRATOR_PLANNER_TIMEOUT',
      );
      yield* drainPendingUsageEvents();
    }
  } catch (error) {
    yield* drainPendingUsageEvents();
    if (isTerminalPlannerError(error)) {
      yield {
        kind: 'orchestrator-progress',
        planId: `plan_failed_${deps.agentTurnId}`,
        subtaskId: 'planner',
        status: 'error',
        label: 'Plan task',
        detail: normalizePlannerError(error),
      };
      yield { kind: 'done' };
      return;
    }

    try {
      plan = createFallbackTaskPlan({
        userText,
        toolScopes: deps.pack.toolScopes,
        linkedFolderCount: deps.requestContext?.linkedFolders?.length ?? 0,
      });
      yield {
        kind: 'orchestrator-progress',
        planId: plan.planId,
        subtaskId: 'planner',
        status: 'blocked',
        label: 'Plan task',
        detail: plannerFallbackDetail(error),
      };
    } catch (fallbackError) {
      yield {
        kind: 'orchestrator-progress',
        planId: `plan_failed_${deps.agentTurnId}`,
        subtaskId: 'planner',
        status: 'error',
        label: 'Plan task',
        detail: normalizePlannerError(fallbackError),
      };
      yield { kind: 'done' };
      return;
    }
  }

  if (!plan) {
    yield {
      kind: 'orchestrator-progress',
      planId: `plan_failed_${deps.agentTurnId}`,
      subtaskId: 'planner',
      status: 'error',
      label: 'Plan task',
      detail: 'ORCHESTRATOR_PLAN_FAILED',
    };
    yield { kind: 'done' };
    return;
  }

  try {
    orderedSubtasks = orderSubtasks(plan);
  } catch (error) {
    yield {
      kind: 'orchestrator-progress',
      planId: `plan_failed_${deps.agentTurnId}`,
      subtaskId: 'planner',
      status: 'error',
      label: 'Plan task',
      detail: normalizePlannerError(error),
    };
    yield { kind: 'done' };
    return;
  }

  // Security boundary (egress isolation): identify subtasks whose output is
  // private-read-derived (they call a private read tool, or transitively depend
  // on one). A web.fetch worker must NOT receive these subtasks' summaries in
  // its model context, even though the orchestrator otherwise threads completed
  // work forward. The planner already strips private-derived DEPENDENCIES from
  // web.fetch subtasks; this is the independent runtime half — without it the
  // global working memory would still surface private-derived summaries (a
  // PARAPHRASE that can evade the literal egress-taint guard) to the egress
  // worker. plan is acyclic here (orderSubtasks threw otherwise).
  // Mutable: seeded from the STATIC plan structure (private-read tools + their
  // declared dependents), then grown at RUNTIME — any non-egress worker that is
  // shown private-derived memory becomes private-derived itself (see the loop
  // below), closing the no-tool relay path into a later web.fetch worker.
  const privateDerivedSubtaskIds = new Set(
    computePrivateDerivedSubtaskIds(plan),
  );

  const routeResults = orderedSubtasks.map((subtask) => {
    try {
      return {
        subtaskId: subtask.id,
        route: selectModelForSubtask(subtask, deps.models, {
          enabledGatewayTools: deps.enabledGatewayTools,
          enabledEndpointFamilies: deps.enabledEndpointFamilies,
        }),
      };
    } catch (error) {
      return { subtaskId: subtask.id, route: null, error };
    }
  });
  const routes = routeResults
    .map((result) => result.route)
    .filter((route): route is ModelRouteDecision => route !== null);

  const workingMemory: OrchestratorWorkingMemoryEntry[] = [];
  const skippedSubtaskIds = new Set<string>();
  let eventOrdinal = 0;

  yield { kind: 'orchestrator-plan', plan, routes };

  for (const subtask of orderedSubtasks) {
    if (skippedSubtaskIds.has(subtask.id)) continue;

    const routeResult = routeResults.find(
      (candidate) => candidate.subtaskId === subtask.id,
    );
    const route = routeResult?.route;
    if (!route) {
      const routeFailReason =
        routeResult?.error instanceof Error
          ? routeResult.error.message
          : 'No enabled model can handle this subtask.';
      yield {
        kind: 'orchestrator-progress',
        planId: plan.planId,
        subtaskId: subtask.id,
        status: 'error',
        label: subtask.title,
        detail: routeFailReason,
      };
      recordFailureNote(workingMemory, plan.planId, subtask, routeFailReason);
      for (const skipped of getTransitiveDependents(
        orderedSubtasks,
        subtask.id,
      )) {
        if (isTerminalNarration(skipped, orderedSubtasks)) continue;
        skippedSubtaskIds.add(skipped.id);
        yield {
          kind: 'orchestrator-progress',
          planId: plan.planId,
          subtaskId: skipped.id,
          status: 'skipped',
          label: skipped.title,
          detail: 'Skipped because an earlier subtask could not be routed.',
        };
        recordFailureNote(
          workingMemory,
          plan.planId,
          skipped,
          'a prerequisite step did not complete',
        );
      }
      continue;
    }

    yield {
      kind: 'orchestrator-progress',
      planId: plan.planId,
      subtaskId: subtask.id,
      status: 'running',
      label: subtask.title,
    };

    if (usesProviderMediaExecutor(subtask)) {
      if (!deps.media) {
        yield {
          kind: 'orchestrator-progress',
          planId: plan.planId,
          subtaskId: subtask.id,
          status: 'error',
          label: subtask.title,
          detail: 'MEDIA_EXECUTOR_UNAVAILABLE',
        };
        // Mirror the routing-failure path: a failed subtask must skip its
        // transitive dependents so they don't run with missing input — except
        // a terminal narration step, which survives to report the failure.
        recordFailureNote(
          workingMemory,
          plan.planId,
          subtask,
          'MEDIA_EXECUTOR_UNAVAILABLE',
        );
        for (const skipped of getTransitiveDependents(
          orderedSubtasks,
          subtask.id,
        )) {
          if (isTerminalNarration(skipped, orderedSubtasks)) continue;
          skippedSubtaskIds.add(skipped.id);
          yield {
            kind: 'orchestrator-progress',
            planId: plan.planId,
            subtaskId: skipped.id,
            status: 'skipped',
            label: skipped.title,
            detail: 'Skipped because an earlier subtask failed.',
          };
          recordFailureNote(
            workingMemory,
            plan.planId,
            skipped,
            'a prerequisite step did not complete',
          );
        }
        continue;
      }
      // M6: the resolver hooks + the media drain run under the same
      // per-subtask error isolation contract as the worker path below — a
      // throw here must mark THIS subtask failed and skip its dependents,
      // not propagate out of runOrchestrator as a blanket
      // AGENT_REQUEST_FAILED that collapses the whole turn.
      try {
        const providerInput = deps.media.resolveProviderInput
          ? await deps.media.resolveProviderInput({ plan, subtask, route })
          : undefined;
        const compositionSpec = deps.media.resolveCompositionSpec
          ? await deps.media.resolveCompositionSpec({ plan, subtask, route })
          : undefined;
        const recordsByHandleId = deps.media.resolveRecords
          ? await deps.media.resolveRecords({ plan, subtask, route })
          : undefined;
        for await (const event of runMediaSubtask({
          agentTurnId: deps.agentTurnId,
          planId: plan.planId,
          subtask,
          route,
          videoAdapters: deps.media.videoAdapters,
          imageAdapters: deps.media.imageAdapters,
          // image.generate delivers its bytes via the binary write-ACK path —
          // the same builder workers use (index.ts), the binary-work-item
          // manager, the destination linked folders, and the session id the
          // ACK round-trips under.
          awaitBinaryWriteAck: deps.awaitBinaryWriteAck,
          binaryWorkItems: deps.media.binaryWorkItems,
          linkedFolders: deps.requestContext?.linkedFolders,
          sessionId: deps.sessionId,
          checkpointClient: deps.media.checkpointClient,
          budgetClient: deps.media.budgetClient,
          handleStore: deps.media.handleStore,
          provenanceSigner: deps.media.provenanceSigner,
          consentVerifier: deps.media.consentVerifier,
          renderBackend: deps.media.renderBackend,
          renderAttestationPolicy: deps.media.renderAttestationPolicy,
          verifyRenderManifestSignature:
            deps.media.verifyRenderManifestSignature,
          providerInput,
          compositionSpec,
          recordsByHandleId,
          encryptArtifact: deps.media.encryptArtifact,
          now: deps.media.now,
          abortSignal: deps.abortSignal,
        })) {
          yield event;
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'ORCHESTRATOR_CANCELLED'
        ) {
          yield {
            kind: 'orchestrator-progress',
            planId: plan.planId,
            subtaskId: subtask.id,
            status: 'error',
            label: subtask.title,
            detail: 'ORCHESTRATOR_CANCELLED',
          };
          yield { kind: 'done' };
          return;
        }
        const mediaFailReason =
          error instanceof Error ? error.message : 'Subtask failed.';
        yield {
          kind: 'orchestrator-progress',
          planId: plan.planId,
          subtaskId: subtask.id,
          status: 'error',
          label: subtask.title,
          detail: mediaFailReason,
        };
        recordFailureNote(workingMemory, plan.planId, subtask, mediaFailReason);
        for (const skipped of getTransitiveDependents(
          orderedSubtasks,
          subtask.id,
        )) {
          if (isTerminalNarration(skipped, orderedSubtasks)) continue;
          skippedSubtaskIds.add(skipped.id);
          yield {
            kind: 'orchestrator-progress',
            planId: plan.planId,
            subtaskId: skipped.id,
            status: 'skipped',
            label: skipped.title,
            detail: 'Skipped because an earlier subtask failed.',
          };
          recordFailureNote(
            workingMemory,
            plan.planId,
            skipped,
            'a prerequisite step did not complete',
          );
        }
      }
      continue;
    }

    const requiresReadResultTool = subtaskRequiresReadResultTool(subtask);
    const requiresFolderWriteTool = subtaskRequiresFolderWriteTool(subtask);
    const scopesResearchAskTool = subtaskScopesResearchAskTool(subtask);
    // A folder.write subtask must generate the artifact AND wait on the human
    // confirmation modal; a research.ask subtask must wait on the approval
    // round-trip AND the air-gapped subagent's real-client web.fetch round
    // trips. Both get the longer write-subtask window; every other subtask
    // keeps the short worker timeout (a quiet worker is stuck).
    const subtaskWorkerTimeoutMs =
      requiresFolderWriteTool || scopesResearchAskTool
        ? deps.writeSubtaskTimeoutMs ??
          deps.workerTimeoutMs ??
          DEFAULT_WRITE_SUBTASK_TIMEOUT_MS
        : deps.workerTimeoutMs ?? 60_000;
    const workerPrompt = [
      `Subtask: ${subtask.title}`,
      `Objective: ${subtask.objective}`,
      `Allowed tools for this subtask: ${subtask.allowedTools.join(', ') || 'none'}`,
      'Complete only this subtask. If you need a tool, use the normal tool-call format.',
      ...(requiresFolderWriteTool
        ? [
            'For folder.write subtasks, invoke folder.write before streaming final prose.',
            'Do not stream the full artifact as assistant text before the write tool call.',
          ]
        : []),
    ].join('\n');

    let finalText = '';
    let cancelAfterCompletedWorker = false;
    let toolResultDigests: string[] = [];
    let suppressedPreWriteText = '';
    let suppressedPreWriteChars = 0;
    let invokedAnyTool = false;
    let invokedFolderWriteTool = false;
    let pendingFolderWriteDispatch = false;
    // True between a research.ask tool-invocation and its matching tool-result:
    // the worker is parked inside gateway.dispatch(research.ask) on the human
    // approval round-trip + the air-gapped subagent run. Defers the worker
    // timeout across that pause, exactly as pendingFolderWriteDispatch defers
    // across the confirmation modal.
    let pendingResearchApproval = false;
    let timedOutDuringFolderWriteDispatch = false;
    let folderWriteDispatchGraceExpired = false;
    let confirmedTerminalFolderWrite = false;
    try {
      throwIfAborted(deps.abortSignal);
      let emittedAnyWorkerEvent = false;
      let emittedWorkerText = false;
      const attemptedModelIds = new Set<string>();
      let attemptsUsed = 0;
      let workerCompleted = false;
      let lastWorkerError: unknown;

      // H2 (Codex review): the honest media-gen degrade subtask must NEVER run an
      // LLM worker. Its empty tool scope already prevents SAVING a fabricated
      // artifact, but a worker could still emit fabricated SVG / "design spec"
      // markup as its TEXT answer (prompt-only enforcement). Emit the FIXED
      // "generation unavailable" message and mark the worker complete so no model
      // output can stand in for the unavailable artifact. The subtask has no
      // dependents and no required tools, so the existing success path records
      // the message to memory and emits `done` WITHOUT consulting any model.
      if (subtask.id === HONEST_MEDIA_GEN_DEGRADE_SUBTASK_ID) {
        const message = honestMediaGenDegradeMessage(subtask);
        finalText = message;
        emittedWorkerText = true;
        for (const text of splitTextForOrchestrator(message)) {
          yield {
            kind: 'orchestrator-text',
            planId: plan.planId,
            subtaskId: subtask.id,
            role: subtask.producesArtifact ? 'final_artifact' : 'working',
            text,
          };
        }
        workerCompleted = true;
      }

      // ── Consent-gated private-read → web egress bridge ──────────────────────
      // A web.fetch subtask is denied private-derived working memory by default
      // (egress isolation). Before it runs, if such memory exists, offer the
      // user the SPECIFIC datums to promote across the boundary (default DENY).
      // Approved datums are whitelisted in the egress-taint guard AND injected
      // into the worker's visible memory; declined datums never cross, and the
      // worker is told the user declined so it can answer honestly instead of
      // dead-ending on a missing input. Runs ONCE per subtask (not per retry).
      const promotedEgressEntries: OrchestratorWorkingMemoryEntry[] = [];
      let egressPromotionDeclined = false;
      if (subtask.allowedTools.includes('web.fetch') && deps.awaitEgressPromotion) {
        const deniedPrivate = workingMemory.filter((entry) =>
          isPrivateDerivedEntry(entry, privateDerivedSubtaskIds),
        );
        if (deniedPrivate.length > 0) {
          const candidates = deniedPrivate.map((entry, i) => ({
            id: `egress_cand_${i}`,
            label: entry.label,
            content: entry.content,
          }));
          yield {
            kind: 'orchestrator-progress',
            planId: plan.planId,
            subtaskId: subtask.id,
            status: 'blocked',
            label: subtask.title,
            detail: 'EGRESS_PROMOTION_AWAITING_CONSENT',
          };
          let decision: { approvedIds: string[] } | undefined;
          try {
            decision = await deps.awaitEgressPromotion({
              agentTurnId: deps.agentTurnId,
              planId: plan.planId,
              subtaskId: subtask.id,
              candidates,
            });
          } catch {
            decision = undefined; // fail-closed: a broken channel denies
          }
          const approvedIds = new Set(decision?.approvedIds ?? []);
          candidates.forEach((candidate, i) => {
            if (!approvedIds.has(candidate.id)) return;
            const entry = deniedPrivate[i];
            // Whitelist the EXACT approved datum in the taint guard and inject
            // it into the worker's visible context.
            deps.gateway.promoteEgress(entry.content);
            promotedEgressEntries.push({
              ...entry,
              label: `User-approved to send to the web (${entry.label})`,
            });
          });
          egressPromotionDeclined = promotedEgressEntries.length === 0;
          yield {
            kind: 'orchestrator-progress',
            planId: plan.planId,
            subtaskId: subtask.id,
            status: 'running',
            label: subtask.title,
            detail: `EGRESS_PROMOTION_RESOLVED:${promotedEgressEntries.length}/${candidates.length}`,
          };
        }
      }

      while (!workerCompleted && attemptsUsed < 3) {
        const [modelId] = buildAttemptModelIds(
          route,
          deps.models,
          providerHealth,
          nowMs(),
          1,
          attemptedModelIds,
        );
        if (!modelId) break;
        attemptedModelIds.add(modelId);
        attemptsUsed += 1;

        try {
          if (!consumeProviderCall()) {
            throw new Error('ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED');
          }
          // Egress isolation. A web.fetch worker NEVER sees private-derived
          // memory. A non-egress worker sees the global memory — but if any of
          // it is private-derived, this worker becomes private-derived too
          // (runtime taint), so its own summary is later excluded from egress
          // workers. This closes the read -> no-tool relay -> fetch path that a
          // purely static (tools + declared deps) classification misses.
          const baseVisibleMemory = visibleWorkingMemoryForSubtask(
            workingMemory,
            subtask,
            privateDerivedSubtaskIds,
          );
          // Re-attach ONLY the user-promoted private datums (egress bridge), or,
          // if the user declined, a content-free note so the worker explains the
          // gap honestly instead of dead-ending on a missing input.
          const declineNote: OrchestratorWorkingMemoryEntry[] = egressPromotionDeclined
            ? [
                {
                  planId: plan.planId,
                  subtaskId: subtask.id,
                  kind: 'user_decision',
                  label: 'Private detail withheld from the web',
                  content:
                    'You chose not to send the private detail this step needs to the web. Do not guess or fabricate it. Complete what you can from public information only, and tell the user plainly that you could not look it up because the private detail was kept off the web.',
                  sourceToolNames: [],
                },
              ]
            : [];
          const visibleMemory = [
            ...baseVisibleMemory,
            ...promotedEgressEntries,
            ...declineNote,
          ];
          if (
            !subtask.allowedTools.includes('web.fetch') &&
            visibleMemory.some((entry) =>
              isPrivateDerivedEntry(entry, privateDerivedSubtaskIds),
            )
          ) {
            privateDerivedSubtaskIds.add(subtask.id);
          }
          for await (const event of runWorkerEventsWithTimeout(
            (signal) =>
              runAgentLoop(
                {
                  gateway: deps.gateway,
                  provider: deps.workerProviderFactory(modelId),
                  pack: restrictPackToSubtaskTools(deps.pack, subtask),
                  agentTurnId: deps.agentTurnId,
                  requestContext: deps.requestContext,
                  fullSkillToolScopes: deps.pack.toolScopes,
                  awaitBinaryWriteAck: deps.awaitBinaryWriteAck,
                  awaitMemoryWriteAck: deps.awaitMemoryWriteAck,
                  abortSignal: signal,
                },
                {
                  messages: buildWorkerMessages(
                    originalMessagesForWorker(deps.messages, subtask),
                    workerPrompt,
                    visibleMemory,
                  ),
                  model: modelId,
                },
              ),
            subtaskWorkerTimeoutMs,
            deps.abortSignal,
            {
              shouldDeferTimeout: () =>
                pendingFolderWriteDispatch || pendingResearchApproval,
              onTimeoutDeferred: () => {
                timedOutDuringFolderWriteDispatch = true;
              },
              onDeferredTimeoutExpired: () => {
                folderWriteDispatchGraceExpired = true;
              },
              shouldCompleteDeferredTimeoutAfterEvent: (event) =>
                event.kind === 'ledger' &&
                isConfirmedFolderWriteLedger(event.entry),
              shouldEndDeferredTimeoutAfterEvent: (event) =>
                event.kind === 'ledger' &&
                event.entry.toolName === 'folder.write',
              deferredTimeoutMs:
                deps.writeDispatchGraceMs ?? DEFAULT_WRITE_DISPATCH_GRACE_MS,
            },
          )) {
            throwIfAborted(deps.abortSignal);
            if (event.kind === 'done') break;
            if (event.kind === 'tool-result') {
              // The research.ask round-trip (approval + air-gapped subagent)
              // has completed — stop deferring the worker timeout for it.
              if (event.toolName === 'research.ask') {
                pendingResearchApproval = false;
              }
              // Internal-only: never forwarded to the wire. Capture a bounded,
              // structured digest of read-result tools (e.g. web.fetch
              // {status, bodyText}) so a dependent subtask's working memory
              // carries the actual payload, not just the worker's prose.
              const digest = digestToolResultForMemory(event);
              if (digest) toolResultDigests.push(digest);
              continue;
            }
            if (
              event.kind === 'chunk' &&
              requiresFolderWriteTool &&
              !invokedFolderWriteTool
            ) {
              suppressedPreWriteChars += event.text.length;
              if (
                suppressedPreWriteText.length <
                MAX_SUPPRESSED_PRE_WRITE_TEXT_CHARS
              ) {
                suppressedPreWriteText += event.text.slice(
                  0,
                  MAX_SUPPRESSED_PRE_WRITE_TEXT_CHARS -
                    suppressedPreWriteText.length,
                );
              }
              continue;
            }
            emittedAnyWorkerEvent = true;
            if (event.kind === 'tool-invocation') {
              invokedAnyTool = true;
              if (event.frame.toolName === 'research.ask') {
                // The worker is about to park inside gateway.dispatch on the
                // approval round-trip + subagent run — defer the timeout until
                // the matching tool-result arrives.
                pendingResearchApproval = true;
              }
              if (event.frame.toolName === 'folder.write') {
                invokedFolderWriteTool = true;
                pendingFolderWriteDispatch = true;
                if (suppressedPreWriteChars > 0) {
                  yield {
                    kind: 'orchestrator-progress',
                    planId: plan.planId,
                    subtaskId: subtask.id,
                    status: 'running',
                    label: subtask.title,
                    detail: `ORCHESTRATOR_PRE_WRITE_TEXT_SUPPRESSED:${suppressedPreWriteChars}`,
                  };
                }
              }
            }
            if (
              event.kind === 'ledger' &&
              event.entry.toolName === 'folder.write'
            ) {
              pendingFolderWriteDispatch = false;
            }
            if (
              event.kind === 'ledger' &&
              isConfirmedFolderWriteLedger(event.entry) &&
              !hasDirectDependents(orderedSubtasks, subtask.id)
            ) {
              confirmedTerminalFolderWrite = true;
            }
            if (event.kind === 'chunk') {
              emittedWorkerText = true;
              finalText += event.text;
              for (const text of splitTextForOrchestrator(event.text)) {
                yield {
                  kind: 'orchestrator-text',
                  planId: plan.planId,
                  subtaskId: subtask.id,
                  role: subtask.producesArtifact ? 'final_artifact' : 'working',
                  text,
                };
              }
              continue;
            }

            const forwarded = mapAllowedWorkerEvent(event, {
              planId: plan.planId,
              subtaskId: subtask.id,
              ordinal: eventOrdinal,
            });
            if (forwarded) {
              eventOrdinal += 1;
              yield forwarded;
            }
          }
          workerCompleted = true;
        } catch (error) {
          // Retry on the next model for any transient worker failure (provider
          // 429/network error OR timeout), but ONLY when nothing has been
          // emitted yet — retrying after partial output would duplicate the
          // artifact. Cancellation and budget exhaustion are terminal, not
          // transient, so they propagate immediately.
          lastWorkerError = error;
          const message = error instanceof Error ? error.message : '';
          const attemptedModel = deps.models.find(
            (model) => model.modelId === modelId,
          );
          const providerError =
            providerErrorFromUnknown(error) ??
            (attemptedModel
              ? normaliseProviderError(
                  error,
                  attemptedModel.providerId,
                  resolveProviderDisplayName(
                    attemptedModel.providerId,
                    deps.providerDisplayNames,
                  ),
                )
              : null);
          if (providerError instanceof ProviderError) {
            providerHealth.mark(providerError, nowMs());
          }
          const isTerminal =
            message === 'ORCHESTRATOR_CANCELLED' ||
            message === 'ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED';
          const hasFreshAttempt =
            attemptsUsed < 3 &&
            buildAttemptModelIds(
              route,
              deps.models,
              providerHealth,
              nowMs(),
              1,
              attemptedModelIds,
            ).length > 0;
          const canRetry =
            !isTerminal &&
            !emittedAnyWorkerEvent &&
            !emittedWorkerText &&
            !pendingFolderWriteDispatch &&
            hasFreshAttempt;
          if (canRetry) {
            if (suppressedPreWriteChars > 0) {
              yield {
                kind: 'orchestrator-progress',
                planId: plan.planId,
                subtaskId: subtask.id,
                status: 'running',
                label: subtask.title,
                detail: `ORCHESTRATOR_PRE_WRITE_TEXT_SUPPRESSED:${suppressedPreWriteChars}`,
              };
            }
            yield {
              kind: 'orchestrator-progress',
              planId: plan.planId,
              subtaskId: subtask.id,
              status: 'blocked',
              label: subtask.title,
              detail:
                providerError?.kind === 'rate_limit'
                  ? 'ORCHESTRATOR_PROVIDER_REROUTE'
                  : message === 'ORCHESTRATOR_WORKER_TIMEOUT'
                    ? 'ORCHESTRATOR_WORKER_TIMEOUT_RETRY'
                    : 'ORCHESTRATOR_WORKER_ERROR_RETRY',
            };
            finalText = '';
            toolResultDigests = [];
            suppressedPreWriteText = '';
            suppressedPreWriteChars = 0;
            invokedAnyTool = false;
            invokedFolderWriteTool = false;
            pendingFolderWriteDispatch = false;
            pendingResearchApproval = false;
            timedOutDuringFolderWriteDispatch = false;
            folderWriteDispatchGraceExpired = false;
            continue;
          }
          throw error;
        }
      }

      if (!workerCompleted) {
        if (lastWorkerError instanceof Error) throw lastWorkerError;
        throw new Error('ORCHESTRATOR_WORKER_NO_ATTEMPT_AVAILABLE');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'ORCHESTRATOR_CANCELLED') {
        yield {
          kind: 'orchestrator-progress',
          planId: plan.planId,
          subtaskId: subtask.id,
          status: 'error',
          label: subtask.title,
          detail: 'ORCHESTRATOR_CANCELLED',
        };
        yield { kind: 'done' };
        return;
      }

      const workerFailReason =
        error instanceof Error ? error.message : 'Subtask failed.';
      if (
        workerFailReason === 'ORCHESTRATOR_WORKER_TIMEOUT' &&
        confirmedTerminalFolderWrite
      ) {
        yield {
          kind: 'orchestrator-progress',
          planId: plan.planId,
          subtaskId: subtask.id,
          status: 'done',
          label: subtask.title,
          detail: 'ORCHESTRATOR_WORKER_TIMEOUT_AFTER_CONFIRMED_WRITE',
        };
        continue;
      }
      let progressDetail = workerFailReason;
      if (workerFailReason === 'ORCHESTRATOR_WORKER_TIMEOUT') {
        if (folderWriteDispatchGraceExpired) {
          progressDetail =
            'ORCHESTRATOR_WORKER_TIMEOUT_WRITE_DISPATCH_ABANDONED';
        } else if (timedOutDuringFolderWriteDispatch) {
          progressDetail = 'ORCHESTRATOR_WORKER_TIMEOUT_AFTER_WRITE_DISPATCH';
        }
      }
      // A worker that died (e.g. timed out) before ever dispatching its
      // required write may still have generated the deliverable as suppressed
      // pre-write text — deliver it rather than discard it. Never fires when
      // the write was dispatched (the file may have landed; text would
      // duplicate it).
      if (
        requiresFolderWriteTool &&
        !invokedFolderWriteTool &&
        suppressedPreWriteText.trim().length > 0
      ) {
        const fallback = `The file could not be saved to your folder, so here is the prepared content:\n\n${suppressedPreWriteText}`;
        for (const text of splitTextForOrchestrator(fallback)) {
          yield {
            kind: 'orchestrator-text',
            planId: plan.planId,
            subtaskId: subtask.id,
            role: subtask.producesArtifact ? 'final_artifact' : 'working',
            text,
          };
        }
      }
      yield {
        kind: 'orchestrator-progress',
        planId: plan.planId,
        subtaskId: subtask.id,
        status: 'error',
        label: subtask.title,
        detail: progressDetail,
      };
      recordFailureNote(workingMemory, plan.planId, subtask, progressDetail);
      for (const skipped of getTransitiveDependents(
        orderedSubtasks,
        subtask.id,
      )) {
        if (isTerminalNarration(skipped, orderedSubtasks)) continue;
        skippedSubtaskIds.add(skipped.id);
        yield {
          kind: 'orchestrator-progress',
          planId: plan.planId,
          subtaskId: skipped.id,
          status: 'skipped',
          label: skipped.title,
          detail: 'Skipped because an earlier subtask failed.',
        };
        recordFailureNote(
          workingMemory,
          plan.planId,
          skipped,
          'a prerequisite step did not complete',
        );
      }
      continue;
    }

    // Defect (a) hardening: a subtask scoped to a required read-result tool
    // (e.g. web.fetch) that completes without ever invoking it did NOT do its
    // job — the model narrated a fetch it never performed. Treat as a subtask
    // error and skip dependents rather than marching to a silent 'done' that
    // leaves the dependent step with no status / content. This only fires when
    // the worker genuinely emitted zero tool calls AND the only allowed tool(s)
    // are read-result tools, so a subtask that legitimately answers from prior
    // memory is unaffected.
    if (requiresReadResultTool && !invokedAnyTool) {
      yield {
        kind: 'orchestrator-progress',
        planId: plan.planId,
        subtaskId: subtask.id,
        status: 'error',
        label: subtask.title,
        detail: 'ORCHESTRATOR_REQUIRED_TOOL_NOT_CALLED',
      };
      recordFailureNote(
        workingMemory,
        plan.planId,
        subtask,
        'a required tool was not called (e.g. the step refused to act)',
      );
      for (const skipped of getTransitiveDependents(
        orderedSubtasks,
        subtask.id,
      )) {
        if (isTerminalNarration(skipped, orderedSubtasks)) continue;
        skippedSubtaskIds.add(skipped.id);
        yield {
          kind: 'orchestrator-progress',
          planId: plan.planId,
          subtaskId: skipped.id,
          status: 'skipped',
          label: skipped.title,
          detail: 'Skipped because an earlier subtask failed.',
        };
        recordFailureNote(
          workingMemory,
          plan.planId,
          skipped,
          'a prerequisite step did not complete',
        );
      }
      continue;
    }

    if (requiresFolderWriteTool && !invokedFolderWriteTool) {
      if (suppressedPreWriteChars > 0) {
        yield {
          kind: 'orchestrator-progress',
          planId: plan.planId,
          subtaskId: subtask.id,
          status: 'running',
          label: subtask.title,
          detail: `ORCHESTRATOR_PRE_WRITE_TEXT_SUPPRESSED:${suppressedPreWriteChars}`,
        };
      }
      // The write never happened, so the suppressed pre-write text IS the
      // deliverable — hand it to the user as subtask text instead of
      // discarding it (2026-06-12 live finding: full letters/checklists were
      // generated, suppressed, and lost while the banner claimed success).
      // Suppression stays in force on the success path, where the written
      // file is the deliverable.
      if (suppressedPreWriteText.trim().length > 0) {
        const fallback = `The file could not be saved to your folder, so here is the prepared content:\n\n${suppressedPreWriteText}`;
        for (const text of splitTextForOrchestrator(fallback)) {
          yield {
            kind: 'orchestrator-text',
            planId: plan.planId,
            subtaskId: subtask.id,
            role: subtask.producesArtifact ? 'final_artifact' : 'working',
            text,
          };
        }
      }
      const requiredWriteFailureNote = suppressedPreWriteText.trim()
        ? `a required folder.write tool was not called; suppressed pre-write text: ${fallbackMemorySummary(suppressedPreWriteText)}`
        : 'a required folder.write tool was not called';
      yield {
        kind: 'orchestrator-progress',
        planId: plan.planId,
        subtaskId: subtask.id,
        status: 'error',
        label: subtask.title,
        detail: 'ORCHESTRATOR_REQUIRED_WRITE_NOT_CALLED',
      };
      recordFailureNote(
        workingMemory,
        plan.planId,
        subtask,
        requiredWriteFailureNote,
      );
      for (const skipped of getTransitiveDependents(
        orderedSubtasks,
        subtask.id,
      )) {
        if (isTerminalNarration(skipped, orderedSubtasks)) continue;
        skippedSubtaskIds.add(skipped.id);
        yield {
          kind: 'orchestrator-progress',
          planId: plan.planId,
          subtaskId: skipped.id,
          status: 'skipped',
          label: skipped.title,
          detail: 'Skipped because an earlier subtask failed.',
        };
        recordFailureNote(
          workingMemory,
          plan.planId,
          skipped,
          'a prerequisite step did not complete',
        );
      }
      continue;
    }

    let memorySummary = fallbackMemorySummary(finalText);
    if (!hasDirectDependents(orderedSubtasks, subtask.id)) {
      memorySummary = fallbackMemorySummary(finalText);
    } else {
      try {
        if (summaryModelCandidates.length > 0) {
          let summarized = false;
          for await (const item of runProviderCandidate({
            planId: plan.planId,
            subtaskId: subtask.id,
            label: subtask.title,
            candidates: summaryModelCandidates,
            timeoutReason: 'ORCHESTRATOR_MEMORY_SUMMARY_FAILED',
            timeoutMs: deps.summaryTimeoutMs ?? 10_000,
            run: (modelId, signal) =>
              summarizeForMemory({
                provider: deps.workerProviderFactory(modelId),
                model: modelId,
                text: finalText,
                abortSignal: signal,
                onUsage: captureUsage('agent_summary'),
              }),
          })) {
            yield* drainPendingUsageEvents();
            if (item.kind === 'progress') {
              yield item.event;
              continue;
            }
            memorySummary = item.value;
            summarized = true;
          }
          if (!summarized) {
            throw new Error('ORCHESTRATOR_MEMORY_SUMMARY_FAILED');
          }
        } else if (!consumeProviderCall()) {
          yield {
            kind: 'orchestrator-progress',
            planId: plan.planId,
            subtaskId: subtask.id,
            status: 'blocked',
            label: subtask.title,
            detail: 'ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED',
          };
          memorySummary = fallbackMemorySummary(finalText);
        } else {
          memorySummary = await withTimeout(
            (signal) =>
              summarizeForMemory({
                provider: deps.workerProviderFactory(deps.summaryModel),
                model: deps.summaryModel,
                text: finalText,
                abortSignal: signal,
                onUsage: captureUsage('agent_summary'),
              }),
            deps.summaryTimeoutMs ?? 10_000,
            deps.abortSignal,
            'ORCHESTRATOR_MEMORY_SUMMARY_FAILED',
          );
          yield* drainPendingUsageEvents();
        }
      } catch (error) {
        yield* drainPendingUsageEvents();
        if (
          error instanceof Error &&
          error.message === 'ORCHESTRATOR_CANCELLED'
        ) {
          cancelAfterCompletedWorker = true;
          yield {
            kind: 'orchestrator-progress',
            planId: plan.planId,
            subtaskId: 'plan',
            status: 'error',
            label: 'Plan cancelled',
              detail: 'ORCHESTRATOR_CANCELLED',
            };
        } else if (
          error instanceof Error &&
          error.message === 'ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED'
        ) {
          yield {
            kind: 'orchestrator-progress',
            planId: plan.planId,
            subtaskId: subtask.id,
            status: 'blocked',
            label: subtask.title,
            detail: 'ORCHESTRATOR_PROVIDER_CALL_BUDGET_EXCEEDED',
          };
        } else {
          yield {
            kind: 'orchestrator-progress',
            planId: plan.planId,
            subtaskId: subtask.id,
            status: 'blocked',
            label: subtask.title,
            detail: 'ORCHESTRATOR_MEMORY_SUMMARY_FAILED',
          };
        }
        memorySummary = fallbackMemorySummary(finalText);
      }
    }

    // Defect (b) fix: carry a structured digest of read-result tool payloads
    // (e.g. web.fetch {status, bodyText}) into the entry content so a dependent
    // subtask receives the ACTUAL fetch result, not only the worker's prose
    // summary. Without this the dependent "Report" step is structurally unable
    // to report HTTP status / content. The digest is already bounded
    // (digestToolResultForMemory clamps the body excerpt) and is then clamped
    // again to the entry's 2_000-char schema cap; trimWorkingMemory keeps the
    // whole working set within MAX_WORKING_MEMORY_CHARS. Masking is unchanged:
    // bodies are masked on-device before they ever reach the enclave.
    const entryContent = composeMemoryEntryContent(
      memorySummary,
      toolResultDigests,
    );

    workingMemory.splice(
      0,
      workingMemory.length,
      ...trimWorkingMemory([
        ...workingMemory,
        {
          planId: plan.planId,
          subtaskId: subtask.id,
          kind:
            subtask.kind === 'file_inspection' ||
            subtask.kind === 'classification' ||
            toolResultDigests.length > 0
              ? 'tool_summary'
              : 'subtask_result',
          label: subtask.title,
          content: entryContent,
          sourceToolNames: subtask.allowedTools,
        },
      ]),
    );

    yield {
      kind: 'orchestrator-progress',
      planId: plan.planId,
      subtaskId: subtask.id,
      status: 'done',
      label: subtask.title,
    };
    if (cancelAfterCompletedWorker) {
      yield { kind: 'done' };
      return;
    }
  }

  yield { kind: 'done' };
}

function restrictPackToSubtaskTools(pack: SkillPack, subtask: AgentSubtask): SkillPack {
  return {
    ...pack,
    toolScopes: pack.toolScopes.filter((tool) => subtask.allowedTools.includes(tool)),
  };
}

function usesProviderMediaExecutor(subtask: AgentSubtask): boolean {
  if (
    subtask.kind === 'video' &&
    (subtask.media?.operation === 'video_generate' ||
      subtask.media?.operation === 'video_render' ||
      subtask.allowedTools.includes('video.generate') ||
      subtask.allowedTools.includes('video.render'))
  ) {
    return true;
  }
  // Image generation/edit runs through the (synchronous) media executor too.
  if (
    subtask.kind === 'image' &&
    (subtask.media?.operation === 'image_generate' ||
      subtask.media?.operation === 'image_edit' ||
      subtask.allowedTools.includes('image.generate') ||
      subtask.allowedTools.includes('image.edit'))
  ) {
    return true;
  }
  return false;
}

function hasDirectDependents(
  subtasks: readonly AgentSubtask[],
  subtaskId: string,
): boolean {
  return subtasks.some((subtask) => subtask.dependsOn.includes(subtaskId));
}

function isConfirmedFolderWriteLedger(
  entry: Omit<ToolCallLedgerEntry, 'id'>,
): boolean {
  return entry.toolName === 'folder.write' && entry.outcome === 'ok';
}

// A TERMINAL NARRATION subtask is the plan's final user-facing report/summary:
// a prose step (synthesis / writing / reasoning) that NOTHING else depends on.
// When an upstream subtask errors, such a step must NOT be skip-cascaded into
// oblivion — that leaves the user with no answer at all (Defect D1: A08's
// legitimate egress refusal and A14's failed extract both swallowed the final
// report). Instead it survives the cascade and runs with a failure note in
// working memory, so it truthfully reports "did X, Y failed because Z" rather
// than fabricating success. A CONSUMING step (image/audio/video/code/extraction
// that transforms the missing artifact) is NOT narration → it still skips.
const TERMINAL_NARRATION_KINDS = new Set<string>([
  'synthesis',
  'writing',
  'reasoning',
]);
function isTerminalNarration(
  subtask: AgentSubtask,
  subtasks: readonly AgentSubtask[],
): boolean {
  return (
    TERMINAL_NARRATION_KINDS.has(subtask.kind) &&
    !hasDirectDependents(subtasks, subtask.id)
  );
}

// Record that a subtask did NOT complete, so any surviving terminal-narration
// step sees the failure in its working memory and reports it honestly. This is
// what makes letting the narrator survive SAFE: without the note the worker
// runs with no context and hallucinates "Draft complete." (the reason the
// earlier terminal-survives attempt was reverted).
function recordFailureNote(
  workingMemory: OrchestratorWorkingMemoryEntry[],
  planId: string,
  subtask: AgentSubtask,
  reason: string,
): void {
  workingMemory.splice(
    0,
    workingMemory.length,
    ...trimWorkingMemory([
      ...workingMemory,
      {
        planId,
        subtaskId: subtask.id,
        kind: 'subtask_result',
        label: subtask.title,
        content: `This step did NOT complete (${reason}). Its output does not exist — report the failure honestly and do not invent, assume, or claim its result.`,
        sourceToolNames: subtask.allowedTools,
      },
    ]),
  );
}

/**
 * Subtasks whose output is private-read-derived: they call a private read tool
 * (the egress-taint read set) directly, or transitively depend on a subtask
 * that does. Mirrors the planner's notion so the executor can keep these
 * subtasks' summaries out of an egress (web.fetch) worker's context. Caller
 * guarantees the plan is acyclic (orderSubtasks throws on a cycle first).
 */
function computePrivateDerivedSubtaskIds(
  plan: AgentTaskPlan,
): ReadonlySet<string> {
  const byId = new Map(plan.subtasks.map((subtask) => [subtask.id, subtask]));
  const memo = new Map<string, boolean>();

  const isPrivateDerived = (subtaskId: string): boolean => {
    const cached = memo.get(subtaskId);
    if (cached !== undefined) return cached;
    memo.set(subtaskId, false); // cycle backstop; plan is acyclic here
    const subtask = byId.get(subtaskId);
    const derived =
      !!subtask &&
      (subtask.allowedTools.some((tool) => EGRESS_TAINT_READ_TOOLS.has(tool)) ||
        subtask.dependsOn.some(isPrivateDerived));
    memo.set(subtaskId, derived);
    return derived;
  };

  const out = new Set<string>();
  for (const subtask of plan.subtasks) {
    if (isPrivateDerived(subtask.id)) out.add(subtask.id);
  }
  return out;
}

/**
 * Working memory a worker may see. For an egress-capable (web.fetch) subtask we
 * DROP every entry produced by a private-read-derived subtask — the egress
 * worker's model context must never contain private-derived content (the
 * finding's invariant), and orchestrator summaries are paraphrases that the
 * literal egress-taint guard can miss. Non-egress workers are unaffected.
 */
/**
 * A working-memory entry is private-derived if its producing subtask is marked
 * private-derived (statically OR by runtime taint) or it carries a private-read
 * tool in its provenance.
 */
function isPrivateDerivedEntry(
  entry: OrchestratorWorkingMemoryEntry,
  privateDerivedSubtaskIds: ReadonlySet<string>,
): boolean {
  return (
    privateDerivedSubtaskIds.has(entry.subtaskId) ||
    entry.sourceToolNames.some((tool) => EGRESS_TAINT_READ_TOOLS.has(tool))
  );
}

function visibleWorkingMemoryForSubtask(
  workingMemory: readonly OrchestratorWorkingMemoryEntry[],
  subtask: AgentSubtask,
  privateDerivedSubtaskIds: ReadonlySet<string>,
): OrchestratorWorkingMemoryEntry[] {
  if (!subtask.allowedTools.includes('web.fetch')) return [...workingMemory];
  return workingMemory.filter(
    (entry) => !isPrivateDerivedEntry(entry, privateDerivedSubtaskIds),
  );
}

/**
 * Tools that can carry a worker's model context to the public internet.
 * `web.fetch` is the orchestrator's primary egress tool; `research.ask`
 * delegates to the air-gapped web researcher (its query egresses after a
 * verbatim user approval + taint check). Both are egress paths, so neither
 * should receive private-derived CONVERSATION HISTORY it does not need.
 *
 * NOTE: this is deliberately a SUPERSET of the WORKING-MEMORY filter
 * (`visibleWorkingMemoryForSubtask`), which stays `web.fetch`-only on purpose —
 * a `research.ask` worker is allowed to see private working memory in order to
 * FORMULATE its user-approved query (that is the research feature). Only its
 * inbound conversation HISTORY is trimmed here. Add any future network-reaching
 * tool to this set so the history-leak class cannot silently reappear.
 */
export const EGRESS_CAPABLE_TOOLS = new Set<ToolName>([
  'web.fetch',
  'research.ask',
]);

function subtaskCanEgress(subtask: AgentSubtask): boolean {
  return subtask.allowedTools.some((tool) => EGRESS_CAPABLE_TOOLS.has(tool));
}

/**
 * Conversation history a worker may see. The egress isolation drops private-
 * read-derived WORKING MEMORY from a web.fetch worker (visibleWorkingMemoryFor-
 * Subtask), but private-derived content can also ride in the conversation
 * HISTORY itself — most notably the refine flow's includePrivateDerivedPrior-
 * Answer carry-forward, which threads a prior private-read-derived ASSISTANT
 * answer back into `messages`. On-device masking is heuristic, not the
 * structural boundary, so for an egress-capable worker (see EGRESS_CAPABLE_TOOLS)
 * we pass ONLY the latest user turn — the current public request the worker is
 * told to act on. Prior assistant/tool turns may be private-read-derived, and
 * prior USER turns can themselves hold privately pasted text (claim/medical
 * detail) the worker could copy into an outbound URL/query, so neither is
 * forwarded. buildWorkerMessages still appends the worker prompt + (filtered)
 * working memory to this turn, so the worker keeps its instructions and the
 * legitimate cross-subtask context. Non-egress workers are unaffected and still
 * see the full history.
 *
 * Exported for direct unit coverage that enumerates the egress tools.
 */
export function originalMessagesForWorker(
  originalMessages: ChatMessage[],
  subtask: AgentSubtask,
): ChatMessage[] {
  if (!subtaskCanEgress(subtask)) return originalMessages;
  const latestUserTurn = [...originalMessages]
    .reverse()
    .find((message) => message.role === 'user');
  return latestUserTurn ? [latestUserTurn] : [];
}

function buildWorkerMessages(
  originalMessages: ChatMessage[],
  workerPrompt: string,
  workingMemory: readonly OrchestratorWorkingMemoryEntry[],
): ChatMessage[] {
  const memoryBlock = workingMemory.length
    ? [
        'Orchestrator memory from completed subtasks:',
        ...workingMemory.map((entry) => `- ${entry.label}: ${entry.content}`),
        '',
      ].join('\n')
    : '';
  const nextUserContent = `${memoryBlock}${workerPrompt}`;
  const last = originalMessages.at(-1);
  if (last?.role === 'user') {
    return [
      ...originalMessages.slice(0, -1),
      { ...last, content: `${last.content}\n\n${nextUserContent}` },
    ];
  }
  return [...originalMessages, { role: 'user', content: nextUserContent }];
}

function trimWorkingMemory(
  entries: readonly OrchestratorWorkingMemoryEntry[],
): OrchestratorWorkingMemoryEntry[] {
  const pinned: OrchestratorWorkingMemoryEntry[] = [];
  const pinnedIndices = new Set<number>();
  let total = 0;

  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== 'tool_summary') continue;
    const size = memoryEntrySize(entry);
    if (total + size > MAX_WORKING_MEMORY_CHARS) continue;
    pinned.push(entry);
    pinnedIndices.add(index);
    total += size;
  }

  if (pinned.length === 0 && entries[0]) {
    const first = entries[0];
    pinned.push({
      ...first,
      content: first.content.slice(
        0,
        Math.max(0, MAX_WORKING_MEMORY_CHARS - first.label.length),
      ),
    });
    pinnedIndices.add(0);
    total = memoryEntrySize(pinned[0]);
  }

  const kept: OrchestratorWorkingMemoryEntry[] = [];
  const candidates = entries.filter((_, index) => !pinnedIndices.has(index));
  for (const entry of [...candidates].reverse()) {
    const size = memoryEntrySize(entry);
    if (total + size > MAX_WORKING_MEMORY_CHARS) continue;
    kept.unshift(entry);
    total += size;
  }

  return [...pinned, ...kept];
}

function memoryEntrySize(entry: OrchestratorWorkingMemoryEntry): number {
  return entry.label.length + entry.content.length;
}

function splitTextForOrchestrator(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += MAX_ORCHESTRATOR_TEXT_CHARS) {
    chunks.push(text.slice(index, index + MAX_ORCHESTRATOR_TEXT_CHARS));
  }
  return chunks;
}

async function* runWorkerEventsWithTimeout(
  factory: (signal: AbortSignal) => AsyncGenerator<AgentLoopEvent>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  options: {
    shouldDeferTimeout?: () => boolean;
    onTimeoutDeferred?: () => void;
    onDeferredTimeoutExpired?: () => void;
    shouldCompleteDeferredTimeoutAfterEvent?: (event: AgentLoopEvent) => boolean;
    shouldEndDeferredTimeoutAfterEvent?: (event: AgentLoopEvent) => boolean;
    deferredTimeoutMs?: number;
  } = {},
): AsyncGenerator<AgentLoopEvent> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const iterator = factory(controller.signal);
  const timeoutSignal = Symbol('worker-timeout');
  const deferredTimeoutSignal = Symbol('worker-deferred-timeout');
  const timeoutPromise = new Promise<typeof timeoutSignal>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      resolve(timeoutSignal);
    }, timeoutMs);
  });

  try {
    while (true) {
      const nextPromise = iterator.next();
      const next = await Promise.race([nextPromise, timeoutPromise]);
      if (next === timeoutSignal) {
        if (options.shouldDeferTimeout?.()) {
          options.onTimeoutDeferred?.();
          let deferredTimeout: ReturnType<typeof setTimeout> | undefined;
          const deferredTimeoutPromise = new Promise<
            typeof deferredTimeoutSignal
          >((resolve) => {
            deferredTimeout = setTimeout(
              () => resolve(deferredTimeoutSignal),
              options.deferredTimeoutMs ?? timeoutMs,
            );
          });
          let deferredNextPromise = nextPromise;
          try {
            while (true) {
              const deferredNext:
                | Awaited<ReturnType<typeof iterator.next>>
                | typeof deferredTimeoutSignal = await Promise.race([
                deferredNextPromise,
                deferredTimeoutPromise,
              ]);
              if (deferredNext === deferredTimeoutSignal) {
                options.onDeferredTimeoutExpired?.();
                controller.abort('timeout');
                throw new Error('ORCHESTRATOR_WORKER_TIMEOUT');
              }
              if (deferredNext.done) {
                return;
              }
              yield deferredNext.value;
              if (
                options.shouldCompleteDeferredTimeoutAfterEvent?.(
                  deferredNext.value,
                )
              ) {
                return;
              }
              if (
                options.shouldEndDeferredTimeoutAfterEvent?.(
                  deferredNext.value,
                ) ?? false
              ) {
                controller.abort('timeout');
                throw new Error('ORCHESTRATOR_WORKER_TIMEOUT');
              }
              deferredNextPromise = iterator.next();
            }
          } finally {
            if (deferredTimeout) clearTimeout(deferredTimeout);
          }
        }
        controller.abort('timeout');
        throw new Error('ORCHESTRATOR_WORKER_TIMEOUT');
      }
      if (next.done) return;
      yield next.value;
    }
  } catch (error) {
    if (!timedOut && (parentSignal?.aborted || controller.signal.aborted)) {
      throw new Error('ORCHESTRATOR_CANCELLED');
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
    void iterator.return?.(undefined);
  }
}

async function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  timeoutReason: string,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    return await Promise.race([
      factory(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort('timeout');
          reject(new Error(timeoutReason));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (!timedOut && (parentSignal?.aborted || controller.signal.aborted)) {
      throw new Error('ORCHESTRATOR_CANCELLED');
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}
function getTransitiveDependents(
  subtasks: readonly AgentSubtask[],
  failedSubtaskId: string,
): AgentSubtask[] {
  const result = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const subtask of subtasks) {
      if (
        !result.has(subtask.id) &&
        subtask.dependsOn.some(
          (depId) => depId === failedSubtaskId || result.has(depId),
        )
      ) {
        result.add(subtask.id);
        changed = true;
      }
    }
  }
  return subtasks.filter((subtask) => result.has(subtask.id));
}

function mapAllowedWorkerEvent(
  event: AgentLoopEvent,
  scope: { planId: string; subtaskId: string; ordinal: number },
): OrchestratorScopedAgentLoopEvent | null {
  if (event.kind === 'usage') return event;
  if (
    event.kind === 'tool-invocation' ||
    event.kind === 'ledger' ||
    event.kind === 'memory-write-signed' ||
    event.kind === 'binary-write-request' ||
    event.kind === 'error'
  ) {
    return { ...event, orchestrator: scope };
  }
  return null;
}

function orderSubtasks(plan: AgentTaskPlan): AgentSubtask[] {
  const byId = new Map(plan.subtasks.map((subtask) => [subtask.id, subtask]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: AgentSubtask[] = [];

  function visit(subtask: AgentSubtask): void {
    if (visited.has(subtask.id)) return;
    if (visiting.has(subtask.id)) {
      throw new Error(`ORCHESTRATOR_PLAN_CYCLE:${subtask.id}`);
    }
    visiting.add(subtask.id);
    for (const depId of subtask.dependsOn) {
      const dependency = byId.get(depId);
      if (!dependency) {
        throw new Error(`ORCHESTRATOR_PLAN_UNKNOWN_DEPENDENCY:${depId}`);
      }
      visit(dependency);
    }
    visiting.delete(subtask.id);
    visited.add(subtask.id);
    ordered.push(subtask);
  }

  for (const subtask of plan.subtasks) visit(subtask);
  return ordered;
}

async function summarizeForMemory(input: {
  provider: ChatProcessor;
  model: string;
  text: string;
  abortSignal?: AbortSignal;
  onUsage?: (response: ProviderResponseLike) => void;
}): Promise<string> {
  const normalized = input.text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Subtask completed.';
  if (normalized.length <= 1_800) return normalized;

  const prompt = [
    'Summarize the completed Calypso subtask for downstream subtasks.',
    'Keep concrete file identities, decisions, missing facts, user-relevant findings, and write targets.',
    'Do not include private raw file contents unless they are essential to the next step.',
    'Return under 1800 characters.',
    '',
    normalized,
  ].join('\n');
  let summary = '';
  const stream = input.provider.streamChat([{ role: 'user', content: prompt }], {
    model: input.model,
    temperature: 0,
    signal: input.abortSignal,
  });
  while (true) {
    const next = await stream.next();
    if (next.done) {
      if (isProviderResponseLike(next.value)) input.onUsage?.(next.value);
      break;
    }
    const chunk = next.value;
    summary += chunk.choices[0]?.delta.content ?? '';
  }
  return summary.replace(/\s+/g, ' ').trim().slice(0, 2_000) || normalized.slice(0, 1_800);
}

function fallbackMemorySummary(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 1_800) || 'Subtask completed.';
}

function isProviderResponseLike(value: unknown): value is ProviderResponseLike {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { provider?: unknown }).provider === 'string' &&
    ((value as { provider: string }).provider.length > 0) &&
    typeof (value as { model?: unknown }).model === 'string' &&
    ((value as { model: string }).model.length > 0)
  );
}

// Read-result tools whose `resultJson` carries a payload (status/body/content)
// that a dependent subtask needs verbatim. A subtask whose ONLY allowed tools
// are drawn from this set is "required to call a read-result tool" — if it
// emits no tool call it cannot have produced the data the plan depends on.
const READ_RESULT_TOOLS = new Set<ToolName>([
  'web.fetch',
  'folder.read',
  'folder.list',
  'file.read',
  'memory.read',
  'memory.list',
]);

// Defect (a) hardening is scoped to web.fetch ONLY, deliberately narrow. A
// subtask whose ONLY tool is web.fetch exists solely to fetch — completing it
// without ever calling web.fetch means the model narrated a fetch it never
// performed, the confirmed A04 failure. Folder/memory read subtasks are NOT
// gated this way: they can legitimately answer from prior working memory or
// from linked-folder context already in the prompt without a tool call, so
// gating them would regress healthy multi-step file plans.
function subtaskRequiresReadResultTool(subtask: AgentSubtask): boolean {
  const allowed = subtask.allowedTools;
  return allowed.length > 0 && allowed.every((tool) => tool === 'web.fetch');
}

function subtaskRequiresFolderWriteTool(subtask: AgentSubtask): boolean {
  return (
    subtask.producesArtifact &&
    subtask.allowedTools.includes('folder.write') &&
    !subtask.allowedTools.some(isAlternativeArtifactTool)
  );
}

/**
 * A research.ask subtask whose worker timeout must span the human approval
 * pause (approveQuery round-trip) AND the air-gapped subagent run (each
 * web.fetch is a real client round-trip). Under the flat 60s worker timeout a
 * slow approval / grounded fetch trips ORCHESTRATOR_WORKER_TIMEOUT and the
 * research step fails even though the subagent would have answered — exactly
 * the folder.write confirmation-modal problem. Mirrors
 * {@link subtaskRequiresFolderWriteTool}: scope on research.ask presence.
 */
function subtaskScopesResearchAskTool(subtask: AgentSubtask): boolean {
  return subtask.allowedTools.includes('research.ask');
}

function isAlternativeArtifactTool(tool: ToolName): boolean {
  return tool !== 'folder.write' && ARTIFACT_PRODUCING_TOOLS[tool];
}

// Max characters of a single tool-result digest carried into working memory.
// Bounded so a large fetched body cannot blow past the entry's 2_000-char
// schema cap or starve other entries within MAX_WORKING_MEMORY_CHARS.
const TOOL_RESULT_DIGEST_MAX_CHARS = 900;

/**
 * Build a compact, structured digest of a successful read-result tool so a
 * dependent subtask's working memory carries the actual payload. For web.fetch
 * this is `HTTP {status}` plus a bounded body excerpt. Returns null for
 * non-ok outcomes, non-read-result tools, or empty payloads — those add no
 * downstream value and the prose summary already covers failures.
 */
function digestToolResultForMemory(event: {
  toolName: ToolName;
  outcome: ToolResultOutcome;
  resultJson: unknown;
}): string | null {
  if (event.outcome !== 'ok') return null;
  if (!READ_RESULT_TOOLS.has(event.toolName)) return null;
  const payload = event.resultJson;
  if (!payload || typeof payload !== 'object') return null;

  if (event.toolName === 'web.fetch') {
    const { status, bodyText } = payload as {
      status?: unknown;
      bodyText?: unknown;
    };
    const statusPart =
      typeof status === 'number' ? `HTTP status ${status}` : 'HTTP status unknown';
    const bodyPart =
      typeof bodyText === 'string' && bodyText.trim().length > 0
        ? ` — body excerpt: ${normalizeExcerpt(bodyText)}`
        : '';
    return `web.fetch result — ${statusPart}${bodyPart}`.slice(
      0,
      TOOL_RESULT_DIGEST_MAX_CHARS,
    );
  }

  // Generic fallback for other read-result tools: a bounded JSON excerpt.
  const json = (() => {
    try {
      return JSON.stringify(payload);
    } catch {
      return '';
    }
  })();
  if (!json) return null;
  return `${event.toolName} result — ${normalizeExcerpt(json)}`.slice(
    0,
    TOOL_RESULT_DIGEST_MAX_CHARS,
  );
}

function normalizeExcerpt(text: string): string {
  // This digest is interpolated verbatim into the dependent worker's prompt
  // (buildWorkerMessages), so defang it the same way sanitizeToolOutputForModel
  // defangs a tool result before the model sees it: redact role-spoof lines and
  // escape `<tool>` fences so a fetched body can't inject an attacker-controlled
  // turn or close the data block. Whitespace-collapse + clamp last.
  return escapeFences(stripDangerousPrefixes(text))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TOOL_RESULT_DIGEST_MAX_CHARS);
}

/**
 * Combine the prose memory summary with any structured tool-result digests for
 * the working-memory entry, clamped to the entry's 2_000-char schema cap. Tool
 * digests lead so the concrete {status, body} survives ahead of the prose if
 * the cap truncates.
 */
function composeMemoryEntryContent(
  memorySummary: string,
  toolResultDigests: readonly string[],
): string {
  if (toolResultDigests.length === 0) {
    return memorySummary.slice(0, 2_000);
  }
  const combined = [...toolResultDigests, memorySummary]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n');
  return (combined || memorySummary).slice(0, 2_000);
}

function orderModelIdsForProviderHealth(
  modelIds: readonly string[],
  models: readonly ModelCapability[],
  health: ProviderHealth,
  nowMs: number,
  maxAttempts: number,
  attemptedModelIds: ReadonlySet<string> = new Set(),
): string[] {
  const providerByModel = new Map(
    models.map((model) => [model.modelId, model.providerId]),
  );
  const unique = [...new Set(modelIds)].filter(
    (modelId) =>
      providerByModel.has(modelId) && !attemptedModelIds.has(modelId),
  );
  const active = unique.filter(
    (modelId) => !health.isCooling(providerByModel.get(modelId)!, nowMs),
  );
  return active.slice(0, maxAttempts);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('ORCHESTRATOR_CANCELLED');
}

function normalizePlannerError(error: unknown): string {
  if (error instanceof Error && error.message === 'ORCHESTRATOR_CANCELLED') {
    return 'ORCHESTRATOR_CANCELLED';
  }
  if (
    error instanceof Error &&
    error.message === 'ORCHESTRATOR_PLANNER_TIMEOUT'
  ) {
    return 'ORCHESTRATOR_PLANNER_TIMEOUT';
  }
  return 'ORCHESTRATOR_PLAN_FAILED';
}

function plannerFallbackDetail(error: unknown): string {
  if (
    error instanceof Error &&
    error.message === 'ORCHESTRATOR_PLANNER_TIMEOUT'
  ) {
    return 'ORCHESTRATOR_PLANNER_TIMEOUT_FALLBACK';
  }
  return 'ORCHESTRATOR_PLAN_FAILED_FALLBACK';
}

function isTerminalPlannerError(error: unknown): boolean {
  return error instanceof Error && error.message === 'ORCHESTRATOR_CANCELLED';
}
