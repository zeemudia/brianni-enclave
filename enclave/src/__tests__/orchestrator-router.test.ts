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
