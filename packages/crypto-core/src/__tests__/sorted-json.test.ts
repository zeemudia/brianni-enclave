import { describe, it, expect } from 'vitest';
import { sortedJsonStringify } from '../sorted-json.js';

describe('sortedJsonStringify', () => {
  it('emits keys in alphabetical order regardless of input order', () => {
    const a = sortedJsonStringify({ b: 2, a: 1, c: 3 });
    const b = sortedJsonStringify({ c: 3, a: 1, b: 2 });
    expect(a).toBe('{"a":1,"b":2,"c":3}');
    expect(a).toBe(b);
  });

  it('drops empty-string mimeType (sister parity with iOS/Android native)', () => {
    const out = sortedJsonStringify({ alg: 'AES-256-GCM', mimeType: '', v: 1 });
    expect(out).toBe('{"alg":"AES-256-GCM","v":1}');
  });

  it('preserves non-empty mimeType', () => {
    const out = sortedJsonStringify({ alg: 'AES-256-GCM', mimeType: 'image/png', v: 1 });
    expect(out).toBe('{"alg":"AES-256-GCM","mimeType":"image/png","v":1}');
  });

  it('drops null values (sister parity with Android buildSortedJsonString)', () => {
    const out = sortedJsonStringify({ a: 1, b: null, c: 2 });
    expect(out).toBe('{"a":1,"c":2}');
  });

  it('drops undefined values (sister parity with Android buildSortedJsonString)', () => {
    const out = sortedJsonStringify({ a: 1, b: undefined, c: 2 });
    expect(out).toBe('{"a":1,"c":2}');
  });

  it('drops s3Parts unconditionally (sister parity — not part of AAD)', () => {
    const out = sortedJsonStringify({ a: 1, s3Parts: ['p1', 'p2'], v: 1 });
    expect(out).toBe('{"a":1,"v":1}');
  });

  it('handles all skip-cases together', () => {
    const out = sortedJsonStringify({
      a: 1,
      b: null,
      c: undefined,
      mimeType: '',
      s3Parts: ['x'],
      z: 'keep',
    });
    expect(out).toBe('{"a":1,"z":"keep"}');
  });
});
