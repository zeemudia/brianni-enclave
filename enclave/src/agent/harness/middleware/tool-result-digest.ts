import type { ReinjectMiddleware } from "../types";

/**
 * Emit the internal `tool-result` digest, then delegate.
 *
 * Corresponds to loop.ts:359–366. The orchestrator executor consumes this
 * event to carry a bounded, defanged digest of read-result tools across a
 * subtask boundary. It is NOT forwarded to the wire.
 *
 * Suppressed for a degenerate unconfirmed memory.write (`ok` with no signed
 * envelope): its bytes are never surfaced — the terminal reinject step turns
 * that case into an honest error instead.
 */
export const toolResultDigestEmitter: ReinjectMiddleware = async function* (
  rc,
  next,
) {
  const { invocation, result } = rc;
  const isUnconfirmedMemoryWrite =
    invocation.toolName === "memory.write" && result.outcome === "ok";
  if (!isUnconfirmedMemoryWrite) {
    yield {
      kind: "tool-result",
      toolName: invocation.toolName,
      outcome: result.outcome,
      resultJson: result.resultJson,
    };
  }
  return yield* next();
};
