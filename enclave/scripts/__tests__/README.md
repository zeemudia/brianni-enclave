# enclave/scripts tests

`deploy.sh` and `health-check.mjs` interact with `nitro-cli` and an AF_VSOCK
socket to a running enclave. Neither is unit-testable off a Nitro-capable
EC2 host, so the verification checklist below is executed manually on a Nitro host
during the pre-merge smoke.

## Manual smoke plan (run on a Nitro host)

Pre-conditions:
- Nitro EC2 host started with Nitro Enclaves enabled.
- `aws-nitro-enclaves-cli` installed; `nitro-enclaves-allocator` service
  running with the reserved memory/CPU budget (7168 MiB / 2 vCPU).
- `enclave/measurement.json` matches the commit under test.
- `@calypso/vsock-native` compiled on the host (`yarn install` at repo
  root after bringing up the EC2 box).

Tests:

1. **`--help` renders.**
   ```
   ./enclave/scripts/deploy.sh --help
   node enclave/scripts/health-check.mjs --help
   ```
   Both exit 0 and print usage.

2. **Preflight missing measurement.**
   Temporarily `mv enclave/measurement.json enclave/measurement.json.bak`
   and re-run deploy — expect `error: enclave/measurement.json missing`
   and exit 1. Restore the file.

3. **Preflight EXPECTED_PCR0 mismatch.**
   `EXPECTED_PCR0=0000…deadbeef ./enclave/scripts/deploy.sh --help` passes
   (help shortcircuits before preflight). Drop `--help`:
   `EXPECTED_PCR0=0000…deadbeef ./enclave/scripts/deploy.sh` → exits
   non-zero with "EXPECTED_PCR0 … does not match measurement.json PCR0".

4. **Lockfile honoured.**
   In one shell, `touch /tmp/calypso-enclave-deploy.lock && echo 99999 >
   /tmp/calypso-enclave-deploy.lock`. Run deploy — expect "another deploy
   is in progress". Remove the lockfile.

5. **Idempotent redeploy (same PCR0).**
   With the current EIF already running, run
   `./enclave/scripts/deploy.sh --build-mode=release --eif-path=enclave/calypso-enclave.eif`.
   Expect:
   - measurement gate passes (same PCR0),
   - backup written to `enclave/dist/backup/<current-pcr0>.eif`,
   - terminate + run cycle,
   - 3 consecutive health-probe OKs,
   - script exits 0.
   Target downtime: 5-10 s per spec.

6. **Measurement-drift abort.**
   Build a deliberately-drifted EIF on a second branch (e.g. bump a
   `SOURCE_DATE_EPOCH` constant). Copy it aside, restore the main branch,
   then run
   `./enclave/scripts/deploy.sh --build-mode=release --eif-path=<drifted.eif>`.
   Expect a measurement-gate abort BEFORE `terminate-enclave` is called.
   Verify via `nitro-cli describe-enclaves` that the running enclave is
   unchanged.

7. **Rollback on health failure.**
   Author a tiny sabotage EIF (build from `enclave/src/index.ts` with the
   vsock listener disabled) with its own PCR0 committed as the
   measurement.json override. Deploy with `--build-mode=release
   --eif-path=<sabotage.eif>`. Expect:
   - measurement gate passes (PCR0 matches the override),
   - health probe fails 15× across the 30 s window,
   - rollback restores the backup,
   - deploy exits non-zero pointing to the runbook.
   Confirm `nitro-cli describe-enclaves` shows the previous PCR0 again.

8. **First-boot (no prior enclave).**
   `nitro-cli terminate-enclave --all`, then run deploy. Expect
   "first-boot deploy (no backup)" log and a successful start.

9. **health-check.mjs rejects wrong frame type.**
   Spin up any TCP listener that echoes a non-HEALTH_PONG frame back on
   port 5000 (e.g. `printf '\x09\x00\x00\x00\x02{}' | nc -l 5000`,
   type=0x09 = HEALTH_PING, not PONG). Run
   `ENCLAVE_PORT=5000 node enclave/scripts/health-check.mjs` — expect
   exit 1 with `expected HEALTH_PONG frame (0x0a) but received type=0x09`.

10. **health-check.mjs rejects a non-ok status.**
    Echo a correctly-typed HEALTH_PONG with `{"status":"degraded"}`.
    Run the probe — expect exit 1 with
    `unhealthy payload: {"status":"degraded"}`. `status: 'ok'` is the whole
    readiness contract now that the enclave runs no Presidio masking sidecar
    (the old `presidio_ready` field was removed from HEALTH_PONG — requiring
    it here would fail every probe against a post-removal enclave and hang
    deploy.sh into a rollback). The deploy script's 3-consecutive window
    still lets a transient startup flap pass once the enclave is listening.

## Unit tests

None — the script's logic is a thin orchestration layer over `nitro-cli`.
A PCR0 comparison unit test was deliberately skipped: the comparison is
two inline `jq` reads plus a `[ "$a" != "$b" ]` check, which is clearer
read in context than extracted into a helper.

## Privacy invariant P8 — byte-identical PCR0 proof

`p8-byte-identical-pcr0.sh` is the live half of the P8 regression gate.
It proves that "adding an LLM provider that uses an existing adapter does
NOT change the enclave attestation hash" by building the EIF twice — once
against the real `enclave/src/providers/providers.json`, once against the
fixture at `enclave/src/providers/__fixtures__/providers.with-xai.json`
— and diffing `measurement.json`. The static Dockerfile half
(`enclave/__tests__/p8-registry-stability.test.ts`) runs on every CI job;
this live half must be run manually per release until a self-hosted
Nitro runner is wired into CI.

### Operator invocation (pre-release Nitro host)

Pre-conditions:
- Nitro EC2 host started with Nitro Enclaves enabled.
- `nitro-cli` on PATH; nitro-enclaves-allocator running.
- Working tree clean for `enclave/src/providers/providers.json`.
- ≥20 GB free disk at the repo root (two reproducible builds consume
  most of that window between them).

```
cd /path/to/repo
NITRO_AVAILABLE=1 ./enclave/scripts/__tests__/p8-byte-identical-pcr0.sh
```

Expected outcome:
- Exit code 0.
- Console log: `SUCCESS — measurement.json byte-identical across both builds`.
- Evidence artefact at
  `docs/legal/build-evidence/p8-byte-identical-pcr0-<YYYY-MM-DD>.md`
  capturing both PCR0 values, the (empty) diff, AMI id, docker buildx
  version, and git HEAD.

Failure surfaces:
- Exit 1 — preconditions not met (missing `nitro-cli`, `jq`, `git`,
  `NITRO_AVAILABLE!=1`, dirty working tree, insufficient disk).
- Exit 2 — **PCR0 DIVERGED**. Investigate before release; P8 is a
  load-bearing privacy invariant. Check `docker buildx diff`, inspect
  `Dockerfile.enclave` for newly-added RUN/COPY steps that reference
  `providers.json`, and rerun the static regression test.
- Exit 3 — trap cleanup failed to restore `providers.json`. Inspect
  working tree and run `git checkout -- enclave/src/providers/providers.json`.

### vitest wrapper

`enclave/__tests__/p8-byte-identical-pcr0.nitro.test.ts` shells out to
this script when `NITRO_AVAILABLE=1`. On every other runner it is
`skipIf`-skipped so CI stays green. Once a self-hosted Nitro runner is
available, setting `NITRO_AVAILABLE=1` on that runner's env picks this
test up automatically — no CI edits required.

### Why the shell script, not pure vitest?

The proof requires two full EIF builds (~25 min each) and `nitro-cli
describe-eif` to extract PCR0. That is firmly outside vitest's unit-test
domain and into "CI integration script" territory. Keeping it as a
shell script lets operators run it standalone, pipe output to release
notes, and debug without vitest in the loop.
