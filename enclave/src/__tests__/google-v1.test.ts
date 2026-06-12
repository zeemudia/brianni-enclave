import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  GoogleV1ChatProcessor,
  googleGroundingCitations,
} from '../providers/adapters/google-v1';
import type { ChatChunk } from '@calypso/chat-types';
import { ProviderError } from '../providers/errors';

const googleMock = vi.hoisted(() => ({
  streamFactory: vi.fn(),
  getGenerativeModelArgs: undefined as unknown,
  startChatArgs: undefined as unknown,
}));

// Mock @google/generative-ai
vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    getGenerativeModel(modelConfig: unknown) {
      googleMock.getGenerativeModelArgs = modelConfig;
      return {
        startChat(startChatParams: unknown) {
          googleMock.startChatArgs = startChatParams;
          return {
            sendMessageStream: vi.fn().mockResolvedValue({
              stream: googleMock.streamFactory(),
            }),
          };
        },
      };
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI };
});

describe('GoogleV1ChatProcessor', () => {
  beforeEach(() => {
    googleMock.getGenerativeModelArgs = undefined;
    googleMock.startChatArgs = undefined;
    googleMock.streamFactory.mockReset();
    googleMock.streamFactory.mockImplementation(() =>
      (async function* () {
        yield { text: () => 'Hello ' };
        yield { text: () => 'world!' };
        yield { text: () => '' }; // Empty chunk (should be skipped)
      })(),
    );
  });

  it('streams chunks in standard ChatChunk format', async () => {
    const processor = new GoogleV1ChatProcessor('fake-api-key');
    const chunks: ChatChunk[] = [];

    for await (const chunk of processor.streamChat(
      [{ role: 'user', content: 'Hi' }],
      { model: 'gemini-2.5-pro' },
    )) {
      chunks.push(chunk);
    }

    // Should have: 'Hello ', 'world!', and final [DONE] chunk
    expect(chunks.length).toBe(3);
    expect(chunks[0].choices[0].delta.content).toBe('Hello ');
    expect(chunks[1].choices[0].delta.content).toBe('world!');
    expect(chunks[2].choices[0].finish_reason).toBe('stop');
  });

  it('converts message history to Gemini format', async () => {
    const processor = new GoogleV1ChatProcessor('fake-api-key');
    const chunks: ChatChunk[] = [];

    for await (const chunk of processor.streamChat(
      [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow-up' },
      ],
      { model: 'gemini-2.5-flash' },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
  });

  it('passes the system instruction at the model level, never via startChat', async () => {
    // Regression: passing systemInstruction via startChat() leaves it a raw
    // string, which the SDK forwards unformatted; stricter model endpoints
    // (gemini-*-flash-lite) reject it with
    // "400 Invalid value at 'system_instruction' (...Content)". It must go to
    // getGenerativeModel(), where the SDK wraps it in a Content object.
    const processor = new GoogleV1ChatProcessor('fake-api-key');

    for await (const _chunk of processor.streamChat(
      [
        { role: 'system', content: 'You are Calypso' },
        { role: 'user', content: 'List the linked folder' },
      ],
      { model: 'gemini-3.1-flash-lite' },
    )) {
      // drain
    }

    expect(googleMock.getGenerativeModelArgs).toEqual(
      expect.objectContaining({ systemInstruction: 'You are Calypso' }),
    );
    expect(googleMock.startChatArgs).not.toHaveProperty('systemInstruction');
  });

  it('omits systemInstruction entirely when there are no system messages', async () => {
    const processor = new GoogleV1ChatProcessor('fake-api-key');

    for await (const _chunk of processor.streamChat(
      [{ role: 'user', content: 'Hi' }],
      { model: 'gemini-3.1-flash-lite' },
    )) {
      // drain
    }

    expect(googleMock.getGenerativeModelArgs).not.toHaveProperty('systemInstruction');
    expect(googleMock.startChatArgs).not.toHaveProperty('systemInstruction');
  });

  it('normalises Google grounding metadata into citation candidates', () => {
    const citations = googleGroundingCitations(
      {
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://example.com', title: 'Example' } },
              ],
              groundingSupports: [
                {
                  segment: { startIndex: 0, endIndex: 5, text: 'Café' },
                  groundingChunkIndices: [0],
                },
              ],
            },
          },
        ],
      },
      'Café society',
    );

    expect(citations).toEqual([
      expect.objectContaining({
        provider: 'google',
        url: 'https://example.com',
        title: 'Example',
        providerStartIndex: 0,
        providerEndIndex: 4,
        providerText: 'Café',
      }),
    ]);
  });

  it('does not fall back after Gemini has yielded native-search output', async () => {
    googleMock.streamFactory
      .mockImplementationOnce(() =>
        (async function* () {
          yield { text: () => 'Partial' };
          throw new Error('googleSearch tool not supported after stream start');
        })(),
      )
      .mockImplementationOnce(() =>
        (async function* () {
          yield { text: () => 'Partial' };
        })(),
      );
    const processor = new GoogleV1ChatProcessor('fake-api-key');
    const chunks: ChatChunk[] = [];

    // H1: the raw SDK error (which can embed request-derived content) is
    // normalised to a sanitised ProviderError even after output was
    // emitted — the turn still fails (no silent fallback), but the raw SDK
    // message never crosses the enclave boundary.
    let thrown: unknown;
    try {
      for await (const chunk of processor.streamChat(
        [{ role: 'user', content: 'Hi' }],
        { model: 'gemini-3-flash-preview', nativeWebSearch: 'auto' },
      )) {
        chunks.push(chunk);
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as Error).message).not.toContain(
      'googleSearch tool not supported',
    );

    expect(googleMock.streamFactory).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([
      expect.objectContaining({
        choices: [
          expect.objectContaining({
            delta: { content: 'Partial' },
          }),
        ],
      }),
    ]);
  });

  it('normalizes Google RESOURCE_EXHAUSTED failures as rate-limit ProviderError', async () => {
    googleMock.streamFactory.mockImplementationOnce(() =>
      (async function* () {
        const error = Object.assign(new Error('RESOURCE_EXHAUSTED'), {
          status: 429,
        });
        throw error;
      })(),
    );
    const processor = new GoogleV1ChatProcessor('fake-api-key');

    let thrown: unknown;
    try {
      for await (const _chunk of processor.streamChat(
        [{ role: 'user', content: 'Hi' }],
        { model: 'gemini-3.1-pro-preview' },
      )) {
        // drain
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).toMatchObject({
      providerId: 'google',
      kind: 'rate_limit',
      status: 429,
    });
  });
});
