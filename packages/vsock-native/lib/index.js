/**
 * AF_VSOCK JavaScript wrapper.
 *
 * Node 22's `new net.Socket({ fd })` rejects AF_VSOCK fds with
 * ERR_INVALID_FD_TYPE because libuv's uv_guess_handle returns UNKNOWN for
 * non-AF_INET/AF_UNIX sockets. We avoid that path by wrapping the raw fd
 * in a stream.Duplex that does async I/O via fs.read / fs.write — which
 * accept any POSIX fd, AF_VSOCK included.
 *
 * Trade-off: fs.read blocks a libuv thread-pool slot while waiting for
 * bytes, so this is not suited for high fan-out. Enclave use (single KMS
 * call at boot + low-concurrency chat bridge) is well within budget.
 */
const { Duplex } = require('node:stream');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const SHUT_WR = 1;
const SHUT_RDWR = 2;
const READ_CHUNK = 64 * 1024;

let addon;
// L1 error-handling-audit — keep the original load error instead of
// discarding the root cause (an ABI mismatch on Linux looks identical to
// "not Linux" without it).
let addonLoadError = null;
try {
  addon = require('node-gyp-build')(path.join(__dirname, '..'));
} catch (err) {
  addon = null;
  addonLoadError = err;
}

function requireAddon() {
  if (!addon) {
    const cause = addonLoadError
      ? ` (load error: ${addonLoadError.message})`
      : '';
    throw new Error(
      '@calypso/vsock-native: native addon not available. ' +
      'This package only works on Linux with kernel vsock support.' +
      cause
    );
  }
  return addon;
}

/**
 * Test-only: override the native addon with a stub so non-Linux CI can
 * exercise the JS wiring (accept-loop, handler dispatch) without opening a
 * real AF_VSOCK fd. The optional second argument injects a fake load
 * error so the requireAddon() diagnostic path is testable regardless of
 * whether the host's real addon loaded. Do NOT call this from production
 * code.
 */
function _setAddonForTests(override, loadError = null) {
  addon = override;
  addonLoadError = loadError;
}

/**
 * Duplex stream wrapping an AF_VSOCK fd.
 *
 * - _read: queues an fs.read; pushes bytes or EOF into the readable side.
 * - _write: fs.write of the entire chunk (handles short writes).
 * - _final: half-closes the writable side so peers that read-to-EOF see the
 *   request terminated. This matches net.Socket#end() semantics.
 * - _destroy: shutdown RDWR then fs.close. Swallows EBADF/ENOTCONN since
 *   those simply mean the peer already closed.
 */
class VsockSocket extends Duplex {
  constructor(fd) {
    super({ allowHalfOpen: true });
    this._fd = fd;
    this._closed = false;
  }

  _read(/* size */) {
    if (this._closed) return;
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    fs.read(this._fd, buf, 0, buf.length, null, (err, bytesRead) => {
      // EBADF after our own destroy() is expected — the `_closed` guard
      // here is what swallows it (destroy() sets `_closed` synchronously
      // BEFORE shutdown/close, so any late read callback lands after it).
      //
      // fd-race design constraint: between fs.close() and this callback
      // the kernel may recycle the fd number for an unrelated handle. We
      // cannot dup/lock the fd from JS, so the `_closed` flag is the only
      // guard — never issue a new fs.read after `_closed` flips (the
      // guard at the top of _read enforces this).
      if (this._closed) return;
      if (err) {
        // L2 error-handling-audit — an EBADF while NOT closed means the
        // fd died under us; the old unconditional swallow made the stream
        // silently stop (no EOF, no error). Surface every error here.
        this.destroy(err);
        return;
      }
      if (bytesRead === 0) {
        this.push(null); // EOF from peer
        return;
      }
      this.push(buf.subarray(0, bytesRead));
    });
  }

  _write(chunk, encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    let offset = 0;
    const writeNext = () => {
      if (offset >= buf.length) return callback();
      fs.write(this._fd, buf, offset, buf.length - offset, null, (err, written) => {
        if (err) return callback(err);
        offset += written;
        writeNext();
      });
    };
    writeNext();
  }

  _final(callback) {
    try {
      requireAddon().vsockShutdown(this._fd, SHUT_WR);
    } catch (err) {
      // Best-effort half-close; surface only unexpected failures.
      return callback(err);
    }
    callback();
  }

  _destroy(err, callback) {
    if (this._closed) return callback(err);
    this._closed = true;
    // L2 error-handling-audit — drop the timeout timer so a destroyed
    // socket cannot fire a late 'timeout' (and the timer doesn't leak).
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
    try { requireAddon().vsockShutdown(this._fd, SHUT_RDWR); } catch {}
    fs.close(this._fd, (closeErr) => {
      // Suppress expected-close errors when we're already in an error path.
      if (closeErr && closeErr.code !== 'EBADF' && !err) return callback(closeErr);
      callback(err);
    });
  }

  // net.Socket-compat no-op. AF_VSOCK has no Nagle.
  setNoDelay() { return this; }
  // net.Socket-compat: keepalive is meaningless on vsock; no-op.
  setKeepAlive() { return this; }
  setTimeout(ms, cb) {
    // Duplex doesn't implement timeouts natively — wire one up manually.
    // NOTE: unlike net.Socket's inactivity timeout, this is a ONE-SHOT
    // timer from the moment of the call; it is NOT reset by read/write
    // activity. No current caller uses it (net.Socket-compat shim); if a
    // caller ever needs true inactivity semantics, reset the timer from
    // _read/_write. Cleared on _destroy.
    if (this._timeoutTimer) { clearTimeout(this._timeoutTimer); this._timeoutTimer = null; }
    if (ms > 0) {
      this._timeoutTimer = setTimeout(() => this.emit('timeout'), ms);
      this._timeoutTimer.unref?.();
    }
    if (cb) this.once('timeout', cb);
    return this;
  }
}

/**
 * Connect to a vsock endpoint and return a Duplex stream.
 *
 * @param {number} port - vsock port
 * @param {number} cid  - vsock CID (3 = parent EC2 from inside the enclave;
 *                        enclave's describe-enclaves CID from the parent)
 * @returns {VsockSocket}
 */
function connect(port, cid) {
  const native = requireAddon();
  const fd = native.vsockConnect(cid, port);
  return new VsockSocket(fd);
}

// H2 error-handling-audit — accept-loop error classification.
//
// accept(2) fails transiently (ECONNABORTED: peer aborted mid-handshake,
// EINTR: signal, EMFILE/ENFILE: fd exhaustion); the old loop terminated
// PERMANENTLY on the first error of any kind, leaving the enclave deaf
// until restart. Only a dead listen fd (EBADF/EINVAL, or close()) should
// halt the loop.
//
// The native AcceptWorker reports `Error("vsock accept failed: " +
// strerror(errno))` WITHOUT a `.code` property, so classification matches
// the glibc strerror text as well as `.code` (the enclave runs a fixed
// glibc image in the C locale, so the text is deterministic).
const ACCEPT_RETRY_DELAY_MS = 100;
const FATAL_ACCEPT_PATTERNS = [
  /\bEBADF\b/,
  /Bad file descriptor/i,
  /\bEINVAL\b/,
  /Invalid argument/i,
];
const IMMEDIATE_RETRY_ACCEPT_PATTERNS = [
  /\bECONNABORTED\b/,
  /connection abort/i,
  /\bEINTR\b/,
  /Interrupted system call/i,
];

function classifyAcceptError(err) {
  // The only call site is inside `if (err)`, so err is always truthy here.
  const text = `${err.code || ''} ${err.message || ''}`;
  if (FATAL_ACCEPT_PATTERNS.some((re) => re.test(text))) return 'fatal';
  if (IMMEDIATE_RETRY_ACCEPT_PATTERNS.some((re) => re.test(text))) {
    return 'retry';
  }
  // EMFILE/ENFILE/ENOMEM/ENOBUFS/unknown: retry after a short delay so a
  // persistent condition backs off instead of hot-looping the error path,
  // while fd-pressure recovery (peers disconnecting) re-arms the server.
  return 'retry-delayed';
}

/**
 * Create a vsock server. Listens on VMADDR_CID_ANY:port inside the enclave.
 *
 * Implements net.Server's surface on top of a native accept-loop: each
 * accepted client fd is wrapped in a VsockSocket and delivered to the
 * connection handler, matching net.Server's 'connection' event contract.
 */
function createServer(connectionHandler) {
  const native = requireAddon();
  const server = new EventEmitter();
  let listenFd = -1;
  let acceptLoopRunning = false;
  let stopping = false;

  server.listen = function vsockListen(port, callback) {
    try {
      listenFd = native.vsockBind(port);
    } catch (err) {
      if (callback) process.nextTick(() => callback(err));
      process.nextTick(() => server.emit('error', err));
      return server;
    }
    acceptLoopRunning = true;
    // Accept runs on a libuv thread-pool worker via AsyncWorker so the JS
    // main thread stays free to dispatch data events on accepted sockets.
    // A blocking accept() on main would freeze every callback that needs
    // the event loop (VsockSocket _read/_write, promise continuations, …).
    const acceptLoop = () => {
      if (stopping || !acceptLoopRunning) return;
      native.vsockAcceptAsync(listenFd, (err, clientFd) => {
        if (stopping || !acceptLoopRunning) {
          if (!err && typeof clientFd === 'number') fs.close(clientFd, () => {});
          return;
        }
        if (err) {
          // H2 error-handling-audit — re-arm on transient errors; halt
          // only when the listen fd is dead. Re-arm BEFORE emitting:
          // with no 'error' listener attached, emit() throws (standard
          // EventEmitter contract) into the N-API callback context and
          // would otherwise also kill the loop.
          const action = classifyAcceptError(err);
          if (action === 'retry') {
            acceptLoop();
          } else if (action === 'retry-delayed') {
            const timer = setTimeout(acceptLoop, ACCEPT_RETRY_DELAY_MS);
            if (typeof timer.unref === 'function') timer.unref();
          }
          server.emit('error', err);
          return;
        }
        const client = new VsockSocket(clientFd);
        // H2 — a synchronously-throwing connection handler must not kill
        // the accept loop nor leak the client fd.
        let handlerError = null;
        try {
          connectionHandler(client);
        } catch (e) {
          handlerError = e;
          try { client.destroy(); } catch {}
        }
        acceptLoop();
        if (handlerError) server.emit('error', handlerError);
      });
    };
    acceptLoop();
    if (callback) process.nextTick(callback);
    process.nextTick(() => server.emit('listening'));
    return server;
  };

  server.close = function vsockClose(callback) {
    stopping = true;
    acceptLoopRunning = false;
    if (listenFd >= 0) {
      try { native.vsockShutdown(listenFd, SHUT_RDWR); } catch {}
      fs.close(listenFd, (err) => {
        listenFd = -1;
        if (callback) callback(err);
        server.emit('close');
      });
    } else if (callback) {
      process.nextTick(callback);
    }
    return server;
  };

  server.address = () => ({ port: 0, family: 'vsock', address: 'vsock' });

  if (typeof connectionHandler === 'function') {
    server.on('connection', connectionHandler);
  }

  return server;
}

module.exports = {
  connect,
  createServer,
  VsockSocket,
  _setAddonForTests,
  // Test seam: the accept-error classifier is the load-bearing decision for
  // whether a failed accept(2) halts the enclave's listener (fatal) or re-arms
  // it (retry / retry-delayed). Exported so its fatal/retry/delayed buckets and
  // the code+message text assembly can be pinned directly, rather than only
  // observed indirectly through accept-loop timing. Not for production use.
  _classifyAcceptError: classifyAcceptError,
};
