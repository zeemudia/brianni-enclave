#!/usr/bin/env bash
# enclave/scripts/deploy.sh — Enclave EIF deployment with backup-swap-rollback.
#
# Thin wrapper around the existing reproducible build pipeline
# (enclave/build.sh) that handles the HOST-side choreography:
#
#   1. Preflight  — lockfile, nitro-cli on PATH, measurement.json present.
#   2. Backup current EIF — snapshot the running enclave's EIF to
#                           enclave/dist/backup/<old-pcr0>.eif so we have
#                           something to roll back to.
#   3. Build / fetch EIF  — ./enclave/build.sh --offline  (default) writes
#                           to the STAGING path, not canonical; in release
#                           mode the externally-supplied --eif-path=<path>
#                           is used as-is. Canonical ($EIF_PATH_CURRENT)
#                           stays pointed at the currently-running EIF
#                           until the new one proves healthy (Codex
#                           pass-4 MEDIUM — preserves the backup invariant
#                           across failed deploys).
#   4. Measurement gate   — describe-eif PCR0 must equal the pinned PCR0
#                           in enclave/measurement.json. Abort BEFORE the
#                           terminate step if it drifts — a mismatched
#                           measurement fails the client attestation
#                           handshake so every user sees the blocker.
#   5. Terminate current  — nitro-cli terminate-enclave --all.
#   6. Run new enclave    — nitro-cli run-enclave (cpu/memory/cid match
#                           the EC2 session playbook) pointing at the
#                           STAGED EIF.
#   7. Wait for health    — allow the enclave to finish its early boot
#                           window, then require 3 consecutive vsock
#                           HEALTH_PING ok reads.
#   8. On fail            — terminate the new enclave, rerun the backup,
#                           exit non-zero and point operator at runbook.
#                           Canonical path is untouched — next deploy's
#                           capture_backup still finds the previously-
#                           running EIF bytes.
#   9. Promote staged EIF — ONLY after wait_for_health passes: mv
#                           $EIF_PATH_STAGING -> $EIF_PATH_CURRENT.
#  10. Backup retention   — prune stale enclave/dist/backup/*.eif files.
#  11. Cleanup            — release lockfile, emit summary.
#
# Running enclaves experience ~5-10s downtime during step 5→7. This is
# inherent to the Nitro terminate/run sequence and matches the Phase 2
# spec.
#
# IMPORTANT: this script does NOT modify enclave/src/ or infra/docker/.
# A rebuild therefore produces the same PCR0 as the pinned measurement —
# drift here is a bug in the pipeline, not in deploy.sh.

set -euo pipefail
IFS=$'\n\t'

# ---------------------------------------------------------------------------
# Paths + defaults
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENCLAVE_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$ENCLAVE_DIR")"

EIF_PATH_CURRENT="$ENCLAVE_DIR/calypso-enclave.eif"
# Staging path used to hold the new EIF WHILE IT IS BEING HEALTH-CHECKED.
# The canonical path ($EIF_PATH_CURRENT) is only overwritten AFTER health
# passes, so a rollback always finds the previously-running EIF bytes
# at the canonical location (Codex pass-4 MEDIUM).
EIF_PATH_STAGING="$ENCLAVE_DIR/calypso-enclave.eif.staging"
BACKUP_DIR="$ENCLAVE_DIR/dist/backup"
MEASUREMENT_FILE="$ENCLAVE_DIR/measurement.json"
# Codex pass-5 CRITICAL: build.sh rewrites measurement.json with the
# freshly-built PCRs, so verifying the NEW EIF against the in-tree file
# after a build is a tautology. Before we invoke build.sh we copy the
# pinned measurement to MEASUREMENT_FILE_PREBUILD so the gate can
# compare the new EIF's PCR0 against the IMMUTABLE pre-build value. On
# mismatch the original file is restored from this copy.
MEASUREMENT_FILE_PREBUILD="$MEASUREMENT_FILE.pre-build"
LOCKFILE="/tmp/calypso-enclave-deploy.lock"
# Stale-lock threshold for the atomic acquire_lock. Matches
# server/scripts/deploy.sh default (30 minutes) — a run that wedged
# beyond that window is almost certainly dead and safe to clear.
LOCK_STALE_SECONDS="${CALYPSO_ENCLAVE_DEPLOY_LOCK_STALE:-1800}"

# Defaults match the Nitro release host profile.
: "${ENCLAVE_CID:=16}"
: "${ENCLAVE_PORT:=5000}"
: "${ENCLAVE_CPU_COUNT:=2}"
# Enclave RAM. The current release-class EIFs are ~2.43 GB and Nitro requires
# at least 4x the EIF size, so release hosts launch them with 10240 MiB. Earlier
# incidents attributed post-launch exits to 10240 MiB, but the reproduced
# 2026-06-01 failure was an over-eager health probe during the warmup window,
# not memory size: the same EIFs boot cleanly at 10240 MiB when probes wait.
: "${ENCLAVE_MEMORY_MB:=10240}"
: "${BUILD_MODE:=offline}"      # offline | release
# EXPECTED_PCR0 (optional): extra defense against a committed-but-wrong
# measurement.json — callers (CI, the release workflow) can pin the value
# independently and this script will refuse to proceed on any mismatch.
: "${EXPECTED_PCR0:=}"
# FORCE_ROTATE (flag, set via --force-rotate): skips the immutable
# pre-build PCR0 gate so operators can intentionally rotate PCR0 per the
# playbook. Default OFF — drift must be explicit, not accidental.
FORCE_ROTATE=0
# ALLOW_NO_BACKUP (flag, set via --allow-no-backup): break-glass override
# that lets capture_backup() skip the hard-fail when an enclave IS
# running but we cannot snapshot its EIF (missing canonical file,
# describe-eif failure, cp failure). Default OFF — operators must
# explicitly opt in; proceeding without a rollback artefact while an
# enclave is live means a failed new-EIF leaves the service dark.
ALLOW_NO_BACKUP=0
# NO_ROLLBACK (flag, set via --no-rollback): operator/debug mode that
# refuses to launch the rollback EIF when the replacement never becomes
# healthy. It intentionally leaves the candidate enclave running so the
# operator can run direct vsock probes and inspect host-side state.
NO_ROLLBACK=0
# DEPLOY_HEALTH_TIMEOUT_SECONDS: budget for the NEW enclave to warm up and
# answer vsock health. Real release warmup (KMS attested key fetch + sidecars)
# was ~75s for a3c35efd when the now-removed Presidio/spaCy model load
# dominated it; it is lower now, but the bigger doc-extraction EIF still
# warms slowly, so the old hardcoded 60s false-rolled-back a healthy enclave.
# Keep generous headroom.
: "${DEPLOY_HEALTH_TIMEOUT_SECONDS:=240}"
# ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS: do not touch the enclave's application
# vsock port immediately after `nitro-cli run-enclave` returns. On Nitro hosts, an
# early connect during the post-EnclaveID/pre-listen window has repeatedly
# caused the VM to hang up before startup completed. Give Node, KMS attested
# delivery and NSM sidecars a quiet warmup period, then start the
# normal 3-consecutive-ok probe loop. Tests set this to 0.
#
# Raised 90 -> 120 after the 2026-06-04 a1027f00 doom-loop: a COLD cutover
# warmed up at ~100s, so the first probe at 90s fired during the wedge-prone
# pre-listen window and the cutover false-failed. The manual recovery that
# succeeded used a ~100s warmup; 120s gives margin above that for cold boots.
# See docs/incidents/enclave-releases/2026-06-04-a1027f00-rotation-deploy-loop-closeout.md.
: "${ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS:=120}"
# ROLLBACK_HEALTH_TIMEOUT_SECONDS: budget for the rollback (last-known-good)
# enclave to come back. It also incurs the full warmup (KMS + sidecars),
# so 30s was far too tight — it declared "ROLLBACK ALSO FAILED" on an enclave
# that simply hadn't finished booting. Must exceed real warmup with margin.
: "${ROLLBACK_HEALTH_TIMEOUT_SECONDS:=180}"
# DEPLOY_HEALTH_RETRY_ATTEMPTS: number of extra same-EIF launches to try before
# rollback when the replacement enclave loads but never becomes healthy. Nitro
# has shown occasional same-bytes/same-PCR0 boot flakes on Nitro hosts, so the
# release path treats one failed health gate like CI treats flaky
# infrastructure: retry the verified artefact once, then rollback if it still
# cannot serve health.
: "${DEPLOY_HEALTH_RETRY_ATTEMPTS:=1}"
# DEPLOY_HEALTH_RETRY_COOLDOWN_SECONDS: quiet period between same-EIF relaunch
# attempts so Nitro can release CID/memory resources and the host-side vsock
# stack can settle.
: "${DEPLOY_HEALTH_RETRY_COOLDOWN_SECONDS:=10}"
# Nitro can take a few seconds to release memory/CID resources after
# terminate-enclave returns. Wait for describe-enclaves to go empty before
# trying to run the replacement EIF, otherwise run-enclave can fail with E29.
: "${ENCLAVE_SHUTDOWN_TIMEOUT_SECONDS:=15}"
# CALYPSO_RELEASE_EIF_DIR: directory where the pre-launch fast path stages
# release EIFs as calypso-enclave-<first8>.eif. Used by capture_backup to
# locate the RUNNING enclave's actual EIF as a rollback source when the
# canonical path has been overwritten out-of-band (e.g. a manual
# `build.sh --offline` before a release-mode deploy — the a1027f00 trap).
: "${CALYPSO_RELEASE_EIF_DIR:=/opt/calypso/enclave}"
# ENCLAVE_BACKUP_RETENTION_COUNT: number of successful-deploy rollback
# snapshots to keep in enclave/dist/backup. The live/rollback release EIFs in
# CALYPSO_RELEASE_EIF_DIR are managed separately by the PCR0 rotation playbook;
# this only prevents the local deploy backup directory from growing forever.
: "${ENCLAVE_BACKUP_RETENTION_COUNT:=2}"

EIF_PATH_OVERRIDE=""
SUDO_NITRO_CLI=""

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
log()  { printf '[deploy] %s\n' "$*" >&2; }
warn() { printf '[deploy] warn: %s\n' "$*" >&2; }
die()  { printf '[deploy] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
enclave/scripts/deploy.sh — Deploy a new enclave EIF with backup-swap-rollback.

Usage:
  ./enclave/scripts/deploy.sh [options]

Options:
  --build-mode=<offline|release>
      offline (default): run ./enclave/build.sh --offline to produce a fresh
                         reproducible EIF on this host.
      release          : use --eif-path=<path> as the new EIF; no build.
  --eif-path=<path>
      Path to a pre-built EIF (required with --build-mode=release). MUST
      NOT equal the canonical path (enclave/calypso-enclave.eif) — stage
      release artefacts at a distinct location (e.g. /tmp/release-<sha>.eif)
      so the backup capture step can snapshot the last-known-good EIF.
  --force-rotate
      (offline mode only) Skip the immutable pre-build PCR0 gate. Use
      ONLY when intentionally rotating PCR0 per the playbook — a drifted/
      non-reproducible build will be accepted. Must be paired with a
      deliberate measurement rotation recorded in enclave/measurement.json
      and VERIFICATIONS.md.
      REFUSED in release mode: release mode does not invoke build.sh so
      measurement.json is never rewritten; rotate the pinned PCR0 via
      the release PR workflow instead.
  --allow-no-backup
      BREAK-GLASS. When an enclave IS running but we cannot capture the
      rollback artefact (canonical EIF missing, describe-eif failure,
      cp failure), capture_backup() normally hard-fails to protect the
      operator from a rollback-impossible deploy. This flag downgrades
      that failure to a warning. PASS ONLY if you have a separate
      rollback plan (e.g. you are doing an emergency bring-up where the
      running enclave is known-broken and cannot serve traffic anyway).
      First-boot deploys (no running enclave) do NOT need this flag.
  --no-rollback
      DEBUG/OPERATOR MODE. If the replacement enclave launches but never
      becomes healthy, do NOT terminate it and do NOT launch the backup EIF.
      Leave the candidate running for direct vsock inspection. This is useful
      during pre-launch fast-path rotations when the operator wants to finish
      forward manually after validating the candidate.
  --help, -h
      Show this help.

Environment:
  ENCLAVE_CID          (default 16)    Enclave vsock CID.
  ENCLAVE_PORT         (default 5000)  vsock health-check port.
  ENCLAVE_CPU_COUNT    (default 2)
  ENCLAVE_MEMORY_MB    (default 10240)
  ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS
                       (default 120)   Quiet warmup after run-enclave before
                                       the first vsock health probe.
  EXPECTED_PCR0        (optional)      If set, abort unless it equals the
                                       PCR0 in enclave/measurement.json.
  ROLLBACK_HEALTH_TIMEOUT_SECONDS
                       (default 180)   Budget for the rollback-target
                                       health probe.
  DEPLOY_HEALTH_RETRY_ATTEMPTS
                       (default 1)     Extra same-EIF launch attempts before
                                       rollback when the new enclave does not
                                       answer health.
  DEPLOY_HEALTH_RETRY_COOLDOWN_SECONDS
                       (default 10)    Quiet wait before a same-EIF retry.
  ENCLAVE_SHUTDOWN_TIMEOUT_SECONDS
                       (default 15)    Budget for Nitro to release the old
                                       enclave's memory/CID after terminate.
  ENCLAVE_BACKUP_RETENTION_COUNT
                       (default 2)     Number of enclave/dist/backup/*.eif
                                       snapshots to retain after a successful
                                       deploy. Set 0 to prune all deploy
                                       backups after promotion.

Exit codes:
  0   — new enclave healthy.
  >0  — rollback attempted (or required operator intervention).

Pre-conditions:
  - nitro-cli installed (aws-nitro-enclaves-cli on AL2023).
  - enclave/measurement.json checked in for the commit being deployed.
  - On a Nitro EC2 host with vsock connectivity to CID=16.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --help|-h)            usage; exit 0 ;;
    --build-mode=*)       BUILD_MODE="${arg#--build-mode=}" ;;
    --eif-path=*)         EIF_PATH_OVERRIDE="${arg#--eif-path=}" ;;
    --force-rotate)       FORCE_ROTATE=1 ;;
    --allow-no-backup)    ALLOW_NO_BACKUP=1 ;;
    --no-rollback)        NO_ROLLBACK=1 ;;
    *)                    die "unknown argument: $arg (use --help)" ;;
  esac
done

if [ "$BUILD_MODE" = "release" ] && [ -z "$EIF_PATH_OVERRIDE" ]; then
  die "--build-mode=release requires --eif-path=<path>."
fi

# Codex pass-6 HIGH-2: refuse release-mode --eif-path that resolves to
# the canonical path. capture_backup() copies $EIF_PATH_CURRENT as the
# rollback source BEFORE the new EIF is validated, so if the operator
# stages a release artefact AT the canonical path, the backup is the
# new (possibly broken) bytes. On health fail, rollback then launches
# the same broken EIF and the rollback target is guaranteed to fail.
#
# Reject the overlap up-front so operators stage release EIFs at a
# distinct path (e.g. /tmp/release-<sha>.eif). Normalise both sides
# via readlink -f so a relative path + a symlink cannot sneak past
# a string compare.
#
# Codex pass-6 HIGH-2: release-mode --force-rotate is also refused
# (below) because build.sh is not invoked in release mode, so
# measurement.json is never rewritten. See the --force-rotate guard
# further down in arg parsing.
if [ "$BUILD_MODE" = "release" ]; then
  override_abs="$(readlink -f "$EIF_PATH_OVERRIDE" 2>/dev/null || echo "$EIF_PATH_OVERRIDE")"
  canonical_abs="$(readlink -f "$EIF_PATH_CURRENT" 2>/dev/null || echo "$EIF_PATH_CURRENT")"
  if [ "$override_abs" = "$canonical_abs" ]; then
    die "--eif-path must not equal the canonical path ($EIF_PATH_CURRENT). Stage your release EIF at a distinct location (e.g. /tmp/release-<sha>.eif) so capture_backup can snapshot the LAST-KNOWN-GOOD EIF — otherwise a failed deploy would roll back to the same broken bytes."
  fi
fi

# Codex pass-6 MEDIUM-2: --force-rotate is meaningless in release mode
# because build_or_fetch_eif does NOT invoke build.sh — the supplied
# --eif-path is used as-is and measurement.json is never rewritten.
# Accepting the flag here would silently mask PCR0 drift: the running
# enclave would be on a NEW PCR0 while the git-tracked pin still
# reflected the OLD value. Force operators to rotate the pin via the
# release PR workflow so the change is auditable.
if [ "$BUILD_MODE" = "release" ] && [ "$FORCE_ROTATE" = "1" ]; then
  die "--force-rotate is not supported in release mode. In release mode the deploy pipeline does not regenerate measurement.json, so the pinned PCR0 would silently drift from the running enclave. To rotate the pinned PCR0 for a release artefact:
  1. Update enclave/measurement.json in the source repository to match the release EIF's PCR0 (nitro-cli describe-eif --eif-path <file> | jq '.Measurements.PCR0').
  2. Commit + push + merge via PR so the change is auditable.
  3. Re-run deploy.sh WITHOUT --force-rotate.
The measurement gate will pass naturally once measurement.json matches."
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
preflight() {
  command -v nitro-cli >/dev/null 2>&1 \
    || die "nitro-cli not on PATH. Install aws-nitro-enclaves-cli."

  for numeric_env in \
    DEPLOY_HEALTH_TIMEOUT_SECONDS \
    ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS \
    ROLLBACK_HEALTH_TIMEOUT_SECONDS \
    DEPLOY_HEALTH_RETRY_ATTEMPTS \
    DEPLOY_HEALTH_RETRY_COOLDOWN_SECONDS \
    ENCLAVE_SHUTDOWN_TIMEOUT_SECONDS \
    ENCLAVE_BACKUP_RETENTION_COUNT; do
    numeric_value="${!numeric_env}"
    case "$numeric_value" in
      ''|*[!0-9]*)
        die "$numeric_env must be a non-negative integer, got: $numeric_value"
        ;;
    esac
  done

  # Check if we need sudo for nitro-cli commands
  if [ "$(id -u)" -eq 0 ]; then
    SUDO_NITRO_CLI=""
  elif sudo -n nitro-cli describe-enclaves >/dev/null 2>&1; then
    SUDO_NITRO_CLI="sudo"
  elif nitro-cli describe-enclaves >/dev/null 2>&1; then
    SUDO_NITRO_CLI=""
  else
    die "Cannot execute nitro-cli. Make sure you are root, in the 'ne' group, or have passwordless sudo access for nitro-cli."
  fi

  command -v jq >/dev/null 2>&1 \
    || die "jq not on PATH."
  command -v node >/dev/null 2>&1 \
    || die "node not on PATH (needed for health-check.mjs)."

  [ -f "$MEASUREMENT_FILE" ] \
    || die "enclave/measurement.json missing. Rebuild with enclave/build.sh first."

  local pinned
  pinned="$(jq -r '.pcr0' "$MEASUREMENT_FILE")"
  [ -n "$pinned" ] && [ "$pinned" != "null" ] \
    || die "enclave/measurement.json has no pcr0 field."

  if [ -n "$EXPECTED_PCR0" ] && [ "$EXPECTED_PCR0" != "$pinned" ]; then
    die "EXPECTED_PCR0 ($EXPECTED_PCR0) does not match measurement.json PCR0 ($pinned). Refusing to deploy."
  fi

  log "pinned PCR0 = $pinned"
}

# Flock-style single-instance guard. Releasing the lockfile happens in
# cleanup() via the EXIT trap.
#
# Codex pass-5 HIGH-2: previous `[ -e … ] && …; else write …` variant had
# a TOCTOU window where two simultaneous invocations could both observe
# "no lock" and both proceed. We now use `set -C` (noclobber) to create
# the lockfile ATOMICALLY — only one process wins. Mirrors the pattern in
# server/scripts/deploy.sh (phase 1 preflight). Stale locks older than
# LOCK_STALE_SECONDS are cleared with a single retry so the rare dead-
# lock from a crashed previous run doesn't require manual intervention.
#
# Codex pass-7 CRITICAL: track LOCK_HELD ownership. The EXIT trap is
# installed at top-level (BEFORE acquire_lock runs), so a die() on the
# "another deploy in progress" branch would otherwise still execute
# cleanup() and rm -f the lockfile of the deploy that legitimately
# holds it — letting a third invocation race in. Only remove the lock
# in cleanup() if THIS process actually acquired it.
LOCK_HELD=0

# Codex pass-9 HIGH-2: transactional guard for measurement.json. The
# EXIT trap's cleanup_prebuild_measurement used to unconditionally
# DELETE $MEASUREMENT_FILE_PREBUILD, so a set -e abort AFTER build.sh
# rewrote measurement.json but BEFORE verify_measurement's explicit
# restore branch ran would leave the git-tracked file silently rotated
# to an EIF that never shipped. We now flip DEPLOY_SUCCEEDED=1 only on
# the full-success path in main(); the EXIT trap RESTORES the pre-build
# copy on any non-success exit, DELETES it on success.
DEPLOY_SUCCEEDED=0

acquire_lock() {
  local payload
  payload="pid=$$ started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if ( set -C; printf '%s\n' "$payload" > "$LOCKFILE" ) 2>/dev/null; then
    LOCK_HELD=1
    return 0
  fi

  # Lock exists. Check staleness — allow auto-clear only if older than
  # LOCK_STALE_SECONDS.
  local lock_mtime now age
  lock_mtime="$(stat -c %Y "$LOCKFILE" 2>/dev/null || stat -f %m "$LOCKFILE" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  age=$(( now - lock_mtime ))

  if (( age > LOCK_STALE_SECONDS )); then
    warn "stale lock (${age}s > ${LOCK_STALE_SECONDS}s threshold). Clearing and retrying."
    rm -f "$LOCKFILE"
    if ( set -C; printf '%s\n' "$payload" > "$LOCKFILE" ) 2>/dev/null; then
      LOCK_HELD=1
      return 0
    fi
    die "could not acquire lock even after clearing stale entry (lockfile=$LOCKFILE)."
  fi

  local holder
  holder="$(cat "$LOCKFILE" 2>/dev/null || true)"
  die "another deploy is in progress (holder=$holder, age=${age}s, lockfile=$LOCKFILE)."
}

cleanup() {
  # Codex pass-7 CRITICAL: only remove the lockfile if THIS process
  # actually acquired it. Otherwise a die() on "another deploy in
  # progress" would clobber the holder's lock and let a third process
  # race in.
  if [ "$LOCK_HELD" = "1" ]; then
    rm -f "$LOCKFILE" 2>/dev/null || true
  fi
  cleanup_staging
  cleanup_prebuild_measurement
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 2: Build or fetch EIF
# ---------------------------------------------------------------------------
build_or_fetch_eif() {
  # Codex pass-5 CRITICAL: capture the pinned PCR0 from the pre-build
  # state BEFORE any step that could rewrite measurement.json. In
  # offline mode build.sh rewrites the file with the freshly-built
  # PCRs; in release mode we keep the same gate for symmetry so the
  # supplied --eif-path is verified against the measurement pinned in
  # git. EXPECTED_PCR0_PRE_BUILD is the IMMUTABLE source of truth
  # for verify_measurement() later in main(). Without it, a drifted
  # or non-reproducible build would silently rotate the pinned value
  # because describe-eif would agree with the just-written file.
  EXPECTED_PCR0_PRE_BUILD="$(jq -r '.pcr0 // empty' "$MEASUREMENT_FILE" 2>/dev/null || echo "")"
  if [ -z "$EXPECTED_PCR0_PRE_BUILD" ]; then
    die "cannot read pinned PCR0 from $MEASUREMENT_FILE — is this a fresh clone without measurement.json? First-boot deploys must set EXPECTED_PCR0 explicitly via env or use --force-rotate. See enclave/README.md and VERIFICATIONS.md."
  fi
  log "pinned PCR0 before build: $EXPECTED_PCR0_PRE_BUILD"

  # Preserve the pre-build measurement so a failed gate can restore
  # the tracked file that build.sh would otherwise leave rewritten.
  # cleanup_prebuild_measurement (invoked from the EXIT trap) deletes
  # this file on successful match; verify_measurement() restores it
  # on mismatch before die()ing.
  cp "$MEASUREMENT_FILE" "$MEASUREMENT_FILE_PREBUILD"

  if [ "$BUILD_MODE" = "release" ]; then
    [ -f "$EIF_PATH_OVERRIDE" ] \
      || die "--eif-path=$EIF_PATH_OVERRIDE does not exist."
    log "using pre-built EIF: $EIF_PATH_OVERRIDE"
    NEW_EIF_PATH="$EIF_PATH_OVERRIDE"
    return
  fi

  # Offline mode: enclave/build.sh emits to $EIF_PATH_CURRENT
  # unconditionally. Codex pass-4 MEDIUM: we must NOT let build.sh
  # clobber the currently-running EIF at the canonical path before
  # health is proven — otherwise a rollback would have nowhere to
  # restore from. Strategy:
  #   1. capture_backup (called before this step) already snapshotted
  #      the currently-running EIF bytes at $EIF_PATH_CURRENT into
  #      $BACKUP_DIR/<OLD_PCR0>.eif — that's the rollback source.
  #   2. After build.sh finishes, MOVE its output to $EIF_PATH_STAGING
  #      and RESTORE the previous canonical bytes from the backup we
  #      just took, so $EIF_PATH_CURRENT reflects the still-running
  #      EIF until we prove the new one healthy (post-health step
  #      promotes staging -> canonical).
  log "running enclave/build.sh --offline …"
  ( cd "$ROOT_DIR" && "$ENCLAVE_DIR/build.sh" --offline )
  [ -f "$EIF_PATH_CURRENT" ] \
    || die "build.sh completed but $EIF_PATH_CURRENT is missing."

  # Move build.sh's output to the staging path BEFORE touching
  # the canonical. If the mv fails, abort before we mutate canonical.
  rm -f "$EIF_PATH_STAGING"
  mv "$EIF_PATH_CURRENT" "$EIF_PATH_STAGING" \
    || die "failed to stage new EIF: mv $EIF_PATH_CURRENT -> $EIF_PATH_STAGING"

  # Restore the previous canonical bytes from the backup we took in
  # step 4. If no backup exists (first-boot), the canonical path is
  # simply absent until post-health promotion — capture_backup on the
  # NEXT deploy will see an empty BACKUP_PATH and log the limitation
  # as it already does today.
  if [ -n "${BACKUP_PATH:-}" ] && [ -f "$BACKUP_PATH" ]; then
    cp "$BACKUP_PATH" "$EIF_PATH_CURRENT" \
      || die "failed to restore previous canonical EIF from $BACKUP_PATH — filesystem state inconsistent"
    log "staged new EIF at $EIF_PATH_STAGING; canonical path still reflects previous (running) EIF"
  else
    log "staged new EIF at $EIF_PATH_STAGING; no previous backup to restore at canonical path (first-boot or prior clobber)"
  fi

  NEW_EIF_PATH="$EIF_PATH_STAGING"
}

# ---------------------------------------------------------------------------
# Step 3: Measurement gate
# ---------------------------------------------------------------------------
# Codex pass-5 CRITICAL: this gate protects against a non-reproducible
# build silently rotating the pinned measurement. In offline mode
# enclave/build.sh rewrites enclave/measurement.json with the PCRs of
# the image it just produced; comparing describe-eif against that
# freshly-rewritten file is a tautology. We compare against the
# IMMUTABLE EXPECTED_PCR0_PRE_BUILD captured by build_or_fetch_eif
# before the build ran.
#
# On mismatch we restore $MEASUREMENT_FILE from the pre-build copy so
# a drifted deploy does not leave the tracked file silently rewritten,
# and then die() before terminate-enclave fires.
#
# Operators who intentionally want to rotate PCR0 must pass
# --force-rotate; the captured EXPECTED_PCR0_PRE_BUILD is still logged
# for audit but the mismatch is downgraded to a warning.
verify_measurement() {
  local expected actual
  expected="$EXPECTED_PCR0_PRE_BUILD"
  actual="$(${SUDO_NITRO_CLI:-} nitro-cli describe-eif --eif-path "$NEW_EIF_PATH" \
            | jq -r '.Measurements.PCR0')"

  if [ -z "$actual" ] || [ "$actual" = "null" ]; then
    # Restore measurement.json that build.sh overwrote so the tracked
    # file is never left silently rotated by a failed verify.
    if [ -f "$MEASUREMENT_FILE_PREBUILD" ]; then
      mv "$MEASUREMENT_FILE_PREBUILD" "$MEASUREMENT_FILE"
    fi
    die "describe-eif returned no PCR0 for $NEW_EIF_PATH."
  fi

  if [ "$actual" != "$expected" ]; then
    if [ "$FORCE_ROTATE" = "1" ]; then
      warn "EIF PCR0 ($actual) != pinned ($expected) but --force-rotate set. Accepting rotation. measurement.json now reflects the new PCR0."
      # Leave the freshly-written measurement.json in place (rotation
      # intent). The pre-build copy is removed on successful exit by
      # cleanup_prebuild_measurement.
    else
      # Restore measurement.json that build.sh overwrote. The pre-build
      # copy is authoritative — on mismatch the git-tracked file must
      # not silently rotate.
      if [ -f "$MEASUREMENT_FILE_PREBUILD" ]; then
        mv "$MEASUREMENT_FILE_PREBUILD" "$MEASUREMENT_FILE"
      fi
      die "EIF PCR0 ($actual) does not match pinned PCR0 ($expected). Drift detected — refusing to rotate without explicit --force-rotate. See enclave/README.md and VERIFICATIONS.md. Aborting BEFORE terminate-enclave."
    fi
  fi

  log "measurement gate passed (PCR0=$actual, pinned=$expected)."
}

# Codex pass-9 HIGH-2: transactional pre-build measurement handling.
# Success path (DEPLOY_SUCCEEDED=1) — the in-place measurement.json
# reflects the shipped state (either unchanged or an intentional
# --force-rotate rotation); the pre-build copy is redundant and gets
# deleted. ANY FAILURE PATH (DEPLOY_SUCCEEDED=0) — the pre-build copy
# is restored over measurement.json so a failed build cannot silently
# rotate the pinned value. This closes the window where build.sh
# rewrites measurement.json, then a subsequent step (describe-eif,
# terminate_and_run, wait_for_health, …) aborts under set -e before
# verify_measurement's inline restore branch could execute — the old
# trap would have deleted the pre-build copy, leaving the git-tracked
# PCR0 pointed at an un-shipped EIF.
#
# Note: verify_measurement() still performs an EAGER restore on an
# explicit mismatch die() — that path leaves no file behind, so this
# trap is a no-op there.
cleanup_prebuild_measurement() {
  if [ ! -f "$MEASUREMENT_FILE_PREBUILD" ]; then
    return 0
  fi
  if [ "$DEPLOY_SUCCEEDED" = "1" ]; then
    rm -f "$MEASUREMENT_FILE_PREBUILD" 2>/dev/null || true
    return 0
  fi
  if mv "$MEASUREMENT_FILE_PREBUILD" "$MEASUREMENT_FILE" 2>/dev/null; then
    log "deploy did not succeed — restored $MEASUREMENT_FILE from pre-build copy (pinned PCR0 preserved)."
  else
    warn "could not restore $MEASUREMENT_FILE from $MEASUREMENT_FILE_PREBUILD — operator must manually revert enclave/measurement.json before retrying."
  fi
}

# ---------------------------------------------------------------------------
# Step 7b: Promote the staged EIF to the canonical path AFTER health.
# ---------------------------------------------------------------------------
# Codex pass-4 MEDIUM: the canonical on-disk EIF ($EIF_PATH_CURRENT) is
# the source of truth for the NEXT deploy's capture_backup. It must
# ALWAYS reflect the currently-running EIF. The previous ordering
# persisted it pre-launch, which meant a failed-build + rollback left
# the canonical path pointing at the broken release — the next deploy
# would then snapshot the wrong image as its "previous" backup.
#
# New ordering (uniform for both build modes):
#   - build_or_fetch_eif writes to $EIF_PATH_STAGING (offline mode
#     further restores canonical from the backup we just took).
#   - terminate_and_run launches the STAGED EIF via nitro-cli.
#   - wait_for_health proves the new enclave works.
#   - THIS function (called AFTER wait_for_health passes) moves
#     $EIF_PATH_STAGING -> $EIF_PATH_CURRENT.
#
# If rollback() fires, $EIF_PATH_STAGING is left in place (or cleaned
# up by the EXIT trap via cleanup_staging) and canonical is untouched —
# the next capture_backup still finds the previously-running EIF bytes.
persist_canonical_eif() {
  if [ ! -f "$EIF_PATH_STAGING" ]; then
    # Either first-boot release-mode deploy from an arbitrary path
    # where NEW_EIF_PATH != staging, or an already-promoted EIF.
    # Fall back to the release-mode copy-from-NEW_EIF_PATH path.
    #
    # Codex pass-5 HIGH-1: previous `cp NEW_EIF_PATH EIF_PATH_CURRENT`
    # was non-atomic — an interrupt (Ctrl+C, disk full, SIGKILL) mid-cp
    # could truncate the canonical EIF. The next deploy's
    # capture_backup() would then snapshot garbage. Write to a temp
    # sibling on the SAME filesystem and atomically rename. The temp
    # path is registered for cleanup so an interrupt leaves no
    # ${CANONICAL}.new.* litter around.
    if [ "$BUILD_MODE" = "release" ] && [ "$NEW_EIF_PATH" != "$EIF_PATH_CURRENT" ]; then
      local temp_eif="${EIF_PATH_CURRENT}.new.$$"
      CANONICAL_TEMP_EIF="$temp_eif"
      cp "$NEW_EIF_PATH" "$temp_eif" \
        || { rm -f "$temp_eif" 2>/dev/null || true; die "failed to stage release EIF at $temp_eif"; }
      mv "$temp_eif" "$EIF_PATH_CURRENT" \
        || { rm -f "$temp_eif" 2>/dev/null || true; die "failed to promote release EIF atomically: mv $temp_eif -> $EIF_PATH_CURRENT"; }
      CANONICAL_TEMP_EIF=""
      log "Copied release EIF to canonical path $EIF_PATH_CURRENT via atomic rename (backup invariant preserved)"
    fi
    return
  fi

  # Offline-mode promotion: staging -> canonical. `mv` on the same
  # filesystem is atomic so this path was already safe — we only
  # explicitly document the invariant here.
  mv "$EIF_PATH_STAGING" "$EIF_PATH_CURRENT" \
    || die "failed to promote staged EIF to canonical: mv $EIF_PATH_STAGING -> $EIF_PATH_CURRENT"
  log "promoted staged EIF to canonical path $EIF_PATH_CURRENT (backup invariant preserved)"
}

# Best-effort cleanup of a leftover staging file on abnormal exit.
cleanup_staging() {
  [ -f "$EIF_PATH_STAGING" ] && rm -f "$EIF_PATH_STAGING" 2>/dev/null || true
  # Also sweep up any half-written canonical temp file from an
  # interrupted release-mode atomic promote.
  if [ -n "${CANONICAL_TEMP_EIF:-}" ] && [ -f "$CANONICAL_TEMP_EIF" ]; then
    rm -f "$CANONICAL_TEMP_EIF" 2>/dev/null || true
  fi
}

# Tracks the in-flight temp file used by release-mode atomic promote
# so cleanup_staging can sweep it on abnormal exit.
CANONICAL_TEMP_EIF=""

# ---------------------------------------------------------------------------
# Step 4: Backup current enclave's EIF
# ---------------------------------------------------------------------------
# We can't recover the literal on-disk EIF that was passed to run-enclave
# if it has since been overwritten. For builds produced by this repo we
# rely on the invariant that a deploy always leaves the last-known-good
# EIF at $EIF_PATH_CURRENT until the next deploy overwrites it. If the
# file has been clobbered between deploys, we can't back it up — record
# the limitation and continue so the operator at least gets the new EIF.
#
# Codex pass-7 HIGH: derive OLD_PCR0 from the CANONICAL EIF FILE itself
# rather than from measurement.json. In the release-mode workflow the
# operator updates measurement.json to the NEW release's PCR0 BEFORE
# running deploy.sh (per the pass-6 --force-rotate guidance), so trusting
# the file would mislabel the backup AND trip the previous drift check
# (canonical_pcr0 != pinned) on every release-mode deploy. The canonical
# EIF on disk IS the currently-running image — `nitro-cli describe-eif`
# is the authoritative source for its real PCR0, and that's what we want
# to label the backup with regardless of what measurement.json says.
#
# Codex pass-8 HIGH-1: fail CLOSED when an enclave IS running but
# backup capture fails. Previous behaviour (warn-and-continue) meant
# terminate_and_run would tear down the live enclave with NO rollback
# source on disk — a failed new EIF then dropped the service with no
# automated recovery path. The only safe default when an enclave is
# live and backup is unrecoverable is to refuse the deploy; operators
# who genuinely need break-glass behaviour (emergency bring-up over a
# known-broken live enclave) opt in via --allow-no-backup.
#
# Codex pass-9 HIGH-1: DECOUPLE "is there an EIF on disk to snapshot?"
# from "is an enclave currently running?". After a host reboot the
# enclave is NOT running but $EIF_PATH_CURRENT likely still holds the
# previously-shipped good image — that's a legitimate rollback target.
# Previous logic returned early on "no running enclave" and skipped the
# snapshot entirely, so build.sh then clobbered the canonical EIF with
# no rollback artefact. The running-enclave check now only decides
# whether a backup FAILURE is fatal (die) or non-fatal (warn and
# continue); the snapshot attempt itself is driven purely by
# "does $EIF_PATH_CURRENT exist?".
capture_backup() {
  OLD_ENCLAVE_JSON="$(${SUDO_NITRO_CLI:-} nitro-cli describe-enclaves 2>/dev/null || echo '[]')"
  OLD_ENCLAVE_ID="$(jq -r '.[0].EnclaveID // empty' <<<"$OLD_ENCLAVE_JSON")"
  BACKUP_PATH=""
  OLD_PCR0=""

  # Case A: no canonical EIF on disk AT ALL. There's literally nothing
  # to snapshot — first-boot or disk-loss case. Fatal only if an
  # enclave IS running (the running state would then be orphaned from
  # any rollback target).
  if [ ! -f "$EIF_PATH_CURRENT" ]; then
    if [ -n "$OLD_ENCLAVE_ID" ]; then
      if [ "$ALLOW_NO_BACKUP" = "1" ]; then
        warn "canonical EIF $EIF_PATH_CURRENT missing but enclave ID=$OLD_ENCLAVE_ID is running. --allow-no-backup set → proceeding without rollback artefact. Operator assumes responsibility."
        return 0
      fi
      die "cannot capture backup: canonical EIF at $EIF_PATH_CURRENT is missing but an enclave (ID=$OLD_ENCLAVE_ID) is running. Refusing to proceed without rollback artefact. To override (break-glass), re-run with --allow-no-backup. See enclave/README.md and VERIFICATIONS.md."
    fi
    log "no canonical EIF on disk and no enclave running — first-boot deploy (no backup to capture)."
    return 0
  fi

  # Case B: canonical EIF exists. Snapshot it regardless of whether
  # an enclave is currently running. Post-reboot deploys now retain
  # rollback coverage because the last-known-good EIF on disk is
  # preserved before build.sh clobbers it.
  #
  # Read the actual PCR0 from the canonical EIF — authoritative for
  # rollback labelling. Do NOT use measurement.json: in release mode the
  # operator has already rotated it to the NEW PCR0 before invoking
  # deploy.sh, so it would mislabel the backup file.
  OLD_PCR0="$(${SUDO_NITRO_CLI:-} nitro-cli describe-eif --eif-path "$EIF_PATH_CURRENT" 2>/dev/null \
              | jq -r '.Measurements.PCR0 // empty' 2>/dev/null || echo "")"
  if [ -z "$OLD_PCR0" ]; then
    if [ -n "$OLD_ENCLAVE_ID" ] && [ "$ALLOW_NO_BACKUP" != "1" ]; then
      die "cannot capture backup: nitro-cli describe-eif failed on $EIF_PATH_CURRENT. Enclave ID=$OLD_ENCLAVE_ID is running. Refusing to proceed. Check disk integrity and nitro-cli state. Override with --allow-no-backup only if you have a separate rollback plan."
    fi
    if [ -n "$OLD_ENCLAVE_ID" ]; then
      warn "nitro-cli describe-eif failed on canonical $EIF_PATH_CURRENT (enclave ID=$OLD_ENCLAVE_ID is running). --allow-no-backup set → proceeding without rollback artefact. Operator assumes responsibility."
    else
      warn "nitro-cli describe-eif failed on canonical $EIF_PATH_CURRENT and no enclave is running — no backup captured (non-fatal: no live service to protect)."
    fi
    return 0
  fi

  # a1027f00 doom-loop fix (2026-06-04 closeout): the canonical EIF is only a
  # valid rollback source if it still matches the RUNNING enclave. In the
  # pre-launch fast path the operator runs `build.sh --offline` (which
  # overwrites the canonical with the NEW bytes) and THEN calls this script in
  # release mode, so the canonical no longer reflects the running enclave. A
  # canonical-based backup would then make rollback() relaunch the NEW (failing)
  # EIF instead of reverting — a relaunch/probe/rollback doom loop that drops the
  # service. The running enclave's true PCR0 is reported by describe-enclaves;
  # compare it to the canonical's PCR0 and, on mismatch, recover a real rollback
  # artefact or fail CLOSED *before* terminate_and_run tears down the live enclave.
  local running_pcr0
  running_pcr0="$(jq -r '.[0].Measurements.PCR0 // empty' <<<"$OLD_ENCLAVE_JSON" 2>/dev/null || echo "")"
  if [ -n "$OLD_ENCLAVE_ID" ] && [ -n "$running_pcr0" ] && [ "$running_pcr0" != "$OLD_PCR0" ]; then
    warn "canonical EIF PCR0 ($OLD_PCR0) does NOT match the running enclave PCR0 ($running_pcr0) — the canonical was overwritten out-of-band (did build.sh run before this deploy?). It is NOT a valid rollback source."
    local candidate found="" cand_pcr0
    # Release artefacts in CALYPSO_RELEASE_EIF_DIR are named with an 8-hex PCR0
    # prefix (calypso-enclave-<first8>.eif, git short-SHA style), so ${running_pcr0:0:8}
    # reproduces that naming convention to locate the running enclave's EIF.
    for candidate in \
      "$BACKUP_DIR/${running_pcr0}.eif" \
      "${CALYPSO_RELEASE_EIF_DIR}/calypso-enclave-${running_pcr0:0:8}.eif"; do
      [ -f "$candidate" ] || continue
      cand_pcr0="$(${SUDO_NITRO_CLI:-} nitro-cli describe-eif --eif-path "$candidate" 2>/dev/null \
                   | jq -r '.Measurements.PCR0 // empty' 2>/dev/null || echo "")"
      if [ "$cand_pcr0" = "$running_pcr0" ]; then found="$candidate"; break; fi
    done
    if [ -n "$found" ]; then
      OLD_PCR0="$running_pcr0"
      BACKUP_PATH="$found"
      log "rollback artefact for the RUNNING enclave located: $BACKUP_PATH (pcr0=$running_pcr0). Canonical ($EIF_PATH_CURRENT) is the new build and will NOT be used for rollback."
      return 0
    fi
    if [ "$ALLOW_NO_BACKUP" = "1" ]; then
      BACKUP_PATH=""
      warn "no rollback EIF for the running enclave (pcr0=$running_pcr0) found in $BACKUP_DIR or $CALYPSO_RELEASE_EIF_DIR. --allow-no-backup set → proceeding without a rollback artefact. Operator assumes responsibility."
      return 0
    fi
    die "cannot capture a valid rollback artefact: the canonical EIF ($EIF_PATH_CURRENT, pcr0=$OLD_PCR0) does not match the RUNNING enclave (pcr0=$running_pcr0), and no EIF for the running PCR0 was found in $BACKUP_DIR or $CALYPSO_RELEASE_EIF_DIR. This is the a1027f00 doom-loop trap: build.sh overwrote the canonical with the new bytes, so a failed cutover would relaunch the NEW EIF instead of reverting. Fix: stage the running enclave's EIF at $BACKUP_DIR/${running_pcr0}.eif (cp the file you originally launched it from), then retry; or re-run with --allow-no-backup if you have a manual rollback plan. Nothing has been terminated — the live enclave is untouched. See docs/incidents/enclave-releases/2026-06-04-a1027f00-rotation-deploy-loop-closeout.md."
  fi

  log "snapshotting canonical EIF: pcr0=$OLD_PCR0 running-enclave-id=${OLD_ENCLAVE_ID:-none}"

  # Soft drift warning (informational only — we still take the backup).
  # The pass-6 hard-fail behaviour was incompatible with the release-mode
  # rotation flow because measurement.json is updated to the NEW PCR0 in
  # the same PR that triggers the release. Backups are rollback insurance
  # — we always want them, even when the pinned-vs-canonical PCR0s
  # disagree (which is the EXPECTED state during release-mode deploys).
  local pinned_pcr0
  pinned_pcr0="$(jq -r '.pcr0 // empty' "$MEASUREMENT_FILE" 2>/dev/null || echo "")"
  if [ -n "$pinned_pcr0" ] && [ "$pinned_pcr0" != "$OLD_PCR0" ]; then
    log "note: canonical EIF PCR0 ($OLD_PCR0) differs from pinned PCR0 ($pinned_pcr0) — expected in release-mode rotation; backup proceeds against the canonical's actual PCR0."
  fi

  mkdir -p "$BACKUP_DIR"
  BACKUP_PATH="$BACKUP_DIR/${OLD_PCR0}.eif"
  if ! cp "$EIF_PATH_CURRENT" "$BACKUP_PATH"; then
    # cp failed. Hard-stop only if an enclave is currently running;
    # otherwise it's a best-effort snapshot and a failure is recoverable
    # (the next successful deploy will repopulate BACKUP_DIR).
    BACKUP_PATH=""
    if [ -n "$OLD_ENCLAVE_ID" ] && [ "$ALLOW_NO_BACKUP" != "1" ]; then
      die "cannot capture backup: cp of $EIF_PATH_CURRENT to $BACKUP_DIR/${OLD_PCR0}.eif failed (disk full? permissions?). Enclave ID=$OLD_ENCLAVE_ID is running. Refusing to proceed. Override with --allow-no-backup only if you have a separate rollback plan."
    fi
    if [ -n "$OLD_ENCLAVE_ID" ]; then
      warn "cp $EIF_PATH_CURRENT -> $BACKUP_DIR/${OLD_PCR0}.eif failed (disk full? permissions?) with enclave ID=$OLD_ENCLAVE_ID running. --allow-no-backup set → proceeding without rollback artefact. Operator assumes responsibility."
    else
      warn "cp $EIF_PATH_CURRENT -> $BACKUP_DIR/${OLD_PCR0}.eif failed and no enclave is running — no backup captured (non-fatal: no live service to protect)."
    fi
    return 0
  fi
  log "backed up previous EIF to $BACKUP_PATH (canonical PCR0=$OLD_PCR0, running-enclave=$([ -n "$OLD_ENCLAVE_ID" ] && echo yes || echo no))"
}

# ---------------------------------------------------------------------------
# Step 7c: Prune old deploy backup EIFs after successful promotion
# ---------------------------------------------------------------------------
backup_eif_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

prune_backup_eifs() {
  local retention="$ENCLAVE_BACKUP_RETENTION_COUNT"

  [ -d "$BACKUP_DIR" ] || return 0

  local manifest sorted
  manifest="$(mktemp "${TMPDIR:-/tmp}/calypso-enclave-backups.XXXXXX")" || {
    warn "could not create temp file for backup retention sweep; leaving $BACKUP_DIR untouched."
    return 0
  }
  sorted="$(mktemp "${TMPDIR:-/tmp}/calypso-enclave-backups.XXXXXX")" || {
    warn "could not create temp file for backup retention sweep; leaving $BACKUP_DIR untouched."
    rm -f "$manifest" 2>/dev/null || true
    return 0
  }

  local file
  for file in "$BACKUP_DIR"/*.eif; do
    [ -e "$file" ] || continue
    printf '%s\t%s\n' "$(backup_eif_mtime "$file")" "$file" >> "$manifest" || true
  done

  local total
  total="$(wc -l < "$manifest" 2>/dev/null | tr -d '[:space:]')"
  total="${total:-0}"

  if [ "$total" -le "$retention" ]; then
    rm -f "$manifest" "$sorted" 2>/dev/null || true
    log "backup retention: $total EIF(s) in $BACKUP_DIR, retention=$retention; nothing to prune."
    return 0
  fi

  if ! sort -rn "$manifest" > "$sorted"; then
    warn "could not sort backup EIFs for retention sweep; leaving $BACKUP_DIR untouched."
    rm -f "$manifest" "$sorted" 2>/dev/null || true
    return 0
  fi

  local index=0 pruned=0
  while IFS=$'\t' read -r _ file; do
    index=$((index + 1))
    if [ "$index" -le "$retention" ]; then
      continue
    fi
    if rm -f -- "$file"; then
      rm -f -- "${file}.pcr0" 2>/dev/null || true
      pruned=$((pruned + 1))
      log "pruned old backup EIF: $file"
    else
      warn "could not prune old backup EIF: $file"
    fi
  done < "$sorted"

  rm -f "$manifest" "$sorted" 2>/dev/null || true
  log "backup retention complete: kept $retention newest EIF(s), pruned $pruned old EIF(s) from $BACKUP_DIR."
  return 0
}

# ---------------------------------------------------------------------------
# Step 5-6: Terminate old + run new
# ---------------------------------------------------------------------------
terminate_and_run() {
  log "terminating all running enclaves …"
  ${SUDO_NITRO_CLI:-} nitro-cli terminate-enclave --all >/dev/null 2>&1 || true

  if ! wait_for_enclave_shutdown "$ENCLAVE_SHUTDOWN_TIMEOUT_SECONDS"; then
    warn "enclave shutdown did not complete within ${ENCLAVE_SHUTDOWN_TIMEOUT_SECONDS}s."
    return 1
  fi

  log "starting new enclave (cid=$ENCLAVE_CID cpu=$ENCLAVE_CPU_COUNT memory=${ENCLAVE_MEMORY_MB}MB) …"
  ${SUDO_NITRO_CLI:-} nitro-cli run-enclave \
    --cpu-count "$ENCLAVE_CPU_COUNT" \
    --memory "$ENCLAVE_MEMORY_MB" \
    --eif-path "$NEW_EIF_PATH" \
    --enclave-cid "$ENCLAVE_CID"
}

run_new_enclave_until_healthy() {
  local max_attempts=$(( DEPLOY_HEALTH_RETRY_ATTEMPTS + 1 ))
  local attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    if [ "$attempt" -gt 1 ]; then
      warn "retrying new EIF launch attempt $attempt/$max_attempts before rollback."
      if [ "$DEPLOY_HEALTH_RETRY_COOLDOWN_SECONDS" -gt 0 ]; then
        log "waiting ${DEPLOY_HEALTH_RETRY_COOLDOWN_SECONDS}s before same-EIF retry."
        sleep "$DEPLOY_HEALTH_RETRY_COOLDOWN_SECONDS"
      fi
    fi

    if ! terminate_and_run; then
      warn "new enclave launch failed on attempt $attempt/$max_attempts."
    elif wait_for_health "$DEPLOY_HEALTH_TIMEOUT_SECONDS"; then
      if [ "$attempt" -gt 1 ]; then
        log "new EIF became healthy after retry attempt $attempt/$max_attempts."
      fi
      return 0
    else
      warn "new EIF health probe failed on attempt $attempt/$max_attempts."
    fi

    attempt=$((attempt + 1))
  done

  return 1
}

# Wait for Nitro to stop reporting running enclaves after terminate-enclave.
# A fixed sleep is not enough on busy hosts: the following run-enclave can
# otherwise race memory/CID cleanup and fail before deploy.sh reaches its
# rollback-aware health gate.
wait_for_enclave_shutdown() {
  local budget_seconds="${1:-15}"
  local attempt=0 current count

  while [ "$attempt" -lt "$budget_seconds" ]; do
    current="$(${SUDO_NITRO_CLI:-} nitro-cli describe-enclaves 2>/dev/null || true)"
    count="$(jq -r 'length' <<<"$current" 2>/dev/null || echo "unknown")"
    if [ "$count" = "0" ]; then
      log "enclave shutdown confirmed."
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  return 1
}

enclave_is_running_for_cid() {
  local current
  current="$(${SUDO_NITRO_CLI:-} nitro-cli describe-enclaves 2>/dev/null)" || {
    # Do not turn a transient nitro-cli read failure into a deploy abort.
    # The following health probe will still provide the real signal.
    return 0
  }

  jq -e --arg cid "$ENCLAVE_CID" '
    any(.[]; ((.EnclaveCID | tostring) == $cid) and ((.State // "RUNNING") == "RUNNING"))
  ' <<<"$current" >/dev/null 2>&1
}

sleep_until_first_health_probe() {
  local delay_seconds="${ENCLAVE_INITIAL_HEALTH_DELAY_SECONDS:-0}"
  local slept=0 step

  if [ "$delay_seconds" -le 0 ]; then
    return 0
  fi

  log "waiting ${delay_seconds}s before first health probe to avoid the Nitro warmup race."
  while [ "$slept" -lt "$delay_seconds" ]; do
    step=2
    if [ $((slept + step)) -gt "$delay_seconds" ]; then
      step=$((delay_seconds - slept))
    fi
    sleep "$step"
    slept=$((slept + step))
    if ! enclave_is_running_for_cid; then
      log "candidate enclave CID $ENCLAVE_CID is not RUNNING during warmup; aborting health wait."
      return 1
    fi
  done
}

# ---------------------------------------------------------------------------
# Step 7: Health probe (3 consecutive OKs inside a configurable window)
# ---------------------------------------------------------------------------
# Arg 1 (optional): total budget in seconds. Default 30s (15 attempts × 2s).
# Used with a tighter value by rollback() — ROLLBACK_HEALTH_TIMEOUT_SECONDS.
wait_for_health() {
  local budget_seconds="${1:-30}"
  local ok=0 attempt=0
  local max_attempts=$(( budget_seconds / 2 ))
  if [ "$max_attempts" -lt 3 ]; then
    max_attempts=3 # Need at least 3 attempts for the "3 consecutive" rule.
  fi

  # Health probe runs on the Nitro host, so it must speak vsock.
  export USE_VSOCK=true
  export ENCLAVE_CID ENCLAVE_PORT

  if ! sleep_until_first_health_probe; then
    return 1
  fi

  while [ "$attempt" -lt "$max_attempts" ]; do
    attempt=$((attempt + 1))
    local health_output
    if health_output="$(node "$SCRIPT_DIR/health-check.mjs" 2>&1)"; then
      ok=$((ok + 1))
      log "health probe attempt $attempt: ok ($ok/3)"
      if [ "$ok" -ge 3 ]; then
        log "health probe confirmed (3 consecutive)."
        return 0
      fi
    else
      ok=0
      if ! enclave_is_running_for_cid; then
        log "health probe attempt $attempt: fail — candidate enclave CID $ENCLAVE_CID is not RUNNING; aborting health wait."
        return 1
      fi
      log "health probe attempt $attempt: fail — $(summarize_health_probe_failure "$health_output")"
    fi
    sleep 2
  done

  return 1
}

summarize_health_probe_failure() {
  local output summary max_len
  output="${1:-}"
  summary="$(printf '%s' "$output" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')"
  if [ -z "$summary" ]; then
    summary="health-check exited non-zero with no output"
  fi
  max_len=240
  if [ "${#summary}" -gt "$max_len" ]; then
    summary="${summary:0:$max_len}..."
  fi
  printf '%s' "$summary"
}

# ---------------------------------------------------------------------------
# Step 8: Rollback
# ---------------------------------------------------------------------------
# A successful `nitro-cli run-enclave` only proves the EIF loaded — the
# enclave could still deadlock during init and never answer vsock. We
# reuse wait_for_health (with the tighter ROLLBACK_HEALTH_TIMEOUT_SECONDS
# budget — 30s by default) so a silent-but-broken backup fails loudly
# instead of passing as "rolled back" while the service is actually down.
rollback() {
  local reason="${1:-health probe failed}"
  warn "$reason — initiating rollback."
  ${SUDO_NITRO_CLI:-} nitro-cli terminate-enclave --all >/dev/null 2>&1 || true
  if ! wait_for_enclave_shutdown "$ENCLAVE_SHUTDOWN_TIMEOUT_SECONDS"; then
    die "ROLLBACK ALSO FAILED — existing enclave did not terminate within ${ENCLAVE_SHUTDOWN_TIMEOUT_SECONDS}s. Manual intervention required. See enclave/README.md and VERIFICATIONS.md."
  fi

  if [ -n "$BACKUP_PATH" ] && [ -f "$BACKUP_PATH" ]; then
    log "restoring backup EIF $BACKUP_PATH …"
    if ! ${SUDO_NITRO_CLI:-} nitro-cli run-enclave \
        --cpu-count "$ENCLAVE_CPU_COUNT" \
        --memory "$ENCLAVE_MEMORY_MB" \
        --eif-path "$BACKUP_PATH" \
        --enclave-cid "$ENCLAVE_CID"; then
      die "ROLLBACK ALSO FAILED — backup EIF does not launch. Manual intervention required. See enclave/README.md and VERIFICATIONS.md."
    fi
    if ! wait_for_health "$ROLLBACK_HEALTH_TIMEOUT_SECONDS"; then
      die "ROLLBACK ALSO FAILED — backup EIF does not respond to vsock health. Manual intervention required. See enclave/README.md and VERIFICATIONS.md."
    fi
    die "rolled back to PCR0=$OLD_PCR0 and confirmed healthy. Investigate the new EIF before retrying. See enclave/README.md and VERIFICATIONS.md."
  fi

  die "health probe failed and no backup available. Manual intervention required — see enclave/README.md and VERIFICATIONS.md."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  preflight
  acquire_lock

  # Snapshot the currently-running EIF BEFORE build.sh overwrites the
  # canonical on-disk path. This is the only reliable rollback source
  # in offline mode (nitro-cli does not expose the running EIF's bytes).
  capture_backup

  # build_or_fetch_eif reads $BACKUP_PATH (set by capture_backup) so
  # it can restore the canonical path after build.sh clobbers it.
  # ordering: capture_backup MUST run before build_or_fetch_eif.
  build_or_fetch_eif
  verify_measurement

  if ! run_new_enclave_until_healthy; then
    if [ "$NO_ROLLBACK" = "1" ]; then
      warn "new EIF did not become healthy after $(( DEPLOY_HEALTH_RETRY_ATTEMPTS + 1 )) launch attempt(s)."
      die "--no-rollback set; leaving the candidate enclave running for operator debugging. Confirm direct health, then either re-pin/restart the server to finish forward or terminate the candidate manually."
    fi
    rollback "new EIF did not become healthy after $(( DEPLOY_HEALTH_RETRY_ATTEMPTS + 1 )) launch attempt(s)"
  fi

  # Codex pass-4 MEDIUM: promote staged EIF -> canonical ONLY after
  # health has passed. If we ever reach this line, the new enclave is
  # proven healthy and can become the rollback target for the next
  # deploy. If rollback() fired above, it terminates the script before
  # we get here — canonical stays pointed at the previous (running) EIF.
  persist_canonical_eif
  prune_backup_eifs

  log "deploy complete. new enclave PCR0=$(jq -r '.pcr0' "$MEASUREMENT_FILE")"

  # Codex pass-9 HIGH-2: flip the transactional flag ONLY after every
  # phase above has succeeded. cleanup_prebuild_measurement now reads
  # this to decide delete (success) vs restore (failure). Any set -e
  # abort before this line leaves DEPLOY_SUCCEEDED=0 → pre-build copy
  # is moved back over measurement.json.
  DEPLOY_SUCCEEDED=1
}

main "$@"
