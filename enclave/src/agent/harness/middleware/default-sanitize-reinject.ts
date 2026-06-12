import { sanitizeToolOutputForModel } from "../../tool-output-sanitizer";
import type { ReinjectMiddleware } from "../types";

/**
 * Terminal reinjection: sanitise the tool result into the message the model
 * hears next. Corresponds to loop.ts:368–376. Does NOT call `next` — it is the
 * tail of the chain.
 *
 * A degenerate unconfirmed memory.write (`ok` with no signed envelope reached
 * the signed gate, so it fell through to here) is rewritten to an honest
 * not-confirmed error: we never tell the model a write succeeded without a gated
 * ACK, and never leak the result bytes.
 */
export const defaultSanitizeReinject: ReinjectMiddleware =

  async function* (rc) {
    const { invocation, result } = rc;
    const isUnconfirmedMemoryWrite =
      invocation.toolName === "memory.write" && result.outcome === "ok";

    return {
      reinjection: {
        role: "user",
        content: sanitizeToolOutputForModel({
          toolName: invocation.toolName,
          outcome: isUnconfirmedMemoryWrite ? "error" : result.outcome,
          reason: isUnconfirmedMemoryWrite
            ? "MEMORY_WRITE_NOT_CONFIRMED"
            : result.reason,
          payload: isUnconfirmedMemoryWrite ? { ok: false } : result.resultJson,
        }),
      },
    };
  };
