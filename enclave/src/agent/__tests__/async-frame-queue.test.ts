/**
 * Unit tests for AsyncFrameQueue — the concurrent output queue that lets BOTH
 * the orchestrator pump AND clientBridge.approveQuery feed frames to a single
 * consuming async-iterator (the AGENT_REQUEST handler's outer for-await).
 *
 * Properties under test:
 *   - delivers pushed frames in order (FIFO)
 *   - supports a producer pushing WHILE the consumer awaits (the core
 *     concurrency requirement: push resolves a pending next())
 *   - ends iteration on close()
 *   - push after close is a no-op (does not resurrect a closed iterator)
 */
import { describe, it, expect } from 'vitest';

import { AsyncFrameQueue } from '../async-frame-queue';

function collect(
  q: AsyncFrameQueue,
): Promise<Buffer[]> {
  return (async () => {
    const out: Buffer[] = [];
    for await (const frame of q) out.push(frame);
    return out;
  })();
}

describe('AsyncFrameQueue', () => {
  it('delivers eagerly-pushed frames in FIFO order, then ends on close', async () => {
    const q = new AsyncFrameQueue();
    q.push(Buffer.from('a'));
    q.push(Buffer.from('b'));
    q.push(Buffer.from('c'));
    q.close();

    const out = await collect(q);
    expect(out.map((b) => b.toString())).toEqual(['a', 'b', 'c']);
  });

  it('resolves a consumer that is awaiting when a producer pushes later', async () => {
    const q = new AsyncFrameQueue();
    const consumed = collect(q);

    // Consumer is now parked on the first next(). Push concurrently.
    q.push(Buffer.from('frame-1'));
    // Give the microtask queue a turn so the awaiting consumer wakes.
    await Promise.resolve();
    q.push(Buffer.from('frame-2'));
    q.close();

    const out = await consumed;
    expect(out.map((b) => b.toString())).toEqual(['frame-1', 'frame-2']);
  });

  it('interleaves two concurrent producers and preserves global push order', async () => {
    const q = new AsyncFrameQueue();
    const consumed = collect(q);

    // Producer A pushes, then after a tick producer B pushes (modeling the
    // pump + approveQuery feeding the same queue).
    q.push(Buffer.from('pump-1'));
    await Promise.resolve();
    q.push(Buffer.from('approval-1'));
    await Promise.resolve();
    q.push(Buffer.from('pump-2'));
    q.close();

    const out = await consumed;
    expect(out.map((b) => b.toString())).toEqual([
      'pump-1',
      'approval-1',
      'pump-2',
    ]);
  });

  it('ends an awaiting consumer when close() is called with nothing queued', async () => {
    const q = new AsyncFrameQueue();
    const consumed = collect(q);
    // Consumer is parked; closing must end iteration with no frames.
    q.close();
    const out = await consumed;
    expect(out).toEqual([]);
  });

  it('push after close is ignored (no frame, iteration stays ended)', async () => {
    const q = new AsyncFrameQueue();
    q.push(Buffer.from('before-close'));
    q.close();
    q.push(Buffer.from('after-close'));

    const out = await collect(q);
    expect(out.map((b) => b.toString())).toEqual(['before-close']);
  });

  it('drains frames queued before close even if the consumer starts after close', async () => {
    const q = new AsyncFrameQueue();
    q.push(Buffer.from('x'));
    q.push(Buffer.from('y'));
    q.close();
    // Consumer attaches AFTER close — must still drain buffered frames then end.
    const out = await collect(q);
    expect(out.map((b) => b.toString())).toEqual(['x', 'y']);
  });
});
