import type { ReinjectMiddleware } from "../types";

/**
 * Emit the dispatch ledger entry, then delegate.
 *
 * Corresponds to `yield { kind: 'ledger', entry: result.ledgerEntry }` at
 * loop.ts:317 — emitted EARLY (before any `binary-write-request` / `tool-result`)
 * for every non-signed path. The signed memory.write gate runs before this and
 * short-circuits, so it owns its own (confirmation-gated, late) ledger and this
 * emitter never runs for a signed write.
 */
export const ledgerEmitter: ReinjectMiddleware = async function* (rc, next) {
  yield { kind: "ledger", entry: rc.result.ledgerEntry };
  return yield* next();
};
