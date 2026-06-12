import { memoryWriteAckGate } from "./middleware/memory-write-ack";
import { ledgerEmitter } from "./middleware/ledger-emitter";
import { binaryWriteAckGate } from "./middleware/binary-write-ack";
import { toolResultDigestEmitter } from "./middleware/tool-result-digest";
import { defaultSanitizeReinject } from "./middleware/default-sanitize-reinject";
import type { ReinjectMiddleware } from "./types";

/**
 * The enclave post-dispatch reinjection chain. ORDER IS THE SECURITY CONTRACT
 * (see `docs/design/agent-harness-middleware.md`):
 *
 *   1. memoryWriteAckGate     — signed memory.write: deliver envelope → block on
 *                               durable ACK → own (late) ledger. Short-circuits.
 *   2. ledgerEmitter          — every other path: emit result.ledgerEntry EARLY,
 *                               before any binary-write-request / tool-result.
 *   3. binaryWriteAckGate     — media transforms: request client write → block on
 *                               ACK → reinject terminal status. Short-circuits.
 *   4. toolResultDigestEmitter— emit the internal tool-result digest (skipped for
 *                               an unconfirmed memory.write). Delegates.
 *   5. defaultSanitizeReinject— terminal: sanitise → model reinjection.
 *
 * Reordering this list reorders wire events and can leak unconfirmed writes or
 * mis-order the audit ledger — do not change without re-review.
 */
export const REINJECT_CHAIN: readonly ReinjectMiddleware[] = [
  memoryWriteAckGate,
  ledgerEmitter,
  binaryWriteAckGate,
  toolResultDigestEmitter,
  defaultSanitizeReinject,
];
