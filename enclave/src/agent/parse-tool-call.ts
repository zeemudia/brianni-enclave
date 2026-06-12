import {
  ToolInvocationFrameSchema,
  TOOL_NAMES,
  type ToolInvocationFrame,
} from '@calypso/chat-types';

import { isToolBanned } from '../tools/scope-check';

export type ParserEvent =
  | { kind: 'text'; value: string }
  | {
      kind: 'tool';
      payload: Pick<ToolInvocationFrame, 'invocationId' | 'toolName' | 'args'>;
    }
  | { kind: 'parse-error'; reason: string };

const OPEN = '<tool>';
const CLOSE = '</tool>';

const VALID_TOOL_NAMES = new Set<string>(TOOL_NAMES);

/**
 * Streaming parser for the `<tool>...</tool>` JSON fence the agent emits.
 *
 * Accepts arbitrary chunk boundaries (token deltas from the provider stream).
 * Plain text is yielded as `text` events; the body inside a fence is
 * accumulated, JSON-parsed on `</tool>`, and yielded as a `tool` event.
 *
 * The parser is deliberately permissive about plain text but strict about
 * the tool payload — invalid JSON, missing fields, unknown / banned tool
 * names all surface as `parse-error` events so the agent loop can append a
 * corrective tool-result and let the model retry without crashing the turn.
 */
export class ToolCallStreamParser {
  private buffer = '';
  private inFence = false;

  *push(chunk: string): Generator<ParserEvent> {
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (!this.inFence) {
        const openAt = this.buffer.indexOf(OPEN);
        if (openAt < 0) {
          // No open fence in the buffer. But we might be mid-prefix
          // (e.g. last chars are "<too"). Hold back the tail to avoid
          // splitting an open tag across emissions.
          const safe = safeTextPrefix(this.buffer, OPEN);
          if (safe > 0) {
            yield { kind: 'text', value: this.buffer.slice(0, safe) };
            this.buffer = this.buffer.slice(safe);
          }
          return;
        }
        if (openAt > 0) {
          yield { kind: 'text', value: this.buffer.slice(0, openAt) };
        }
        this.buffer = this.buffer.slice(openAt + OPEN.length);
        this.inFence = true;
        continue;
      }

      const closeAt = this.buffer.indexOf(CLOSE);
      if (closeAt < 0) return; // wait for more
      const body = this.buffer.slice(0, closeAt);
      this.buffer = this.buffer.slice(closeAt + CLOSE.length);
      this.inFence = false;
      yield this.parseBody(body);
    }
  }

  *flush(): Generator<ParserEvent> {
    if (this.inFence) {
      yield { kind: 'parse-error', reason: 'UNCLOSED_FENCE' };
      this.buffer = '';
      this.inFence = false;
      return;
    }
    if (this.buffer.length > 0) {
      yield { kind: 'text', value: this.buffer };
      this.buffer = '';
    }
  }

  private parseBody(raw: string): ParserEvent {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { kind: 'parse-error', reason: 'MALFORMED_JSON' };
    }
    if (typeof json !== 'object' || json === null) {
      return { kind: 'parse-error', reason: 'NOT_AN_OBJECT' };
    }
    const obj = json as Record<string, unknown>;
    const toolName = obj.toolName;
    if (typeof toolName === 'string') {
      if (isToolBanned(toolName)) {
        return {
          kind: 'parse-error',
          reason: `TIER_C_D_BANNED:${toolName}`,
        };
      }
      if (!VALID_TOOL_NAMES.has(toolName)) {
        return {
          kind: 'parse-error',
          reason: `UNKNOWN_TOOL_NAME:${toolName}`,
        };
      }
    }
    if (
      typeof obj.toolName !== 'string' ||
      typeof obj.args !== 'object' ||
      obj.args === null
    ) {
      return { kind: 'parse-error', reason: 'MISSING_REQUIRED_FIELDS' };
    }
    // Codex finding #2: invocationId is enclave-minted; we deliberately
    // ignore any model-supplied value. Validate the rest against the
    // schema using a transient placeholder for invocationId + agentTurnId
    // — the loop substitutes both with freshly minted values.
    const parsed = ToolInvocationFrameSchema.safeParse({
      invocationId: 'parse-time-placeholder-invocation',
      agentTurnId: 'parse-time-placeholder-turn',
      toolName: obj.toolName,
      args: obj.args,
    });
    if (!parsed.success) {
      return { kind: 'parse-error', reason: 'INVALID_FRAME_SHAPE' };
    }
    return {
      kind: 'tool',
      payload: {
        // Model-supplied invocationId is INTENTIONALLY DROPPED here.
        // The agent loop mints a fresh uuid via randomUUID() before
        // emitting the TOOL_INVOCATION frame.
        invocationId: '',
        toolName: parsed.data.toolName,
        args: parsed.data.args,
      },
    };
  }
}

/**
 * How many characters from the start of `s` are safe to flush as text —
 * i.e. cannot possibly be the start of `marker`. Used to avoid splitting
 * `<tool>` across two text emissions when the tag straddles a chunk
 * boundary.
 */
function safeTextPrefix(s: string, marker: string): number {
  // The last (marker.length - 1) chars could be the prefix of marker;
  // hold them back. Anything before that is safe.
  const tail = Math.max(0, s.length - (marker.length - 1));
  // Check whether the tail actually looks like a prefix of marker.
  for (let i = tail; i < s.length; i += 1) {
    const candidate = s.slice(i);
    if (marker.startsWith(candidate)) {
      return i;
    }
  }
  return s.length;
}
