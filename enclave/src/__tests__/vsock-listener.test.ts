/**
 * Error-handling audit L3 — post-startup listener error visibility.
 *
 * createEnclaveListener attached `server.on('error', reject)` to a promise
 * that had already settled once listen succeeded, so every later listener
 * error was silently swallowed. After startup the server must log listener
 * errors (redacted: code only — enclave stderr is host-visible).
 */
import { describe, expect, it, vi } from 'vitest';

import { createEnclaveListener } from '../vsock-listener';

describe('createEnclaveListener (L3)', () => {
  it('logs post-startup listener errors with code only (no raw message)', async () => {
    // Port 0 → ephemeral TCP port (local dev path; no /dev/nsm here).
    const server = await createEnclaveListener(() => {}, 0);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const err = Object.assign(new Error('secret payload detail'), {
        code: 'ECONNABORTED',
      });
      server.emit('error', err);

      expect(spy).toHaveBeenCalled();
      const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('ECONNABORTED');
      expect(logged).not.toContain('secret payload detail');
    } finally {
      spy.mockRestore();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
