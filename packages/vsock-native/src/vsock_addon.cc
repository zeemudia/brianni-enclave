/**
 * N-API addon for AF_VSOCK (Linux Nitro Enclaves).
 *
 * Provides two functions:
 *   vsockConnect(cid, port) → fd    — connect to an enclave
 *   vsockBind(port)         → fd    — listen for connections (inside an enclave)
 *
 * The returned file descriptor is passed to Node.js net.Socket({ fd })
 * for a Socket-compatible stream interface.
 *
 * This only compiles on Linux with kernel vsock support (CONFIG_VSOCKETS).
 * On macOS / non-Linux, install silently fails (see package.json "install" script).
 */

#include <napi.h>

#ifdef __linux__
#include <sys/socket.h>
#include <linux/vm_sockets.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>

/**
 * vsockConnect(cid: number, port: number) → number (fd)
 *
 * Creates an AF_VSOCK socket and connects to the given CID:port.
 * Returns the raw file descriptor for wrapping in net.Socket.
 */
Napi::Value VsockConnect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "Expected (cid: number, port: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t cid = info[0].As<Napi::Number>().Uint32Value();
  uint32_t port = info[1].As<Napi::Number>().Uint32Value();

  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) {
    Napi::Error::New(env, std::string("socket(AF_VSOCK) failed: ") + strerror(errno))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  struct sockaddr_vm addr;
  memset(&addr, 0, sizeof(addr));
  addr.svm_family = AF_VSOCK;
  addr.svm_cid = cid;
  addr.svm_port = port;

  if (connect(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
    int err = errno;
    close(fd);
    Napi::Error::New(env, std::string("vsock connect failed: ") + strerror(err))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return Napi::Number::New(env, fd);
}

/**
 * vsockBind(port: number) → number (fd)
 *
 * Creates an AF_VSOCK socket, binds to VMADDR_CID_ANY:port, and listens.
 * Returns the listening fd for use with accept().
 *
 * Inside a Nitro Enclave, CID_ANY means the enclave's own CID.
 * The parent EC2 instance connects via the enclave's assigned CID.
 */
Napi::Value VsockBind(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected (port: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t port = info[0].As<Napi::Number>().Uint32Value();

  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) {
    Napi::Error::New(env, std::string("socket(AF_VSOCK) failed: ") + strerror(errno))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  struct sockaddr_vm addr;
  memset(&addr, 0, sizeof(addr));
  addr.svm_family = AF_VSOCK;
  addr.svm_cid = VMADDR_CID_ANY;
  addr.svm_port = port;

  if (bind(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
    int err = errno;
    close(fd);
    Napi::Error::New(env, std::string("vsock bind failed: ") + strerror(err))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (listen(fd, 128) < 0) {
    int err = errno;
    close(fd);
    Napi::Error::New(env, std::string("vsock listen failed: ") + strerror(err))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return Napi::Number::New(env, fd);
}

/**
 * vsockAccept(serverFd: number) → number (clientFd)
 *
 * Accepts a connection on a listening vsock fd.
 * Returns the client connection fd.
 */
Napi::Value VsockAccept(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected (serverFd: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  int serverFd = info[0].As<Napi::Number>().Int32Value();

  struct sockaddr_vm addr;
  socklen_t addrLen = sizeof(addr);
  int clientFd = accept(serverFd, reinterpret_cast<struct sockaddr*>(&addr), &addrLen);

  if (clientFd < 0) {
    Napi::Error::New(env, std::string("vsock accept failed: ") + strerror(errno))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return Napi::Number::New(env, clientFd);
}

/**
 * vsockAcceptAsync(serverFd: number, callback: (err, fd) => void)
 *
 * Non-blocking variant of VsockAccept. Runs the blocking accept() on a libuv
 * worker thread so the JS main thread stays free to dispatch data events on
 * already-accepted sockets. Without this, the server would wedge after the
 * first client connects: accept() blocks main, VsockSocket _read/_write
 * callbacks need main to fire, so inbound pings never get processed.
 */
class AcceptWorker : public Napi::AsyncWorker {
 public:
  AcceptWorker(Napi::Function& callback, int serverFd)
      : Napi::AsyncWorker(callback), serverFd_(serverFd), clientFd_(-1),
        savedErrno_(0) {}

  void Execute() override {
    struct sockaddr_vm addr;
    socklen_t addrLen = sizeof(addr);
    clientFd_ = accept(serverFd_, reinterpret_cast<struct sockaddr*>(&addr),
                       &addrLen);
    if (clientFd_ < 0) {
      savedErrno_ = errno;
      SetError(std::string("vsock accept failed: ") + strerror(savedErrno_));
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Callback().Call({env.Null(), Napi::Number::New(env, clientFd_)});
  }

  void OnError(const Napi::Error& err) override {
    Napi::Env env = Env();
    Callback().Call({err.Value(), env.Undefined()});
  }

 private:
  int serverFd_;
  int clientFd_;
  int savedErrno_;
};

Napi::Value VsockAcceptAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "Expected (serverFd: number, cb: function)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  int serverFd = info[0].As<Napi::Number>().Int32Value();
  Napi::Function cb = info[1].As<Napi::Function>();
  AcceptWorker* worker = new AcceptWorker(cb, serverFd);
  worker->Queue();
  return env.Undefined();
}

/**
 * vsockShutdown(fd: number, how: number) → undefined
 *
 * Calls shutdown(fd, how) on an AF_VSOCK fd. Used by the JS Duplex wrapper
 * to signal half-close when the writable side ends, so peers that read
 * to EOF (e.g. HTTP-over-TLS to KMS) see the request terminated.
 *
 * how: 0 (SHUT_RD), 1 (SHUT_WR), 2 (SHUT_RDWR).
 */
Napi::Value VsockShutdown(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "Expected (fd: number, how: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  int fd = info[0].As<Napi::Number>().Int32Value();
  int how = info[1].As<Napi::Number>().Int32Value();

  if (shutdown(fd, how) < 0) {
    int err = errno;
    // ENOTCONN after peer close is not a real error — treat as no-op.
    if (err != ENOTCONN) {
      Napi::Error::New(env, std::string("vsock shutdown failed: ") + strerror(err))
          .ThrowAsJavaScriptException();
    }
  }
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("vsockConnect", Napi::Function::New(env, VsockConnect));
  exports.Set("vsockBind", Napi::Function::New(env, VsockBind));
  exports.Set("vsockAccept", Napi::Function::New(env, VsockAccept));
  exports.Set("vsockAcceptAsync", Napi::Function::New(env, VsockAcceptAsync));
  exports.Set("vsockShutdown", Napi::Function::New(env, VsockShutdown));
  return exports;
}

NODE_API_MODULE(vsock_native, Init)

#else
// Non-Linux stub — throws at runtime if called
Napi::Value NotAvailable(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), "vsock is only available on Linux with kernel vsock support")
      .ThrowAsJavaScriptException();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("vsockConnect", Napi::Function::New(env, NotAvailable));
  exports.Set("vsockBind", Napi::Function::New(env, NotAvailable));
  exports.Set("vsockAccept", Napi::Function::New(env, NotAvailable));
  exports.Set("vsockAcceptAsync", Napi::Function::New(env, NotAvailable));
  exports.Set("vsockShutdown", Napi::Function::New(env, NotAvailable));
  return exports;
}

NODE_API_MODULE(vsock_native, Init)
#endif
