import { describe, expect, it } from 'vitest';
import type { ChatProcessor, ModelCapability } from '@calypso/chat-types';

import { createTaskPlan } from '../orchestrator/planner';
import { selectModelForSubtask } from '../orchestrator/router';

const USER_TASK =
  'Write an application letter tailored for the position at OpenAI based on my resume. ' +
  'Update my resume as it is outdated. The vacancy and my resume are available in the linked folder.';

function processorWithText(text: string): ChatProcessor {
  return {
    async *streamChat() {
      yield {
        id: 'chunk_1',
        choices: [{ delta: { content: text }, finish_reason: null }],
      };
    },
  };
}

const MODELS: ModelCapability[] = [
  {
    modelId: 'gpt-5.4-mini',
    providerId: 'openai',
    strengths: ['fast_reasoning', 'filesystem_read', 'structured_extraction'],
    strengthQuality: [
      { strength: 'fast_reasoning', tier: 'strong' },
      { strength: 'filesystem_read', tier: 'strong' },
      { strength: 'structured_extraction', tier: 'standard' },
    ],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier: 'low',
    latencyTier: 'fast',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
    maxContextTokens: 400000,
  },
  {
    modelId: 'gemini-3.1-pro-preview',
    providerId: 'google',
    strengths: ['structured_extraction', 'long_context', 'research'],
    strengthQuality: [
      { strength: 'structured_extraction', tier: 'strong' },
      { strength: 'long_context', tier: 'strong' },
    ],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier: 'medium',
    latencyTier: 'standard',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
    maxContextTokens: 1048576,
  },
  {
    modelId: 'gpt-5.5',
    providerId: 'openai',
    strengths: ['writing', 'long_context', 'general_reasoning'],
    strengthQuality: [
      { strength: 'writing', tier: 'frontier' },
      { strength: 'long_context', tier: 'strong' },
    ],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier: 'high',
    latencyTier: 'standard',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
    maxContextTokens: 1050000,
  },
  {
    modelId: 'test-image-model',
    providerId: 'openai',
    strengths: ['image_generation'],
    strengthQuality: [{ strength: 'image_generation', tier: 'frontier' }],
    modalities: ['text_in', 'image_out'],
    endpointFamily: 'image',
    costTier: 'high',
    latencyTier: 'standard',
    routingStatus: 'registered_pending_gateway',
    requiredGatewayTools: ['image.generate'],
  },
];

describe('orchestrated application materials scenario', () => {
  it('plans and routes resume plus application-letter work without unsupported media subtasks', async () => {
    const plan = await createTaskPlan({
      provider: processorWithText(`
<plan id="planner_application">
{
  "planId": "model_supplied_plan_id",
  "title": "Prepare OpenAI application materials",
  "summary": "Inspect the linked folder, extract resume and vacancy facts, then draft the updated resume and tailored letter.",
  "subtasks": [
    {
      "id": "st_inspect",
      "title": "Inspect linked folder",
      "objective": "Find the resume and vacancy files in the linked folder.",
      "kind": "file_inspection",
      "requiredCapabilities": ["fast_reasoning", "filesystem_read"],
      "allowedTools": ["folder.list", "folder.read", "file.read"],
      "dependsOn": [],
      "producesArtifact": false,
      "risk": "low"
    },
    {
      "id": "st_extract",
      "title": "Compare resume and vacancy",
      "objective": "Extract relevant facts from the resume and vacancy for tailoring.",
      "kind": "extraction",
      "requiredCapabilities": ["structured_extraction", "long_context"],
      "allowedTools": ["folder.read", "file.read"],
      "dependsOn": ["st_inspect"],
      "producesArtifact": false,
      "risk": "low"
    },
    {
      "id": "st_resume",
      "title": "Update resume",
      "objective": "Draft an updated resume aligned to the vacancy.",
      "kind": "writing",
      "requiredCapabilities": ["writing", "long_context"],
      "allowedTools": ["doc.draft", "folder.write"],
      "dependsOn": ["st_extract"],
      "producesArtifact": true,
      "risk": "medium"
    },
    {
      "id": "st_letter",
      "title": "Draft application letter",
      "objective": "Write a tailored application letter for OpenAI.",
      "kind": "writing",
      "requiredCapabilities": ["writing", "long_context"],
      "allowedTools": ["doc.draft", "folder.write"],
      "dependsOn": ["st_extract"],
      "producesArtifact": true,
      "risk": "medium"
    }
  ]
}
</plan>`),
      model: 'gpt-5.5',
      plannerTag: 'planner_application',
      userText: USER_TASK,
      toolScopes: ['folder.list', 'folder.read', 'file.read', 'doc.draft', 'folder.write'],
      linkedFolderCount: 1,
    });

    expect(plan.planId).not.toBe('model_supplied_plan_id');
    expect(plan.subtasks.map((subtask) => subtask.kind)).toEqual([
      'file_inspection',
      'extraction',
      'writing',
      'writing',
    ]);
    expect(plan.subtasks.some((subtask) => subtask.allowedTools.includes('folder.list'))).toBe(
      true,
    );
    expect(
      plan.subtasks.some((subtask) =>
        subtask.requiredCapabilities.some((capability) =>
          ['long_context', 'structured_extraction'].includes(capability),
        ),
      ),
    ).toBe(true);
    expect(plan.subtasks.filter((subtask) => subtask.producesArtifact)).toHaveLength(2);
    expect(plan.subtasks.every((subtask) => subtask.kind !== 'image')).toBe(true);
    expect(plan.subtasks.every((subtask) => subtask.kind !== 'audio')).toBe(true);

    const routes = plan.subtasks.map((subtask) =>
      selectModelForSubtask(subtask, MODELS, {
        enabledEndpointFamilies: ['chat'],
      }),
    );
    expect(routes.find((route) => route.subtaskId === 'st_inspect')?.modelId).toBe(
      'gpt-5.4-mini',
    );
    expect(routes.find((route) => route.subtaskId === 'st_extract')?.modelId).toBe(
      'gemini-3.1-pro-preview',
    );
    expect(routes.find((route) => route.subtaskId === 'st_resume')?.modelId).toBe('gpt-5.5');
    expect(routes.find((route) => route.subtaskId === 'st_letter')?.modelId).toBe('gpt-5.5');
    expect(routes.map((route) => route.modelId)).not.toContain('test-image-model');
  });
});
