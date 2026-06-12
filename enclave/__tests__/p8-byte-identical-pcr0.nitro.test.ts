/**
 * Privacy invariant P8 — live byte-identical PCR0 proof (Nitro-only).
 *
 * This test exists to catch the class of regression the static Dockerfile
 * test cannot: a build-time side-effect that MEASURES the provider registry
 * (e.g., a RUN step that hashes providers.json into an env var, or a
 * COPY-into-builder path that gets referenced by the final stage
 * transitively). The only way to prove "adding a provider does not change
 * PCR0" is to build both variants end-to-end and diff the measurements.
 *
 * The heavy lifting lives in enclave/scripts/__tests__/p8-byte-identical-pcr0.sh
 * — this vitest wrapper executes it when NITRO_AVAILABLE=1 is set and
 * asserts exit 0. Skipped on every non-Nitro runner (ubuntu-latest CI,
 * developer laptops) so it never false-fails.
 *
 * How to run locally on a Nitro host:
 *   NITRO_AVAILABLE=1 yarn workspace @calypso/enclave test -- p8-byte-identical-pcr0
 *
 * How CI picks it up: once a self-hosted Nitro runner lands, set
 * NITRO_AVAILABLE=1 on that runner's env and the existing enclave-unit job
 * starts executing this test automatically. Until then, operators run the
 * shell script manually per release — see
 * enclave/scripts/__tests__/README.md.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHELL_SCRIPT = resolve(
  __dirname,
  '..',
  'scripts',
  '__tests__',
  'p8-byte-identical-pcr0.sh',
);

describe.skipIf(process.env.NITRO_AVAILABLE !== '1')(
  'Privacy invariant P8 — live byte-identical PCR0 (Nitro-only)',
  () => {
    it('builds with and without a synthetic provider and produces byte-identical PCR0', () => {
      // The shell script handles tee-down cleanup (trap EXIT restores
      // providers.json). A non-zero exit here means one of:
      //   - the builds diverged (P8 broken)
      //   - tooling prerequisite missing (nitro-cli, disk space)
      //   - the providers.json restore failed — the script exits non-zero
      //     rather than leave the working tree dirty.
      expect(() =>
        execFileSync('/usr/bin/env', ['bash', SHELL_SCRIPT], {
          stdio: 'inherit',
          // Two back-to-back reproducible builds on a fresh host take ~25 min
          // each per the Phase 2 repro proof. Allow 90 min for the full cycle.
          timeout: 90 * 60 * 1000,
        }),
      ).not.toThrow();
    });
  },
);
