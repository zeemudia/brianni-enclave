import { describe, expect, it } from 'vitest';
import type { ModelCapability } from '@calypso/chat-types';
import {
  isVideoGenerationRoutable,
  computeMediaToolStripSet,
} from '../media-routability.js';

const veo: ModelCapability = {
  modelId: 'veo-3.1-generate-preview',
  providerId: 'google',
  strengths: ['video_generation'],
  strengthQuality: [{ strength: 'video_generation', tier: 'frontier' }],
  modalities: ['text_in', 'image_in', 'video_out'],
  endpointFamily: 'video',
  costTier: 'high',
  latencyTier: 'slow',
  routingStatus: 'enabled',
  requiredGatewayTools: ['video.generate'],
};

describe('isVideoGenerationRoutable', () => {
  it('true when an enabled video model has its required tools scoped', () => {
    expect(isVideoGenerationRoutable([veo], ['video.generate'])).toBe(true);
  });

  it('false when the video model is not enabled (registered_pending_gateway)', () => {
    expect(
      isVideoGenerationRoutable(
        [{ ...veo, routingStatus: 'registered_pending_gateway' }],
        ['video.generate'],
      ),
    ).toBe(false);
  });

  it('false when the required gateway tool is not scoped', () => {
    expect(isVideoGenerationRoutable([veo], [])).toBe(false);
  });

  it('false when no video-family model exists (only image)', () => {
    expect(
      isVideoGenerationRoutable(
        [{ ...veo, endpointFamily: 'image', requiredGatewayTools: ['image.generate'] }],
        ['video.generate'],
      ),
    ).toBe(false);
  });
});

describe('computeMediaToolStripSet (fail-closed media gate)', () => {
  it('strips nothing when image + video generate + video render are all routable', () => {
    const strip = computeMediaToolStripSet({
      imageGenerationRoutable: true,
      videoGenerateRoutable: true,
      videoRenderRoutable: true,
    });
    expect(strip.size).toBe(0);
  });

  it('strips image tools when image generation is not routable', () => {
    const strip = computeMediaToolStripSet({
      imageGenerationRoutable: false,
      videoGenerateRoutable: true,
      videoRenderRoutable: true,
    });
    expect([...strip].sort()).toEqual(['image.edit', 'image.generate']);
  });

  it('strips video.generate when video generation is not routable', () => {
    const strip = computeMediaToolStripSet({
      imageGenerationRoutable: true,
      videoGenerateRoutable: false,
      videoRenderRoutable: false,
    });
    expect([...strip].sort()).toEqual(['video.generate', 'video.render']);
  });

  it('strips video.render but keeps video.generate when only render lacks a backend', () => {
    const strip = computeMediaToolStripSet({
      imageGenerationRoutable: true,
      videoGenerateRoutable: true,
      videoRenderRoutable: false,
    });
    expect([...strip]).toEqual(['video.render']);
  });
});
