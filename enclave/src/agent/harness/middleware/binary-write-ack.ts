import { sanitizeToolOutputForModel } from "../../tool-output-sanitizer";
import type { ReinjectMiddleware } from "../types";

/**
 * Binary-write ACK gate, lifted verbatim from `runAgentLoop` (loop.ts:319–343).
 *
 * A media transform (`image.transform`, `audio.transform`, …) produces bytes
 * the enclave cannot persist itself — it asks the CLIENT to write them. This
 * gate yields the `binary-write-request` to the client, BLOCKS on the client's
 * write ACK, then reinjects the terminal status (not the intermediate
 * `awaiting_client_write`). Structurally identical to the memory.write gate.
 *
 * Anything without a `clientOnlyBinaryWrite` (or a non-ok dispatch) passes
 * straight through to the rest of the chain.
 */
export const binaryWriteAckGate: ReinjectMiddleware = async function* (
  rc,
  next,
) {
  const { invocation, result, ctx } = rc;
  if (result.outcome !== "ok" || !result.clientOnlyBinaryWrite) {
    return yield* next();
  }

  yield { kind: "binary-write-request", payload: result.clientOnlyBinaryWrite };

  const ackResult = ctx.deps.awaitBinaryWriteAck
    ? await ctx.deps.awaitBinaryWriteAck(result.clientOnlyBinaryWrite)
    : {
        invocationId: invocation.invocationId,
        outcome: "error" as const,
        reason: "BINARY_WRITE_ACK_UNAVAILABLE",
        resultJson: {
          status: "error",
          reason: "BINARY_WRITE_ACK_UNAVAILABLE",
        },
      };

  return {
    reinjection: {
      role: "user",
      content: sanitizeToolOutputForModel({
        toolName: invocation.toolName,
        outcome: ackResult.outcome,
        reason: ackResult.reason,
        payload: ackResult.resultJson ?? null,
      }),
    },
  };
};
