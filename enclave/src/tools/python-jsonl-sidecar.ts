import { spawn, type ChildProcess } from 'node:child_process';

type SidecarResponse<T> =
  | ({ status: 'ok' } & T)
  | { status: 'error'; error?: string };

export interface PythonJsonlSidecarOptions {
  scriptPath: string;
  readyLine: string;
  timeoutMs: number;
  pythonBin?: string;
  args?: readonly string[];
}

/**
 * Small reusable wrapper for long-running Python JSONL services.
 * Requests are deliberately serialised: each sidecar process has one
 * stdin/stdout stream pair, so one pending response at a time avoids
 * response correlation bugs without requiring every Python helper to
 * implement request ids.
 */
export class PythonJsonlSidecar<TRequest, TResponse extends object> {
  private process: ChildProcess | null = null;
  private ready = false;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private queue: Promise<void> = Promise.resolve();
  private pendingResolve: ((value: TResponse) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;

  constructor(private readonly opts: PythonJsonlSidecarOptions) {}

  async start(): Promise<void> {
    if (this.process && this.ready) return;
    if (this.process) this.stop();
    const pythonBin = this.opts.pythonBin ?? 'python3';
    const args = [this.opts.scriptPath, ...(this.opts.args ?? [])];
    this.process = spawn(pythonBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.ready = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';

    await new Promise<void>((resolve, reject) => {
      const onReady = (data: Buffer) => {
        this.stdoutBuffer += data.toString();
        const lines = this.stdoutBuffer.split('\n');
        this.stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.includes(this.opts.readyLine)) {
            cleanup();
            this.ready = true;
            this.process!.stdout!.on('data', this.onStdout);
            resolve();
            return;
          }
        }
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`PYTHON_SIDECAR_EXITED:${code ?? 'signal'}`));
      };
      const cleanup = () => {
        this.process?.stdout?.off('data', onReady);
        this.process?.off('error', onError);
        this.process?.off('exit', onExit);
      };
      this.process!.stdout!.on('data', onReady);
      this.process!.stderr!.on('data', (data: Buffer) => {
        this.stderrBuffer += data.toString();
      });
      this.process!.on('error', onError);
      this.process!.on('exit', onExit);
    });

    this.process.on('exit', (code) => {
      this.ready = false;
      const pendingReject = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      if (pendingReject) {
        pendingReject(new Error(`PYTHON_SIDECAR_EXITED:${code ?? 'signal'}`));
      }
    });
  }

  async request(payload: TRequest): Promise<TResponse> {
    if (!this.process || !this.ready) {
      throw new Error('PYTHON_SIDECAR_UNAVAILABLE');
    }
    const run = this.queue.then(() => this.performRequest(payload));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  stop(): void {
    const proc = this.process;
    const pendingReject = this.pendingReject;
    this.process = null;
    this.ready = false;
    this.pendingResolve = null;
    this.pendingReject = null;
    pendingReject?.(new Error('PYTHON_SIDECAR_STOPPED'));
    if (proc && !proc.killed) {
      proc.kill();
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  private performRequest(payload: TRequest): Promise<TResponse> {
    return new Promise<TResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolve = null;
        this.pendingReject = null;
        this.stop();
        reject(new Error(`PYTHON_SIDECAR_TIMEOUT:${this.opts.timeoutMs}`));
      }, this.opts.timeoutMs);

      this.pendingResolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.pendingReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      try {
        this.process!.stdin!.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private readonly onStdout = (data: Buffer): void => {
    this.stdoutBuffer += data.toString();
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!this.pendingResolve && !this.pendingReject) continue;
      try {
        const parsed = JSON.parse(line) as SidecarResponse<TResponse>;
        if (parsed.status === 'ok') {
          const { status: _status, ...rest } = parsed;
          this.pendingResolve?.(rest as TResponse);
        } else {
          this.pendingReject?.(
            new Error(`PYTHON_SIDECAR_ERROR: ${parsed.error ?? 'unknown error'}`),
          );
        }
      } catch (err) {
        this.pendingReject?.(
          new Error(
            `PYTHON_SIDECAR_INVALID_RESPONSE: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      } finally {
        this.pendingResolve = null;
        this.pendingReject = null;
      }
    }
  };
}
