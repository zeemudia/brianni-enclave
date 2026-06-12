#!/usr/bin/env bash
# enclave/scripts/__tests__/p8-byte-identical-pcr0.sh
#
# Privacy invariant P8 — live byte-identical PCR0 proof.
#
# Proves that "adding an LLM provider that uses an existing adapter does NOT
# change the enclave attestation hash". The static Dockerfile test
# (enclave/__tests__/p8-registry-stability.test.ts) guarantees providers.json
# is not in the final-stage COPY surface; this script proves it end-to-end
# by building the EIF twice — once against the real providers.json, once
# against a synthetic fixture with an extra provider — and diffing
# measurement.json's PCR0.
#
# Requirements:
#   - Nitro-capable EC2 host (nitro-cli on PATH).
#   - NITRO_AVAILABLE=1 in the environment.
#   - At least 20 GB free disk for two back-to-back reproducible builds.
#   - Run from any cwd; the script resolves paths from its own location.
#
# Usage (manual operator run per release):
#   NITRO_AVAILABLE=1 ./enclave/scripts/__tests__/p8-byte-identical-pcr0.sh
#
# Evidence artefact written to:
#   docs/legal/build-evidence/p8-byte-identical-pcr0-<YYYY-MM-DD>.md
#
# Exit codes:
#   0  — PCR0 is byte-identical across both builds (invariant holds).
#   1  — preconditions not met (nitro-cli missing, disk full, etc.).
#   2  — PCR0 diverged between builds (INVARIANT VIOLATED — investigate).
#   3  — trap cleanup failed to restore providers.json.

set -euo pipefail
IFS=$'\n\t'

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENCLAVE_SCRIPTS_DIR="$(dirname "$SCRIPT_DIR")"
ENCLAVE_DIR="$(dirname "$ENCLAVE_SCRIPTS_DIR")"
REPO_ROOT="$(dirname "$ENCLAVE_DIR")"

PROVIDERS_JSON="$ENCLAVE_DIR/src/providers/providers.json"
FIXTURE_JSON="$ENCLAVE_DIR/src/providers/__fixtures__/providers.with-xai.json"
MEASUREMENT_JSON="$ENCLAVE_DIR/measurement.json"
BUILD_SCRIPT="$ENCLAVE_DIR/build.sh"

WORK_DIR="$(mktemp -d -t p8-pcr0-XXXXXX)"
ORIGINAL_MEASUREMENT="$WORK_DIR/measurement.original.json"
AUGMENTED_MEASUREMENT="$WORK_DIR/measurement.augmented.json"
DIFF_OUTPUT="$WORK_DIR/measurement.diff"

EVIDENCE_DIR="$REPO_ROOT/docs/legal/build-evidence"
TODAY="$(date -u +%Y-%m-%d)"
EVIDENCE_FILE="$EVIDENCE_DIR/p8-byte-identical-pcr0-$TODAY.md"

# ---------------------------------------------------------------------------
# Trap: always restore providers.json + remove temp dir
# ---------------------------------------------------------------------------
# shellcheck disable=SC2329 # invoked indirectly via trap
cleanup() {
  local exit_code=$?
  # Best-effort restore — even if the script exploded mid-augmentation.
  # `git checkout --` is idempotent; if providers.json is already clean it's
  # a no-op.
  if [ -f "$PROVIDERS_JSON" ]; then
    if ! git -C "$REPO_ROOT" checkout -- "enclave/src/providers/providers.json" 2>/dev/null; then
      echo "error: failed to restore enclave/src/providers/providers.json from git — working tree may be dirty" >&2
      # Only override a zero exit; a non-zero inner failure is more
      # important to surface.
      if [ "$exit_code" -eq 0 ]; then
        exit_code=3
      fi
    fi
  fi
  rm -rf "$WORK_DIR" 2>/dev/null || true
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
log() { printf '[p8] %s\n' "$1"; }
fail() { printf '[p8] error: %s\n' "$1" >&2; exit 1; }

log "starting P8 byte-identical PCR0 proof ($TODAY)"

if [ "${NITRO_AVAILABLE:-0}" != "1" ]; then
  fail "NITRO_AVAILABLE=1 must be set (this script is Nitro-only)"
fi

if ! command -v nitro-cli >/dev/null 2>&1; then
  fail "nitro-cli not on PATH — run on a Nitro-capable EC2 host"
fi

if ! command -v jq >/dev/null 2>&1; then
  fail "jq not on PATH — required to parse measurement.json + build the fixture"
fi

if ! command -v git >/dev/null 2>&1; then
  fail "git not on PATH — required for providers.json restore"
fi

if [ ! -f "$PROVIDERS_JSON" ]; then
  fail "providers.json not found at $PROVIDERS_JSON"
fi

if [ ! -f "$FIXTURE_JSON" ]; then
  fail "fixture not found at $FIXTURE_JSON — did you delete it?"
fi

if [ ! -x "$BUILD_SCRIPT" ]; then
  fail "$BUILD_SCRIPT is missing or not executable"
fi

# Disk-space check — 20 GB minimum for two back-to-back reproducible builds.
free_gb=$(df -BG "$REPO_ROOT" 2>/dev/null | awk 'NR==2 { gsub(/G/, "", $4); print $4 }')
if [ -n "${free_gb:-}" ] && [ "$free_gb" -lt 20 ] 2>/dev/null; then
  fail "only ${free_gb}GB free at $REPO_ROOT — need ≥20GB for two back-to-back reproducible builds"
fi

# Refuse to run against a dirty working tree for providers.json — restore
# semantics only work from a known-clean base.
if ! git -C "$REPO_ROOT" diff --quiet -- "enclave/src/providers/providers.json" 2>/dev/null; then
  fail "enclave/src/providers/providers.json has uncommitted changes — commit or stash before running"
fi

# ---------------------------------------------------------------------------
# Build 1: original providers.json
# ---------------------------------------------------------------------------
log "build 1/2: stock providers.json (production registry)"
(cd "$REPO_ROOT" && "$BUILD_SCRIPT" --offline) >&2 || fail "build 1 failed"

if [ ! -f "$MEASUREMENT_JSON" ]; then
  fail "measurement.json not produced by build 1"
fi
cp "$MEASUREMENT_JSON" "$ORIGINAL_MEASUREMENT"
log "build 1 PCR0: $(jq -r '.Measurements.PCR0 // .PCR0 // "<unknown>"' "$ORIGINAL_MEASUREMENT")"

# ---------------------------------------------------------------------------
# Augment: swap providers.json for the fixture with an extra provider entry.
# The augmented JSON is NOT re-signed — the enclave BUILD does not execute
# signature verification; signatures are checked at enclave BOOT (against
# the baked registry-verify-key.pem). This test is about EIF-artefact
# byte-identity across registry content changes, not runtime validity.
# ---------------------------------------------------------------------------
log "augment: installing fixture with synthetic xai provider"
cp "$FIXTURE_JSON" "$PROVIDERS_JSON"

# Sanity check — did the swap actually land?
if ! jq -e '.providers | map(.id) | index("xai")' "$PROVIDERS_JSON" >/dev/null; then
  fail "fixture swap failed — xai provider not present in providers.json"
fi

# ---------------------------------------------------------------------------
# Build 2: augmented providers.json
# ---------------------------------------------------------------------------
log "build 2/2: augmented providers.json (fixture with +xai)"
(cd "$REPO_ROOT" && "$BUILD_SCRIPT" --offline) >&2 || fail "build 2 failed"

cp "$MEASUREMENT_JSON" "$AUGMENTED_MEASUREMENT"
log "build 2 PCR0: $(jq -r '.Measurements.PCR0 // .PCR0 // "<unknown>"' "$AUGMENTED_MEASUREMENT")"

# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------
log "diffing measurements"
if diff -u "$ORIGINAL_MEASUREMENT" "$AUGMENTED_MEASUREMENT" > "$DIFF_OUTPUT"; then
  log "SUCCESS — measurement.json byte-identical across both builds"
  diff_status=0
else
  log "FAILURE — measurement.json DIVERGED between builds (P8 violated)"
  log "  diff:"
  sed 's/^/    /' "$DIFF_OUTPUT" >&2
  diff_status=2
fi

# ---------------------------------------------------------------------------
# Evidence artefact
# ---------------------------------------------------------------------------
mkdir -p "$EVIDENCE_DIR"

pcr0_original=$(jq -r '.Measurements.PCR0 // .PCR0 // "<unknown>"' "$ORIGINAL_MEASUREMENT")
pcr0_augmented=$(jq -r '.Measurements.PCR0 // .PCR0 // "<unknown>"' "$AUGMENTED_MEASUREMENT")
host_identity="$(hostname) / $(uname -srm)"
aws_ami="$(curl -fsS --max-time 2 http://169.254.169.254/latest/meta-data/ami-id 2>/dev/null || echo 'unavailable')"
buildx_version="$(docker buildx version 2>/dev/null || echo 'unavailable')"
git_head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo 'unknown')"
now_utc="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

{
  echo "# P8 byte-identical PCR0 evidence — $TODAY"
  echo ""
  if [ "$diff_status" -eq 0 ]; then
    echo "**Result: PASS** — invariant P8 holds end-to-end."
  else
    echo "**Result: FAIL** — PCR0 diverged between builds. P8 is broken."
  fi
  echo ""
  echo "## Host"
  echo ""
  echo "- Hostname/OS: \`$host_identity\`"
  echo "- AWS AMI: \`$aws_ami\`"
  echo "- docker buildx: \`$buildx_version\`"
  echo "- git HEAD: \`$git_head\`"
  echo "- Run time (UTC): \`$now_utc\`"
  echo ""
  echo "## Build 1 — stock providers.json"
  echo ""
  echo "- PCR0: \`$pcr0_original\`"
  echo ""
  echo "## Build 2 — augmented providers.json (fixture +xai)"
  echo ""
  echo "- PCR0: \`$pcr0_augmented\`"
  echo ""
  echo "## Diff (measurement.json)"
  echo ""
  echo '```diff'
  if [ -s "$DIFF_OUTPUT" ]; then
    cat "$DIFF_OUTPUT"
  else
    echo "(empty — files are byte-identical)"
  fi
  echo '```'
  echo ""
  echo "## Fixture"
  echo ""
  echo "Augmented registry installed at \`enclave/src/providers/providers.json\`"
  echo "from \`enclave/src/providers/__fixtures__/providers.with-xai.json\`"
  echo "— one extra provider entry \`xai\` using the \`openai_v1\` adapter."
  echo "The fixture signature field is copied verbatim and NOT valid; the"
  echo "enclave BUILD does not verify registry signatures (that happens at"
  echo "boot against the baked verify-key). This evidence proves the EIF"
  echo "artefact is stable across registry CONTENT, not that the fixture"
  echo "would pass the enclave's runtime signature check."
} > "$EVIDENCE_FILE"

log "evidence written to $EVIDENCE_FILE"
log "exit status: $diff_status"
exit "$diff_status"
