import type {
  AgentTaskPlan,
  MediaArtifactKind,
  MediaJobStatus,
  ModelRouteDecision,
  OrchestratorEventScope,
  OrchestratorProgressEvent,
} from '@calypso/chat-types';

import type { AgentLoopEvent } from '../agent/loop';

// Mirrors the `detail: z.string().max(500)` bound on the
// `orchestrator_progress` / `orchestrator_media_job_progress` variants of
// OrchestratorProgressEventSchema (packages/chat-types/src/orchestrator.ts).
// Progress `detail` is frequently sourced from an upstream `error.message`
// (executor.ts subtask-failure / route-failure / retry paths), which is
// unbounded — a long worker/provider/network error message would otherwise
// produce a chunk that fails the client's `OrchestratorProgressEventSchema.parse`
// (apps/{mobile,web}/lib/agent/transport.ts), aborting the whole task with a
// raw Zod `too_big` error instead of degrading gracefully. Clamp here so the
// envelope is always schema-valid regardless of the detail source.
const PROGRESS_DETAIL_MAX_CHARS = 500;

function clampProgressDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  if (detail.length <= PROGRESS_DETAIL_MAX_CHARS) return detail;
  // Reserve room for a single-character ellipsis so the result is <= the max.
  return `${detail.slice(0, PROGRESS_DETAIL_MAX_CHARS - 1)}…`;
}

export type OrchestratorExecutorEvent =
  | {
      kind: 'orchestrator-plan';
      plan: AgentTaskPlan;
      routes: ModelRouteDecision[];
    }
  | {
      kind: 'orchestrator-progress';
      planId: string;
      subtaskId: string;
      status: 'queued' | 'running' | 'blocked' | 'done' | 'error' | 'skipped';
      label: string;
      detail?: string;
    }
  | {
      kind: 'orchestrator-text';
      planId: string;
      subtaskId: string;
      role: 'working' | 'final_artifact';
      text: string;
    }
  | {
      kind: 'orchestrator-media-job-progress';
      planId: string;
      subtaskId: string;
      mediaJobId: string;
      status: MediaJobStatus;
      label: string;
      detail?: string;
      progressPercent?: number;
    }
  | {
      kind: 'orchestrator-artifact';
      planId: string;
      subtaskId: string;
      artifactId: string;
      artifactKind: MediaArtifactKind;
      title: string;
      byteSize: number;
      sha256: string;
      ciphertextRef: string;
    };

export type OrchestratorScopedAgentLoopEvent =
  | (Extract<AgentLoopEvent, { kind: 'tool-invocation' }> & {
      orchestrator: OrchestratorEventScope;
    })
  | (Extract<AgentLoopEvent, { kind: 'ledger' }> & {
      orchestrator: OrchestratorEventScope;
    })
  | (Extract<AgentLoopEvent, { kind: 'memory-write-signed' }> & {
      orchestrator: OrchestratorEventScope;
    })
  | (Extract<AgentLoopEvent, { kind: 'binary-write-request' }> & {
      orchestrator: OrchestratorEventScope;
    })
  | Extract<AgentLoopEvent, { kind: 'usage' }>
  | (Extract<AgentLoopEvent, { kind: 'error' }> & {
      orchestrator: OrchestratorEventScope;
    });

export function toProgressChunk(
  event: OrchestratorExecutorEvent,
): OrchestratorProgressEvent {
  if (event.kind === 'orchestrator-plan') {
    return {
      _type: 'orchestrator_plan',
      plan: event.plan,
      routes: event.routes,
    };
  }
  if (event.kind === 'orchestrator-text') {
    return {
      _type: 'orchestrator_text',
      planId: event.planId,
      subtaskId: event.subtaskId,
      role: event.role,
      text: event.text,
    };
  }
  if (event.kind === 'orchestrator-media-job-progress') {
    return {
      _type: 'orchestrator_media_job_progress',
      planId: event.planId,
      subtaskId: event.subtaskId,
      mediaJobId: event.mediaJobId,
      status: event.status,
      label: event.label,
      detail: clampProgressDetail(event.detail),
      progressPercent: event.progressPercent,
    };
  }
  if (event.kind === 'orchestrator-artifact') {
    return {
      _type: 'orchestrator_artifact',
      planId: event.planId,
      subtaskId: event.subtaskId,
      artifactId: event.artifactId,
      kind: event.artifactKind,
      title: event.title,
      byteSize: event.byteSize,
      sha256: event.sha256,
      ciphertextRef: event.ciphertextRef,
    };
  }
  return {
    _type: 'orchestrator_progress',
    planId: event.planId,
    subtaskId: event.subtaskId,
    status: event.status,
    label: event.label,
    detail: clampProgressDetail(event.detail),
  };
}
