import type { AgentLoopEvent } from "../loop";
import type {
  ReinjectMiddleware,
  ReinjectOutcome,
  ToolResultContext,
} from "./types";

/**
 * Run the reinjection middleware chain as an onion.
 *
 * `chain[0]` is the outermost middleware; its `next()` runs `chain[1]`, and so
 * on. The chain MUST end in a terminal middleware that returns a
 * {@link ReinjectOutcome} without calling `next` — calling `next` past the end
 * throws `REINJECT_CHAIN_EXHAUSTED` (a programmer error: the tail of the chain
 * is meant to be the default sanitize+reinject step).
 *
 * Generator-shaped so wire events (`memory-write-signed`, `binary-write-request`,
 * intermediate `chunk`s) surface in real time, including BEFORE any awaited work
 * inside a middleware completes.
 */
export async function* runReinjectChain(
  chain: readonly ReinjectMiddleware[],
  rc: ToolResultContext,
): AsyncGenerator<AgentLoopEvent, ReinjectOutcome> {
  const dispatchFrom =
    (index: number) =>
    async function* (): AsyncGenerator<AgentLoopEvent, ReinjectOutcome> {
      const middleware = chain[index];
      if (!middleware) {
        throw new Error("REINJECT_CHAIN_EXHAUSTED");
      }
      return yield* middleware(rc, dispatchFrom(index + 1));
    };

  return yield* dispatchFrom(0)();
}
