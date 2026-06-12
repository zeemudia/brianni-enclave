import { sha256 } from 'js-sha256';
import type { StyleCategory } from './types';

/**
 * Deterministic ID for a StyleSuggestion.
 *
 * Byte-identical on mobile (Hermes) and web (V8) because js-sha256 is a
 * pure-JS implementation — no SubtleCrypto, no native bindings.
 *
 * Collisions are bounded by the first 16 hex chars (64 bits); for a single
 * message this is effectively zero.
 */
export function makeId(
  category: StyleCategory,
  start: number,
  end: number,
  original: string,
): string {
  const payload = `${category}:${start}:${end}:${original}`;
  return sha256(payload).slice(0, 16);
}
