/**
 * Regression test for the NSM helper daemon refactor.
 *
 * Pre-fix: every `getNSMAttestationDoc()` call spawned a fresh `python3`
 * via `execFile`. At 50 parallel attestations the fork pressure pushed tail
 * requests past the 5s execFile timeout, which tripped the enclave's
 * socket-destroy path and — in combination with the `VsockClient.send()`
 * close-hang — blew up `tests/integration/nitro/vsock-bridge-load.test.ts`.
 *
 * Post-fix: a single long-running `python3 nsm_helper.py --daemon` process
 * reads framed JSON from stdin and writes framed JSON on stdout (the
 * long-running line-framed sidecar pattern). Spawn cost is paid once at
 * enclave boot, not per attestation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock node:child_process BEFORE importing the module under test.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  // Keep execFile etc. exported so any other code paths compile, even
  // though this test doesn't exercise them.
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));

// Force the "inside Nitro" branch — nsm.ts checks /dev/nsm existence at
// module load, so we stub fs.existsSync before importing.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => (p === '/dev/nsm' ? true : actual.existsSync(p)),
  };
});

function makeMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 42;
  return proc;
}

async function expectRejectsQuickly(promise: Promise<unknown>, pattern: RegExp) {
  await expect(
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('timed out waiting for startup rejection')),
          50,
        ),
      ),
    ]),
  ).rejects.toThrow(pattern);
}

describe('NsmSidecar', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.resetModules();
  });

  it('spawns python3 nsm_helper.py in --daemon mode and resolves on NSM_READY', async () => {
    const proc = makeMockProcess();
    spawnMock.mockReturnValue(proc);

    const { NsmSidecar } = await import('../nsm');
    const sidecar = new NsmSidecar();
    const startPromise = sidecar.start();

    // Emit the ready signal on next tick
    setTimeout(() => proc.stdout.emit('data', Buffer.from('NSM_READY\n')), 5);

    await startPromise;
    expect(sidecar.isReady()).toBe(true);

    // Verify the spawn invocation shape.
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('python3');
    expect(args).toEqual(expect.arrayContaining([expect.stringContaining('nsm_helper.py'), '--daemon']));
  });

  it('queues a request over stdin and resolves with the parsed attestation', async () => {
    const proc = makeMockProcess();
    spawnMock.mockReturnValue(proc);

    const { NsmSidecar } = await import('../nsm');
    const sidecar = new NsmSidecar();
    const startPromise = sidecar.start();
    setTimeout(() => proc.stdout.emit('data', Buffer.from('NSM_READY\n')), 5);
    await startPromise;

    const nonce = Buffer.alloc(32, 1);
    const pubkey = Buffer.alloc(65, 2);
    const resultPromise = sidecar.getAttestationDoc(nonce, pubkey);

    await new Promise((r) => setTimeout(r, 5));
    expect(proc.stdin.write).toHaveBeenCalledTimes(1);
    const written = (proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const req = JSON.parse(written.trim());
    expect(req.nonce).toBe(nonce.toString('base64'));
    expect(req.public_key).toBe(pubkey.toString('base64'));

    // Simulate daemon response
    const response = {
      status: 'ok',
      attestation_doc: 'mock-b64-doc',
      pcrs: { PCR0: 'aa', PCR1: 'bb', PCR2: 'cc' },
    };
    proc.stdout.emit('data', Buffer.from(JSON.stringify(response) + '\n'));

    const result = await resultPromise;
    expect(result.attestationDoc).toBe('mock-b64-doc');
    expect(result.pcrs.PCR0).toBe('aa');
  });

  it('serialises concurrent requests (one spawn, one stdin write per request)', async () => {
    const proc = makeMockProcess();
    spawnMock.mockReturnValue(proc);

    const { NsmSidecar } = await import('../nsm');
    const sidecar = new NsmSidecar();
    const startPromise = sidecar.start();
    setTimeout(() => proc.stdout.emit('data', Buffer.from('NSM_READY\n')), 5);
    await startPromise;

    // Fire 3 concurrent requests
    const p1 = sidecar.getAttestationDoc(Buffer.alloc(32, 1), Buffer.alloc(65, 1));
    const p2 = sidecar.getAttestationDoc(Buffer.alloc(32, 2), Buffer.alloc(65, 2));
    const p3 = sidecar.getAttestationDoc(Buffer.alloc(32, 3), Buffer.alloc(65, 3));

    // Each completes in order as we feed responses. The critical property:
    // exactly ONE python3 process has been spawned, regardless of parallelism.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const reply = {
        status: 'ok',
        attestation_doc: `doc-${i}`,
        pcrs: { PCR0: `p${i}`, PCR1: 'b', PCR2: 'c' },
      };
      proc.stdout.emit('data', Buffer.from(JSON.stringify(reply) + '\n'));
    }

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.attestationDoc).toBe('doc-0');
    expect(r2.attestationDoc).toBe('doc-1');
    expect(r3.attestationDoc).toBe('doc-2');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when daemon reports an error status', async () => {
    const proc = makeMockProcess();
    spawnMock.mockReturnValue(proc);

    const { NsmSidecar } = await import('../nsm');
    const sidecar = new NsmSidecar();
    const startPromise = sidecar.start();
    setTimeout(() => proc.stdout.emit('data', Buffer.from('NSM_READY\n')), 5);
    await startPromise;

    const resultPromise = sidecar.getAttestationDoc(Buffer.alloc(32, 1), Buffer.alloc(65, 1));
    await new Promise((r) => setTimeout(r, 5));

    const errorResponse = { status: 'error', error: 'NSM ioctl failed: EIO' };
    proc.stdout.emit('data', Buffer.from(JSON.stringify(errorResponse) + '\n'));

    await expect(resultPromise).rejects.toThrow(/NSM ioctl failed/);
  });

  it('rejects startup when daemon exits before ready and includes stderr', async () => {
    const proc = makeMockProcess();
    spawnMock.mockReturnValue(proc);

    const { NsmSidecar } = await import('../nsm');
    const sidecar = new NsmSidecar();
    const startPromise = sidecar.start();

    proc.stderr.emit('data', Buffer.from('Traceback: cbor2 missing\n'));
    proc.emit('exit', 1);

    await expectRejectsQuickly(
      startPromise,
      /NSM_UNAVAILABLE: helper exited before NSM_READY.*cbor2 missing/s,
    );
  });

  // M4 (error-handling audit): a wedged helper used to time out EVERY
  // subsequent attestation forever — NsmSidecar did not self-heal on
  // timeout. The timeout must restart the daemon so the next attestation
  // attempt can succeed.
  it('restarts the daemon after a request timeout so the next attestation succeeds', async () => {
    vi.useFakeTimers();
    try {
      const proc1 = makeMockProcess();
      const proc2 = makeMockProcess();
      spawnMock.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

      const { NsmSidecar } = await import('../nsm');
      const sidecar = new NsmSidecar();
      const startPromise = sidecar.start();
      proc1.stdout.emit('data', Buffer.from('NSM_READY\n'));
      await startPromise;

      const stalled = sidecar.getAttestationDoc(
        Buffer.alloc(32, 1),
        Buffer.alloc(65, 1),
      );
      // Attach the rejection handler BEFORE advancing timers — the
      // rejection fires mid-advance and would otherwise be flagged as an
      // unhandled rejection.
      const stalledRejects = expect(stalled).rejects.toThrow(
        /NSM_UNAVAILABLE: daemon timeout/,
      );
      // Never respond; the 5s request timeout fires.
      await vi.advanceTimersByTimeAsync(5_001);
      await stalledRejects;

      // Restart-on-timeout: a second helper was spawned.
      expect(spawnMock).toHaveBeenCalledTimes(2);
      proc2.stdout.emit('data', Buffer.from('NSM_READY\n'));
      await vi.advanceTimersByTimeAsync(1);
      expect(sidecar.isReady()).toBe(true);

      const next = sidecar.getAttestationDoc(
        Buffer.alloc(32, 2),
        Buffer.alloc(65, 2),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(proc2.stdin.write).toHaveBeenCalledTimes(1);
      proc2.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            status: 'ok',
            attestation_doc: 'doc-after-restart',
            pcrs: { PCR0: 'a', PCR1: 'b', PCR2: 'c' },
          })}\n`,
        ),
      );
      await expect(next).resolves.toMatchObject({
        attestationDoc: 'doc-after-restart',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // M4 (error-handling audit): a sync stdin.write throw used to reject the
  // inner queue promise — `this.queue` became a rejected promise and every
  // later caller hung forever with no timer armed.
  it('a sync stdin.write throw rejects the caller and does not poison the queue', async () => {
    const proc1 = makeMockProcess();
    spawnMock.mockReturnValue(proc1);

    const { NsmSidecar } = await import('../nsm');
    const sidecar = new NsmSidecar();
    const startPromise = sidecar.start();
    setTimeout(() => proc1.stdout.emit('data', Buffer.from('NSM_READY\n')), 5);
    await startPromise;

    proc1.stdin.write.mockImplementationOnce(() => {
      throw new Error('EPIPE: broken pipe');
    });

    // Stage the self-heal restart process before triggering the failure.
    const proc2 = makeMockProcess();
    spawnMock.mockReturnValue(proc2);
    setTimeout(() => proc2.stdout.emit('data', Buffer.from('NSM_READY\n')), 10);

    await expectRejectsQuickly(
      sidecar.getAttestationDoc(Buffer.alloc(32, 1), Buffer.alloc(65, 1)),
      /NSM_UNAVAILABLE/,
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(sidecar.isReady()).toBe(true);

    const next = sidecar.getAttestationDoc(
      Buffer.alloc(32, 2),
      Buffer.alloc(65, 2),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(proc2.stdin.write).toHaveBeenCalledTimes(1);
    proc2.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          status: 'ok',
          attestation_doc: 'doc-2',
          pcrs: { PCR0: 'a', PCR1: 'b', PCR2: 'c' },
        })}\n`,
      ),
    );
    await expect(next).resolves.toMatchObject({ attestationDoc: 'doc-2' });
  });
});
