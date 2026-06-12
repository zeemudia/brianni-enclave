/**
 * H2 / L1 / L2 error-handling-audit regressions for the JS wrapper.
 *
 * Uses `_setAddonForTests` to stub the native addon so non-Linux CI can
 * exercise the accept-loop wiring without a real AF_VSOCK fd.
 *
 * NOTE: the native AcceptWorker reports errors as
 * `Error("vsock accept failed: " + strerror(errno))` WITHOUT a `.code`
 * property, so the wrapper classifies by message text too — both shapes
 * are covered below.
 */
import { describe, it, expect, afterEach } from 'vitest';
import vsock from '../index.js';

const { createServer, VsockSocket, _setAddonForTests } = vsock;

// Deliberately far outside any real fd range: fs.close() on these must
// EBADF (never close a live fd of the test process).
const FAKE_LISTEN_FD = 2147483600;
const FAKE_CLIENT_FD_BASE = 2147483500;

function makeStubAddon(acceptScript) {
  // acceptScript: array of { err } | { fd } | 'pending'. Each call to
  // vsockAcceptAsync consumes the next entry; 'pending' (or exhaustion)
  // never invokes the callback — modelling a blocked accept(2).
  let scriptIndex = 0;
  const stub = {
    acceptCalls: 0,
    vsockBind: () => FAKE_LISTEN_FD,
    vsockConnect: () => FAKE_CLIENT_FD_BASE,
    vsockShutdown: () => {},
    vsockAcceptAsync: (fd, cb) => {
      stub.acceptCalls += 1;
      const step = acceptScript[scriptIndex];
      scriptIndex += 1;
      if (step === undefined || step === 'pending') return;
      // Deliver asynchronously like the real AsyncWorker.
      setImmediate(() => {
        if (step.err) cb(step.err, undefined);
        else cb(null, step.fd);
      });
    },
  };
  return stub;
}

function errWithCode(code, message) {
  const err = new Error(message ?? `vsock accept failed: ${code}`);
  if (code) err.code = code;
  return err;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  _setAddonForTests(null);
});

describe('H2: accept loop resilience', () => {
  it('re-arms after a transient ECONNABORTED and accepts the next connection', async () => {
    const stub = makeStubAddon([
      { err: errWithCode('ECONNABORTED') },
      { fd: FAKE_CLIENT_FD_BASE + 1 },
      'pending',
    ]);
    _setAddonForTests(stub);

    const clients = [];
    const errors = [];
    const server = createServer((client) => clients.push(client));
    server.on('error', (err) => errors.push(err));
    server.listen(5005);

    await wait(50);

    expect(errors).toHaveLength(1);
    expect(clients).toHaveLength(1); // loop survived the transient error
    expect(stub.acceptCalls).toBe(3); // err → retry → connection → pending
    clients.forEach((c) => c.destroy());
  });

  it('re-arms on the native error shape (message text, no .code property)', async () => {
    const stub = makeStubAddon([
      { err: new Error('vsock accept failed: Software caused connection abort') },
      { fd: FAKE_CLIENT_FD_BASE + 2 },
      'pending',
    ]);
    _setAddonForTests(stub);

    const clients = [];
    const server = createServer((client) => clients.push(client));
    server.on('error', () => {});
    server.listen(5005);

    await wait(50);

    expect(clients).toHaveLength(1);
    clients.forEach((c) => c.destroy());
  });

  it('retries EMFILE after a delay instead of dying (and instead of hot-looping)', async () => {
    const stub = makeStubAddon([
      { err: errWithCode('EMFILE', 'vsock accept failed: Too many open files') },
      { fd: FAKE_CLIENT_FD_BASE + 3 },
      'pending',
    ]);
    _setAddonForTests(stub);

    const clients = [];
    const server = createServer((client) => clients.push(client));
    server.on('error', () => {});
    server.listen(5005);

    // Before the retry delay elapses the loop must NOT have re-armed.
    await wait(20);
    expect(stub.acceptCalls).toBe(1);

    // After the delay it re-arms and accepts.
    await wait(200);
    expect(clients).toHaveLength(1);
    clients.forEach((c) => c.destroy());
  });

  it('halts permanently on EBADF (listen fd dead)', async () => {
    const stub = makeStubAddon([
      { err: new Error('vsock accept failed: Bad file descriptor') },
      { fd: FAKE_CLIENT_FD_BASE + 4 },
      'pending',
    ]);
    _setAddonForTests(stub);

    const clients = [];
    const errors = [];
    const server = createServer((client) => clients.push(client));
    server.on('error', (err) => errors.push(err));
    server.listen(5005);

    await wait(250);

    expect(errors).toHaveLength(1);
    expect(clients).toHaveLength(0);
    expect(stub.acceptCalls).toBe(1); // never re-armed
  });

  it('a throwing connectionHandler destroys that client and keeps accepting', async () => {
    const stub = makeStubAddon([
      { fd: FAKE_CLIENT_FD_BASE + 5 },
      { fd: FAKE_CLIENT_FD_BASE + 6 },
      'pending',
    ]);
    _setAddonForTests(stub);

    const clients = [];
    const errors = [];
    let calls = 0;
    const server = createServer((client) => {
      calls += 1;
      clients.push(client);
      if (calls === 1) throw new Error('handler boom');
    });
    server.on('error', (err) => errors.push(err));
    server.listen(5005);

    await wait(50);

    expect(calls).toBe(2); // loop survived the throwing handler
    expect(errors.map((e) => e.message)).toContain('handler boom');
    expect(clients[0].destroyed).toBe(true); // failed client not leaked
    expect(clients[1].destroyed).toBe(false);
    clients[1].destroy();
  });
});

describe('L1: addon load failure diagnostics', () => {
  it('requireAddon surfaces the original load error when the addon is unavailable', () => {
    _setAddonForTests(null, new Error('No native build was found for platform=fake'));
    let thrown;
    try {
      createServer(() => {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toMatch(/only works on Linux/);
    // The root cause must be appended, not discarded.
    expect(thrown.message).toMatch(/load error: No native build was found/);
  });

  it('omits the load-error suffix when there was no load error', () => {
    _setAddonForTests(null, null);
    let thrown;
    try {
      createServer(() => {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown.message).toMatch(/only works on Linux/);
    expect(thrown.message).not.toMatch(/load error:/);
  });
});

describe('L2: VsockSocket stream error handling', () => {
  it('surfaces EBADF as a stream error when the socket is NOT closed', async () => {
    const stub = makeStubAddon(['pending']);
    _setAddonForTests(stub);

    // fs.read on this fd yields EBADF while _closed === false — the old
    // code swallowed it (stream silently stopped: no EOF, no error).
    const socket = new VsockSocket(FAKE_CLIENT_FD_BASE + 7);
    const errPromise = new Promise((resolve) => socket.on('error', resolve));
    socket.resume(); // trigger _read

    const err = await errPromise;
    expect(err.code).toBe('EBADF');
  });

  it('clears the setTimeout timer on destroy', () => {
    const stub = makeStubAddon(['pending']);
    _setAddonForTests(stub);

    const socket = new VsockSocket(FAKE_CLIENT_FD_BASE + 8);
    let fired = false;
    socket.setTimeout(30, () => {
      fired = true;
    });
    socket.destroy();

    return wait(80).then(() => {
      expect(fired).toBe(false);
      expect(socket._timeoutTimer).toBeFalsy();
    });
  });
});
