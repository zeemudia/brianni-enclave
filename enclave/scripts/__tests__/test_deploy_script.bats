#!/usr/bin/env bats

setup() {
    export TESTDIR="$BATS_TEST_TMPDIR"
    export ROOT="$TESTDIR/root"
    export MOCK_LOG="$TESTDIR/nitro.log"
    export RUN_COUNT_FILE="$TESTDIR/run-count"
    export TERMINATED_FILE="$TESTDIR/terminated"
    export TEST_PCR0="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    mkdir -p "$ROOT/enclave/scripts" "$ROOT/enclave/dist/backup" "$TESTDIR/bin"
    cp "$BATS_TEST_DIRNAME/../deploy.sh" "$ROOT/enclave/scripts/deploy.sh"
    chmod +x "$ROOT/enclave/scripts/deploy.sh"
    printf '{"pcr0":"%s"}\n' "$TEST_PCR0" > "$ROOT/enclave/measurement.json"
    printf 'current-eif\n' > "$ROOT/enclave/calypso-enclave.eif"
    printf 'release-eif\n' > "$TESTDIR/release.eif"
    cat > "$ROOT/enclave/scripts/health-check.mjs" <<'NODE'
process.exit(0);
NODE

    cat > "$TESTDIR/bin/nitro-cli" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_LOG"
case "${1:-}" in
  describe-enclaves)
    if [ -f "$TERMINATED_FILE" ]; then
      printf '[]\n'
    elif [ -n "${MOCK_RUNNING_PCR0:-}" ]; then
      printf '[{"EnclaveID":"old-enclave","State":"RUNNING","EnclaveCID":%s,"Measurements":{"PCR0":"%s"}}]\n' "${ENCLAVE_CID:-16}" "$MOCK_RUNNING_PCR0"
    else
      printf '[{"EnclaveID":"old-enclave","State":"RUNNING","EnclaveCID":%s}]\n' "${ENCLAVE_CID:-16}"
    fi
    ;;
  describe-eif)
    # args: describe-eif --eif-path <path>. If a "<path>.pcr0" sidecar exists,
    # report that PCR0 (lets tests model per-EIF measurements, e.g. a canonical
    # overwritten with new bytes vs the running enclave's old EIF). Else default.
    _eifp="${3:-}"
    if [ -n "$_eifp" ] && [ -f "${_eifp}.pcr0" ]; then
      printf '{"Measurements":{"PCR0":"%s"}}\n' "$(cat "${_eifp}.pcr0")"
    else
      printf '{"Measurements":{"PCR0":"%s"}}\n' "$TEST_PCR0"
    fi
    ;;
  terminate-enclave)
    printf '1\n' > "$TERMINATED_FILE"
    exit 0
    ;;
  run-enclave)
    count=0
    if [ -f "$RUN_COUNT_FILE" ]; then count="$(cat "$RUN_COUNT_FILE")"; fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$RUN_COUNT_FILE"
    if [ "${NITRO_ALWAYS_FAIL_RUN:-0}" = "1" ]; then
      exit 39
    fi
    if [ "${NITRO_FAIL_FIRST_RUN:-0}" = "1" ] && [ "$count" -eq 1 ]; then
      exit 39
    fi
    rm -f "$TERMINATED_FILE"
    if [ "${NITRO_EXIT_AFTER_RUN:-0}" = "1" ]; then
      printf '1\n' > "$TERMINATED_FILE"
    fi
    printf '{"EnclaveID":"enclave-%s"}\n' "$count"
    ;;
  *)
    echo "unexpected nitro-cli command: $*" >&2
    exit 99
    ;;
esac
SH
    chmod +x "$TESTDIR/bin/nitro-cli"
    export PATH="$TESTDIR/bin:$PATH"
}

@test "rolls back when new enclave launch fails after termination" {
    run env \
      EXPECTED_PCR0="$TEST_PCR0" \
      ENCLAVE_CID=16 \
      ENCLAVE_PORT=5000 \
      ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS=0 \
      DEPLOY_HEALTH_RETRY_ATTEMPTS=0 \
      ROLLBACK_HEALTH_TIMEOUT_SECONDS=6 \
      NITRO_FAIL_FIRST_RUN=1 \
      "$ROOT/enclave/scripts/deploy.sh" \
        --build-mode=release \
        --eif-path="$TESTDIR/release.eif"

    [ "$status" -ne 0 ]
    [[ "$output" == *"new enclave launch failed — initiating rollback"* ]]
    [[ "$output" == *"rolled back to PCR0=$TEST_PCR0 and confirmed healthy"* ]]
    [ "$(cat "$RUN_COUNT_FILE")" -eq 2 ]
    grep -q "run-enclave" "$MOCK_LOG"
}

@test "retries the verified EIF once when first boot never answers health" {
    cat > "$ROOT/enclave/scripts/health-check.mjs" <<'NODE'
import { readFileSync } from "node:fs";

const runCount = Number(readFileSync(process.env.RUN_COUNT_FILE, "utf8"));
const passAfterRun = Number(process.env.HEALTH_PASS_AFTER_RUN ?? "1");
process.exit(runCount >= passAfterRun ? 0 : 1);
NODE

    run env \
      EXPECTED_PCR0="$TEST_PCR0" \
      ENCLAVE_CID=16 \
      ENCLAVE_PORT=5000 \
      ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS=0 \
      DEPLOY_HEALTH_TIMEOUT_SECONDS=6 \
      DEPLOY_HEALTH_RETRY_ATTEMPTS=1 \
      DEPLOY_HEALTH_RETRY_COOLDOWN_SECONDS=0 \
      HEALTH_PASS_AFTER_RUN=2 \
      RUN_COUNT_FILE="$RUN_COUNT_FILE" \
      "$ROOT/enclave/scripts/deploy.sh" \
        --build-mode=release \
        --eif-path="$TESTDIR/release.eif"

    [ "$status" -eq 0 ]
    [[ "$output" == *"new EIF health probe failed on attempt 1/2"* ]]
    [[ "$output" == *"retrying new EIF launch attempt 2/2 before rollback"* ]]
    [[ "$output" == *"new EIF became healthy after retry attempt 2/2"* ]]
    [[ "$output" != *"rolled back"* ]]
    [ "$(cat "$RUN_COUNT_FILE")" -eq 2 ]
}

@test "rolls back after same-EIF health retries are exhausted" {
    cat > "$ROOT/enclave/scripts/health-check.mjs" <<'NODE'
import { readFileSync } from "node:fs";

const runCount = Number(readFileSync(process.env.RUN_COUNT_FILE, "utf8"));
const passAfterRun = Number(process.env.HEALTH_PASS_AFTER_RUN ?? "1");
process.exit(runCount >= passAfterRun ? 0 : 1);
NODE

    run env \
      EXPECTED_PCR0="$TEST_PCR0" \
      ENCLAVE_CID=16 \
      ENCLAVE_PORT=5000 \
      ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS=0 \
      DEPLOY_HEALTH_TIMEOUT_SECONDS=6 \
      DEPLOY_HEALTH_RETRY_ATTEMPTS=1 \
      DEPLOY_HEALTH_RETRY_COOLDOWN_SECONDS=0 \
      ROLLBACK_HEALTH_TIMEOUT_SECONDS=6 \
      HEALTH_PASS_AFTER_RUN=3 \
      RUN_COUNT_FILE="$RUN_COUNT_FILE" \
      "$ROOT/enclave/scripts/deploy.sh" \
        --build-mode=release \
        --eif-path="$TESTDIR/release.eif"

    [ "$status" -ne 0 ]
    [[ "$output" == *"new EIF health probe failed on attempt 1/2"* ]]
    [[ "$output" == *"new EIF health probe failed on attempt 2/2"* ]]
    [[ "$output" == *"new EIF did not become healthy after 2 launch attempt(s) — initiating rollback"* ]]
    [[ "$output" == *"rolled back to PCR0=$TEST_PCR0 and confirmed healthy"* ]]
    [ "$(cat "$RUN_COUNT_FILE")" -eq 3 ]
}

@test "no-rollback mode leaves failed candidate running for operator debugging" {
    cat > "$ROOT/enclave/scripts/health-check.mjs" <<'NODE'
console.error("candidate not listening yet");
process.exit(1);
NODE

    run env \
      EXPECTED_PCR0="$TEST_PCR0" \
      ENCLAVE_CID=16 \
      ENCLAVE_PORT=5000 \
      ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS=0 \
      DEPLOY_HEALTH_TIMEOUT_SECONDS=6 \
      DEPLOY_HEALTH_RETRY_ATTEMPTS=0 \
      "$ROOT/enclave/scripts/deploy.sh" \
        --build-mode=release \
        --eif-path="$TESTDIR/release.eif" \
        --no-rollback

    [ "$status" -ne 0 ]
    [[ "$output" == *"new EIF did not become healthy after 1 launch attempt(s)"* ]]
    [[ "$output" == *"--no-rollback set; leaving the candidate enclave running for operator debugging"* ]]
    [[ "$output" == *"candidate not listening yet"* ]]
    [[ "$output" != *"initiating rollback"* ]]
    [[ "$output" != *"restoring backup EIF"* ]]
    [ "$(cat "$RUN_COUNT_FILE")" -eq 1 ]
}

@test "health probe failure includes health-check diagnostics" {
    cat > "$ROOT/enclave/scripts/health-check.mjs" <<'NODE'
console.error("vsock connect ECONNREFUSED");
process.exit(1);
NODE

    run env \
      EXPECTED_PCR0="$TEST_PCR0" \
      ENCLAVE_CID=16 \
      ENCLAVE_PORT=5000 \
      ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS=0 \
      DEPLOY_HEALTH_TIMEOUT_SECONDS=2 \
      DEPLOY_HEALTH_RETRY_ATTEMPTS=0 \
      "$ROOT/enclave/scripts/deploy.sh" \
        --build-mode=release \
        --eif-path="$TESTDIR/release.eif" \
        --no-rollback

    [ "$status" -ne 0 ]
    [[ "$output" == *"health probe attempt 1: fail — vsock connect ECONNREFUSED"* ]]
}

@test "health wait fails fast when candidate exits during warmup" {
    run env \
      EXPECTED_PCR0="$TEST_PCR0" \
      ENCLAVE_CID=16 \
      ENCLAVE_PORT=5000 \
      ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS=10 \
      DEPLOY_HEALTH_TIMEOUT_SECONDS=30 \
      DEPLOY_HEALTH_RETRY_ATTEMPTS=0 \
      NITRO_EXIT_AFTER_RUN=1 \
      "$ROOT/enclave/scripts/deploy.sh" \
        --build-mode=release \
        --eif-path="$TESTDIR/release.eif" \
        --no-rollback

    [ "$status" -ne 0 ]
    [[ "$output" == *"candidate enclave CID 16 is not RUNNING during warmup; aborting health wait"* ]]
    [[ "$output" == *"new EIF did not become healthy after 1 launch attempt(s)"* ]]
    [ "$(cat "$RUN_COUNT_FILE")" -eq 1 ]
}

@test "successful deploy prunes old backup EIFs after promotion" {
    old_backup_1="$ROOT/enclave/dist/backup/old-1.eif"
    old_backup_2="$ROOT/enclave/dist/backup/old-2.eif"
    old_backup_3="$ROOT/enclave/dist/backup/old-3.eif"
    printf 'old-backup-1\n' > "$old_backup_1"
    printf 'old-backup-2\n' > "$old_backup_2"
    printf 'old-backup-3\n' > "$old_backup_3"
    touch -t 202001010101 "$old_backup_1"
    touch -t 202002020202 "$old_backup_2"
    touch -t 202003030303 "$old_backup_3"

    run env \
      EXPECTED_PCR0="$TEST_PCR0" \
      ENCLAVE_CID=16 \
      ENCLAVE_PORT=5000 \
      ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS=0 \
      DEPLOY_HEALTH_TIMEOUT_SECONDS=6 \
      ENCLAVE_BACKUP_RETENTION_COUNT=2 \
      "$ROOT/enclave/scripts/deploy.sh" \
        --build-mode=release \
        --eif-path="$TESTDIR/release.eif"

    [ "$status" -eq 0 ]
    backup_count="$(find "$ROOT/enclave/dist/backup" -maxdepth 1 -type f -name '*.eif' | wc -l | tr -d ' ')"
    [ "$backup_count" -eq 2 ]
    [ -f "$ROOT/enclave/dist/backup/${TEST_PCR0}.eif" ]
    [ ! -f "$old_backup_1" ]
    [ ! -f "$old_backup_2" ]
    [[ "$output" == *"pruned old backup EIF"* ]]
}

# a1027f00 doom-loop fix: when build.sh overwrote the canonical EIF with the NEW
# bytes before a release-mode deploy, the canonical no longer matches the running
# enclave. capture_backup must NOT snapshot the canonical (that would make
# rollback relaunch the new/failing EIF). It must fail CLOSED before terminating
# the live enclave when no real rollback EIF for the running PCR0 exists.
@test "fails closed (no terminate) when canonical was overwritten and no rollback EIF for the running enclave exists" {
    NEW_PCR0="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    RUNNING_PCR0="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    # Canonical on disk = the NEW build (build.sh already clobbered it).
    printf '%s' "$NEW_PCR0" > "$ROOT/enclave/calypso-enclave.eif.pcr0"
    printf '%s' "$NEW_PCR0" > "$TESTDIR/release.eif.pcr0"
    printf '{"pcr0":"%s"}\n' "$NEW_PCR0" > "$ROOT/enclave/measurement.json"

    run env \
      EXPECTED_PCR0="$NEW_PCR0" \
      MOCK_RUNNING_PCR0="$RUNNING_PCR0" \
      CALYPSO_RELEASE_EIF_DIR="$TESTDIR/opt" \
      ENCLAVE_CID=16 ENCLAVE_PORT=5000 \
      ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS=0 \
      "$ROOT/enclave/scripts/deploy.sh" \
        --build-mode=release \
        --eif-path="$TESTDIR/release.eif"

    [ "$status" -ne 0 ]
    [[ "$output" == *"does not match the RUNNING enclave"* ]]
    [[ "$output" == *"doom-loop trap"* ]]
    # Critically: nothing was terminated, no new enclave launched.
    [ ! -f "$TERMINATED_FILE" ]
    [ ! -f "$RUN_COUNT_FILE" ]
}

# Companion: when the running enclave's real EIF IS available (staged in
# CALYPSO_RELEASE_EIF_DIR), capture_backup recovers it as the rollback target,
# so a failed cutover reverts to the RUNNING PCR0 — NOT the new bytes.
@test "recovers the running enclave's staged EIF as the rollback target on cutover failure" {
    NEW_PCR0="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    RUNNING_PCR0="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    printf '%s' "$NEW_PCR0" > "$ROOT/enclave/calypso-enclave.eif.pcr0"
    printf '%s' "$NEW_PCR0" > "$TESTDIR/release.eif.pcr0"
    printf '{"pcr0":"%s"}\n' "$NEW_PCR0" > "$ROOT/enclave/measurement.json"
    # Stage the running enclave's real EIF where the fast path keeps them.
    mkdir -p "$TESTDIR/opt"
    printf 'old-running-eif\n' > "$TESTDIR/opt/calypso-enclave-bbbbbbbb.eif"
    printf '%s' "$RUNNING_PCR0" > "$TESTDIR/opt/calypso-enclave-bbbbbbbb.eif.pcr0"

    # Health passes only after the 2nd run-enclave (new EIF fails → rollback).
    cat > "$ROOT/enclave/scripts/health-check.mjs" <<'NODE'
import { readFileSync } from "node:fs";
const runCount = Number(readFileSync(process.env.RUN_COUNT_FILE, "utf8"));
process.exit(runCount >= Number(process.env.HEALTH_PASS_AFTER_RUN ?? "1") ? 0 : 1);
NODE

    run env \
      EXPECTED_PCR0="$NEW_PCR0" \
      MOCK_RUNNING_PCR0="$RUNNING_PCR0" \
      CALYPSO_RELEASE_EIF_DIR="$TESTDIR/opt" \
      ENCLAVE_CID=16 ENCLAVE_PORT=5000 \
      ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS=0 \
      DEPLOY_HEALTH_TIMEOUT_SECONDS=6 \
      DEPLOY_HEALTH_RETRY_ATTEMPTS=0 \
      ROLLBACK_HEALTH_TIMEOUT_SECONDS=6 \
      HEALTH_PASS_AFTER_RUN=2 \
      RUN_COUNT_FILE="$RUN_COUNT_FILE" \
      "$ROOT/enclave/scripts/deploy.sh" \
        --build-mode=release \
        --eif-path="$TESTDIR/release.eif"

    [ "$status" -ne 0 ]
    [[ "$output" == *"rollback artefact for the RUNNING enclave located"* ]]
    [[ "$output" == *"restoring backup EIF $TESTDIR/opt/calypso-enclave-bbbbbbbb.eif"* ]]
    [[ "$output" == *"rolled back to PCR0=$RUNNING_PCR0 and confirmed healthy"* ]]
}
