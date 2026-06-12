/**
 * NSM (Nitro Secure Module) attestation interface.
 *
 * On Nitro Enclaves: talks to /dev/nsm via a long-running `python3
 * nsm_helper.py --daemon` sidecar. The sidecar is spawned once at enclave
 * boot; per-request cost is a line-framed JSON round-trip on stdin/stdout,
 * not a fresh `fork(2)` + Python interpreter cold-start. This follows the
 * long-running line-framed JSON sidecar pattern and eliminates the
 * fork-pressure regression that wedged
 * `tests/integration/nitro/vsock-bridge-load.test.ts` at LOAD=50 on
 * 2026-04-19.
 *
 * On local dev (no /dev/nsm): returns a development-only placeholder.
 * Tests and local dev never have NSM hardware, so this is expected.
 */
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const NSM_DEVICE = '/dev/nsm';
const isNitroEnclave = existsSync(NSM_DEVICE);
const NSM_START_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 4096;
const READY_LINE = 'NSM_READY';

export interface NSMAttestationResult {
  /** Base64-encoded COSE_Sign1 attestation document */
  attestationDoc: string;
  /** PCR measurements from the attestation document */
  pcrs: {
    PCR0: string;
    PCR1: string;
    PCR2: string;
  };
}

// ---------------------------------------------------------------------------
// Long-running helper daemon
// ---------------------------------------------------------------------------

interface DaemonResponse {
  status: 'ok' | 'error';
  error?: string;
  attestation_doc?: string;
  pcrs?: { PCR0: string; PCR1: string; PCR2: string };
}

export class NsmSidecar {
  private process: ChildProcess | null = null;
  private ready = false;
  // Serialises stdin writes so multiple in-flight requests cannot interleave.
  private queue: Promise<void> = Promise.resolve();
  private pendingResolve: ((r: NSMAttestationResult) => void) | null = null;
  private pendingReject: ((e: Error) => void) | null = null;
  private buffer = '';
  private stderrTail = '';

  async start(): Promise<void> {
    if (this.process && this.ready) return;
    if (this.process) this.stop();

    const scriptPath = pathTo('nsm_helper.py');
    const child = spawn('python3', [scriptPath, '--daemon'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    this.ready = false;
    this.buffer = '';
    this.stderrTail = '';

    child.stderr!.on('data', this.onStderr);

    await new Promise<void>((resolve, reject) => {
      let startupStdout = '';
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout!.off('data', onReady);
        child.off('error', onError);
        child.off('exit', onExit);
        fn();
      };

      const onReady = (data: Buffer) => {
        startupStdout += data.toString();
        if (!startupStdout.includes(READY_LINE)) return;
        settle(() => {
          this.ready = true;
          child.stdout!.on('data', this.onData);
          resolve();
        });
      };
      const onError = (error: Error) => {
        settle(() => {
          this.process = null;
          reject(
            new Error(
              `NSM_UNAVAILABLE: helper failed to start: ${error.message}${this.formatStderrTail()}`,
            ),
          );
        });
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(() => {
          this.process = null;
          reject(
            new Error(
              `NSM_UNAVAILABLE: helper exited before ${READY_LINE} (${formatExitStatus(
                code,
                signal,
              )})${this.formatStderrTail()}`,
            ),
          );
        });
      };
      const timer = setTimeout(() => {
        settle(() => {
          this.process = null;
          child.kill();
          reject(
            new Error(
              `NSM_UNAVAILABLE: helper did not emit ${READY_LINE} after ${NSM_START_TIMEOUT_MS}ms${this.formatStderrTail()}`,
            ),
          );
        });
      }, NSM_START_TIMEOUT_MS);

      child.stdout!.on('data', onReady);
      child.on('error', onError);
      child.on('exit', onExit);
    });

    child.on('exit', (code, signal) => {
      this.ready = false;
      if (this.process === child) {
        this.process = null;
      }
      const pendingReject = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      if (pendingReject) {
        pendingReject(
          new Error(`NSM_UNAVAILABLE: helper exited with ${formatExitStatus(code, signal)}`),
        );
      }
    });
  }

  private readonly onStderr = (data: Buffer): void => {
    this.stderrTail = `${this.stderrTail}${data.toString()}`.slice(
      -STDERR_TAIL_BYTES,
    );
  };

  private formatStderrTail(): string {
    const stderr = this.stderrTail.trim();
    return stderr ? `; stderr: ${stderr}` : '';
  }

  private readonly onData = (data: Buffer): void => {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      if (!this.pendingResolve) continue;
      try {
        const response = JSON.parse(line) as DaemonResponse;
        if (response.status === 'ok' && response.attestation_doc && response.pcrs) {
          this.pendingResolve({
            attestationDoc: response.attestation_doc,
            pcrs: response.pcrs,
          });
        } else {
          this.pendingReject?.(
            new Error(`NSM_UNAVAILABLE: ${response.error ?? 'unknown daemon error'}`),
          );
        }
      } catch {
        this.pendingReject?.(new Error('NSM_UNAVAILABLE: invalid daemon response'));
      }
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  };

  async getAttestationDoc(
    nonce: Buffer,
    publicKey: Buffer,
  ): Promise<NSMAttestationResult> {
    if (!this.process || !this.ready) {
      throw new Error('NSM_UNAVAILABLE: sidecar not running');
    }

    const NSM_TIMEOUT_MS = 5_000;

    return new Promise<NSMAttestationResult>((resolve, reject) => {
      const run = (): Promise<void> =>
        new Promise<void>((done) => {
          const timer = setTimeout(() => {
            this.pendingResolve = null;
            this.pendingReject = null;
            reject(new Error('NSM_UNAVAILABLE: daemon timeout after 5s'));
            done();
            // M4: self-heal on timeout — a wedged helper would
            // otherwise time out every subsequent attestation forever.
            this.stop();
            this.start().catch(() => {});
          }, NSM_TIMEOUT_MS);

          this.pendingResolve = (r) => {
            clearTimeout(timer);
            resolve(r);
            done();
          };
          this.pendingReject = (e) => {
            clearTimeout(timer);
            reject(e);
            done();
          };

          const request =
            JSON.stringify({
              nonce: nonce.toString('base64'),
              public_key: publicKey.toString('base64'),
            }) + '\n';
          // M4: the helper can die between the ready-check and this write —
          // a synchronous throw here used to reject the inner queue
          // promise, leaving `this.queue` permanently rejected so every
          // later caller hung with no timer armed. Reject THIS caller,
          // settle the queue slot, and self-heal.
          try {
            this.process!.stdin!.write(request);
          } catch {
            clearTimeout(timer);
            this.pendingResolve = null;
            this.pendingReject = null;
            reject(
              new Error('NSM_UNAVAILABLE: failed to write to NSM helper'),
            );
            done();
            this.stop();
            this.start().catch(() => {});
          }
        });
      // M4: rejection-tolerant chaining — even if an earlier slot somehow
      // rejected, the next request must still run.
      this.queue = this.queue.then(run, run);
    });
  }

  stop(): void {
    this.process?.kill();
    this.process = null;
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }
}

// ---------------------------------------------------------------------------
// Module singleton — `EnclaveRouter.init()` calls `initNsmSidecar()` once at
// boot; `getNSMAttestationDoc()` is the per-request API used by the router.
// ---------------------------------------------------------------------------

let _sidecar: NsmSidecar | null = null;

export async function initNsmSidecar(): Promise<void> {
  if (!isNitroEnclave) return;
  if (_sidecar) return;
  const sidecar = new NsmSidecar();
  await sidecar.start();
  _sidecar = sidecar;
}

export function stopNsmSidecar(): void {
  _sidecar?.stop();
  _sidecar = null;
}

/**
 * Get an attestation document from the NSM hardware.
 *
 * @param nonce - Client-provided nonce (anti-replay)
 * @param publicKey - Ephemeral ECDH public key to bind into the attestation
 */
export async function getNSMAttestationDoc(
  nonce: Buffer,
  publicKey: Buffer,
): Promise<NSMAttestationResult> {
  if (!isNitroEnclave) {
    return getDevPlaceholder();
  }
  if (!_sidecar) {
    throw new Error(
      'NSM_UNAVAILABLE: sidecar not initialised — call initNsmSidecar() at boot',
    );
  }
  return _sidecar.getAttestationDoc(nonce, publicKey);
}

// ---------------------------------------------------------------------------
// Development placeholder (no /dev/nsm)
// ---------------------------------------------------------------------------

const DEV_MEASUREMENT = 'DEV_MODE_NO_NSM_HARDWARE';

function getDevPlaceholder(): NSMAttestationResult {
  return {
    attestationDoc: '',
    pcrs: {
      PCR0: DEV_MEASUREMENT,
      PCR1: DEV_MEASUREMENT,
      PCR2: DEV_MEASUREMENT,
    },
  };
}

function pathTo(relative: string): string {
  return resolve(import.meta.dirname ?? __dirname, relative);
}

function formatExitStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
}
