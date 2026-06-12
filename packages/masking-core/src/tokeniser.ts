import type { PIIEntity, PIIToken } from "./types";

const MAX_PII_TOKEN_LENGTH = 30;

/**
 * PII Tokeniser per tech spec s6.3.
 * Masks detected PII entities with sequential tokens and supports
 * round-trip rehydration for streaming responses.
 */
export class PIITokeniser {
  private counters: Map<string, number> = new Map();
  private tokenMap: Map<string, string> = new Map();

  /**
   * Replace PII entities with sequential tokens like [NAME_1], [EMAIL_2].
   * Entities must be from the same text (positions reference the original).
   *
   * L7 error-handling-audit — FAIL CLOSED on invalid entity sets: entities
   * must be integer-positioned, in-bounds, non-empty ranges with no
   * overlaps. An overlapping or out-of-range entity silently corrupts the
   * masked output (partially-overwritten tokens, resurfaced PII
   * fragments); corrupted masking must never be sent to the provider, so
   * mask() throws instead. `detectPII` guarantees a valid set — this guard
   * protects against future entity sources (e.g. re-introduced NER
   * merging) violating the invariant.
   */
  mask(
    text: string,
    entities: PIIEntity[],
  ): { masked: string; tokens: PIIToken[] } {
    assertValidEntitySet(text, entities);
    // Sort by start position descending so replacements don't shift indices
    const sorted = [...entities].sort((a, b) => b.startIndex - a.startIndex);
    let masked = text;
    const tokens: PIIToken[] = [];

    for (const entity of sorted) {
      const count = (this.counters.get(entity.type) ?? 0) + 1;
      this.counters.set(entity.type, count);

      const token = `[${entity.type}_${count}]`;
      const original = text.slice(entity.startIndex, entity.endIndex);

      this.tokenMap.set(token, original);
      tokens.push({
        token,
        original,
        type: entity.type,
        startIndex: entity.startIndex,
        endIndex: entity.endIndex,
        confidence: entity.confidence,
      });

      masked =
        masked.slice(0, entity.startIndex) +
        token +
        masked.slice(entity.endIndex);
    }

    return { masked, tokens };
  }

  /**
   * Replace PII tokens in text with original values.
   * Only substitutes tokens present in the current session's tokenMap.
   * Unknown tokens (e.g., model-generated [NAME_2]) are left as-is.
   */
  rehydrate(text: string): string {
    let result = text;
    for (const [token, original] of this.tokenMap) {
      result = result.replaceAll(token, original);
    }
    return result;
  }

  /**
   * Register enclave-supplied tokens for client-side rehydration.
   *
   * NOTE (L8 error-handling-audit): the original "TEE second-pass masking"
   * this was built for was REMOVED on 2026-06-01 (over-masking), but this
   * method is NOT dead code — it is the live sink for `tee_token_map`
   * stream frames: the enclave surfaces agent-path token→original maps
   * before the model stream begins, and the chat/agent transports
   * (apps/{web,mobile}/lib/chat/create-transport.ts,
   * apps/{web,mobile}/lib/agent/agent-session.ts) feed them here so
   * streamed responses rehydrate correctly. Entries are trusted from the
   * attested enclave session — do not feed untrusted input here, as every
   * registered token is substituted verbatim during rehydrate().
   */
  addTEETokens(teeTokens: PIIToken[]): void {
    for (const t of teeTokens) {
      this.tokenMap.set(t.token, t.original);
    }
  }

  /** Get the total number of tokens issued across all types (for TEE counter sync). */
  getTokenCount(): number {
    let total = 0;
    for (const count of this.counters.values()) {
      total += count;
    }
    return total;
  }

  getSubstitutions(): { token: string; original: string }[] {
    return Array.from(this.tokenMap, ([token, original]) => ({
      token,
      original,
    }));
  }

  /** Clear all state between conversations. */
  clear(): void {
    this.counters.clear();
    this.tokenMap.clear();
  }
}

/**
 * L7 error-handling-audit — structural validation for mask() input.
 * Throws when any entity is non-integer, out of bounds, an empty/inverted
 * range, or overlaps another entity.
 */
function assertValidEntitySet(text: string, entities: PIIEntity[]): void {
  const byStart = [...entities].sort((a, b) => a.startIndex - b.startIndex);
  let previous: PIIEntity | null = null;
  for (const entity of byStart) {
    const { startIndex, endIndex, type } = entity;
    if (
      !Number.isInteger(startIndex) ||
      !Number.isInteger(endIndex) ||
      endIndex <= startIndex
    ) {
      throw new Error(
        `PII masking failed: invalid entity range [${startIndex}, ${endIndex}) for type ${type}`,
      );
    }
    if (startIndex < 0 || endIndex > text.length) {
      throw new Error(
        `PII masking failed: entity range [${startIndex}, ${endIndex}) out of bounds for text of length ${text.length}`,
      );
    }
    if (previous && startIndex < previous.endIndex) {
      throw new Error(
        `PII masking failed: entity [${startIndex}, ${endIndex}) overlaps [${previous.startIndex}, ${previous.endIndex})`,
      );
    }
    previous = entity;
  }
}

/**
 * Find the safe point to emit text during SSE streaming,
 * avoiding splitting a PII token like [NAME_1] across chunks.
 * Per tech spec s7.2.
 */
export function findSafeEmitPoint(chunk: string): number {
  // Look for an unterminated bracket near the end of the chunk
  const lastOpen = chunk.lastIndexOf("[");
  if (lastOpen === -1) {
    return chunk.length;
  }

  // Check if the bracket is closed after it
  const lastClose = chunk.indexOf("]", lastOpen);
  if (lastClose !== -1) {
    // Bracket is closed — safe to emit everything
    return chunk.length;
  }

  // Unterminated bracket — only emit up to it
  // But only if it looks like it could be a PII token (within MAX_PII_TOKEN_LENGTH of end)
  if (chunk.length - lastOpen <= MAX_PII_TOKEN_LENGTH) {
    return lastOpen;
  }

  // The bracket is too far from the end to be a PII token — safe to emit
  return chunk.length;
}
