/**
 * Regression tests for Bug 5 (commit 3703ce2): enclave parseFrames must
 * half-close accepted vsock sockets when the peer sends FIN, otherwise
 * accepted fds leak, the libuv worker pool (filled with pending fs.reads on
 * those dangling fds) saturates after ~4 sequential requests, and the whole
 * enclave appears to hang.
 *
 * Three scenarios exercised with a fake Socket + fake router:
 *   A) peer sends 'end' while idle → socket.end() is called once.
 *   B) peer sends 'end' while drainFrames is in-flight → socket.end() is
 *      deferred until the in-flight request finishes (no half-written
 *      response truncation).
 *   C) router.handleMessage throws → parseFrames destroys the socket, and a
 *      subsequent 'end' does not attempt a second end() on the already-
 *      destroyed socket.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { encodeFrame, MSG } from '../vsock';
import { parseFrames, type EnclaveRouter } from '../index';

// Minimal Socket stand-in. parseFrames touches:
//   .on('data' | 'error' | 'end' | 'close' | 'drain'), .write(buf),
//   .end(), .destroy()
// That's the whole surface we need to fake.
class FakeSocket extends EventEmitter {
  public writes: Buffer[] = [];
  public ended = false;
  public destroyed = false;
  public endCalls = 0;
  public destroyCalls = 0;
  /** L1 backpressure test hook: write() returns false this many times. */
  public refuseWrites = 0;

  write(buf: Buffer): boolean {
    this.writes.push(Buffer.from(buf));
    if (this.refuseWrites > 0) {
      this.refuseWrites -= 1;
      return false;
    }
    return true;
  }
  end(): void {
    this.endCalls += 1;
    this.ended = true;
  }
  destroy(): void {
    this.destroyCalls += 1;
    this.destroyed = true;
  }
}

function fakeRouter(
  handler: (raw: Buffer, signal?: AbortSignal) => AsyncGenerator<Buffer>,
): EnclaveRouter {
  return { handleMessage: handler } as unknown as EnclaveRouter;
}

// Helper: let scheduled microtasks / setImmediate callbacks run.
async function flush(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('parseFrames on-end fd cleanup (Bug 5 regression)', () => {
  it('scenario A: peer ends while idle → socket.end() is called exactly once', async () => {
    const sock = new FakeSocket();
    const router = fakeRouter(async function* () {
      // Not invoked in this scenario — no data is sent before end.
    });

    parseFrames(sock as unknown as Socket, router);

    sock.emit('end');
    await flush();

    expect(sock.endCalls).toBe(1);
    expect(sock.destroyCalls).toBe(0);
  });

  it('scenario B: end during in-flight drainFrames is deferred until processing completes', async () => {
    const sock = new FakeSocket();

    // Router's handleMessage blocks on a manually-resolved promise so we can
    // drive the processing=true window deterministically.
    let release: (() => void) | null = null;
    const pending = new Promise<void>((r) => {
      release = r;
    });

    const router = fakeRouter(async function* (_raw: Buffer) {
      await pending;
      yield encodeFrame(
        MSG.HEALTH_PONG,
        Buffer.from(JSON.stringify({ status: 'ok' })),
      );
    });

    parseFrames(sock as unknown as Socket, router);

    // Send a complete HEALTH_PING frame (type + 4-byte big-endian length=0).
    const pingFrame = encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0));
    sock.emit('data', pingFrame);

    // Let drainFrames start and await `pending`.
    await flush();

    // Peer ends in the middle of processing. socket.end() MUST NOT fire yet —
    // otherwise the response we're about to write is truncated.
    sock.emit('end');
    await flush();
    expect(sock.endCalls).toBe(0);

    // Release the router; drainFrames writes the response, processing=false,
    // end-handler's polling loop exits and calls socket.end().
    release!();
    await flush(10);

    expect(sock.writes.length).toBe(1);
    expect(sock.endCalls).toBe(1);
  });

  it('scenario C: router throws → socket.destroy(); a later end does not re-call end()', async () => {
    const sock = new FakeSocket();

    const router = fakeRouter(async function* (_raw: Buffer): AsyncGenerator<Buffer> {
      throw new Error('boom');
    });

    parseFrames(sock as unknown as Socket, router);

    const pingFrame = encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0));
    sock.emit('data', pingFrame);
    await flush();

    expect(sock.destroyCalls).toBeGreaterThanOrEqual(1);
    const endCallsBeforeEnd = sock.endCalls;

    // Peer ends after the error. The on('end') handler still runs and tries
    // to call end() — but processing is false and the socket is already
    // destroyed, so end() either no-ops or is called once. What matters is
    // we don't double-destroy.
    sock.emit('end');
    await flush();

    expect(sock.destroyCalls).toBe(1);
    // endCalls may be 0 or 1; we only care that it didn't blow up.
    expect(sock.endCalls - endCallsBeforeEnd).toBeLessThanOrEqual(1);
  });
});

describe('parseFrames disconnect-abort + backpressure (L1)', () => {
  it('stops writing response frames after the socket closes', async () => {
    const sock = new FakeSocket();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const router = fakeRouter(async function* () {
      yield encodeFrame(MSG.HEALTH_PONG, Buffer.from('frame-1'));
      await gate;
      yield encodeFrame(MSG.HEALTH_PONG, Buffer.from('frame-2'));
    });

    parseFrames(sock as unknown as Socket, router);
    sock.emit('data', encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0)));
    await flush();
    expect(sock.writes.length).toBe(1);

    // Peer disconnects while the handler is still producing.
    sock.emit('close');
    release!();
    await flush(10);

    // frame-2 must NOT be written into the dead socket.
    expect(sock.writes.length).toBe(1);
  });

  it('passes a per-connection AbortSignal that fires on close', async () => {
    const sock = new FakeSocket();
    let seenSignal: AbortSignal | undefined;
    const router = fakeRouter(async function* (_raw, signal) {
      seenSignal = signal;
      yield encodeFrame(MSG.HEALTH_PONG, Buffer.alloc(0));
    });

    parseFrames(sock as unknown as Socket, router);
    sock.emit('data', encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0)));
    await flush();

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(false);
    sock.emit('close');
    expect(seenSignal!.aborted).toBe(true);
  });

  it('waits for drain before writing the next frame when write() returns false', async () => {
    const sock = new FakeSocket();
    sock.refuseWrites = 1;

    const router = fakeRouter(async function* () {
      yield encodeFrame(MSG.HEALTH_PONG, Buffer.from('frame-1'));
      yield encodeFrame(MSG.HEALTH_PONG, Buffer.from('frame-2'));
    });

    parseFrames(sock as unknown as Socket, router);
    sock.emit('data', encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0)));
    await flush(10);

    // First write returned false → the second frame is held back until
    // the kernel signals drain.
    expect(sock.writes.length).toBe(1);

    sock.emit('drain');
    await flush(10);
    expect(sock.writes.length).toBe(2);
  });

  it('a drain-wait does not hang when the socket closes instead of draining', async () => {
    const sock = new FakeSocket();
    sock.refuseWrites = 1;

    let completed = false;
    const router = fakeRouter(async function* () {
      yield encodeFrame(MSG.HEALTH_PONG, Buffer.from('frame-1'));
      yield encodeFrame(MSG.HEALTH_PONG, Buffer.from('frame-2'));
      completed = true;
    });

    parseFrames(sock as unknown as Socket, router);
    sock.emit('data', encodeFrame(MSG.HEALTH_PING, Buffer.alloc(0)));
    await flush(10);
    expect(sock.writes.length).toBe(1);

    // Close while awaiting drain: the wait must resolve (abort) and the
    // remaining frame must be dropped, not written or hung on.
    sock.emit('close');
    await flush(10);
    expect(sock.writes.length).toBe(1);
    expect(completed).toBe(false);
  });
});

describe('parseFrames is exported from enclave/src/index (Bug 5)', () => {
  it('parseFrames is callable — if this import ever goes missing, the file lost its on-end handler too', () => {
    expect(typeof parseFrames).toBe('function');
    // parseFrames(socket, router) — 2 params.
    expect(parseFrames.length).toBe(2);
  });
});
