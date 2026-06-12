import { describe, expect, it } from 'vitest';
import { deriveKey } from '@calypso/crypto-core/hkdf';
import { SearchIndex, hmacTerm, type SearchIndexStore, type SearchRef } from '@calypso/search-core';
import {
  SEARCH_HMAC_PARITY_VECTORS,
  SEARCH_KEY_SALT,
  SEARCH_KEY_INFO,
  SEARCH_KEY_LENGTH,
} from '../index';

class MemStore implements SearchIndexStore {
  private idx = new Map<string, SearchRef[]>();
  private indexed = new Map<string, number>();
  async put(tag: string, ref: SearchRef): Promise<void> {
    const list = this.idx.get(tag) ?? [];
    const key = `${ref.conversationId}:${ref.messageId}`;
    if (!list.some((r) => `${r.conversationId}:${r.messageId}` === key)) {
      list.push(ref);
    }
    this.idx.set(tag, list);
  }
  async get(tag: string): Promise<SearchRef[]> {
    return this.idx.get(tag) ?? [];
  }
  async deleteByConversation(conversationId: string): Promise<void> {
    for (const [tag, refs] of this.idx) {
      this.idx.set(
        tag,
        refs.filter((r) => r.conversationId !== conversationId),
      );
    }
    this.indexed.delete(conversationId);
  }
  async hasIndexedConversation(id: string): Promise<boolean> {
    return this.indexed.has(id);
  }
  async markIndexed(id: string, at: number): Promise<void> {
    this.indexed.set(id, at);
  }
  async clearAll(): Promise<void> {
    this.idx.clear();
    this.indexed.clear();
  }
}

describe('search HMAC parity vectors (cross-platform)', () => {
  const { rootHex, messages, terms, queries } = SEARCH_HMAC_PARITY_VECTORS;

  it('root is 32 bytes, term + query fixture shapes look right', () => {
    expect(rootHex).toHaveLength(64);
    expect(messages.length).toBeGreaterThanOrEqual(5);
    expect(terms.length).toBeGreaterThanOrEqual(5);
    expect(queries.length).toBeGreaterThanOrEqual(5);
  });

  it.each(terms.map((t) => [t.term, t] as const))(
    'HMAC(search_key, "%s") matches the pinned tag',
    async (_term, vector) => {
      const root = new Uint8Array(Buffer.from(rootHex, 'hex'));
      const salt = new TextEncoder().encode(SEARCH_KEY_SALT);
      const searchKey = await deriveKey(
        root,
        salt,
        SEARCH_KEY_INFO,
        SEARCH_KEY_LENGTH,
      );
      const tag = await hmacTerm(searchKey, vector.term);
      expect(tag).toBe(vector.tagHex);
    },
  );

  it('built index returns the pinned conversation for every query (user-visible hit parity)', async () => {
    const root = new Uint8Array(Buffer.from(rootHex, 'hex'));
    const salt = new TextEncoder().encode(SEARCH_KEY_SALT);
    const searchKey = await deriveKey(
      root,
      salt,
      SEARCH_KEY_INFO,
      SEARCH_KEY_LENGTH,
    );

    const store = new MemStore();
    const index = new SearchIndex(searchKey, store);
    for (const m of messages) {
      await index.build({
        id: m.conversationId,
        messages: [{ id: m.messageId, role: 'user', content: m.text }],
      });
    }

    for (const { q, hit } of queries) {
      const refs = await index.query(q);
      const convs = new Set(refs.map((r) => r.conversationId));
      expect(convs.has(hit)).toBe(true);
      expect(convs.size).toBe(1);
    }
  });
});
