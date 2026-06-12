/**
 * Additional coverage for google-v1.ts.
 * Targets uncovered branches:
 * - Line 31: nonSystemMessages empty (only system messages provided)
 * - Empty history (single user message)
 * - No system instruction
 */
import { describe, it, expect, vi } from 'vitest';
import { GoogleV1ChatProcessor } from '../providers/adapters/google-v1';
import type { ChatChunk } from '@calypso/chat-types';

vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    getGenerativeModel() {
      return {
        startChat() {
          return {
            sendMessageStream: vi.fn().mockResolvedValue({
              stream: (async function* () {
                yield { text: () => 'response' };
              })(),
            }),
          };
        },
      };
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI };
});

describe('GoogleV1ChatProcessor — coverage gaps', () => {
  it('handles messages with only system role (no user messages)', async () => {
    const processor = new GoogleV1ChatProcessor('fake-key');
    const chunks: ChatChunk[] = [];

    for await (const chunk of processor.streamChat(
      [{ role: 'system', content: 'Be a calculator' }],
      { model: 'gemini-2.5-pro' },
    )) {
      chunks.push(chunk);
    }

    // Should still work — lastUserMessage will be empty string
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('handles single user message with no history', async () => {
    const processor = new GoogleV1ChatProcessor('fake-key');
    const chunks: ChatChunk[] = [];

    for await (const chunk of processor.streamChat(
      [{ role: 'user', content: 'Hello' }],
      { model: 'gemini-2.5-flash' },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('passes temperature and max_tokens options', async () => {
    const processor = new GoogleV1ChatProcessor('fake-key');
    const chunks: ChatChunk[] = [];

    for await (const chunk of processor.streamChat(
      [{ role: 'user', content: 'Hello' }],
      { model: 'gemini-2.5-pro', temperature: 0.7, max_tokens: 500 },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
