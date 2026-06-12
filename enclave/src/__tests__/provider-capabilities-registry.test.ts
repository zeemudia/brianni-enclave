import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildModelCapabilities } from '../orchestrator/model-capabilities';
import { loadAndVerifyRegistry } from '../providers/registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const providersPath = resolve(__dirname, '../providers/providers.json');
const verifyKeyPath = resolve(__dirname, '../providers/registry-verify-key.pem');

describe('signed provider registry capability metadata', () => {
  it('exposes orchestrator routing capabilities for current chat models', () => {
    // Verify the COMMITTED providers.json against the COMMITTED production
    // verify key under the current (envelope) signing format. This is a
    // deliberate CI gate: if providers.json is ever left unsigned, signed in
    // the legacy providers-only format, or signed with the wrong key, this
    // fails the pipeline rather than the enclave at boot
    // (INVALID_REGISTRY_SIGNATURE).
    const registry = JSON.parse(readFileSync(providersPath, 'utf8'));
    const verifyKey = readFileSync(verifyKeyPath, 'utf8');
    const providers = loadAndVerifyRegistry(registry, verifyKey);
    const capabilities = buildModelCapabilities(providers);
    const byModelId = new Map(
      capabilities.map((capability) => [capability.modelId, capability]),
    );

    expect(byModelId.get('gpt-5.5')).toMatchObject({
      strengths: expect.arrayContaining([
        'planning',
        'long_context',
        'writing',
        'code',
      ]),
      endpointFamily: 'chat',
      routingStatus: 'enabled',
      nativeWebSearch: {
        providerTool: 'openai_web_search',
        toolVersion: 'responses-web_search',
      },
    });
    expect(byModelId.get('gpt-5.4-mini')).toMatchObject({
      strengths: expect.arrayContaining([
        'fast_reasoning',
        'classification',
        'structured_extraction',
      ]),
      costTier: 'low',
      latencyTier: 'fast',
      nativeWebSearch: {
        providerTool: 'openai_web_search',
      },
    });
    expect(byModelId.get('claude-haiku-4-5-20251001')).toMatchObject({
      strengths: expect.arrayContaining(['fast_reasoning', 'classification']),
      costTier: 'low',
      latencyTier: 'fast',
    });
    expect(byModelId.get('gemini-3.1-pro-preview')).toMatchObject({
      strengths: expect.arrayContaining([
        'research',
        'long_context',
        'search_grounded',
        'structured_extraction',
      ]),
      nativeWebSearch: {
        providerTool: 'google_search_grounding',
      },
    });
    expect(byModelId.get('claude-sonnet-4-6')).toMatchObject({
      strengths: expect.arrayContaining(['search_grounded']),
      nativeWebSearch: {
        providerTool: 'anthropic_web_search',
        toolVersion: 'web_search_20260209',
      },
    });
    expect(byModelId.get('gpt-image-2')).toMatchObject({
      strengths: expect.arrayContaining(['image_generation']),
      endpointFamily: 'image',
      routingStatus: 'registered_pending_gateway',
      requiredGatewayTools: expect.arrayContaining([
        'image.generate',
        'image.edit',
      ]),
    });
    expect(byModelId.get('gpt-4o-transcribe')).toMatchObject({
      strengths: expect.arrayContaining(['speech_to_text']),
      endpointFamily: 'audio_transcription',
      routingStatus: 'registered_pending_gateway',
      requiredGatewayTools: ['audio.transcribe'],
    });
    expect(byModelId.get('gpt-4o-mini-tts')).toMatchObject({
      strengths: expect.arrayContaining(['audio_generation']),
      endpointFamily: 'audio_speech',
      routingStatus: 'registered_pending_gateway',
      requiredGatewayTools: ['audio.speech'],
    });
    expect(byModelId.get('gemini-2.5-flash-image')).toMatchObject({
      providerId: 'google',
      strengths: expect.arrayContaining(['image_generation']),
      endpointFamily: 'image',
      routingStatus: 'registered_pending_gateway',
      requiredGatewayTools: expect.arrayContaining([
        'image.generate',
        'image.edit',
      ]),
    });
    const veo = byModelId.get('veo-3.1-generate-preview');
    expect(veo).toMatchObject({
      providerId: 'google',
      strengths: expect.arrayContaining(['video_generation']),
      modalities: expect.arrayContaining(['text_in', 'image_in', 'video_out']),
      endpointFamily: 'video',
      routingStatus: 'registered_pending_gateway',
      requiredGatewayTools: ['video.generate'],
    });

    const openAiVideo = byModelId.get('sora-2');
    expect(openAiVideo?.routingStatus).not.toBe('enabled');
  });
});
