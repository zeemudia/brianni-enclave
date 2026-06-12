import { describe, it, expect } from 'vitest';
import { CATEGORY_PRIORITY } from '../types';
import type { StyleCategory, StyleSuggestion } from '../types';

describe('stylometric types', () => {
  it('defines a strictly ascending priority for every category', () => {
    const categories: StyleCategory[] = [
      'punctuation',
      'case',
      'contraction',
      'filler',
      'idiom',
      'sentence_length',
    ];
    const priorities = categories.map((cat) => CATEGORY_PRIORITY[cat]);
    expect(priorities).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('gives punctuation the highest (lowest numeric) priority', () => {
    expect(CATEGORY_PRIORITY.punctuation).toBeLessThan(CATEGORY_PRIORITY.case);
    expect(CATEGORY_PRIORITY.punctuation).toBeLessThan(CATEGORY_PRIORITY.contraction);
    expect(CATEGORY_PRIORITY.punctuation).toBeLessThan(CATEGORY_PRIORITY.filler);
    expect(CATEGORY_PRIORITY.punctuation).toBeLessThan(CATEGORY_PRIORITY.idiom);
    expect(CATEGORY_PRIORITY.punctuation).toBeLessThan(CATEGORY_PRIORITY.sentence_length);
  });

  it('permits constructing a StyleSuggestion with the required fields', () => {
    const suggestion: StyleSuggestion = {
      id: '0123456789abcdef',
      category: 'punctuation',
      original: '!!!',
      replacement: '!',
      startIndex: 4,
      endIndex: 7,
      confidence: 1.0,
    };
    expect(suggestion.id).toHaveLength(16);
    expect(suggestion.category).toBe('punctuation');
  });
});
