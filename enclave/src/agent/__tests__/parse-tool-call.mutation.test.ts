import { describe, expect, it } from 'vitest';

import {
  ToolCallStreamParser,
  type ParserEvent,
} from '../parse-tool-call';

// Mutation-hardening for the streaming <tool>...</tool> parser. This is the
// INPUT-VALIDATION boundary for model-emitted tool calls: a parse bug can admit
// a banned/unknown/malformed tool call, mis-split a fence across chunk
// boundaries (leaking an unfinished tag as user text), or fail to surface a
// parse-error the agent loop needs to reinject a correction. Every reason string
// is load-bearing because the loop branches on it.

function drain(parser: ToolCallStreamParser, chunks: string[]): ParserEvent[] {
  const out: ParserEvent[] = [];
  for (const c of chunks) for (const e of parser.push(c)) out.push(e);
  for (const e of parser.flush()) out.push(e);
  return out;
}

const validTool = (args: Record<string, unknown> = { namespace: 'default' }) =>
  JSON.stringify({ toolName: 'memory.list', args });

describe('ToolCallStreamParser — parse-error reasons', () => {
  it('MALFORMED_JSON for non-JSON inside a fence', () => {
    const e = drain(new ToolCallStreamParser(), ['<tool>{nope</tool>']);
    expect(e).toContainEqual({ kind: 'parse-error', reason: 'MALFORMED_JSON' });
  });

  it('NOT_AN_OBJECT for a JSON primitive or null inside a fence', () => {
    // Kills the `typeof json !== 'object' || json === null` guard (each operand).
    // A string/number/boolean fails `typeof !== 'object'`; literal null fails the
    // `=== null` operand. (An array passes this guard — see the array case below
    // — because `typeof [] === 'object'`, so it is classified later.)
    for (const body of ['"a string"', '42', 'true', 'null']) {
      const e = drain(new ToolCallStreamParser(), [`<tool>${body}</tool>`]);
      expect(e, body).toContainEqual({
        kind: 'parse-error',
        reason: 'NOT_AN_OBJECT',
      });
    }
  });

  it('an OBJECT is NOT misclassified as NOT_AN_OBJECT', () => {
    // Guards `json === null` arm: a real object must pass the object check.
    const e = drain(new ToolCallStreamParser(), [`<tool>${validTool()}</tool>`]);
    expect(e.some((x) => x.kind === 'tool')).toBe(true);
    expect(e.some((x) => x.kind === 'parse-error')).toBe(false);
  });

  it('TIER_C_D_BANNED reason carries the banned tool name', () => {
    const e = drain(new ToolCallStreamParser(), [
      `<tool>${JSON.stringify({ toolName: 'email.send', args: {} })}</tool>`,
    ]);
    const err = e.find((x) => x.kind === 'parse-error');
    expect(err).toBeDefined();
    expect((err as { reason: string }).reason).toBe('TIER_C_D_BANNED:email.send');
  });

  it('UNKNOWN_TOOL_NAME reason carries the unknown tool name', () => {
    const e = drain(new ToolCallStreamParser(), [
      `<tool>${JSON.stringify({ toolName: 'not.a.real.tool', args: {} })}</tool>`,
    ]);
    const err = e.find((x) => x.kind === 'parse-error');
    expect((err as { reason: string }).reason).toBe(
      'UNKNOWN_TOOL_NAME:not.a.real.tool',
    );
  });

  it('a banned name is rejected as banned BEFORE the unknown-name check', () => {
    // Pins ordering: `mailbox.read` is banned AND not a valid tool name; the
    // banned check must win so the loop records a Tier C/D rejection, not a
    // generic unknown-name. Kills reordering / dropping the banned branch.
    const e = drain(new ToolCallStreamParser(), [
      `<tool>${JSON.stringify({ toolName: 'mailbox.read', args: {} })}</tool>`,
    ]);
    const err = e.find((x) => x.kind === 'parse-error');
    expect((err as { reason: string }).reason).toBe(
      'TIER_C_D_BANNED:mailbox.read',
    );
  });

  it('MISSING_REQUIRED_FIELDS when toolName is not a string', () => {
    const e = drain(new ToolCallStreamParser(), [
      `<tool>${JSON.stringify({ toolName: 123, args: {} })}</tool>`,
    ]);
    expect(e).toContainEqual({
      kind: 'parse-error',
      reason: 'MISSING_REQUIRED_FIELDS',
    });
  });

  it('MISSING_REQUIRED_FIELDS when args is absent', () => {
    const e = drain(new ToolCallStreamParser(), [
      `<tool>${JSON.stringify({ toolName: 'memory.list' })}</tool>`,
    ]);
    expect(e).toContainEqual({
      kind: 'parse-error',
      reason: 'MISSING_REQUIRED_FIELDS',
    });
  });

  it('MISSING_REQUIRED_FIELDS when args is null', () => {
    // Kills the `obj.args === null` operand of the missing-fields guard.
    const e = drain(new ToolCallStreamParser(), [
      `<tool>{"toolName":"memory.list","args":null}</tool>`,
    ]);
    expect(e).toContainEqual({
      kind: 'parse-error',
      reason: 'MISSING_REQUIRED_FIELDS',
    });
  });

  it('MISSING_REQUIRED_FIELDS when args is a non-object (string)', () => {
    const e = drain(new ToolCallStreamParser(), [
      `<tool>{"toolName":"memory.list","args":"oops"}</tool>`,
    ]);
    expect(e).toContainEqual({
      kind: 'parse-error',
      reason: 'MISSING_REQUIRED_FIELDS',
    });
  });

  it('INVALID_FRAME_SHAPE when args is an ARRAY (passes missing-fields, fails schema)', () => {
    // An array satisfies `typeof obj.args === 'object' && obj.args !== null`, so
    // it slips past MISSING_REQUIRED_FIELDS, but ToolInvocationFrameSchema
    // requires an OBJECT record for args, so safeParse fails → INVALID_FRAME_SHAPE.
    // This is the only branch that reaches the schema-shape rejection, so it
    // pins the `!parsed.success → INVALID_FRAME_SHAPE` arm.
    const e = drain(new ToolCallStreamParser(), [
      `<tool>{"toolName":"memory.list","args":[1,2,3]}</tool>`,
    ]);
    const reasons = e
      .filter((x) => x.kind === 'parse-error')
      .map((x) => (x as { reason: string }).reason);
    expect(reasons).toContain('INVALID_FRAME_SHAPE');
    // It must NOT be a tool event — the malformed frame is rejected.
    expect(e.some((x) => x.kind === 'tool')).toBe(false);
  });
});

describe('ToolCallStreamParser — streaming / fence boundary behaviour', () => {
  it('flush() emits buffered trailing plain text (no open fence)', () => {
    // Kills removal of the `if (this.buffer.length > 0)` flush text arm and the
    // `text` value. Push text with no fence then flush.
    const p = new ToolCallStreamParser();
    const out: ParserEvent[] = [];
    // "<too" is held back by safeTextPrefix (it could be the start of <tool>),
    // so it is only emitted on flush.
    for (const e of p.push('hello <too')) out.push(e);
    // Nothing past the safe prefix yet → only "hello " was emitted.
    expect(out).toEqual([{ kind: 'text', value: 'hello ' }]);
    for (const e of p.flush()) out.push(e);
    expect(out).toContainEqual({ kind: 'text', value: '<too' });
  });

  it('does not emit an EMPTY text event when the whole buffer is a held-back prefix', () => {
    // When the entire buffer is "<too" (a potential prefix of "<tool>"), safe===0
    // and NO text must be emitted (the `if (safe > 0)` guard). Kills `safe > 0`
    // → `>= 0` / `true`, which would emit a spurious empty-string text event.
    const p = new ToolCallStreamParser();
    const out: ParserEvent[] = [];
    for (const e of p.push('<too')) out.push(e);
    expect(out).toEqual([]); // nothing emitted, "<too" held back
    expect(out.some((x) => x.kind === 'text' && x.value === '')).toBe(false);
  });

  it('parses an EMPTY-bodied fence (closeAt === 0) as a parse-error, not a stall', () => {
    // "<tool></tool>" — after consuming "<tool>", the buffer starts with the
    // CLOSE tag so closeAt === 0. The real `if (closeAt < 0)` is FALSE so the
    // empty body is parsed → MALFORMED_JSON. A `closeAt <= 0` mutant would
    // `return` (wait for more) and the parse-error would be lost.
    const e = drain(new ToolCallStreamParser(), ['<tool></tool>']);
    expect(e).toContainEqual({ kind: 'parse-error', reason: 'MALFORMED_JSON' });
  });

  it('holds back a partial open-tag prefix across chunks, then completes it', () => {
    // safeTextPrefix: "<too" must NOT be flushed as text because it could be the
    // prefix of "<tool>". Kills the safe-prefix arithmetic / loop mutations.
    const p = new ToolCallStreamParser();
    const out: ParserEvent[] = [];
    for (const e of p.push('answer: <too')) out.push(e);
    expect(out).toEqual([{ kind: 'text', value: 'answer: ' }]);
    // Complete the fence in the next chunk.
    for (const e of p.push(`l>${validTool()}</tool>`)) out.push(e);
    for (const e of p.flush()) out.push(e);
    const tools = out.filter((x) => x.kind === 'tool');
    expect(tools).toHaveLength(1);
    // The held-back "<too" never leaked as user-visible text.
    expect(
      out
        .filter((x): x is { kind: 'text'; value: string } => x.kind === 'text')
        .map((x) => x.value)
        .join(''),
    ).toBe('answer: ');
  });

  it('emits leading text before an open fence as a text event', () => {
    // Kills the `if (openAt > 0)` text-emit guard.
    const e = drain(new ToolCallStreamParser(), [
      `prefix <tool>${validTool()}</tool>`,
    ]);
    expect(e).toContainEqual({ kind: 'text', value: 'prefix ' });
  });

  it('does NOT emit an empty leading-text event when the fence opens at index 0', () => {
    // Kills `if (openAt > 0)` → `if (true)` (which would emit an empty "" text).
    const e = drain(new ToolCallStreamParser(), [`<tool>${validTool()}</tool>`]);
    expect(e.some((x) => x.kind === 'text' && x.value === '')).toBe(false);
  });

  it('waits for the closing fence before emitting (closeAt < 0 returns)', () => {
    // First push has the open fence + partial body, no close. No tool event yet.
    const p = new ToolCallStreamParser();
    const first: ParserEvent[] = [];
    for (const e of p.push(`<tool>${validTool().slice(0, 12)}`)) first.push(e);
    expect(first.some((x) => x.kind === 'tool')).toBe(false);
    expect(first.some((x) => x.kind === 'parse-error')).toBe(false);
    // Completing the body yields exactly one tool event.
    const rest: ParserEvent[] = [];
    for (const e of p.push(`${validTool().slice(12)}</tool>`)) rest.push(e);
    expect(rest.filter((x) => x.kind === 'tool')).toHaveLength(1);
  });

  it('UNCLOSED_FENCE on flush, and the buffer is RESET (no leftover-text pollution)', () => {
    const p = new ToolCallStreamParser();
    const out: ParserEvent[] = [];
    for (const e of p.push('<tool>{"toolName":"memory.list"')) out.push(e);
    for (const e of p.flush()) out.push(e);
    expect(out).toContainEqual({ kind: 'parse-error', reason: 'UNCLOSED_FENCE' });
    // After UNCLOSED, buffer must be reset to '' — a subsequent clean stream
    // must NOT carry any leftover prefix text. Kills `this.buffer = ''` →
    // `this.buffer = 'Stryker was here!'` (which would leak as leading text).
    const after = drain(p, [`<tool>${validTool()}</tool>`]);
    expect(after.filter((x) => x.kind === 'tool')).toHaveLength(1);
    expect(after.some((x) => x.kind === 'text')).toBe(false);
  });

  it('flush() resets the buffer after emitting trailing text (no double-emit)', () => {
    // Kills `this.buffer = ''` → `'Stryker was here!'` on the trailing-text flush
    // arm: a second flush must emit nothing.
    const p = new ToolCallStreamParser();
    const first: ParserEvent[] = [];
    for (const e of p.push('trailing text')) first.push(e);
    for (const e of p.flush()) first.push(e);
    expect(first).toContainEqual({ kind: 'text', value: 'trailing text' });
    const second: ParserEvent[] = [];
    for (const e of p.flush()) second.push(e);
    expect(second).toEqual([]);
  });

  it('flush() with an empty buffer and no open fence emits nothing', () => {
    const p = new ToolCallStreamParser();
    for (const _ of p.push('clean text')) {
      /* drained */
    }
    const tail: ParserEvent[] = [];
    for (const e of p.flush()) tail.push(e);
    expect(tail).toEqual([]);
  });

  it('drops the model-supplied invocationId and mints an empty placeholder', () => {
    const e = drain(new ToolCallStreamParser(), [
      `<tool>${JSON.stringify({ invocationId: 'attacker-chosen', toolName: 'memory.list', args: { namespace: 'default' } })}</tool>`,
    ]);
    const tool = e.find((x) => x.kind === 'tool') as
      | { payload: { invocationId: string; toolName: string } }
      | undefined;
    expect(tool?.payload.invocationId).toBe('');
    expect(tool?.payload.toolName).toBe('memory.list');
  });
});
