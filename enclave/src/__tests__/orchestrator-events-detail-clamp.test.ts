import { describe, expect, it } from 'vitest';
import { OrchestratorProgressEventSchema } from '@calypso/chat-types';

import { toProgressChunk } from '../orchestrator/events';

// Repro for the web.fetch task-abort bug (capability-proof A04): a web.fetch
// failure surfaced an upstream error whose `error.message` exceeded 500 chars.
// The executor forwards that message verbatim as the progress `detail`, the
// enclave serialises the chunk without validating it, and the client's
// `OrchestratorProgressEventSchema.parse` (apps/{mobile,web}/lib/agent/
// transport.ts) throws a Zod `too_big` error on `detail`, aborting the task
// instead of degrading. The fix clamps `detail` in toProgressChunk so the
// emitted chunk is always schema-valid.
describe('toProgressChunk detail clamping', () => {
  const longDetail = 'x'.repeat(900);

  it('emits a schema-valid orchestrator_progress chunk for an over-long error detail', () => {
    const chunk = toProgressChunk({
      kind: 'orchestrator-progress',
      planId: 'plan_1',
      subtaskId: 'subtask_1',
      status: 'error',
      label: 'Fetch URL',
      detail: longDetail,
    });

    // Before the fix this throws a ZodError (too_big on `detail`) — exactly
    // the array the UI rendered when the A04 web.fetch task aborted.
    const parsed = OrchestratorProgressEventSchema.parse(chunk);

    expect(parsed._type).toBe('orchestrator_progress');
    if (parsed._type !== 'orchestrator_progress') throw new Error('wrong variant');
    expect(parsed.detail).toBeDefined();
    expect(parsed.detail!.length).toBeLessThanOrEqual(500);
    // The first 499 chars are preserved; only the tail is replaced by an ellipsis.
    expect(parsed.detail!.startsWith('x'.repeat(499))).toBe(true);
  });

  it('emits a schema-valid orchestrator_media_job_progress chunk for an over-long detail', () => {
    const chunk = toProgressChunk({
      kind: 'orchestrator-media-job-progress',
      planId: 'plan_1',
      subtaskId: 'subtask_1',
      mediaJobId: 'media_1',
      status: 'error',
      label: 'Render',
      detail: longDetail,
      progressPercent: 0,
    });

    const parsed = OrchestratorProgressEventSchema.parse(chunk);
    expect(parsed._type).toBe('orchestrator_media_job_progress');
    if (parsed._type !== 'orchestrator_media_job_progress') {
      throw new Error('wrong variant');
    }
    expect(parsed.detail!.length).toBeLessThanOrEqual(500);
  });

  it('passes short detail through unchanged', () => {
    const chunk = toProgressChunk({
      kind: 'orchestrator-progress',
      planId: 'plan_1',
      subtaskId: 'subtask_1',
      status: 'done',
      label: 'Report status',
      detail: 'SSRF_BLOCKED',
    });
    const parsed = OrchestratorProgressEventSchema.parse(chunk);
    if (parsed._type !== 'orchestrator_progress') throw new Error('wrong variant');
    expect(parsed.detail).toBe('SSRF_BLOCKED');
  });
});
