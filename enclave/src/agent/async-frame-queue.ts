/**
 * AsyncFrameQueue — a single-consumer / multi-producer FIFO of encoded vsock
 * frames, consumed via async iteration.
 *
 * Why this exists (Layer-3 research-query approval, Phase 3): the AGENT_REQUEST
 * handler used to `yield encodeFrame(...)` directly from inside its
 * `for await (const item of agentEventStream)` loop. But Layer 3's
 * `clientBridge.approveQuery` is invoked from `tier-research.run`, which runs
 * INSIDE `gateway.dispatch(research.ask)`, which the orchestrator/agent loop is
 * BLOCKED awaiting. While approveQuery is pending the orchestrator generator is
 * suspended and yields nothing — so the for-await loop cannot emit the approval
 * frame to the client. A naive direct-yield approach deadlocks.
 *
 * The fix: route ALL outbound frames through this queue. A background "pump"
 * drains the orchestrator generator into the queue (`push`), and approveQuery
 * ALSO pushes its RESEARCH_QUERY_APPROVAL frame into the SAME queue from a
 * different async context. The handler's outer loop simply iterates the queue,
 * so the approval frame reaches the client even while the orchestrator is
 * suspended awaiting dispatch.
 *
 * Semantics:
 *   - push(frame): enqueue. Backpressure-free (unbounded in-memory buffer);
 *     a parked consumer is woken immediately. A push after close() is ignored.
 *   - close(): end iteration once the buffer drains. Idempotent.
 *   - async-iterator: yields frames in push order, then completes after close.
 *     Single consumer only (the handler's one for-await).
 */
export class AsyncFrameQueue implements AsyncIterable<Buffer> {
  private readonly buffer: Buffer[] = [];
  private closed = false;
  /** Resolver for a consumer currently parked on next() with an empty buffer. */
  private waiting: ((result: IteratorResult<Buffer>) => void) | null = null;

  /**
   * Enqueue a frame. If a consumer is parked awaiting next(), it is woken with
   * this frame directly. Ignored after close() so a closed iterator cannot be
   * resurrected.
   */
  push(frame: Buffer): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: frame, done: false });
      return;
    }
    this.buffer.push(frame);
  }

  /**
   * End iteration once buffered frames drain. A parked consumer is completed
   * immediately. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: (): Promise<IteratorResult<Buffer>> => {
        // Drain buffered frames first (even after close).
        const buffered = this.buffer.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        // Empty + open → park until the next push() or close().
        return new Promise<IteratorResult<Buffer>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
