import { describe, expect, it } from 'vitest';
import type { ModelCapability } from '@calypso/chat-types';

import { buildModelCapabilities } from '../orchestrator/model-capabilities';
import { selectModelForSubtask } from '../orchestrator/router';

describe('orchestrator model capabilities', () => {
  it('extracts capability metadata from provider registry models', () => {
    const capabilities = buildModelCapabilities([
      {
        id: 'openai',
        adapter: 'openai_v1',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnvVar: 'OPENAI_API_KEY',
        models: [
          {
            id: 'gpt-5.5',
            displayName: 'GPT-5.5',
            contextWindow: 1050000,
            capabilities: {
              strengths: ['general_reasoning', 'long_context', 'writing'],
              strengthQuality: [{ strength: 'writing', tier: 'frontier' }],
              modalities: ['text_in', 'text_out'],
              endpointFamily: 'chat',
              costTier: 'high',
              latencyTier: 'standard',
              routingStatus: 'enabled',
              nativeWebSearch: {
                providerTool: 'openai_web_search',
                toolVersion: 'responses-web_search',
              },
            },
          },
          {
            id: 'test-image-model',
            displayName: 'Test Image Model',
            capabilities: {
              strengths: ['image_generation'],
              strengthQuality: [
                { strength: 'image_generation', tier: 'frontier' },
              ],
              modalities: ['text_in', 'image_in', 'image_out'],
              endpointFamily: 'image',
              costTier: 'high',
              latencyTier: 'standard',
              routingStatus: 'registered_pending_gateway',
              requiredGatewayTools: ['image.generate', 'image.edit'],
            },
          },
        ],
      },
    ]);

    expect(capabilities[0]).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      strengths: ['general_reasoning', 'long_context', 'writing'],
      maxContextTokens: 1050000,
      nativeWebSearch: {
        providerTool: 'openai_web_search',
        toolVersion: 'responses-web_search',
      },
    });
    expect(
      capabilities.find((model) => model.modelId === 'test-image-model'),
    ).toMatchObject({
      strengths: ['image_generation'],
      endpointFamily: 'image',
      routingStatus: 'registered_pending_gateway',
      requiredGatewayTools: ['image.generate', 'image.edit'],
    });
  });

  it('uses conservative fallback metadata for old registry entries', () => {
    const capabilities = buildModelCapabilities([
      {
        id: 'anthropic',
        adapter: 'anthropic_v1',
        baseUrl: 'https://api.anthropic.com',
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        models: [{ id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' }],
      },
    ]);

    expect(capabilities[0]?.strengths).toEqual(['general_reasoning']);
    expect(capabilities[0]?.modalities).toEqual(['text_in', 'text_out']);
    expect(capabilities[0]?.endpointFamily).toBe('chat');
    expect(capabilities[0]?.routingStatus).toBe('enabled');
  });
});

describe('selectModelForSubtask', () => {
  const models: ModelCapability[] = [
    {
      modelId: 'gpt-5.5',
      providerId: 'openai',
      strengths: ['planning', 'long_context', 'writing', 'general_reasoning'],
      strengthQuality: [
        { strength: 'planning', tier: 'frontier' },
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
      modelId: 'gpt-5.4-mini',
      providerId: 'openai',
      strengths: ['fast_reasoning', 'classification', 'structured_extraction'],
      strengthQuality: [
        { strength: 'fast_reasoning', tier: 'strong' },
        { strength: 'classification', tier: 'strong' },
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
      strengths: ['research', 'long_context', 'structured_extraction'],
      strengthQuality: [
        { strength: 'research', tier: 'frontier' },
        { strength: 'long_context', tier: 'strong' },
        { strength: 'structured_extraction', tier: 'strong' },
      ],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 1048576,
    },
  ];

  it('chooses a fast cheap model for classification', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_classify',
        title: 'Classify files',
        objective: 'Find the resume and vacancy.',
        kind: 'classification',
        requiredCapabilities: ['fast_reasoning', 'structured_extraction'],
        allowedTools: ['folder.list'],
        dependsOn: [],
        producesArtifact: false,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('gpt-5.4-mini');
  });

  it('chooses a research model for research subtasks', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_research',
        title: 'Research employer',
        objective: 'Find facts about OpenAI role expectations.',
        kind: 'research',
        requiredCapabilities: ['research', 'long_context'],
        allowedTools: ['web.fetch'],
        dependsOn: [],
        producesArtifact: false,
        risk: 'medium',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('gemini-3.1-pro-preview');
  });

  it('chooses a strong writing model for final drafting', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_write',
        title: 'Draft letter',
        objective: 'Write a polished application letter.',
        kind: 'writing',
        requiredCapabilities: ['writing', 'long_context'],
        allowedTools: ['doc.draft', 'folder.write'],
        dependsOn: ['st_classify'],
        producesArtifact: true,
        risk: 'medium',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('gpt-5.5');
  });

  it('orders fallbacks across providers before lower-ranked same-provider models', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_write',
        title: 'Write report',
        objective: 'Write the final report.',
        kind: 'writing',
        requiredCapabilities: ['writing', 'long_context'],
        allowedTools: [],
        dependsOn: [],
        producesArtifact: true,
        risk: 'low',
      },
      [
        ...models,
        {
          modelId: 'gpt-5.4',
          providerId: 'openai',
          strengths: ['general_reasoning', 'long_context', 'writing'],
          strengthQuality: [
            { strength: 'writing', tier: 'strong' },
            { strength: 'long_context', tier: 'strong' },
          ],
          modalities: ['text_in', 'text_out'],
          endpointFamily: 'chat',
          costTier: 'medium',
          latencyTier: 'standard',
          routingStatus: 'enabled',
          requiredGatewayTools: [],
          maxContextTokens: 1_000_000,
        },
        {
          modelId: 'claude-opus-4-7',
          providerId: 'anthropic',
          strengths: ['general_reasoning', 'writing'],
          strengthQuality: [{ strength: 'writing', tier: 'frontier' }],
          modalities: ['text_in', 'text_out'],
          endpointFamily: 'chat',
          costTier: 'high',
          latencyTier: 'standard',
          routingStatus: 'enabled',
          requiredGatewayTools: [],
          maxContextTokens: 200_000,
        },
      ],
      { enabledEndpointFamilies: ['chat'] },
    );

    expect(decision.modelId).toBe('gpt-5.5');
    expect(decision.providerId).toBe('openai');
    expect(decision.fallbackModelIds[0]).toBe('claude-opus-4-7');
  });

  // Regression: the live "Reply with exactly one sentence" task dead-ended with
  // NO_MODEL_FOR_SUBTASK because the planner labels short writing tasks
  // ['writing','fast_reasoning'], but the catalog splits the speed axis
  // (fast_reasoning lives on the small/fast models) from the content axis
  // (writing lives on the frontier models). Strict superset matching meant no
  // single model held both, so the simplest possible task failed. A speed
  // preference must never make a content task unroutable.
  it('routes a writing+fast_reasoning subtask to the best writer instead of failing closed', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_reply',
        title: 'Write confirmation sentence',
        objective: 'Reply with exactly one sentence.',
        kind: 'writing',
        requiredCapabilities: ['writing', 'fast_reasoning'],
        allowedTools: [],
        dependsOn: [],
        producesArtifact: true,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('gpt-5.5');
  });

  // Guard the partition: relaxing soft capabilities must NOT relax modality
  // gates. A subtask that also needs a true modality capability (video) must
  // still fail closed against chat-only models, even though those models match
  // the soft 'writing' capability.
  it('still fails closed when a hard modality capability is unmet, despite a soft-capability match', () => {
    expect(() =>
      selectModelForSubtask(
        {
          id: 'st_mixed',
          title: 'Write and animate',
          objective: 'Write a caption and generate a clip.',
          kind: 'writing',
          requiredCapabilities: ['writing', 'video_generation'],
          allowedTools: [],
          dependsOn: [],
          producesArtifact: true,
          risk: 'medium',
        },
        models,
        { enabledEndpointFamilies: ['chat'] },
      ),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('routes local OCR and transcription subtasks through chat models when tools satisfy media capabilities', () => {
    const imageDecision = selectModelForSubtask(
      {
        id: 'st_ocr',
        title: 'OCR private image',
        objective: 'Use the local OCR tool to read text from proof-image.png.',
        kind: 'image',
        requiredCapabilities: ['vision', 'general_reasoning'],
        allowedTools: ['image.ocr'],
        dependsOn: [],
        producesArtifact: false,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );
    const audioDecision = selectModelForSubtask(
      {
        id: 'st_transcribe_local',
        title: 'Transcribe private audio',
        objective: 'Use the local transcription tool to transcribe proof-audio.m4a.',
        kind: 'audio',
        requiredCapabilities: ['speech_to_text', 'general_reasoning'],
        allowedTools: ['audio.transcribe'],
        dependsOn: [],
        producesArtifact: false,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );

    expect(imageDecision.modelId).toBe('gpt-5.5');
    expect(audioDecision.modelId).toBe('gpt-5.5');
  });

  it('routes bounded local media transforms through chat even if the planner labels them with generation caps', () => {
    const imageDecision = selectModelForSubtask(
      {
        id: 'st_resize',
        title: 'Resize private image',
        objective: 'Use the local image transform tool to resize proof-image.png.',
        kind: 'image',
        requiredCapabilities: ['image_generation', 'general_reasoning'],
        allowedTools: ['image.transform'],
        dependsOn: [],
        producesArtifact: true,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );
    const audioDecision = selectModelForSubtask(
      {
        id: 'st_clip',
        title: 'Clip private audio',
        objective: 'Use the local audio transform tool to create a WAV clip.',
        kind: 'audio',
        requiredCapabilities: ['audio_generation', 'general_reasoning'],
        allowedTools: ['audio.transform'],
        dependsOn: [],
        producesArtifact: true,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );
    const videoDecision = selectModelForSubtask(
      {
        id: 'st_extract_audio',
        title: 'Extract private video audio',
        objective: 'Use the local video transform tool to extract an audio track.',
        kind: 'video',
        requiredCapabilities: ['video_generation', 'general_reasoning'],
        allowedTools: ['video.transform'],
        dependsOn: [],
        producesArtifact: true,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );

    expect(imageDecision.modelId).toBe('gpt-5.5');
    expect(audioDecision.modelId).toBe('gpt-5.5');
    expect(videoDecision.modelId).toBe('gpt-5.5');
  });

  // Regression (live A12/A14 on PCR0 d04aa48b): the LLM planner labels a media
  // TRANSFORM subtask with a modality capability that the old exact (cap→tool)
  // map did not pair with the tool the planner actually scoped — e.g. an image
  // resize tagged 'vision' (old map satisfied 'vision' only by inspect/ocr) while
  // scoping image.transform, or a video audio-extract tagged 'vision'. Every
  // enabled model then scored 0 and the subtask dead-ended in NO_MODEL_FOR_SUBTASK.
  // A local family tool must satisfy ANY hard cap that family can serve.
  it('routes a media transform through chat even when the planner mislabels its modality capability', () => {
    const imageResizeAsVision = selectModelForSubtask(
      {
        id: 'st_resize',
        title: 'Create resized copy',
        objective: 'Resize proof-image.png with the local transform tool.',
        kind: 'image',
        requiredCapabilities: ['vision', 'general_reasoning'],
        allowedTools: ['image.transform'],
        dependsOn: ['st_inspect'],
        producesArtifact: true,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );
    const videoExtractAsVision = selectModelForSubtask(
      {
        id: 'st_extract_audio',
        title: 'Extract audio track',
        objective: 'Extract the audio track from proof-video.mp4.',
        kind: 'video',
        requiredCapabilities: ['vision', 'speech_to_text', 'general_reasoning'],
        allowedTools: ['video.transform'],
        dependsOn: ['st_transcribe'],
        producesArtifact: true,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );

    expect(imageResizeAsVision.modelId).toBe('gpt-5.5');
    expect(videoExtractAsVision.modelId).toBe('gpt-5.5');
  });

  // Regression (live A14 on PCR0 97cc3994): "extract the audio track to .m4a"
  // scopes video.transform but the planner labels it 'audio_generation' (it is
  // producing an audio file). The video family did not list audio_generation, so
  // the subtask dead-ended in NO_MODEL_FOR_SUBTASK:st_extract_audio and skipped
  // its dependent summary — even though video.transform performs the extraction
  // locally. A video tool can derive audio, so the video family must satisfy it.
  it('routes a video audio-extract through chat when the planner labels it audio_generation', () => {
    const videoExtractAsAudioGen = selectModelForSubtask(
      {
        id: 'st_extract_audio',
        title: 'Extract audio track',
        objective: 'Extract the audio track from proof-video.mp4 to proof-video-audio.m4a.',
        kind: 'video',
        requiredCapabilities: ['audio_generation', 'general_reasoning'],
        allowedTools: ['video.transform'],
        dependsOn: ['st_transcribe'],
        producesArtifact: true,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );

    expect(videoExtractAsAudioGen.modelId).toBe('gpt-5.5');
  });

  // Regression (live A08 on PCR0 d04aa48b): the planner decomposed a privacy
  // boundary prompt into an "Assess request against privacy policy" subtask
  // labelled requiredCapabilities:['moderation']. 'moderation' was a HARD cap
  // and no enabled chat model carries it, so the subtask dead-ended in
  // NO_MODEL_FOR_SUBTASK and skipped its dependent report. A policy/safety
  // judgment is an in-context task any chat model can do — it must route.
  it('routes a moderation/policy-assessment subtask through a chat model', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_assess',
        title: 'Assess request against privacy policy',
        objective: 'Decide whether fetching the canary URL would exfiltrate data.',
        kind: 'reasoning',
        requiredCapabilities: ['moderation', 'general_reasoning'],
        allowedTools: [],
        dependsOn: ['st_read'],
        producesArtifact: false,
        risk: 'low',
      },
      models,
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBeDefined();
    expect(decision.modelId).not.toBe('');
  });

  it('does not let a cheap mini model displace a frontier writer for writing', () => {
    const miniWriter: ModelCapability = {
      modelId: 'gpt-5.4-mini-writing',
      providerId: 'openai',
      strengths: ['writing'],
      strengthQuality: [{ strength: 'writing', tier: 'basic' }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'low',
      latencyTier: 'fast',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 128000,
    };
    const decision = selectModelForSubtask(
      {
        id: 'st_write',
        title: 'Draft letter',
        objective: 'Write a polished application letter.',
        kind: 'writing',
        requiredCapabilities: ['writing'],
        allowedTools: ['doc.draft'],
        dependsOn: [],
        producesArtifact: true,
        risk: 'medium',
      },
      [...models, miniWriter],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('gpt-5.5');
  });

  it('fails closed when no modality is available', () => {
    expect(() =>
      selectModelForSubtask(
        {
          id: 'st_image',
          title: 'Create image',
          objective: 'Generate an image.',
          kind: 'image',
          requiredCapabilities: ['image_generation'],
          allowedTools: [],
          dependsOn: [],
          producesArtifact: false,
          risk: 'low',
        },
        models,
        { enabledEndpointFamilies: ['chat'] },
      ),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('does not route to registered specialist models until their gateway tools exist', () => {
    expect(() =>
      selectModelForSubtask(
        {
          id: 'st_image',
          title: 'Create image',
          objective: 'Generate an image.',
          kind: 'image',
          requiredCapabilities: ['image_generation'],
          allowedTools: [],
          dependsOn: [],
          producesArtifact: false,
          risk: 'low',
        },
        [
          {
            modelId: 'test-image-model',
            providerId: 'openai',
            strengths: ['image_generation'],
            strengthQuality: [
              { strength: 'image_generation', tier: 'frontier' },
            ],
            modalities: ['text_in', 'image_out'],
            endpointFamily: 'image',
            costTier: 'high',
            latencyTier: 'standard',
            routingStatus: 'registered_pending_gateway',
            requiredGatewayTools: ['image.generate'],
          },
        ],
        { enabledGatewayTools: [], enabledEndpointFamilies: ['chat', 'image'] },
      ),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('routes image and audio specialists when their adapters and gateway tools are enabled', () => {
    const imageDecision = selectModelForSubtask(
      {
        id: 'st_image',
        title: 'Create image',
        objective: 'Generate an image.',
        kind: 'image',
        requiredCapabilities: ['image_generation'],
        allowedTools: ['image.generate'],
        dependsOn: [],
        producesArtifact: true,
        risk: 'medium',
      },
      [
        {
          modelId: 'test-image-model',
          providerId: 'openai',
          strengths: ['image_generation'],
          strengthQuality: [
            { strength: 'image_generation', tier: 'frontier' },
          ],
          modalities: ['text_in', 'image_out'],
          endpointFamily: 'image',
          costTier: 'high',
          latencyTier: 'standard',
          routingStatus: 'enabled',
          requiredGatewayTools: ['image.generate'],
        },
      ],
      {
        enabledGatewayTools: ['image.generate'],
        enabledEndpointFamilies: ['chat', 'image'],
      },
    );

    const audioDecision = selectModelForSubtask(
      {
        id: 'st_audio',
        title: 'Create voiceover',
        objective: 'Generate speech from the script.',
        kind: 'audio',
        requiredCapabilities: ['audio_generation'],
        allowedTools: ['audio.speech'],
        dependsOn: [],
        producesArtifact: true,
        risk: 'medium',
      },
      [
        {
          modelId: 'test-audio-model',
          providerId: 'openai',
          strengths: ['audio_generation'],
          strengthQuality: [
            { strength: 'audio_generation', tier: 'strong' },
          ],
          modalities: ['text_in', 'audio_out'],
          endpointFamily: 'audio_speech',
          costTier: 'medium',
          latencyTier: 'fast',
          routingStatus: 'enabled',
          requiredGatewayTools: ['audio.speech'],
        },
      ],
      {
        enabledGatewayTools: ['audio.speech'],
        enabledEndpointFamilies: ['chat', 'audio_speech'],
      },
    );

    const transcriptionDecision = selectModelForSubtask(
      {
        id: 'st_transcribe',
        title: 'Transcribe memo',
        objective: 'Turn the uploaded memo audio into text.',
        kind: 'audio',
        requiredCapabilities: ['speech_to_text'],
        allowedTools: ['audio.transcribe'],
        dependsOn: [],
        producesArtifact: true,
        risk: 'medium',
      },
      [
        {
          modelId: 'test-transcribe-model',
          providerId: 'openai',
          strengths: ['speech_to_text'],
          strengthQuality: [
            { strength: 'speech_to_text', tier: 'strong' },
          ],
          modalities: ['audio_in', 'text_out'],
          endpointFamily: 'audio_transcription',
          costTier: 'medium',
          latencyTier: 'fast',
          routingStatus: 'enabled',
          requiredGatewayTools: ['audio.transcribe'],
        },
      ],
      {
        enabledGatewayTools: ['audio.transcribe'],
        enabledEndpointFamilies: ['chat', 'audio_transcription'],
      },
    );

    expect(imageDecision.modelId).toBe('test-image-model');
    expect(audioDecision.modelId).toBe('test-audio-model');
    expect(transcriptionDecision.modelId).toBe('test-transcribe-model');
  });

  it('does not route specialist endpoint families until their adapter is enabled', () => {
    expect(() =>
      selectModelForSubtask(
        {
          id: 'st_image',
          title: 'Create image',
          objective: 'Generate an image.',
          kind: 'image',
          requiredCapabilities: ['image_generation'],
          allowedTools: ['image.generate'],
          dependsOn: [],
          producesArtifact: true,
          risk: 'medium',
        },
        [
          {
            modelId: 'test-image-model',
            providerId: 'openai',
            strengths: ['image_generation'],
            strengthQuality: [
              { strength: 'image_generation', tier: 'frontier' },
            ],
            modalities: ['text_in', 'image_out'],
            endpointFamily: 'image',
            costTier: 'high',
            latencyTier: 'standard',
            routingStatus: 'enabled',
            requiredGatewayTools: ['image.generate'],
          },
        ],
        {
          enabledGatewayTools: ['image.generate'],
          enabledEndpointFamilies: ['chat'],
        },
      ),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('keeps production chat-only routing closed even when specialist tools are scoped', () => {
    expect(() =>
      selectModelForSubtask(
        {
          id: 'st_image',
          title: 'Create image',
          objective: 'Generate an image.',
          kind: 'image',
          requiredCapabilities: ['image_generation'],
          allowedTools: ['image.generate'],
          dependsOn: [],
          producesArtifact: true,
          risk: 'medium',
        },
        [
          {
            modelId: 'test-image-model',
            providerId: 'openai',
            strengths: ['image_generation'],
            strengthQuality: [
              { strength: 'image_generation', tier: 'frontier' },
            ],
            modalities: ['text_in', 'image_out'],
            endpointFamily: 'image',
            costTier: 'high',
            latencyTier: 'standard',
            routingStatus: 'enabled',
            requiredGatewayTools: ['image.generate'],
          },
          {
            modelId: 'test-audio-model',
            providerId: 'openai',
            strengths: ['audio_generation'],
            strengthQuality: [
              { strength: 'audio_generation', tier: 'strong' },
            ],
            modalities: ['text_in', 'audio_out'],
            endpointFamily: 'audio_speech',
            costTier: 'medium',
            latencyTier: 'fast',
            routingStatus: 'enabled',
            requiredGatewayTools: ['audio.speech'],
          },
        ],
        {
          enabledGatewayTools: [
            'folder.read',
            'image.generate',
            'audio.speech',
          ],
          enabledEndpointFamilies: ['chat'],
        },
      ),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('does not route responses endpoint models until a responses adapter exists', () => {
    expect(() =>
      selectModelForSubtask(
        {
          id: 'st_reason',
          title: 'Reason',
          objective: 'Reason through the task.',
          kind: 'reasoning',
          requiredCapabilities: ['general_reasoning'],
          allowedTools: [],
          dependsOn: [],
          producesArtifact: false,
          risk: 'low',
        },
        [
          {
            modelId: 'test-responses-model',
            providerId: 'openai',
            strengths: ['general_reasoning'],
            strengthQuality: [
              { strength: 'general_reasoning', tier: 'standard' },
            ],
            modalities: ['text_in', 'text_out'],
            endpointFamily: 'responses',
            costTier: 'medium',
            latencyTier: 'standard',
            routingStatus: 'enabled',
            requiredGatewayTools: [],
          },
        ],
        { enabledEndpointFamilies: ['chat'] },
      ),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });
});

describe('selectModelForSubtask — image generation routing (both gates open)', () => {
  const imageModel: ModelCapability = {
    modelId: 'gpt-image-2',
    providerId: 'openai',
    strengths: ['image_generation'],
    strengthQuality: [{ strength: 'image_generation', tier: 'frontier' }],
    modalities: ['text_in', 'image_in', 'image_out'],
    endpointFamily: 'image',
    costTier: 'high',
    latencyTier: 'standard',
    routingStatus: 'enabled',
    requiredGatewayTools: ['image.generate', 'image.edit'],
  };
  const chatModel: ModelCapability = {
    modelId: 'gpt-5.5',
    providerId: 'openai',
    strengths: ['general_reasoning', 'writing'],
    strengthQuality: [{ strength: 'writing', tier: 'frontier' }],
    modalities: ['text_in', 'text_out'],
    endpointFamily: 'chat',
    costTier: 'high',
    latencyTier: 'standard',
    routingStatus: 'enabled',
    requiredGatewayTools: [],
  };
  const imageSubtask = {
    id: 'st_image',
    title: 'Generate poster',
    objective: 'Generate a bake-sale poster image.',
    kind: 'image' as const,
    requiredCapabilities: ['image_generation' as const, 'general_reasoning' as const],
    allowedTools: ['image.generate' as const],
    dependsOn: [],
    producesArtifact: true,
    risk: 'low' as const,
  };

  it('routes an image_generate subtask to the enabled image model when the image endpoint family + gateway tools are enabled', () => {
    const decision = selectModelForSubtask([imageSubtask][0], [chatModel, imageModel], {
      enabledEndpointFamilies: ['chat', 'image'],
      enabledGatewayTools: ['image.generate', 'image.edit'],
    });
    expect(decision.modelId).toBe('gpt-image-2');
    expect(decision.providerId).toBe('openai');
  });

  it('fails closed (NO_MODEL_FOR_SUBTASK) when the image endpoint family is NOT enabled — the fail-closed gate', () => {
    expect(() =>
      selectModelForSubtask(imageSubtask, [chatModel, imageModel], {
        enabledEndpointFamilies: ['chat'], // image family withheld
        enabledGatewayTools: ['image.generate', 'image.edit'],
      }),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('fails closed when the image model is registered_pending_gateway (not enabled)', () => {
    expect(() =>
      selectModelForSubtask(imageSubtask, [chatModel, { ...imageModel, routingStatus: 'registered_pending_gateway' }], {
        enabledEndpointFamilies: ['chat', 'image'],
        enabledGatewayTools: ['image.generate', 'image.edit'],
      }),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });
});

// Provider-diverse fallback ordering & cap. The fallback list must (a) exclude
// the primary, (b) round-robin across DISTINCT providers so the first fallbacks
// come from providers other than the primary's, (c) keep same-provider models
// LAST, and (d) be capped at 4 entries.
describe('selectModelForSubtask — provider-diverse fallback ordering', () => {
  function writer(
    modelId: string,
    providerId: string,
    tier: 'frontier' | 'strong' | 'standard' | 'basic',
  ): ModelCapability {
    return {
      modelId,
      providerId,
      strengths: ['writing', 'general_reasoning'],
      strengthQuality: [{ strength: 'writing', tier }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 200_000,
    };
  }

  const writeSubtask = {
    id: 'st_write',
    title: 'Write report',
    objective: 'Write the final report.',
    kind: 'writing' as const,
    requiredCapabilities: ['writing' as const],
    allowedTools: [],
    dependsOn: [],
    producesArtifact: true,
    risk: 'low' as const,
  };

  it('excludes the primary model from its own fallback list', () => {
    const decision = selectModelForSubtask(
      writeSubtask,
      [
        writer('openai-frontier', 'openai', 'frontier'),
        writer('anthropic-strong', 'anthropic', 'strong'),
      ],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('openai-frontier');
    expect(decision.fallbackModelIds).not.toContain('openai-frontier');
    expect(decision.fallbackModelIds).toContain('anthropic-strong');
  });

  it('orders cross-provider fallbacks before same-provider lower-ranked models', () => {
    // Primary = openai-frontier (openai). openai also has a weaker model.
    // Cross-provider anthropic/google models must come BEFORE the second openai
    // model, which is appended last.
    const decision = selectModelForSubtask(
      writeSubtask,
      [
        writer('openai-frontier', 'openai', 'frontier'),
        writer('openai-weak', 'openai', 'basic'),
        writer('anthropic-strong', 'anthropic', 'strong'),
        writer('google-standard', 'google', 'standard'),
      ],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('openai-frontier');
    // anthropic + google (distinct providers) come first; the same-provider
    // openai-weak is last.
    expect(decision.fallbackModelIds).toEqual([
      'anthropic-strong',
      'google-standard',
      'openai-weak',
    ]);
  });

  it('round-robins one model per provider before taking a second from any provider', () => {
    // openai (primary) has two extra models; anthropic has one. Round-robin must
    // interleave: first pass takes one anthropic (cross-provider) then one
    // openai extra, second pass takes the remaining openai extra.
    const decision = selectModelForSubtask(
      writeSubtask,
      [
        writer('openai-frontier', 'openai', 'frontier'),
        writer('openai-strong', 'openai', 'strong'),
        writer('openai-standard', 'openai', 'standard'),
        writer('anthropic-strong', 'anthropic', 'strong'),
      ],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('openai-frontier');
    // anthropic provider is ordered before primary's own provider; each pass
    // shifts one per provider.
    expect(decision.fallbackModelIds).toEqual([
      'anthropic-strong',
      'openai-strong',
      'openai-standard',
    ]);
  });

  it('caps the fallback list at exactly four entries', () => {
    // Six distinct cross-provider fallbacks available; only four are returned.
    const decision = selectModelForSubtask(
      writeSubtask,
      [
        writer('openai-frontier', 'openai', 'frontier'),
        writer('p1-a', 'prov1', 'strong'),
        writer('p2-a', 'prov2', 'strong'),
        writer('p3-a', 'prov3', 'strong'),
        writer('p4-a', 'prov4', 'strong'),
        writer('p5-a', 'prov5', 'strong'),
        writer('p6-a', 'prov6', 'strong'),
      ],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('openai-frontier');
    expect(decision.fallbackModelIds).toHaveLength(4);
  });

  it('returns an empty fallback list when the primary is the only viable model', () => {
    const decision = selectModelForSubtask(
      writeSubtask,
      [writer('openai-frontier', 'openai', 'frontier')],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('openai-frontier');
    expect(decision.fallbackModelIds).toEqual([]);
  });

  it('reports the matched capabilities and subtask kind in the decision reason', () => {
    // Two required capabilities so the ", " join separator is observable (a
    // single cap cannot distinguish join(", ") from join("")).
    const decision = selectModelForSubtask(
      {
        ...writeSubtask,
        kind: 'research',
        requiredCapabilities: ['writing', 'general_reasoning'],
      },
      [writer('openai-frontier', 'openai', 'frontier')],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.reason).toBe('Matched writing, general_reasoning for research.');
    expect(decision.subtaskId).toBe('st_write');
  });

  it('interleaves cross-provider fallbacks one-per-provider per round (round-robin, not drain-first)', () => {
    // Primary is provC. Two cross-providers remain: provA has TWO models, provB
    // has ONE. Correct round-robin takes provA-1, provB-1, provA-2 (one per
    // provider per pass). A drain-first bug (break after every single push)
    // would produce provA-1, provA-2, provB-1. provA sorts before provB so
    // bucket insertion order is provA then provB.
    const decision = selectModelForSubtask(
      writeSubtask,
      [
        writer('provC-primary', 'provC', 'frontier'),
        writer('provA-1', 'provA', 'strong'),
        writer('provA-2', 'provA', 'standard'),
        writer('provB-1', 'provB', 'strong'),
      ],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('provC-primary');
    expect(decision.fallbackModelIds).toEqual(['provA-1', 'provB-1', 'provA-2']);
  });
});

// Hard-capability gate coverage for the modality strengths that the existing
// suite does not exercise as fail-closed gates: vision, embedding, computer_use.
// If any of these were demoted to a soft preference (the literal `''` mutants on
// HARD_CAPABILITIES), a subtask requiring it would route to a chat model that
// lacks it instead of failing closed.
describe('selectModelForSubtask — hard modality gates (vision/embedding/computer_use)', () => {
  const chatOnly: ModelCapability[] = [
    {
      modelId: 'gpt-5.5',
      providerId: 'openai',
      strengths: ['writing', 'general_reasoning'],
      strengthQuality: [{ strength: 'writing', tier: 'frontier' }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'high',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 400_000,
    },
  ];

  function base(
    cap: 'vision' | 'embedding' | 'computer_use',
    allowedTools: string[] = [],
  ) {
    return {
      id: 'st_hard',
      title: 'Hard cap subtask',
      objective: 'Needs a true modality capability.',
      kind: 'reasoning' as const,
      requiredCapabilities: [cap, 'general_reasoning' as const],
      allowedTools: allowedTools as never,
      dependsOn: [],
      producesArtifact: false,
      risk: 'low' as const,
    };
  }

  it('fails closed when a vision capability is required and no model (or local tool) supplies it', () => {
    expect(() =>
      selectModelForSubtask(base('vision'), chatOnly, {
        enabledEndpointFamilies: ['chat'],
      }),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('fails closed when an embedding capability is required and no model supplies it', () => {
    expect(() =>
      selectModelForSubtask(base('embedding'), chatOnly, {
        enabledEndpointFamilies: ['chat'],
      }),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('fails closed when a computer_use capability is required and no model supplies it', () => {
    expect(() =>
      selectModelForSubtask(base('computer_use'), chatOnly, {
        enabledEndpointFamilies: ['chat'],
      }),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('fails closed when an audio_generation capability is required and no model (or local tool) supplies it', () => {
    expect(() =>
      selectModelForSubtask(
        {
          id: 'st_audio_hard',
          title: 'Generate speech',
          objective: 'Generate provider speech.',
          kind: 'audio',
          requiredCapabilities: ['audio_generation', 'general_reasoning'],
          allowedTools: [],
          dependsOn: [],
          producesArtifact: true,
          risk: 'low',
        },
        chatOnly,
        { enabledEndpointFamilies: ['chat'] },
      ),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  it('fails closed when a speech_to_text capability is required and no model (or local tool) supplies it', () => {
    expect(() =>
      selectModelForSubtask(
        {
          id: 'st_stt_hard',
          title: 'Transcribe',
          objective: 'Transcribe with a provider STT endpoint.',
          kind: 'audio',
          requiredCapabilities: ['speech_to_text', 'general_reasoning'],
          allowedTools: [],
          dependsOn: [],
          producesArtifact: true,
          risk: 'low',
        },
        chatOnly,
        { enabledEndpointFamilies: ['chat'] },
      ),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });

  // Each local-modality family's FIRST tool must satisfy the family's hard caps.
  // Existing tests scope the 2nd/3rd tool of each family (image.ocr,
  // audio.transcribe, video.transform); these scope the FIRST tool
  // (image.inspect, audio.inspect, video.inspect / video.transcribe) so a blank
  // of those literals is caught.
  it('routes vision via a chat model when image.inspect is the scoped local tool', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_inspect_img',
        title: 'Inspect image',
        objective: 'Inspect proof-image.png with the local inspect tool.',
        kind: 'image',
        requiredCapabilities: ['vision', 'general_reasoning'],
        allowedTools: ['image.inspect'],
        dependsOn: [],
        producesArtifact: false,
        risk: 'low',
      },
      chatOnly,
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('gpt-5.5');
  });

  it('routes speech_to_text via a chat model when audio.inspect is the scoped local tool', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_inspect_audio',
        title: 'Inspect audio',
        objective: 'Inspect proof-audio.m4a with the local inspect tool.',
        kind: 'audio',
        requiredCapabilities: ['speech_to_text', 'general_reasoning'],
        allowedTools: ['audio.inspect'],
        dependsOn: [],
        producesArtifact: false,
        risk: 'low',
      },
      chatOnly,
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('gpt-5.5');
  });

  it('routes vision via a chat model when video.inspect is the scoped local tool', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_inspect_video',
        title: 'Inspect video',
        objective: 'Inspect proof-video.mp4 with the local inspect tool.',
        kind: 'video',
        requiredCapabilities: ['vision', 'general_reasoning'],
        allowedTools: ['video.inspect'],
        dependsOn: [],
        producesArtifact: false,
        risk: 'low',
      },
      chatOnly,
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('gpt-5.5');
  });

  it('routes speech_to_text via a chat model when video.transcribe is the scoped local tool', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_video_transcribe',
        title: 'Transcribe video',
        objective: 'Transcribe proof-video.mp4 with the local transcribe tool.',
        kind: 'video',
        requiredCapabilities: ['speech_to_text', 'general_reasoning'],
        allowedTools: ['video.transcribe'],
        dependsOn: [],
        producesArtifact: false,
        risk: 'low',
      },
      chatOnly,
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('gpt-5.5');
  });

  it('routes a vision subtask when a model carries the vision strength', () => {
    const visionModel: ModelCapability = {
      modelId: 'gpt-5.5-vision',
      providerId: 'openai',
      strengths: ['vision', 'general_reasoning'],
      strengthQuality: [{ strength: 'vision', tier: 'strong' }],
      modalities: ['text_in', 'image_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'high',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 400_000,
    };
    const decision = selectModelForSubtask(base('vision'), [...chatOnly, visionModel], {
      enabledEndpointFamilies: ['chat'],
    });
    expect(decision.modelId).toBe('gpt-5.5-vision');
  });

  // embedding has NO local-tool family, so even scoping a media tool cannot
  // satisfy it — it must still fail closed. Pins that embedding stays hard and
  // is not accidentally covered by the LOCAL_MODALITY_TOOL_FAMILIES table.
  it('still fails closed for embedding even when local media tools are scoped', () => {
    expect(() =>
      selectModelForSubtask(
        base('embedding', ['image.ocr', 'audio.transcribe', 'video.transform']),
        chatOnly,
        { enabledEndpointFamilies: ['chat'] },
      ),
    ).toThrow('NO_MODEL_FOR_SUBTASK');
  });
});

// Score-shape coverage: context bonus, quality-sensitive weighting, and the
// utility/coverage arithmetic that several survivors mutate. These pick a
// DIFFERENT winner depending on the arithmetic, so flipping an operator changes
// the selected model.
describe('selectModelForSubtask — scoring shape', () => {
  it('prefers a >=1M-context model over an otherwise-equal sub-1M model (context bonus)', () => {
    const subtask = {
      id: 'st_long',
      title: 'Long context read',
      objective: 'Summarise a very large document.',
      kind: 'synthesis' as const,
      requiredCapabilities: ['general_reasoning' as const],
      allowedTools: [],
      dependsOn: [],
      producesArtifact: false,
      risk: 'low' as const,
    };
    // Two identical models except maxContextTokens: one exactly at 1_000_000,
    // one just under. The context bonus (only granted at >= 1_000_000) must
    // break the tie toward the 1M model. Ids chosen so the tie-break (localeCompare,
    // ascending) would otherwise pick 'a-small'.
    const millionModel: ModelCapability = {
      modelId: 'z-million',
      providerId: 'openai',
      strengths: ['general_reasoning'],
      strengthQuality: [{ strength: 'general_reasoning', tier: 'standard' }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 1_000_000,
    };
    const almostModel: ModelCapability = {
      ...millionModel,
      modelId: 'a-small',
      maxContextTokens: 999_999,
    };
    const decision = selectModelForSubtask(subtask, [almostModel, millionModel], {
      enabledEndpointFamilies: ['chat'],
    });
    expect(decision.modelId).toBe('z-million');
  });

  // The SAME contrast pair routes to DIFFERENT winners depending on the kind's
  // quality/utility weighting. Model A is moderate-quality (standard) but
  // cheap/fast; model B is higher-quality (strong) but expensive/slow.
  //   non-sensitive (q=2,u=3): A=27, B=21 -> A wins
  //   quality-sensitive (q=4,u=1): A=23, B=31 -> B wins
  // (coverage is equal — both match exactly one soft cap.) Flipping the
  // quality/utility weight assignment swaps both outcomes, so this pins the
  // QUALITY_SENSITIVE_KINDS membership and the weight values.
  function moderateCheapFast(cap: 'writing' | 'classification'): ModelCapability {
    return {
      modelId: 'a-cheap-fast',
      providerId: 'anthropic',
      strengths: [cap],
      strengthQuality: [{ strength: cap, tier: 'standard' }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'low',
      latencyTier: 'fast',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 200_000,
    };
  }
  function strongExpensiveSlow(cap: 'writing' | 'classification'): ModelCapability {
    return {
      modelId: 'z-strong-slow',
      providerId: 'openai',
      strengths: [cap],
      strengthQuality: [{ strength: cap, tier: 'strong' }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'high',
      latencyTier: 'slow',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 200_000,
    };
  }

  it('weights quality over utility for quality-sensitive kinds (writing)', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_quality',
        title: 'Write polished copy',
        objective: 'Write polished marketing copy.',
        kind: 'writing',
        requiredCapabilities: ['writing'],
        allowedTools: [],
        dependsOn: [],
        producesArtifact: true,
        risk: 'low',
      },
      [moderateCheapFast('writing'), strongExpensiveSlow('writing')],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('z-strong-slow');
  });

  it('weights utility over quality for non-quality-sensitive kinds (classification)', () => {
    const decision = selectModelForSubtask(
      {
        id: 'st_classify',
        title: 'Classify intent',
        objective: 'Classify the message intent.',
        kind: 'classification',
        requiredCapabilities: ['classification'],
        allowedTools: [],
        dependsOn: [],
        producesArtifact: false,
        risk: 'low',
      },
      [moderateCheapFast('classification'), strongExpensiveSlow('classification')],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('a-cheap-fast');
  });

  // Every quality-sensitive kind must apply the quality-favouring weights. The
  // 'writing' soft cap is matched by both models regardless of kind, so the kind
  // alone decides the weighting. If any of these kinds were dropped from
  // QUALITY_SENSITIVE_KINDS, the cheap-fast model would win for that kind.
  it.each(['planning', 'reasoning', 'writing', 'code', 'synthesis'] as const)(
    'treats %s as a quality-sensitive kind (strong model wins)',
    (kind) => {
      const decision = selectModelForSubtask(
        {
          id: `st_${kind}`,
          title: 'Sensitive kind',
          objective: 'A quality-sensitive subtask.',
          kind,
          requiredCapabilities: ['writing'],
          allowedTools: [],
          dependsOn: [],
          producesArtifact: true,
          risk: 'low',
        },
        [moderateCheapFast('writing'), strongExpensiveSlow('writing')],
        { enabledEndpointFamilies: ['chat'] },
      );
      expect(decision.modelId).toBe('z-strong-slow');
    },
  );

  // The complementary non-sensitive kinds must apply the utility-favouring
  // weights (cheap-fast wins). Pins the boundary of the sensitive set so a stray
  // ADDITION (e.g. 'classification' -> '' collapses two entries, or another kind
  // wrongly joining) is observable.
  it.each(['classification', 'audio', 'image', 'video'] as const)(
    'treats %s as a non-quality-sensitive kind (cheap-fast model wins)',
    (kind) => {
      const decision = selectModelForSubtask(
        {
          id: `st_${kind}`,
          title: 'Non-sensitive kind',
          objective: 'A utility-favoured subtask.',
          kind,
          requiredCapabilities: ['writing'],
          allowedTools: [],
          dependsOn: [],
          producesArtifact: false,
          risk: 'low',
        },
        [moderateCheapFast('writing'), strongExpensiveSlow('writing')],
        { enabledEndpointFamilies: ['chat'] },
      );
      expect(decision.modelId).toBe('a-cheap-fast');
    },
  );

  it('rewards broader capability coverage (more matched soft caps wins)', () => {
    // Two writers of equal quality tier; one matches an extra requested soft
    // capability. The coverage bonus (matched-cap count * 10) must pick the
    // broader-coverage model. Flipping `* 10` -> `/ 10` collapses the bonus and
    // the localeCompare tie-break would pick the alphabetically-first id.
    const broad: ModelCapability = {
      modelId: 'z-broad',
      providerId: 'openai',
      strengths: ['writing', 'general_reasoning'],
      strengthQuality: [
        { strength: 'writing', tier: 'strong' },
        { strength: 'general_reasoning', tier: 'standard' },
      ],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 200_000,
    };
    const narrow: ModelCapability = {
      modelId: 'a-narrow',
      providerId: 'anthropic',
      strengths: ['writing'],
      strengthQuality: [{ strength: 'writing', tier: 'strong' }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 200_000,
    };
    const decision = selectModelForSubtask(
      {
        id: 'st_write',
        title: 'Write and reason',
        objective: 'Write copy and reason about it.',
        kind: 'writing',
        requiredCapabilities: ['writing', 'general_reasoning'],
        allowedTools: [],
        dependsOn: [],
        producesArtifact: true,
        risk: 'low',
      },
      [broad, narrow],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('z-broad');
  });

  // Coverage (matched-cap COUNT * 10) is a real swing term. A model matching
  // THREE soft caps at low (basic) quality must beat a model matching ONE soft
  // cap at frontier quality for a non-sensitive kind, because the coverage bonus
  // (30 vs 10) outweighs the quality gap (3*2 vs 10*2). Flipping `* 10` -> `/ 10`
  // collapses coverage to a fraction and the frontier-but-narrow model would win.
  it('rewards broad capability coverage over a single high-quality match (coverage * 10)', () => {
    const broadBasic: ModelCapability = {
      modelId: 'a-broad-basic',
      providerId: 'openai',
      strengths: ['classification', 'structured_extraction', 'fast_reasoning'],
      strengthQuality: [
        { strength: 'classification', tier: 'basic' },
        { strength: 'structured_extraction', tier: 'basic' },
        { strength: 'fast_reasoning', tier: 'basic' },
      ],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 200_000,
    };
    const narrowFrontier: ModelCapability = {
      modelId: 'z-narrow-frontier',
      providerId: 'anthropic',
      strengths: ['classification'],
      strengthQuality: [{ strength: 'classification', tier: 'frontier' }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 200_000,
    };
    const decision = selectModelForSubtask(
      {
        id: 'st_cov',
        title: 'Classify with extraction',
        objective: 'Classify and extract fields.',
        kind: 'classification', // non-sensitive: qualityWeight 2
        requiredCapabilities: [
          'classification',
          'structured_extraction',
          'fast_reasoning',
        ],
        allowedTools: [],
        dependsOn: [],
        producesArtifact: false,
        risk: 'low',
      },
      [broadBasic, narrowFrontier],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('a-broad-basic');
  });

  it('breaks exact score ties by ascending modelId (localeCompare)', () => {
    // Two fully-identical models differing only by id. The sort tie-break picks
    // the lexicographically smaller id. Pins `a.model.modelId.localeCompare(b...)`.
    const make = (modelId: string): ModelCapability => ({
      modelId,
      providerId: 'openai',
      strengths: ['writing'],
      strengthQuality: [{ strength: 'writing', tier: 'strong' }],
      modalities: ['text_in', 'text_out'],
      endpointFamily: 'chat',
      costTier: 'medium',
      latencyTier: 'standard',
      routingStatus: 'enabled',
      requiredGatewayTools: [],
      maxContextTokens: 200_000,
    });
    const decision = selectModelForSubtask(
      {
        id: 'st_tie',
        title: 'Write',
        objective: 'Write.',
        kind: 'writing',
        requiredCapabilities: ['writing'],
        allowedTools: [],
        dependsOn: [],
        producesArtifact: true,
        risk: 'low',
      },
      [make('m-zzz'), make('m-aaa')],
      { enabledEndpointFamilies: ['chat'] },
    );
    expect(decision.modelId).toBe('m-aaa');
  });
});
