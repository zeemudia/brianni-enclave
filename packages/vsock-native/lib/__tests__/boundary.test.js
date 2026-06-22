/**
 * Boundary-coverage mutation tests for the AF_VSOCK JS wrapper
 * (lib/index.js). These complement index.test.ts (Bug-1 async-accept
 * regression) and accept-loop.test.js (H2/L1/L2 resilience) by exercising the
 * stream lifecycle (_read EOF / _write short-writes / _final half-close /
 * _destroy close handling), the accept-error classifier across every bucket,
 * connect()/server.close()/server.address(), and the stop-during-accept fd
 * cleanup.
 *
 * The native addon is Linux-only and not compiled here, so every test stubs it
 * via `_setAddonForTests`. fd-bearing paths use REAL temp-file / pipe fds so
 * the genuine fs.read/fs.write/fs.close syscalls run, keeping the suite
 * hermetic without opening a real AF_VSOCK socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vsock from '../index.js';

// The wrapper does `const fs = require('node:fs')` and calls `fs.write`. To
// force a SHORT write (regular files never short-write) we patch the SAME fs
// module object the wrapper holds. Use createRequire so we mutate the CJS
// module the wrapper references, not a separate ESM namespace binding.
const nodeFs = createRequire(import.meta.url)('node:fs');

const {
  connect,
  createServer,
  VsockSocket,
  _setAddonForTests,
  _classifyAcceptError,
} = vsock;

// Guaranteed-invalid sentinel fds, far outside any real fd the test process
// could own. Codex P2: the wrapper calls fs.close() on the fd returned by
// vsockBind/vsockConnect during destroy()/close(), so a low default like 7 (or
// even 4242 under fd pressure) could close a LIVE Vitest/Stryker worker
// descriptor and create cross-test flakes. Using out-of-range sentinels means
// any such fs.close() simply EBADFs harmlessly (matching the existing pattern
// in accept-loop.test.js). Tests that need a genuinely closable fd use
// openTempFd() instead.
const SENTINEL_LISTEN_FD = 2147483600;
const SENTINEL_CONNECT_FD = 2147483500;

function makeAddon(overrides = {}) {
  return {
    vsockConnect: vi.fn(() => SENTINEL_CONNECT_FD),
    vsockBind: vi.fn(() => SENTINEL_LISTEN_FD),
    vsockAccept: vi.fn(),
    vsockAcceptAsync: vi.fn(),
    vsockShutdown: vi.fn(),
    ...overrides,
  };
}

// A real, writable temp file fd — fs.write/fs.read/fs.close all succeed on it.
function openTempFd(initialContents) {
  const dir = mkdtempSync(join(tmpdir(), 'vsock-boundary-'));
  const path = join(dir, 'fd.bin');
  if (initialContents !== undefined) writeFileSync(path, initialContents);
  else writeFileSync(path, '');
  // 'r+' so both read and write work on the same fd.
  return { fd: openSync(path, 'r+'), path };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  _setAddonForTests(null);
  vi.restoreAllMocks();
});

describe('connect()', () => {
  it('asks the addon to open the fd for the given cid+port and wraps it', () => {
    // Default vsockConnect returns the out-of-range SENTINEL_CONNECT_FD, so the
    // socket.destroy() below fs.close()es a guaranteed-invalid fd (EBADF), never
    // a live worker descriptor.
    const addon = makeAddon();
    _setAddonForTests(addon);

    const socket = connect(5005, 3);

    // cid is the FIRST arg, port the SECOND — a swap here would dial the
    // wrong endpoint. Pins vsockConnect(cid, port) ordering.
    expect(addon.vsockConnect).toHaveBeenCalledWith(3, 5005);
    expect(socket).toBeInstanceOf(VsockSocket);
    socket.destroy();
  });
});

describe('VsockSocket stream lifecycle', () => {
  it('_write writes the full chunk to the fd, looping over short writes', async () => {
    _setAddonForTests(makeAddon());
    const { fd, path } = openTempFd();
    const socket = new VsockSocket(fd);

    const payload = Buffer.from('hello-vsock-payload');
    await new Promise((resolve, reject) => {
      socket.write(payload, (err) => (err ? reject(err) : resolve()));
    });
    socket.end();
    await new Promise((resolve) => socket.on('finish', resolve));

    expect(readFileSync(path)).toEqual(payload);
    socket.destroy();
  });

  it('_write advances the offset across SHORT writes until the whole chunk lands', async () => {
    // Forces a short-write loop (fs.write reports 1 byte at a time) so the
    // second+ iterations exercise `buf.length - offset` (remaining-length) and
    // the offset accumulation. Kills `buf.length - offset` -> `+ offset` (which
    // would compute a length past the buffer on iteration 2) and the err branch.
    _setAddonForTests(makeAddon());
    const { fd, path } = openTempFd();
    const socket = new VsockSocket(fd);

    const realWrite = nodeFs.write;
    const lenInvariantViolations = [];
    const writeSpy = vi
      .spyOn(nodeFs, 'write')
      .mockImplementation((wfd, buf, off, len, pos, cb) => {
        // The wrapper must always pass a length of EXACTLY the remaining bytes
        // (`buf.length - offset`). If a mutant computes `buf.length + offset`,
        // iteration 2+ asks to write PAST the end of the buffer — record that
        // invariant break so the test fails loudly. Then honour offset/len but
        // cap each real syscall at a single byte to force the short-write loop.
        if (off + len > buf.length) {
          lenInvariantViolations.push({ off, len, bufLen: buf.length });
        }
        return realWrite.call(nodeFs, wfd, buf, off, Math.min(len, 1), pos, (err, written) =>
          cb(err, err ? written : 1),
        );
      });

    try {
      const payload = Buffer.from('multi-syscall-write');
      await new Promise((resolve, reject) => {
        socket.write(payload, (err) => (err ? reject(err) : resolve()));
      });
      socket.end();
      await new Promise((resolve) => socket.on('finish', resolve));

      // The wrapper NEVER asked to write past the buffer (kills the
      // `buf.length - offset` -> `+ offset` remaining-length mutant).
      expect(lenInvariantViolations).toEqual([]);
      // Every byte written, one syscall per byte → the loop really iterated.
      expect(writeSpy.mock.calls.length).toBe(payload.length);
      writeSpy.mockRestore();
      expect(readFileSync(path)).toEqual(payload);
    } finally {
      if (writeSpy.mock) writeSpy.mockRestore();
      socket.destroy();
    }
  });

  it('_write coerces a string chunk via the provided encoding', async () => {
    _setAddonForTests(makeAddon());
    const { fd, path } = openTempFd();
    // Bypass Writable's decodeStrings so _write receives a raw string +
    // encoding (covers `Buffer.from(chunk, encoding)`).
    const socket = new VsockSocket(fd);
    socket._writableState.decodeStrings = false;

    await new Promise((resolve, reject) => {
      socket.write('A', 'utf8', (err) => (err ? reject(err) : resolve()));
    });
    socket.end();
    await new Promise((resolve) => socket.on('finish', resolve));

    expect(readFileSync(path).toString()).toBe('A');
    socket.destroy();
  });

  it('_read pushes bytes then EOF (push(null)) when the fd reaches end of file', async () => {
    _setAddonForTests(makeAddon());
    const { fd } = openTempFd('streamed-bytes');
    const socket = new VsockSocket(fd);

    const chunks = [];
    const ended = new Promise((resolve) => socket.on('end', resolve));
    socket.on('data', (c) => chunks.push(c));
    socket.resume();
    await ended;

    expect(Buffer.concat(chunks).toString()).toBe('streamed-bytes');
    socket.destroy();
  });

  it('_final half-closes the writable side via vsockShutdown(fd, SHUT_WR=1)', async () => {
    const addon = makeAddon();
    _setAddonForTests(addon);
    const { fd } = openTempFd();
    const socket = new VsockSocket(fd);

    socket.end();
    await new Promise((resolve) => socket.on('finish', resolve));

    expect(addon.vsockShutdown).toHaveBeenCalledWith(fd, 1);
    socket.destroy();
  });

  it('_final surfaces an unexpected shutdown failure as the finish error', async () => {
    const boom = new Error('shutdown exploded');
    const addon = makeAddon({
      vsockShutdown: vi.fn(() => {
        throw boom;
      }),
    });
    _setAddonForTests(addon);
    const { fd } = openTempFd();
    const socket = new VsockSocket(fd);

    const errored = new Promise((resolve) => socket.on('error', resolve));
    socket.end();
    const err = await errored;
    expect(err).toBe(boom);
    // shutdown threw, so the fd is still open — close it directly to avoid a leak.
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  });

  it('_destroy half-closes RDWR (SHUT_RDWR=2) and closes the fd', async () => {
    const addon = makeAddon();
    _setAddonForTests(addon);
    const { fd } = openTempFd();
    const socket = new VsockSocket(fd);

    const closed = new Promise((resolve) => socket.on('close', resolve));
    socket.destroy();
    await closed;

    expect(addon.vsockShutdown).toHaveBeenCalledWith(fd, 2);
  });

  it('_destroy is idempotent — a second destroy() does not double-shutdown', async () => {
    const addon = makeAddon();
    _setAddonForTests(addon);
    const { fd } = openTempFd();
    const socket = new VsockSocket(fd);

    const closed = new Promise((resolve) => socket.on('close', resolve));
    socket.destroy();
    await closed;
    const callsAfterFirst = addon.vsockShutdown.mock.calls.length;

    socket.destroy(); // _closed already true → early return
    expect(addon.vsockShutdown.mock.calls.length).toBe(callsAfterFirst);
  });

  it('_destroy swallows an EBADF close error (peer already closed)', async () => {
    const addon = makeAddon();
    _setAddonForTests(addon);
    const { fd } = openTempFd();
    closeSync(fd); // make the eventual fs.close(fd) inside _destroy EBADF
    const socket = new VsockSocket(fd);

    // Destroy with no preceding error: the EBADF from fs.close must be
    // suppressed (closeErr.code === 'EBADF' && !err) so 'close' still fires
    // without an 'error'.
    const errors = [];
    socket.on('error', (e) => errors.push(e));
    const closed = new Promise((resolve) => socket.on('close', resolve));
    socket.destroy();
    await closed;

    expect(errors).toHaveLength(0);
  });

  it('setNoDelay / setKeepAlive are chainable net.Socket-compat no-ops', () => {
    _setAddonForTests(makeAddon());
    const { fd } = openTempFd();
    const socket = new VsockSocket(fd);
    expect(socket.setNoDelay()).toBe(socket);
    expect(socket.setKeepAlive()).toBe(socket);
    socket.destroy();
  });

  it('setTimeout(ms>0) fires a one-shot timeout and invokes the callback', async () => {
    _setAddonForTests(makeAddon());
    const { fd } = openTempFd();
    const socket = new VsockSocket(fd);

    let fired = false;
    const ret = socket.setTimeout(20, () => {
      fired = true;
    });
    expect(ret).toBe(socket); // chainable

    await wait(60);
    expect(fired).toBe(true);
    socket.destroy();
  });

  it('setTimeout(0) clears any pending timer and arms nothing', async () => {
    _setAddonForTests(makeAddon());
    const { fd } = openTempFd();
    const socket = new VsockSocket(fd);

    let fired = false;
    socket.setTimeout(20, () => {
      fired = true;
    });
    // ms <= 0 must clear the existing timer and NOT arm a new one.
    socket.setTimeout(0);
    expect(socket._timeoutTimer).toBeFalsy();

    await wait(60);
    expect(fired).toBe(false);
    socket.destroy();
  });
});

describe('createServer() lifecycle', () => {
  it('server.address() reports the vsock pseudo-address', () => {
    _setAddonForTests(makeAddon());
    const server = createServer(() => {});
    expect(server.address()).toEqual({ port: 0, family: 'vsock', address: 'vsock' });
  });

  it('listen() emits "listening" and invokes the listen callback', async () => {
    const addon = makeAddon({ vsockAcceptAsync: vi.fn(() => {}) /* never completes */ });
    _setAddonForTests(addon);

    const server = createServer(() => {});
    const listening = new Promise((resolve) => server.on('listening', resolve));
    let cbCalled = false;
    server.listen(5005, () => {
      cbCalled = true;
    });
    await listening;
    expect(cbCalled).toBe(true);
    expect(addon.vsockBind).toHaveBeenCalledWith(5005);
    server.close();
  });

  it('listen() routes a bind failure to the callback AND an "error" event', async () => {
    const bindErr = new Error('vsock bind failed: Address already in use');
    const addon = makeAddon({
      vsockBind: vi.fn(() => {
        throw bindErr;
      }),
    });
    _setAddonForTests(addon);

    const server = createServer(() => {});
    const cbErr = await new Promise((resolve) => {
      server.on('error', () => {});
      server.listen(5005, (err) => resolve(err));
    });
    expect(cbErr).toBe(bindErr);
    // The accept loop must never start after a failed bind.
    expect(addon.vsockAcceptAsync).not.toHaveBeenCalled();
  });

  it('close() shuts down the listen fd and emits "close"', async () => {
    const addon = makeAddon({ vsockAcceptAsync: vi.fn(() => {}) });
    const { fd: listenFd } = openTempFd();
    addon.vsockBind = vi.fn(() => listenFd);
    _setAddonForTests(addon);

    const server = createServer(() => {});
    server.listen(5005);
    await wait(10);

    const closed = new Promise((resolve) => server.on('close', resolve));
    const closeCbErr = await new Promise((resolve) => {
      server.close((err) => resolve(err));
    });
    await closed;

    // listenFd >= 0 path: shutdown(RDWR=2) then fs.close.
    expect(addon.vsockShutdown).toHaveBeenCalledWith(listenFd, 2);
    expect(closeCbErr).toBeFalsy();
  });

  it('close() before listen() still invokes the callback (listenFd < 0 branch)', async () => {
    _setAddonForTests(makeAddon());
    const server = createServer(() => {});
    const cbErr = await new Promise((resolve) => server.close((err) => resolve(err)));
    expect(cbErr).toBeUndefined();
  });

  it('close() before listen() with NO callback does not throw', async () => {
    // Kills the `if (callback)` -> `if (true)` guard in the no-fd branch: a
    // callback-less close must not `process.nextTick(undefined)` and crash.
    _setAddonForTests(makeAddon());
    const server = createServer(() => {});
    expect(() => server.close()).not.toThrow();
    await wait(5);
  });

  it('a bind failure with NO listen callback still emits "error" without crashing', async () => {
    // Kills the `if (callback)` -> `if (true)` guard on the bind-error path:
    // with no callback, the code must NOT invoke `undefined(err)` — it must
    // only emit the 'error' event.
    const bindErr = new Error('vsock bind failed: Address already in use');
    const addon = makeAddon({
      vsockBind: vi.fn(() => {
        throw bindErr;
      }),
    });
    _setAddonForTests(addon);

    const server = createServer(() => {});
    const emitted = await new Promise((resolve) => {
      server.on('error', (e) => resolve(e));
      // No listen callback on purpose.
      expect(() => server.listen(5005)).not.toThrow();
    });
    expect(emitted).toBe(bindErr);
  });

  it('a client fd accepted AFTER close() is dropped AND its fd is closed', async () => {
    let acceptCb;
    const addon = makeAddon({
      vsockAcceptAsync: vi.fn((_fd, cb) => {
        acceptCb = cb;
      }),
    });
    const { fd: lateClientFd } = openTempFd();
    _setAddonForTests(addon);

    const delivered = [];
    const server = createServer((client) => delivered.push(client));
    server.listen(5005);
    await wait(10);

    server.close();
    // Deliver a numeric client fd AFTER close(): the stopping guard must drop
    // it and CLOSE the fd (`!err && typeof clientFd === 'number'`) rather than
    // hand a live socket to the (stopped) handler or leak the fd.
    acceptCb(null, lateClientFd);
    await wait(20);

    expect(delivered).toHaveLength(0);
    // The dropped fd must now be closed — a second close raises EBADF.
    expect(() => closeSync(lateClientFd)).toThrowError(/EBADF/);
  });

  it('an ERROR delivered after close() is swallowed without touching any fd', async () => {
    // Kills the `!err` half of the post-stop cleanup guard: when the late
    // accept resolves with an error (not a fd), the cleanup must NOT attempt
    // fs.close on the undefined clientFd.
    let acceptCb;
    const addon = makeAddon({
      vsockAcceptAsync: vi.fn((_fd, cb) => {
        acceptCb = cb;
      }),
    });
    _setAddonForTests(addon);
    const server = createServer(() => {});
    const errors = [];
    server.on('error', (e) => errors.push(e));
    server.listen(5005);
    await wait(10);

    server.close();
    acceptCb(new Error('vsock accept failed: Software caused connection abort'), undefined);
    await wait(20);

    // Swallowed: no error emitted, no re-arm.
    expect(errors).toHaveLength(0);
  });

});

describe('classifyAcceptError buckets (via the live accept loop)', () => {
  function scriptedAddon(steps) {
    let i = 0;
    // makeAddon()'s default vsockBind already returns SENTINEL_LISTEN_FD, so the
    // server.close() in these tests fs.close()es a guaranteed-invalid fd (EBADF).
    const addon = makeAddon();
    addon.calls = 0;
    addon.vsockAcceptAsync = vi.fn((_fd, cb) => {
      addon.calls += 1;
      const step = steps[i++];
      if (!step || step === 'pending') return;
      setImmediate(() => (step.err ? cb(step.err, undefined) : cb(null, step.fd)));
    });
    return addon;
  }

  it('classifies an EINVAL accept error as fatal (loop halts)', async () => {
    const addon = scriptedAddon([
      { err: new Error('vsock accept failed: Invalid argument') },
      'pending',
    ]);
    _setAddonForTests(addon);

    const server = createServer(() => {});
    server.on('error', () => {});
    server.listen(5005);
    await wait(60);

    // Fatal → never re-armed (exactly one accept call).
    expect(addon.calls).toBe(1);
    server.close();
  });

  it('uses err.code in classification even when the message is opaque', async () => {
    // Message is generic; only `.code` says ECONNABORTED → retry bucket. Pins
    // the `${err.code || ''} ${err.message || ''}` text assembly: dropping the
    // code half would misclassify this as retry-delayed (slower) — we assert
    // the FAST re-arm by checking it accepts within the immediate tick window.
    const codeErr = new Error('opaque accept failure');
    codeErr.code = 'ECONNABORTED';
    const { fd: clientFd } = openTempFd();
    const addon = scriptedAddon([{ err: codeErr }, { fd: clientFd }, 'pending']);
    _setAddonForTests(addon);

    const clients = [];
    const server = createServer((c) => clients.push(c));
    server.on('error', () => {});
    server.listen(5005);

    // Immediate retry: by the next macrotask the next connection is accepted.
    await wait(30);
    expect(clients).toHaveLength(1);
    clients.forEach((c) => c.destroy());
    server.close();
  });
});

describe('VsockSocket half-open + read-guard semantics', () => {
  it('keeps the writable side OPEN after the readable side hits EOF (allowHalfOpen:true)', async () => {
    // Kills the `allowHalfOpen: true` -> `false` constructor mutant: with
    // half-open the writable side must survive a peer read-EOF, so the
    // server-side handler can still write its response after the client has
    // finished sending. With `false`, Node auto-ends writable on read-EOF.
    _setAddonForTests(makeAddon());
    const { fd } = openTempFd('peer-bytes');
    const socket = new VsockSocket(fd);

    socket.on('data', () => {});
    const ended = new Promise((resolve) => socket.on('end', resolve));
    socket.resume();
    await ended;
    // One more turn so any auto-finish would have landed.
    await wait(5);

    expect(socket.writable).toBe(true);
    expect(socket.writableEnded).toBe(false);
    socket.destroy();
  });

  it('does not push after destroy() — an in-flight read callback is dropped', async () => {
    // Kills the `_read` close-guard mutants (`if (this._closed) return`): a
    // read callback that lands AFTER destroy() flipped `_closed` must not push
    // bytes / EOF into a torn-down stream (fd-recycle safety).
    _setAddonForTests(makeAddon());
    const { fd } = openTempFd('late-bytes');
    const socket = new VsockSocket(fd);

    const pushed = [];
    socket.on('data', (c) => pushed.push(c));
    let ended = false;
    socket.on('end', () => {
      ended = true;
    });

    socket.resume(); // schedules an fs.read
    socket.destroy(); // flips _closed before the read callback fires
    await wait(20);

    expect(pushed).toHaveLength(0);
    expect(ended).toBe(false);
  });

  it('propagates a write error to the write callback', async () => {
    // Kills the `_write` error branch (`if (err) return callback(err)`): a
    // write to a closed fd must surface EBADF to the caller, not silently
    // succeed.
    _setAddonForTests(makeAddon());
    const { fd } = openTempFd();
    closeSync(fd); // subsequent fs.write(fd) -> EBADF
    const socket = new VsockSocket(fd);
    // A failed _write makes Writable emit 'error' asynchronously; absorb it so
    // it is not an unhandled exception. We assert on the write callback's err.
    socket.on('error', () => {});

    const writeErr = await new Promise((resolve) => {
      socket.write(Buffer.from('x'), (err) => resolve(err));
    });
    expect(writeErr).toBeInstanceOf(Error);
    expect(writeErr.code).toBe('EBADF');
    // Let the async 'error' emit settle inside the absorbing listener.
    await wait(5);
  });
});

describe('requireAddon diagnostics (exact message shape)', () => {
  it('uses the canonical unavailable-addon prefix AND the Linux hint', () => {
    // Kills the prefix/hint string mutants: BOTH halves of the diagnostic must
    // be present so the operator sees what failed and why.
    _setAddonForTests(null, null);
    let msg = '';
    try {
      createServer(() => {});
    } catch (err) {
      msg = err.message;
    }
    expect(msg).toContain('@calypso/vsock-native: native addon not available.');
    expect(msg).toContain('This package only works on Linux with kernel vsock support.');
  });

  it('emits NO trailing cause clause when there is no load error (exact suffix)', () => {
    // Kills the `'' ` (empty cause) -> non-empty mutant: with no load error the
    // message must END exactly at the Linux hint, with no " (load error: …)".
    _setAddonForTests(null, null);
    let msg = '';
    try {
      createServer(() => {});
    } catch (err) {
      msg = err.message;
    }
    expect(msg).toBe(
      '@calypso/vsock-native: native addon not available. ' +
        'This package only works on Linux with kernel vsock support.',
    );
  });

  it('appends the EXACT load-error cause clause when a load error is present', () => {
    _setAddonForTests(null, new Error('ABI mismatch on the prebuilt binary'));
    let msg = '';
    try {
      createServer(() => {});
    } catch (err) {
      msg = err.message;
    }
    expect(msg).toBe(
      '@calypso/vsock-native: native addon not available. ' +
        'This package only works on Linux with kernel vsock support.' +
        ' (load error: ABI mismatch on the prebuilt binary)',
    );
  });
});

describe('createServer connection-event wiring + close state', () => {
  it('registers the handler as a "connection" listener exactly once', () => {
    // Kills the `typeof connectionHandler === 'function'` guard + the
    // 'connection' event-name string: a function handler must be wired to the
    // 'connection' event (net.Server contract).
    _setAddonForTests(makeAddon({ vsockAcceptAsync: vi.fn(() => {}) }));
    const handler = vi.fn();
    const server = createServer(handler);
    expect(server.listenerCount('connection')).toBe(1);
    server.emit('connection', 'fake-socket');
    expect(handler).toHaveBeenCalledWith('fake-socket');
  });

  it('does NOT register a connection listener when the handler is not a function', () => {
    _setAddonForTests(makeAddon());
    const server = createServer(undefined);
    expect(server.listenerCount('connection')).toBe(0);
  });

  it('close() flips stopping so the accept loop does not re-arm afterwards', async () => {
    // Kills `stopping = true` -> false and `acceptLoopRunning = false` -> true:
    // after close(), an accept callback that fires must hit the stopping guard
    // and NOT re-arm vsockAcceptAsync.
    let acceptCb;
    const addon = makeAddon({
      vsockAcceptAsync: vi.fn((_fd, cb) => {
        acceptCb = cb;
      }),
    });
    _setAddonForTests(addon);
    const server = createServer(() => {});
    server.listen(5005);
    await wait(10);
    const callsBeforeClose = addon.vsockAcceptAsync.mock.calls.length;

    server.close();
    // An accept that resolves with an error after close must be swallowed,
    // never re-arming the loop.
    acceptCb(new Error('vsock accept failed: Software caused connection abort'), undefined);
    await wait(20);

    expect(addon.vsockAcceptAsync.mock.calls.length).toBe(callsBeforeClose);
  });

  it('close() resets listenFd to -1 so a second close() takes the no-fd branch (covered indirectly)', async () => {
    // Kills `listenFd = -1` -> `+1`: after the first close resets the fd, a
    // second close() must NOT try to shutdown/close a (stale or recycled) fd.
    const { fd: listenFd } = openTempFd();
    const addon = makeAddon({
      vsockBind: vi.fn(() => listenFd),
      vsockAcceptAsync: vi.fn(() => {}),
    });
    _setAddonForTests(addon);
    const server = createServer(() => {});
    server.listen(5005);
    await wait(10);

    await new Promise((resolve) => server.close(() => resolve()));
    const shutdownCallsAfterFirst = addon.vsockShutdown.mock.calls.length;

    // Second close: listenFd is now -1, so the no-fd branch runs (callback via
    // nextTick, no extra shutdown).
    const secondCbErr = await new Promise((resolve) => server.close((err) => resolve(err)));
    expect(secondCbErr).toBeUndefined();
    expect(addon.vsockShutdown.mock.calls.length).toBe(shutdownCallsAfterFirst);
  });
});

describe('_classifyAcceptError (direct, pinning every bucket + the text source)', () => {
  it('classifies the FATAL buckets (dead listen fd) by code OR message', () => {
    expect(_classifyAcceptError({ code: 'EBADF' })).toBe('fatal');
    expect(
      _classifyAcceptError({ message: 'vsock accept failed: Bad file descriptor' }),
    ).toBe('fatal');
    expect(_classifyAcceptError({ code: 'EINVAL' })).toBe('fatal');
    expect(
      _classifyAcceptError({ message: 'vsock accept failed: Invalid argument' }),
    ).toBe('fatal');
  });

  it('classifies the IMMEDIATE-RETRY buckets (transient) by code OR message', () => {
    expect(_classifyAcceptError({ code: 'ECONNABORTED' })).toBe('retry');
    expect(
      _classifyAcceptError({ message: 'vsock accept failed: Software caused connection abort' }),
    ).toBe('retry');
    expect(_classifyAcceptError({ code: 'EINTR' })).toBe('retry');
    expect(
      _classifyAcceptError({ message: 'vsock accept failed: Interrupted system call' }),
    ).toBe('retry');
  });

  it('classifies fd-pressure / unknown as RETRY-DELAYED (back off, never die)', () => {
    expect(_classifyAcceptError({ code: 'EMFILE' })).toBe('retry-delayed');
    expect(_classifyAcceptError({ code: 'ENFILE' })).toBe('retry-delayed');
    expect(_classifyAcceptError({ code: 'ENOMEM' })).toBe('retry-delayed');
    expect(_classifyAcceptError({ message: 'totally unrecognised failure' })).toBe(
      'retry-delayed',
    );
  });

  it('reads BOTH the code and the message when assembling the match text', () => {
    // Kills the `${err.code || ''} ${err.message || ''}` mutants: a fatal
    // signal carried ONLY in the message (no code) must still be fatal, and a
    // fatal signal carried ONLY in the code (opaque message) must still be
    // fatal — proving each half of the text is consulted.
    expect(
      _classifyAcceptError({ code: undefined, message: 'vsock accept failed: Bad file descriptor' }),
    ).toBe('fatal');
    expect(_classifyAcceptError({ code: 'EBADF', message: undefined })).toBe('fatal');
    // The `|| ''` fallbacks must not let a totally-empty error crash or
    // misclassify — an empty error is unknown → delayed retry, not fatal.
    expect(_classifyAcceptError({})).toBe('retry-delayed');
  });

  it('prefers fatal over retry when (hypothetically) both could match — order matters', () => {
    // FATAL is checked first; a message containing both an EINVAL and an
    // ECONNABORTED token must resolve fatal (the listen fd is gone, so do not
    // hot-retry a dead fd).
    expect(
      _classifyAcceptError({
        message: 'vsock accept failed: Invalid argument after connection abort',
      }),
    ).toBe('fatal');
  });
});

describe('setTimeout timer hygiene', () => {
  it('re-arming setTimeout clears the previous one-shot timer (no double fire)', async () => {
    // Kills the pre-clear guard `if (this._timeoutTimer) clearTimeout(...)`:
    // two setTimeout calls must leave exactly ONE armed timer, not two.
    _setAddonForTests(makeAddon());
    const { fd } = openTempFd();
    const socket = new VsockSocket(fd);

    let fires = 0;
    socket.on('timeout', () => (fires += 1));
    socket.setTimeout(20);
    socket.setTimeout(20); // must clear the first before arming the second

    await wait(70);
    expect(fires).toBe(1);
    socket.destroy();
  });
});
