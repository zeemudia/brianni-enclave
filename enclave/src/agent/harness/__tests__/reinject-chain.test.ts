import { describe, it, expect } from "vitest";

import { runReinjectChain } from "../reinject-chain";
import type {
  ReinjectMiddleware,
  ReinjectOutcome,
  ToolResultContext,
} from "../types";
import type { AgentLoopEvent } from "../../loop";

// The chain-runner tests exercise composition only, so a bare context is
// enough — none of the fake middlewares read `rc`.
const rc = {} as ToolResultContext;

const okOutcome = (content: string): ReinjectOutcome => ({
  reinjection: { role: "user", content },
});

async function drain(
  gen: AsyncGenerator<AgentLoopEvent, ReinjectOutcome>,
): Promise<{ events: AgentLoopEvent[]; outcome: ReinjectOutcome }> {
  const events: AgentLoopEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, outcome: step.value };
}

describe("runReinjectChain", () => {
  it("runs middleware as an onion: outer wraps inner, events in order", async () => {
    const order: string[] = [];

    const outer: ReinjectMiddleware = async function* (_rc, next) {
      order.push("outer-before");
      yield { kind: "chunk", text: "outer" };
      const out = yield* next();
      order.push("outer-after");
      return out;
    };
    const inner: ReinjectMiddleware = async function* () {
      order.push("inner");
      yield { kind: "chunk", text: "inner" };
      return okOutcome("R");
    };

    const { events, outcome } = await drain(runReinjectChain([outer, inner], rc));

    expect(order).toEqual(["outer-before", "inner", "outer-after"]);
    expect(events).toEqual([
      { kind: "chunk", text: "outer" },
      { kind: "chunk", text: "inner" },
    ]);
    expect(outcome.reinjection.content).toBe("R");
  });

  it("short-circuits: a middleware that never calls next skips the rest", async () => {
    let innerRan = false;

    const shortCircuit: ReinjectMiddleware = async function* () {
      return okOutcome("SC");
    };
    const inner: ReinjectMiddleware = async function* () {
      innerRan = true;
      return okOutcome("never");
    };

    const { outcome } = await drain(
      runReinjectChain([shortCircuit, inner], rc),
    );

    expect(innerRan).toBe(false);
    expect(outcome.reinjection.content).toBe("SC");
  });

  it("surfaces a pre-await event before the awaited work completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const gating: ReinjectMiddleware = async function* (_rc, next) {
      // Mirrors the memory.write gate: emit the signed-envelope frame to the
      // client BEFORE blocking on the durable-persist ACK.
      yield { kind: "chunk", text: "pre-await" };
      await gate;
      return yield* next();
    };
    const terminal: ReinjectMiddleware = async function* () {
      return okOutcome("after-await");
    };

    const gen = runReinjectChain([gating, terminal], rc);

    // The first event must arrive while the gate is still unresolved.
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ kind: "chunk", text: "pre-await" });

    release();
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    expect(step.value.reinjection.content).toBe("after-await");
  });

  it("throws when a middleware calls next past the end of the chain", async () => {
    const passthrough: ReinjectMiddleware = async function* (_rc, next) {
      return yield* next();
    };

    await expect(
      drain(runReinjectChain([passthrough], rc)),
    ).rejects.toThrow("REINJECT_CHAIN_EXHAUSTED");
  });
});
