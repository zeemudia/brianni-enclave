/**
 * Regression tests for @calypso/vsock-native.
 *
 * Bug 1 (commit e51fda4): `vsockAccept` was a blocking syscall scheduled on
 * the main thread. After the first client connected, main blocked inside the
 * next `accept()`, so every subsequent callback on already-accepted sockets
 * (VsockSocket _read/_write) stalled and every server->enclave ping timed
 * out at 3s. The fix: `vsockAcceptAsync` on a libuv AsyncWorker.
 *
 * The native addon is Linux-only and not compiled on macOS, so these tests
 * never open a real AF_VSOCK socket. We exercise the JS wrapper via the
 * `_setAddonForTests` injection hook.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vsockNative = require('../index.js');

const { connect, createServer, _setAddonForTests } = vsockNative as {
  connect: (port: number, cid: number) => unknown;
  createServer: (handler?: (socket: unknown) => void) => {
    listen: (port: number, cb?: () => void) => EventEmitter & { close: (cb?: () => void) => unknown };
  };
  _setAddonForTests: (addon: unknown) => void;
};

function makeMockAddon() {
  return {
    vsockConnect: vi.fn(() => 42),
    vsockBind: vi.fn(() => 7),
    // Intentionally keep a spy on the legacy sync accept so tests can assert
    // the JS layer does NOT call it (would reintroduce the main-thread block).
    vsockAccept: vi.fn(),
    // Async variant: invoke callback with a fake clientFd once, then never
    // again (prevents the accept-loop from racing the test's assertions).
    vsockAcceptAsync: vi.fn((_listenFd: number, cb: (err: Error | null, fd: number) => void) => {
      // Dispatch async so the JS loop has a chance to wire `connectionHandler`
      // before the mock clientFd lands.
      setImmediate(() => cb(null, 99));
    }),
    vsockShutdown: vi.fn(),
  };
}

afterEach(() => {
  // Restore default discovery after each test so one failing test doesn't
  // poison neighbours.
  _setAddonForTests(null);
});

describe('vsock-native — stub path (macOS / non-Linux)', () => {
  it('connect() throws when the native addon is unavailable', () => {
    _setAddonForTests(null);
    expect(() => connect(1234, 3)).toThrowError(/only works on Linux/i);
  });

  it('createServer() throws when the native addon is unavailable', () => {
    // createServer calls requireAddon() synchronously before returning, so
    // the throw propagates to the caller rather than being deferred to a
    // server.emit('error'). Regression signal: if the throw stops happening,
    // server.listen() would silently do nothing on macOS dev machines.
    _setAddonForTests(null);
    expect(() => createServer(() => {})).toThrowError(/only works on Linux/i);
  });
});

describe('vsock-native — accept loop uses async worker (Bug 1 regression)', () => {
  it('createServer().listen() calls vsockAcceptAsync, NOT the sync vsockAccept', async () => {
    const addon = makeMockAddon();
    _setAddonForTests(addon);

    const connections: unknown[] = [];
    const server = createServer((client) => connections.push(client));
    server.listen(5000);

    // Give the accept-loop a tick to dispatch.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(addon.vsockBind).toHaveBeenCalledWith(5000);
    expect(addon.vsockAcceptAsync).toHaveBeenCalled();
    expect(addon.vsockAccept).not.toHaveBeenCalled();

    // Clean shutdown so vitest doesn't hang on pending timers / loops.
    (server as unknown as { close: (cb?: () => void) => void }).close();
  });

  it('accepted connections are wrapped and delivered to the handler', async () => {
    const addon = makeMockAddon();
    _setAddonForTests(addon);

    const received: unknown[] = [];
    const server = createServer((client) => received.push(client));
    server.listen(5000);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(received.length).toBeGreaterThanOrEqual(1);
    (server as unknown as { close: (cb?: () => void) => void }).close();
  });

  it('accepted server-side sockets stay half-open after peer EOF', async () => {
    const addon = makeMockAddon();
    _setAddonForTests(addon);

    const received: Array<{ allowHalfOpen?: boolean }> = [];
    const server = createServer((client) =>
      received.push(client as { allowHalfOpen?: boolean }),
    );
    server.listen(5000);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].allowHalfOpen).toBe(true);
    (server as unknown as { close: (cb?: () => void) => void }).close();
  });

  it('exports vsockAcceptAsync on the native addon surface', () => {
    // Sanity check on the mock contract — if someone renames this export in
    // the .cc addon, node-gyp-build will still load the module but the JS
    // wrapper would throw `TypeError: native.vsockAcceptAsync is not a function`.
    const addon = makeMockAddon();
    _setAddonForTests(addon);
    expect(typeof addon.vsockAcceptAsync).toBe('function');
  });
});
