import type { MemoryMutationEnvelope } from "@calypso/chat-types";

import type { MemoryWriteAckResult } from "../../loop";
import { sanitizeToolOutputForModel } from "../../tool-output-sanitizer";
import type { ReinjectMiddleware, ToolResultContext } from "../types";

/**
 * Codex finding #1 + the ACK-gating fix, lifted verbatim from
 * `runAgentLoop` (loop.ts:291–370).
 *
 * For a successful `memory.write` the gateway has SIGNED an envelope but the
 * write is not yet durable. This gate:
 *   1. Delivers the signed envelope to the CLIENT (never the model) so the
 *      client can call `saveMemory` with the signed bytes.
 *   2. BLOCKS on the client's durable-persist ACK (Phase 2/3) before the model
 *      or the ledger hear success — otherwise the model narrates "I saved…"
 *      before the write is durable (false on failure) and re-writes on
 *      read-after-write.
 *
 * Any other tool result — including a degenerate `memory.write` that produced
 * no signed envelope — is passed straight through to the rest of the chain.
 */
export const memoryWriteAckGate: ReinjectMiddleware = async function* (
  rc,
  next,
) {
  const signed = extractSignedEnvelope(rc);
  if (!signed) {
    return yield* next();
  }

  const { invocation, result, ctx } = rc;

  // Phase 1: hand the signed bytes to the client.
  yield {
    kind: "memory-write-signed",
    invocationId: invocation.invocationId,
    signedEnvelope: signed.signedEnvelope,
    signature: signed.signature,
    signedBlobB64: signed.signedBlobB64,
  };

  // Phase 2/3: block on durable persist + ACK. The undefined-awaiter fallback
  // mirrors BINARY_WRITE_ACK_UNAVAILABLE; the timeout itself is owned by the
  // wire layer so the turn never hangs.
  const ack: MemoryWriteAckResult = ctx.deps.awaitMemoryWriteAck
    ? await ctx.deps.awaitMemoryWriteAck({
        invocationId: invocation.invocationId,
        agentTurnId: ctx.agentTurnId,
      })
    : { outcome: "error", reason: "MEMORY_WRITE_ACK_UNAVAILABLE" };
  const confirmed = ack.outcome === "ok";

  // Ledger "Done" reflects the CONFIRMED durable write, not the sign-time
  // dispatch outcome. Yielded AFTER the signed envelope so wire ordering is
  // memory-write-signed → ledger (this gate short-circuits, so the chain's
  // ledgerEmitter never runs for a signed write).
  yield {
    kind: "ledger",
    entry: confirmed
      ? result.ledgerEntry
      : {
          ...result.ledgerEntry,
          outcome: "error",
          reason: ack.reason ?? "MEMORY_WRITE_NOT_CONFIRMED",
        },
  };

  // Reinject the REAL outcome. Signed-envelope bytes are never surfaced to the
  // model (audit lives in the ledger).
  return {
    reinjection: {
      role: "user",
      content: sanitizeToolOutputForModel({
        toolName: invocation.toolName,
        outcome: confirmed ? "ok" : "error",
        reason: confirmed
          ? undefined
          : (ack.reason ?? "MEMORY_WRITE_NOT_CONFIRMED"),
        payload: confirmed
          ? { ok: true, recordVersion: ack.recordVersion }
          : { ok: false },
      }),
    },
  };
};

interface SignedEnvelope {
  signedEnvelope: MemoryMutationEnvelope;
  signature: string;
  signedBlobB64: string;
}

/**
 * Replicates loop.ts:291–311: a signed memory.write is an `ok` `memory.write`
 * whose resultJson carries a `signedEnvelope` + string `signature`. Anything
 * else returns null (→ pass through).
 */
function extractSignedEnvelope(rc: ToolResultContext): SignedEnvelope | null {
  const { invocation, result } = rc;
  if (
    invocation.toolName !== "memory.write" ||
    result.outcome !== "ok" ||
    !result.resultJson ||
    typeof result.resultJson !== "object"
  ) {
    return null;
  }
  const payload = result.resultJson as {
    signedEnvelope?: MemoryMutationEnvelope;
    signature?: string;
    signedBlobB64?: string;
  };
  if (!payload.signedEnvelope || typeof payload.signature !== "string") {
    return null;
  }
  return {
    signedEnvelope: payload.signedEnvelope,
    signature: payload.signature,
    signedBlobB64: payload.signedBlobB64 ?? "",
  };
}
