/**
 * Tests for runResearchSubagent (Task 2B.2).
 *
 * Two assertions:
 *   1. Happy path  — web.fetch called, URL in sources, non-empty answer.
 *   2. Web-only scope — memory.read attempt is rejected OUT_OF_SCOPE by
 *      the gateway; no private read happens.
 */

import { describe, it, expect, vi } from 'vitest';

import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  ResearchQuery,
  ToolInvocationFrame,
  ToolResultFrame,
} from '@calypso/chat-types';

import { ToolGateway, type ClientBridge } from '../../tools';
import { runResearchSubagent } from '../research-subagent';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid parent ToolGateway with a ClientBridge. */
function makeParentGateway(bridge: ClientBridge): ToolGateway {
  return new ToolGateway({
    clientBridge: bridge,
    userId: 'user-test-001',
    sessionId: 'session-test-001',
  });
}

/**
 * Build a multi-invocation fake ChatProcessor.
 * Each element of `scripts` is the token stream for one provider call.
 */
function mkProvider(scripts: string[][]): ChatProcessor {
  let invocation = 0;
  return {
    async *streamChat(
      _messages: ChatMessage[],
    ): AsyncGenerator<ChatChunk> {
      const tokens = scripts[invocation] ?? [];
      invocation += 1;
      for (let i = 0; i < tokens.length; i++) {
        const isLast = i === tokens.length - 1;
        yield {
          id: `chunk_${invocation}_${i}`,
          choices: [
            {
              delta: { content: tokens[i] },
              finish_reason: isLast ? 'stop' : null,
            },
          ],
        };
      }
    },
  };
}

/**
 * Build a ClientBridge whose invokeClient calls `handler` for each frame.
 */
function mkBridge(
  handler: (frame: ToolInvocationFrame) => ToolResultFrame,
): ClientBridge {
  return {
    invokeClient: vi.fn().mockImplementation(async (frame) => handler(frame)),
  };
}

// ─── A sample ResearchQuery ───────────────────────────────────────────────────
const SAMPLE_QUERY: ResearchQuery = {
  insurer: 'Aetna',
  planType: 'PPO',
  question: 'What is the appeal deadline for a denied claim?',
  year: 2026,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runResearchSubagent', () => {
  it('happy path: fetches a URL, returns non-empty answer and the URL in sources', async () => {
    // The provider will:
    //   - Round 1: emit a web.fetch tool call for a test URL.
    //   - Round 2: emit a short prose summary (after the tool result is reinjected).
    const fetchUrl = 'https://example.gov/aetna-ppo-appeals-2026';
    const webFetchTool = JSON.stringify({
      invocationId: 'inv-fetch-1',
      toolName: 'web.fetch',
      // Both url AND query are required by handleWebFetch; omitting query
      // causes an invalidArgs rejection, so include it here.
      args: { url: fetchUrl, query: 'Aetna PPO appeal deadline' },
    });

    const provider = mkProvider([
      [`<tool>${webFetchTool}</tool>`],
      [
        'According to the source, Aetna PPO plans allow ',
        '180 days from the denial date to file an appeal.',
      ],
    ]);

    // The clientBridge returns a fake web.fetch result when invoked.
    const bridge = mkBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: 'ok',
      resultJson: {
        status: 200,
        bodyText:
          'Aetna PPO: You have 180 days from the date of the denial notice to file a first-level appeal.',
      },
    }));

    const parent = makeParentGateway(bridge);

    const result = await runResearchSubagent({
      parentGateway: parent,
      query: SAMPLE_QUERY,
      queryString: 'Aetna PPO appeal deadline 2026',
      provider,
      turnId: 't-happy',
    });

    // The URL collected via the tool-invocation event must appear in sources.
    expect(result.sources).toContain(fetchUrl);

    // The answer must be non-empty (the model's prose from round 2).
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.answer).toContain('180 days');
  });

  it('F1: failed web.fetch (invalid args / rejected) does NOT appear in sources', async () => {
    // The provider emits a web.fetch with no query field — handleWebFetch will
    // return invalidArgs (gateway_rejected), so the fetch FAILS. The URL must
    // NOT appear in sources (sources-on-success guarantee).
    const failUrl = 'https://example.gov/should-not-appear';
    const webFetchBadArgs = JSON.stringify({
      invocationId: 'inv-fetch-bad',
      toolName: 'web.fetch',
      // Deliberately omit "query" — tier-a-read requires both url + query.
      args: { url: failUrl },
    });

    const provider = mkProvider([
      [`<tool>${webFetchBadArgs}</tool>`],
      ['I could not fetch. Here is a fallback answer.'],
    ]);

    // Bridge should never be called (the gateway rejects before invokeClient)
    // because the missing query causes invalidArgs before the bridge is reached.
    const bridge = mkBridge(() => ({
      invocationId: 'never',
      outcome: 'ok' as const,
      resultJson: { status: 200, bodyText: 'body' },
    }));

    const parent = makeParentGateway(bridge);

    const result = await runResearchSubagent({
      parentGateway: parent,
      query: SAMPLE_QUERY,
      queryString: 'Aetna PPO appeal deadline 2026',
      provider,
      turnId: 't-failed-fetch',
    });

    // The URL from the failed fetch must NOT appear in sources.
    expect(result.sources).not.toContain(failUrl);
    expect(result.sources).toHaveLength(0);

    // The model still produced a fallback answer (round 2 ran).
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.answer).toContain('fallback');
  });

  it('audit accuracy: a SUCCESSFUL fetch then a post-fetch loop failure still returns the URL in sources (failed=true)', async () => {
    // Round 1: provider emits a web.fetch for https://x → the bridge returns a
    // SUCCESSFUL result, so https://x is promoted into `sources`.
    // Round 2: provider THROWS (models a post-fetch internal error / a stalled
    // turn). Before this fix the throw propagated out of runResearchSubagent and
    // the already-fetched https://x was discarded; the audit then under-reported
    // egress. Now the partial `sources` MUST still be returned with failed=true.
    const fetchUrl = 'https://x';
    const webFetchTool = JSON.stringify({
      invocationId: 'inv-fetch-then-fail',
      toolName: 'web.fetch',
      args: { url: fetchUrl, query: 'ER appeal deadline' },
    });

    let invocation = 0;
    const provider: ChatProcessor = {
      async *streamChat(): AsyncGenerator<ChatChunk> {
        invocation += 1;
        if (invocation === 1) {
          yield {
            id: 'chunk_fetch',
            choices: [
              {
                delta: { content: `<tool>${webFetchTool}</tool>` },
                finish_reason: 'stop',
              },
            ],
          };
          return;
        }
        // Round 2 (after the fetch succeeded and was reinjected): fail hard.
        throw new Error('research subagent post-fetch failure');
      },
    };

    // The bridge returns a SUCCESSFUL web.fetch — https://x DID leave the device.
    const bridge = mkBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: 'ok',
      resultJson: {
        status: 200,
        bodyText: 'Appeals may be filed within 180 days.',
      },
    }));

    const parent = makeParentGateway(bridge);

    const result = await runResearchSubagent({
      parentGateway: parent,
      query: SAMPLE_QUERY,
      queryString: 'Aetna PPO appeal deadline 2026',
      provider,
      turnId: 't-fetch-then-fail',
    });

    // The loop failed AFTER the fetch — failed must be signalled, and the
    // already-fetched URL must STILL be present (the audit must not lose it).
    expect(result.failed).toBe(true);
    expect(result.sources).toContain(fetchUrl);

    // Sanity: a clean run (the happy-path test above) reports failed=false.
  });

  it('grounding: a SELF-EMITTING parent bridge emits a web.fetch frame and resolves via a delivered TOOL_RESULT → non-empty sources/answer, failed=false', async () => {
    // Reproduces the live "no web access" bug end-to-end through the air gap.
    //
    // In production the sibling's web.fetch resolver was created but never
    // resolved because no TOOL_INVOCATION frame was ever emitted to the client
    // (the main pump is parked inside gateway.dispatch(research.ask)). This test
    // models the FIXED reverse-channel: the parent bridge exposes a SELF-EMITTING
    // `invokeClientFromSibling` that (a) pushes the frame onto an emit sink, and
    // (b) returns a promise that resolves only when a matching TOOL_RESULT is
    // delivered out-of-band. A run that hung would time out and return
    // failed=true with empty sources; this asserts the opposite.
    const fetchUrl = 'https://example.gov/grounded-source-2026';
    const webFetchTool = JSON.stringify({
      invocationId: 'inv-fetch-grounded',
      toolName: 'web.fetch',
      args: { url: fetchUrl, query: 'grounded fact' },
    });

    const provider = mkProvider([
      [`<tool>${webFetchTool}</tool>`],
      ['Grounded answer: the appeal window is 180 days.'],
    ]);

    // Emit sink + pending resolvers keyed by invocationId (the same routing the
    // real EnclaveRouter uses via outstandingInvocations). The self-emitting
    // bridge pushes the frame, then awaits a delivered TOOL_RESULT.
    const emitted: ToolInvocationFrame[] = [];
    const pending = new Map<string, (r: ToolResultFrame) => void>();

    const bridge: ClientBridge = {
      // Plain variant should NOT be used by the sibling when the self-emitting
      // one is present; wire it to a throw so any accidental use is caught.
      invokeClient: () => {
        throw new Error('plain invokeClient must not be used by a sibling');
      },
      invokeClientFromSibling: (frame) => {
        // (a) EMIT the frame — this is the step the plain bridge skipped.
        emitted.push(frame);
        // (b) Register a resolver, then deliver the matching TOOL_RESULT on a
        //     later tick (models the client POSTing /tool-result).
        return new Promise<ToolResultFrame>((resolve) => {
          pending.set(frame.invocationId, resolve);
          setTimeout(() => {
            const r = pending.get(frame.invocationId);
            if (r) {
              pending.delete(frame.invocationId);
              r({
                invocationId: frame.invocationId,
                outcome: 'ok',
                resultJson: {
                  status: 200,
                  bodyText: 'Appeals may be filed within 180 days.',
                },
              });
            }
          }, 0);
        });
      },
    };

    const parent = makeParentGateway(bridge);

    const result = await runResearchSubagent({
      parentGateway: parent,
      query: SAMPLE_QUERY,
      queryString: 'grounded appeal deadline 2026',
      provider,
      turnId: 't-grounded',
    });

    // (a) A TOOL_INVOCATION frame for the sibling's web.fetch was emitted.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].toolName).toBe('web.fetch');
    expect((emitted[0].args as { url?: string }).url).toBe(fetchUrl);

    // (b) The resolver resolved on the delivered TOOL_RESULT, so the run did NOT
    //     time out: it grounded a real source and produced an answer.
    expect(result.failed).toBe(false);
    expect(result.sources).toContain(fetchUrl);
    expect(result.answer).toContain('180 days');
  });

  it('web-only scope: memory.read attempt is rejected OUT_OF_SCOPE, no private data accessed', async () => {
    // The research worker pack only has "web.fetch" in toolScopes.
    // A model that tries "memory.read" must get an OUT_OF_SCOPE gateway rejection.
    const memoryReadTool = JSON.stringify({
      invocationId: 'inv-mem-1',
      toolName: 'memory.read',
      args: { namespace: 'default', id: 'some-record-id' },
    });

    // Round 1: provider emits memory.read (disallowed).
    // Round 2: provider responds to the gateway rejection.
    const provider = mkProvider([
      [`<tool>${memoryReadTool}</tool>`],
      ['I cannot access private memory. Here is a public answer instead.'],
    ]);

    // The bridge should NEVER be called (gateway rejects before dispatch).
    const bridge = mkBridge(() => ({
      invocationId: 'never',
      outcome: 'ok',
      resultJson: {},
    }));
    const bridgeMock = bridge.invokeClient as ReturnType<typeof vi.fn>;

    const parent = makeParentGateway(bridge);

    const result = await runResearchSubagent({
      parentGateway: parent,
      query: SAMPLE_QUERY,
      queryString: 'Aetna PPO appeal deadline 2026',
      provider,
      turnId: 't-scope',
    });

    // The gateway must NOT have dispatched the memory.read to the client.
    expect(bridgeMock.mock.calls.length).toBe(0);

    // The model recovered (round 2 ran) and produced a text answer.
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.answer).toContain('public answer');

    // No sources since web.fetch was never called.
    expect(result.sources).toHaveLength(0);
  });
});
