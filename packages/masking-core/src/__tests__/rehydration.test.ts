import { describe, it, expect } from 'vitest';
import { findSafeEmitPoint } from '../tokeniser';

describe('Cross-chunk rehydration', () => {
  it('should hold back partial PII token at end of chunk', () => {
    const chunk = 'Hello [NA';
    const safePoint = findSafeEmitPoint(chunk);
    expect(safePoint).toBe(6); // emit "Hello " only
  });

  it('should emit full text when no partial token', () => {
    const chunk = 'Hello [NAME_1], welcome';
    const safePoint = findSafeEmitPoint(chunk);
    expect(safePoint).toBe(chunk.length);
  });

  it('should emit everything when bracket is closed', () => {
    const chunk = 'Results for [NAME_1] are ready';
    const safePoint = findSafeEmitPoint(chunk);
    expect(safePoint).toBe(chunk.length);
  });

  it('should emit everything when no brackets present', () => {
    const chunk = 'Just plain text here';
    const safePoint = findSafeEmitPoint(chunk);
    expect(safePoint).toBe(chunk.length);
  });

  it('should handle multiple complete tokens', () => {
    const chunk = '[NAME_1] and [EMAIL_1] are here';
    const safePoint = findSafeEmitPoint(chunk);
    expect(safePoint).toBe(chunk.length);
  });

  it('should hold back at last unterminated bracket', () => {
    const chunk = '[NAME_1] said [EMA';
    const safePoint = findSafeEmitPoint(chunk);
    expect(safePoint).toBe(14); // emit "[NAME_1] said " only
  });

  it('should emit everything when unterminated bracket is too far from end to be PII token', () => {
    // MAX_PII_TOKEN_LENGTH is 30, so a bracket more than 30 chars from end is safe
    const padding = 'x'.repeat(35);
    const chunk = `Some text [${padding}`;
    const safePoint = findSafeEmitPoint(chunk);
    // The bracket is 36 chars from end (> MAX_PII_TOKEN_LENGTH), so emit all
    expect(safePoint).toBe(chunk.length);
  });

  it('should handle empty string', () => {
    const safePoint = findSafeEmitPoint('');
    expect(safePoint).toBe(0);
  });

  it('should handle string that is just an opening bracket', () => {
    const safePoint = findSafeEmitPoint('[');
    expect(safePoint).toBe(0); // Hold back the bracket
  });
});
