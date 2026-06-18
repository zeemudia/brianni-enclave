import { describe, expect, it } from 'vitest';
import type { ChatProcessor, ToolName } from '@calypso/chat-types';

import { createTaskPlan } from '../planner';

// MEASURED orchestrator-DAG destructive→dependent reject (spec §12 #2, planner
// half). At plan-parse time the orchestrator only sees the generic
// `connector.act` family on a subtask's allowedTools (NOT the specific connector
// operation), so the only implementable plan-time check is the coarse,
// operation-blind one: reject a plan where a `connector.act` subtask transitively
// depends on another `connector.act` subtask. The precise turn-scoped guard in
// dispatchConnector (A1) is the runtime backstop.
//
// Re-prompt/fallback semantics (mirrors the existing dependency-graph reject):
//  - parsePlanBlock → null triggers ONE corrective re-prompt; if the model keeps
//    returning the bad shape, createTaskPlan degrades to the single-step fallback
//    (`st_single`). So a chain plan that NEVER changes ends at `st_single`, and
//    the malformed connector.act→connector.act shape never survives.

const PLANNER_TAG = 'planner_connector_dag';

// Scopes including BOTH connector families so usesOnlyAvailableTools does not
// reject the chain plans for the wrong reason.
const CONNECTOR_SCOPES: ToolName[] = ['connector.read', 'connector.act'];

function staticProcessor(text: string): ChatProcessor {
  return {
    async *streamChat() {
      yield {
        id: 'c',
        choices: [{ delta: { content: text }, finish_reason: null }],
      };
    },
  } as unknown as ChatProcessor;
}

/** A provider that returns `bad` on the first call and `good` on the retry. */
function retryingProcessor(
  bad: string,
  good: string,
): { provider: ChatProcessor; calls: () => number; prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  return {
    prompts,
    calls: () => call,
    provider: {
      async *streamChat(messages: { role: string; content: string }[]) {
        prompts.push(messages[0]?.content ?? '');
        const text = call === 0 ? bad : good;
        call += 1;
        yield { id: 'c', choices: [{ delta: { content: text }, finish_reason: null }] };
      },
    } as unknown as ChatProcessor,
  };
}

function planBlock(subtasks: string): string {
  return `<plan id="${PLANNER_TAG}">{"planId":"plan_x","title":"T","summary":"s","subtasks":[${subtasks}]}</plan>`;
}

function subtask(
  id: string,
  allowedTools: ToolName[],
  dependsOn: string[],
): string {
  return JSON.stringify({
    id,
    title: id,
    objective: 'o',
    kind: 'tool_action',
    requiredCapabilities: ['general_reasoning'],
    allowedTools,
    dependsOn,
    producesArtifact: true,
    risk: 'low',
  });
}

async function plan(text: string, toolScopes: ToolName[] = CONNECTOR_SCOPES) {
  return createTaskPlan({
    provider: staticProcessor(text),
    model: 'gpt-5.5',
    plannerTag: PLANNER_TAG,
    userText: 'do the connector work',
    toolScopes: [...toolScopes],
    linkedFolderCount: 0,
  });
}

describe('createTaskPlan — §12 #2 orchestrator-DAG connector-mutation chain reject', () => {
  it('rejects a connector.act subtask that DIRECTLY depends on another connector.act subtask', async () => {
    const text = planBlock(
      [
        subtask('st_act1', ['connector.act'], []),
        subtask('st_act2', ['connector.act'], ['st_act1']),
      ].join(','),
    );

    // The model never changes its answer, so the planner re-prompts once then
    // degrades to the single-step fallback — the malformed two-act chain must
    // NOT survive.
    const result = await plan(text);
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0]?.id).toBe('st_single');
    // No surviving chain of two connector.act subtasks.
    const actSteps = result.subtasks.filter((s) =>
      s.allowedTools.includes('connector.act'),
    );
    expect(actSteps.length).toBeLessThanOrEqual(1);
  });

  it('rejects a connector.act subtask that TRANSITIVELY depends (via a non-connector step) on another connector.act subtask', async () => {
    const text = planBlock(
      [
        subtask('st_act1', ['connector.act'], []),
        subtask('st_mid', [], ['st_act1']),
        subtask('st_act2', ['connector.act'], ['st_mid']),
      ].join(','),
    );

    const result = await plan(text);
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0]?.id).toBe('st_single');
  });

  it('ACCEPTS a connector.read subtask feeding a connector.act subtask (read → write is fine)', async () => {
    const text = planBlock(
      [
        subtask('st_read', ['connector.read'], []),
        subtask('st_act', ['connector.act'], ['st_read']),
      ].join(','),
    );

    const result = await plan(text);
    // Accepted verbatim (enclave-owned planId aside): the model's two-step plan
    // survives, NOT the single-step fallback.
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks.map((s) => s.id)).toEqual(['st_read', 'st_act']);
  });

  it('ACCEPTS two INDEPENDENT connector.act subtasks (no dependsOn between them)', async () => {
    const text = planBlock(
      [
        subtask('st_act1', ['connector.act'], []),
        subtask('st_act2', ['connector.act'], []),
      ].join(','),
    );

    const result = await plan(text);
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks.map((s) => s.id)).toEqual(['st_act1', 'st_act2']);
  });

  it('re-prompts with the connector.act chain feedback, then accepts a corrected (independent-act) plan', async () => {
    const bad = planBlock(
      [
        subtask('st_act1', ['connector.act'], []),
        subtask('st_act2', ['connector.act'], ['st_act1']),
      ].join(','),
    );
    const good = planBlock(
      [
        subtask('st_act1', ['connector.act'], []),
        subtask('st_act2', ['connector.act'], []),
      ].join(','),
    );
    const { provider, calls, prompts } = retryingProcessor(bad, good);

    const result = await createTaskPlan({
      provider,
      model: 'gpt-5.5',
      plannerTag: PLANNER_TAG,
      userText: 'do the connector work',
      toolScopes: [...CONNECTOR_SCOPES],
      linkedFolderCount: 0,
    });

    expect(calls()).toBe(2); // retried once
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks.map((s) => s.id)).toEqual(['st_act1', 'st_act2']);
    // The retry prompt carries the connector-chain correction (absent from the
    // first prompt).
    expect(prompts[0] ?? '').not.toMatch(/previous plan/i);
    expect(prompts[1] ?? '').toMatch(/connector\.act/);
  });

  it('regression: a plan with NO connector subtasks (folder read → write) is unaffected', async () => {
    const folderScopes: ToolName[] = ['folder.read', 'file.read', 'folder.write'];
    const text = planBlock(
      [
        JSON.stringify({
          id: 'st_read',
          title: 'Read',
          objective: 'o',
          kind: 'file_inspection',
          requiredCapabilities: ['filesystem_read'],
          allowedTools: ['folder.read', 'file.read'],
          dependsOn: [],
          producesArtifact: false,
          risk: 'low',
        }),
        JSON.stringify({
          id: 'st_write',
          title: 'Write',
          objective: 'o',
          kind: 'writing',
          requiredCapabilities: ['writing'],
          allowedTools: ['folder.write'],
          dependsOn: ['st_read'],
          producesArtifact: true,
          risk: 'low',
        }),
      ].join(','),
    );

    const result = await createTaskPlan({
      provider: staticProcessor(text),
      model: 'gpt-5.5',
      plannerTag: PLANNER_TAG,
      userText: 'read my files then write a summary file',
      toolScopes: folderScopes,
      linkedFolderCount: 1,
    });

    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks.map((s) => s.id)).toEqual(['st_read', 'st_write']);
  });

  it('KNOWN over-approximation: a subtask that merely SCOPES connector.act (surplus, alongside file.read) but depends on a connector.act subtask still trips the chain reject (pinned, not latent)', async () => {
    // hasConnectorActChain is operation-blind: it keys off allowedTools
    // membership, not actual use. A subtask over-scoped with connector.act
    // (here also scoping file.read) that depends on a real connector.act subtask
    // is treated as a chain and rejected → fallback. This documents the
    // intentional, fail-safe over-rejection so it can't regress silently.
    const scopes: ToolName[] = ['connector.read', 'connector.act', 'file.read'];
    const result = await plan(
      planBlock(
        [
          subtask('st_act1', ['connector.act'], []),
          // surplus connector.act scope; at runtime this step would only file.read
          subtask('st_surplus', ['connector.act', 'file.read'], ['st_act1']),
        ].join(','),
      ),
      scopes,
    );
    // Rejected → degrades to the single-step fallback (over-approximation cost is
    // planner quality, never a safety regression — the runtime A1 guard is precise).
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0]?.id).toBe('st_single');
  });
});
