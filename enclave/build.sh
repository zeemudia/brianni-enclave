#!/bin/bash
# enclave/build.sh — Deterministic enclave build + measurement extraction
#
# Builds the enclave Docker image, converts to EIF, and outputs measurement.json.
# The measurement is then injected into mobile/web apps via scripts/inject-measurement.sh.
#
# Usage:
#   ./enclave/build.sh             # Full online build (requires Nitro-capable EC2)
#   ./enclave/build.sh --local     # Docker-only build (no EIF, computes image hash)
#   ./enclave/build.sh --offline   # Online vendor step, then docker build --network=none
#                                  # + EIF conversion. Requires Nitro EC2 for the EIF step.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION=$(jq -r '.version' "$SCRIPT_DIR/package.json")
resolve_commit_hash() {
  if [ -n "${CALYPSO_SOURCE_SHA:-}" ]; then
    printf '%s' "$CALYPSO_SOURCE_SHA" | tr -d '[:space:]'
    return
  fi

  if [ -f "$ROOT_DIR/.calypso-source-sha" ]; then
    tr -d '[:space:]' < "$ROOT_DIR/.calypso-source-sha"
    return
  fi

  git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown"
}
COMMIT_HASH="$(resolve_commit_hash)"
if [ -z "$COMMIT_HASH" ]; then
  COMMIT_HASH="unknown"
fi

# Codex MEDIUM #18 — `COMMIT_HASH` flows from `CALYPSO_SOURCE_SHA`
# env (CI release path) or the `.calypso-source-sha` marker file
# (attacker-plantable with repo-write access). A malicious value like
# `abc","pcr0":"<attacker_pcr0>` would, before this guard, get raw-
# interpolated into `measurement.json` via a here-doc and create JSON
# with two `pcr0` keys. `jq -r '.pcr0'` then returns the LATER value
# (jq duplicate-key semantics), and `inject-measurement.sh` would
# patch the client-pinned PINNED_MEASUREMENT with the attacker's
# PCR0 — a TEE trust-anchor compromise. Validate against an
# allowlist BEFORE any string interpolation, and fail loudly on
# mismatch.
if ! [[ "$COMMIT_HASH" =~ ^[0-9a-fA-F]{7,40}$ ]] && [ "$COMMIT_HASH" != "unknown" ]; then
  echo "error: COMMIT_HASH is not a valid git short/long SHA or the 'unknown' fallback." >&2
  echo "       Got: $COMMIT_HASH" >&2
  echo "       Refusing to build — a malformed commit hash could poison" >&2
  echo "       measurement.json and the client-pinned PCR0." >&2
  exit 1
fi
TODAY=$(date +%Y-%m-%d)

# Portable sha256: sha256sum on Linux, shasum -a 256 on macOS.
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD="shasum -a 256"
else
  echo "error: neither sha256sum nor shasum found on PATH" >&2
  exit 1
fi

MODE="${1:-full}"
DOCKER_NETWORK_ARGS=()
VENDOR_MANIFEST_SHA=""
DOCKER_ISOLATION_MODE="${CALYPSO_ENCLAVE_DOCKER_ISOLATION:-auto}"
DOCKER_IMAGE_TAG="calypso-enclave:local"

DISPOSABLE_DOCKER_BASE=""
DISPOSABLE_DOCKER_BRIDGE=""
DISPOSABLE_DOCKER_PIDFILE=""
DISPOSABLE_DOCKER_SUDO_PID=""
cleanup_disposable_dockerd() {
  local rc=$?
  trap - EXIT INT TERM

  if [ -n "$DISPOSABLE_DOCKER_PIDFILE" ] && [ -f "$DISPOSABLE_DOCKER_PIDFILE" ]; then
    local dockerd_pid
    dockerd_pid="$(cat "$DISPOSABLE_DOCKER_PIDFILE" 2>/dev/null || true)"
    if [ -n "$dockerd_pid" ]; then
      sudo -n kill "$dockerd_pid" >/dev/null 2>&1 || true
      for _ in $(seq 1 30); do
        sudo -n kill -0 "$dockerd_pid" >/dev/null 2>&1 || break
        sleep 1
      done
      sudo -n kill -9 "$dockerd_pid" >/dev/null 2>&1 || true
    fi
  fi

  if [ -n "$DISPOSABLE_DOCKER_SUDO_PID" ]; then
    wait "$DISPOSABLE_DOCKER_SUDO_PID" >/dev/null 2>&1 || true
  fi

  if [ -n "$DISPOSABLE_DOCKER_BRIDGE" ]; then
    sudo -n ip link delete "$DISPOSABLE_DOCKER_BRIDGE" >/dev/null 2>&1 || true
  fi

  if [ -n "$DISPOSABLE_DOCKER_BASE" ]; then
    case "$DISPOSABLE_DOCKER_BASE" in
      */calypso-enclave-dockerd-*) sudo -n rm -rf "$DISPOSABLE_DOCKER_BASE" >/dev/null 2>&1 || true ;;
      *) echo "warning: refusing to remove unexpected disposable Docker root: $DISPOSABLE_DOCKER_BASE" >&2 ;;
    esac
  fi

  return "$rc"
}

maybe_reexec_with_disposable_dockerd() {
  if [ "${CALYPSO_ENCLAVE_DISPOSABLE_DOCKER_ACTIVE:-0}" = "1" ]; then
    return
  fi

  case "$DOCKER_ISOLATION_MODE" in
    host|off|none|0) return ;;
    auto|disposable|disposable-dockerd) ;;
    *)
      echo "error: CALYPSO_ENCLAVE_DOCKER_ISOLATION must be one of: auto, disposable, host." >&2
      echo "       Got: $DOCKER_ISOLATION_MODE" >&2
      exit 1
      ;;
  esac

  # Release/offline builds are the PCR0-rotation path that is sensitive to a
  # reused host Docker graph. Keep local Docker Desktop/dev builds simple unless the
  # operator explicitly opts in later with a supported mode.
  if [ "$MODE" != "--offline" ]; then
    if [ "$DOCKER_ISOLATION_MODE" = "auto" ]; then
      return
    fi
    echo "error: disposable dockerd isolation is currently supported only for --offline release builds." >&2
    echo "       Use CALYPSO_ENCLAVE_DOCKER_ISOLATION=host for non-release local/dev builds." >&2
    exit 1
  fi

  if [ "$(uname -s)" != "Linux" ]; then
    if [ "$DOCKER_ISOLATION_MODE" = "auto" ]; then
      return
    fi
    echo "error: disposable dockerd isolation requires Linux." >&2
    exit 1
  fi

  command -v dockerd >/dev/null 2>&1 || {
    echo "error: dockerd not found; cannot isolate the enclave build graph." >&2
    echo "       Install Docker Engine or set CALYPSO_ENCLAVE_DOCKER_ISOLATION=host to use the legacy host graph." >&2
    exit 1
  }
  command -v docker >/dev/null 2>&1 || {
    echo "error: docker CLI not found." >&2
    exit 1
  }
  command -v sudo >/dev/null 2>&1 || {
    echo "error: sudo not found; starting a disposable rootful dockerd requires sudo." >&2
    exit 1
  }
  sudo -n true >/dev/null 2>&1 || {
    echo "error: passwordless sudo is required to start/stop the disposable dockerd." >&2
    echo "       This is intentional: falling back to the host /var/lib/docker would reintroduce overlay2 drift." >&2
    exit 1
  }

  # Fail-closed guard for old nitro-cli/linuxkit versions that might ignore
  # DOCKER_HOST: remove the release tag from the production daemon before the
  # isolated build. The disposable daemon will recreate the same stable tag.
  # If nitro-cli accidentally looks at /var/run/docker.sock, the image is absent
  # and the build fails instead of measuring stale host Docker bytes.
  env -u DOCKER_HOST docker image rm --force "$DOCKER_IMAGE_TAG" >/dev/null 2>&1 || true

  local parent nonce run_root data_root exec_root sock log_file
  parent="${CALYPSO_ENCLAVE_DOCKER_ROOT_PARENT:-/var/tmp}"
  nonce="${USER:-$(id -un)}-$$-$(date -u +%Y%m%dT%H%M%SZ)"
  DISPOSABLE_DOCKER_BASE="$parent/calypso-enclave-dockerd-$nonce"
  run_root="$DISPOSABLE_DOCKER_BASE/run"
  data_root="$DISPOSABLE_DOCKER_BASE/data"
  exec_root="$DISPOSABLE_DOCKER_BASE/exec"
  DISPOSABLE_DOCKER_BRIDGE="cbe$$"
  sock="$run_root/docker.sock"
  DISPOSABLE_DOCKER_PIDFILE="$run_root/dockerd.pid"
  log_file="$DISPOSABLE_DOCKER_BASE/dockerd.log"

  case "$DISPOSABLE_DOCKER_BASE" in
    */calypso-enclave-dockerd-*) ;;
    *)
      echo "error: refusing unsafe disposable Docker root: $DISPOSABLE_DOCKER_BASE" >&2
      exit 1
      ;;
  esac

  # Least-privilege: the disposable dockerd state tree (incl. the rootful
  # docker socket) must be PRIVATE to the invoking uid. `sudo mkdir -p` would
  # leave the dirs at the default umask (~0755, world-traversable), and
  # granting the dockerd socket to the caller's PRIMARY group would hand
  # root-equivalent Docker access to any local user sharing that group during
  # the build window — they could tamper with calypso-enclave:local before
  # nitro-cli measures it (PCR0 poisoning). So: create the tree, lock the base
  # to 0700, own everything to the invoking uid, and never set --group.
  sudo -n mkdir -p "$run_root" "$data_root" "$exec_root"
  sudo -n chown -R "$(id -u):$(id -g)" "$DISPOSABLE_DOCKER_BASE"
  sudo -n chmod 700 "$DISPOSABLE_DOCKER_BASE"
  : > "$log_file"
  sudo -n ip link delete "$DISPOSABLE_DOCKER_BRIDGE" >/dev/null 2>&1 || true
  sudo -n ip link add name "$DISPOSABLE_DOCKER_BRIDGE" type bridge
  sudo -n ip addr add 172.30.255.1/24 dev "$DISPOSABLE_DOCKER_BRIDGE"
  sudo -n ip link set "$DISPOSABLE_DOCKER_BRIDGE" up

  echo "=== Starting same-host disposable dockerd for enclave build ==="
  echo "Docker socket: unix://$sock"
  echo "Docker data-root: $data_root"
  echo "Docker bridge: $DISPOSABLE_DOCKER_BRIDGE"

  # shellcheck disable=SC2024 # log_file is user-owned before sudo starts dockerd.
  sudo -n dockerd \
    --host "unix://$sock" \
    --data-root "$data_root" \
    --exec-root "$exec_root" \
    --pidfile "$DISPOSABLE_DOCKER_PIDFILE" \
    --storage-driver overlay2 \
    --bridge "$DISPOSABLE_DOCKER_BRIDGE" \
    --iptables=false \
    --ip-forward=false \
    --ip-masq=false \
    --userland-proxy=false \
    >"$log_file" 2>&1 &
  DISPOSABLE_DOCKER_SUDO_PID="$!"

  trap cleanup_disposable_dockerd EXIT INT TERM

  local ready=0
  for _ in $(seq 1 60); do
    if [ -S "$sock" ]; then
      # Restrict the rootful docker socket to the invoking uid ONLY (0600).
      # dockerd creates it root-owned ~0660; without a --group grant it is not
      # group-exposed, but we still chown to the caller and chmod 600 so no
      # group/other can reach the root-equivalent endpoint during the build.
      sudo -n chown "$(id -u):$(id -g)" "$sock" >/dev/null 2>&1 || true
      sudo -n chmod 600 "$sock" >/dev/null 2>&1 || true
      if DOCKER_HOST="unix://$sock" docker info >/dev/null 2>&1; then
        ready=1
        break
      fi
    fi
    if [ -f "$DISPOSABLE_DOCKER_PIDFILE" ]; then
      local pid
      pid="$(cat "$DISPOSABLE_DOCKER_PIDFILE" 2>/dev/null || true)"
      if [ -n "$pid" ] && ! sudo -n kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
    fi
    sleep 1
  done

  if [ "$ready" -ne 1 ]; then
    echo "error: disposable dockerd did not become ready. Last dockerd logs:" >&2
    tail -80 "$log_file" >&2 || true
    exit 1
  fi

  echo "Disposable dockerd ready; re-running build with isolated DOCKER_HOST."
  CALYPSO_ENCLAVE_DISPOSABLE_DOCKER_ACTIVE=1 \
  CALYPSO_ENCLAVE_VENDOR_READY=1 \
  DOCKER_HOST="unix://$sock" \
    "$0" "$@"
  exit $?
}

# Minimum free disk required before we'll start a build. The enclave build
# with --no-cache needs ~15 GB for transient BuildKit state (~2.4 GB vendor
# COPY + ~1.8 GB final image + intermediate stages + ~1.6 GB EIF output).
# In --offline release mode that state now lives in a same-host disposable
# dockerd data-root and is deleted wholesale after nitro-cli writes the EIF.
# The limit still matters: a disk-full build can leave a partial disposable
# data-root, and the EIF itself is written under the repo.
MIN_FREE_GB=20
free_gb() {
  df -BG "$ROOT_DIR" 2>/dev/null | awk 'NR==2 { gsub(/G/, "", $4); print $4 }' \
    || df -g "$ROOT_DIR" 2>/dev/null | awk 'NR==2 { print $4 }' \
    || echo 0
}
FREE_GB="$(free_gb)"
if [ -n "$FREE_GB" ] && [ "$FREE_GB" -lt "$MIN_FREE_GB" ] 2>/dev/null; then
  echo "error: only ${FREE_GB}GB free on the build volume; need ${MIN_FREE_GB}GB." >&2
  echo "       interrupted docker builds leak overlay2 layers that a normal" >&2
  echo "       prune cannot recover. Free space before retrying, e.g.:" >&2
  echo "         docker builder prune -af --force" >&2
  echo "         docker system prune -af --volumes --force" >&2
  echo "       If /var/lib/docker is still large vs. 'docker system df'," >&2
  echo "       you have orphan overlay2 state; see the playbook for the" >&2
  echo "       'sudo systemctl stop docker && sudo rm -rf /var/lib/docker'" >&2
  echo "       recovery sequence." >&2
  exit 1
fi

if [ "$MODE" = "--offline" ]; then
  if [ "${CALYPSO_ENCLAVE_VENDOR_READY:-0}" = "1" ]; then
    echo "=== Offline mode: vendor directory already refreshed; verifying manifest ==="
  else
    echo "=== Offline mode: refreshing vendor directory ==="
    "$ROOT_DIR/infra/docker/vendor-deps.sh"
  fi
  MANIFEST_PATH="$ROOT_DIR/infra/docker/VENDOR-MANIFEST.sha256"
  if [ -f "$MANIFEST_PATH" ]; then
    # Reproducibility guard: vendor-deps.sh just regenerated the manifest.
    # The vendorManifestSha256 recorded in measurement.json (and thus the
    # provenance of the pinned PCR0) MUST correspond to the COMMITTED
    # manifest, otherwise no committed artifact can reproduce the recorded
    # hash and the source-to-PCR0 reproducibility claim is unverifiable.
    #
    # The check is git-based, so it MUST run — an offline build that records a
    # vendorManifestSha256 without verifying it against the committed manifest
    # gives false provenance assurance. If git or the repo checkout is
    # unavailable (e.g. building from an exported tarball), FAIL CLOSED rather
    # than silently skipping the guard.
    if ! command -v git >/dev/null 2>&1 || ! git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
      echo "error: offline enclave build requires a git checkout to verify the" >&2
      echo "       refreshed vendor manifest against the committed" >&2
      echo "       infra/docker/VENDOR-MANIFEST.sha256. git is unavailable or" >&2
      echo "       \$ROOT_DIR is not a git repository, so the reproducibility" >&2
      echo "       guard cannot run. Build from a git checkout." >&2
      exit 1
    fi
    # If the refreshed manifest differs from what git has COMMITTED, abort and
    # force the operator to review + commit it before building. Compare against
    # HEAD (not the index): `git diff` with no ref compares working-tree↔index,
    # so a `git add`ed-but-uncommitted manifest would slip through. `diff HEAD`
    # catches both staged and unstaged divergence from the committed tree; the
    # ls-files check still catches a never-committed (untracked) manifest.
    if ! git -C "$ROOT_DIR" diff --quiet HEAD -- "$MANIFEST_PATH" 2>/dev/null \
      || [ -n "$(git -C "$ROOT_DIR" ls-files --others --exclude-standard -- "$MANIFEST_PATH")" ]; then
      echo "error: infra/docker/VENDOR-MANIFEST.sha256 changed after vendor-deps.sh." >&2
      echo "       Building now would record a vendorManifestSha256 in" >&2
      echo "       measurement.json that the committed manifest cannot reproduce," >&2
      echo "       breaking source-to-PCR0 reproducibility. Review and commit the" >&2
      echo "       refreshed manifest first:" >&2
      echo "         git -C \"$ROOT_DIR\" diff -- infra/docker/VENDOR-MANIFEST.sha256" >&2
      echo "         git -C \"$ROOT_DIR\" add infra/docker/VENDOR-MANIFEST.sha256 && git commit" >&2
      exit 1
    fi
    # Only reachable once the committed manifest matches the refreshed one.
    VENDOR_MANIFEST_SHA=$($SHA256_CMD "$MANIFEST_PATH" | awk '{print $1}')
    echo "Vendor manifest sha256: $VENDOR_MANIFEST_SHA (matches committed manifest)"
  fi
  DOCKER_NETWORK_ARGS=(--network=none)
fi

maybe_reexec_with_disposable_dockerd "$@"

# Preemptively cap BuildKit cache so this build can't be the straw that
# fills the disk. In the release path this command targets the disposable
# dockerd above; in legacy/host mode it targets the host daemon as before.
if command -v docker >/dev/null 2>&1; then
  docker builder prune --force --keep-storage 4GB >/dev/null 2>&1 || true
fi

echo "Building Calypso enclave image v${VERSION} (${COMMIT_HASH})..."

# Trap: if docker build fails in legacy/host mode, run a best-effort prune so
# the next invocation starts with a cleaner builder. In --offline release mode
# this targets the disposable dockerd and is redundant with the outer rm -rf,
# but harmless.
cleanup_on_build_failure() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "docker build failed (exit $rc); pruning builder cache before cleanup..." >&2
    docker builder prune --force >/dev/null 2>&1 || true
  fi
  return $rc
}
trap cleanup_on_build_failure ERR

docker build \
  --no-cache \
  "${DOCKER_NETWORK_ARGS[@]}" \
  --build-arg SOURCE_DATE_EPOCH=0 \
  --build-arg VENDOR_DIR=infra/docker/vendor \
  -f "$ROOT_DIR/infra/docker/Dockerfile.enclave" \
  -t "$DOCKER_IMAGE_TAG" \
  "$ROOT_DIR"

# Clear the trap — past this point a failure is in nitro-cli, not docker,
# and its temporary files are small (no overlay2 involvement).
trap - ERR

# Post-build prune: cap BuildKit cache so a sequence of builds can never
# grow unbounded. Honour a small keep-storage so cache hits are still
# fast for same-context re-runs; the cap is the property we actually care
# about in production.
docker builder prune --force --keep-storage 4GB >/dev/null 2>&1 || true
# Also drop dangling (<none>) images left by previous --no-cache builds. In
# legacy/host mode, each rebuild untags the prior calypso-enclave:local and
# those unreferenced image layers otherwise pile up. In disposable mode this is
# redundant with deleting the temporary data-root, but harmless.
docker image prune --force >/dev/null 2>&1 || true

if [ "$MODE" = "--local" ]; then
  # Local mode: compute a reproducible hash from the Docker image layers.
  # This is NOT a real PCR0 (which requires nitro-cli), but demonstrates
  # the pipeline and provides a deterministic value for testing.
  echo "Local mode: computing Docker image hash as measurement proxy..."
  IMAGE_HASH=$(docker inspect --format='{{.Id}}' "$DOCKER_IMAGE_TAG" | sed 's/sha256://')

  # PCR0-compatible format: pad to 96 hex chars (SHA-384 length)
  PCR0=$(echo -n "$IMAGE_HASH" | sha384sum | awk '{print $1}')

  echo "  Docker image ID: ${IMAGE_HASH:0:16}..."
  echo "  Derived PCR0:    ${PCR0:0:16}...${PCR0: -16}"

  # Codex MEDIUM #18 — generate measurement.json via `jq -n --arg`
  # so each value is JSON-encoded by jq, never raw shell-interpolated.
  # A malicious commitHash containing quotes / newlines / control
  # bytes would corrupt the JSON if dropped through a here-doc; with
  # --arg, jq escapes it into a string literal.
  jq -n \
    --arg pcr0 "$PCR0" \
    --arg version "$VERSION" \
    --arg commitHash "$COMMIT_HASH" \
    --arg verifiedAt "$TODAY" \
    '{
      pcr0: $pcr0,
      version: $version,
      commitHash: $commitHash,
      verifiedAt: $verifiedAt,
      source: "docker-image-hash",
      note: "Derived from Docker image hash — NOT a real Nitro PCR0. Use full build on Nitro EC2 for production."
    }' > "$SCRIPT_DIR/measurement.json"
else
  # Full or offline build: convert to EIF and extract real PCR measurements
  echo "Converting to Nitro EIF..."
  nitro-cli build-enclave \
    --docker-uri "$DOCKER_IMAGE_TAG" \
    --output-file "$SCRIPT_DIR/calypso-enclave.eif"

  echo "Extracting measurements..."
  EIF_INFO=$(nitro-cli describe-eif --eif-path "$SCRIPT_DIR/calypso-enclave.eif")
  PCR0=$(echo "$EIF_INFO" | jq -r '.Measurements.PCR0')
  PCR1=$(echo "$EIF_INFO" | jq -r '.Measurements.PCR1')
  PCR2=$(echo "$EIF_INFO" | jq -r '.Measurements.PCR2')

  echo "  PCR0: $PCR0"
  echo "  PCR1: $PCR1"
  echo "  PCR2: $PCR2"

  SOURCE_LABEL="nitro-cli"
  if [ "$MODE" = "--offline" ]; then
    SOURCE_LABEL="nitro-cli-offline"
  fi

  # Codex MEDIUM #18 — see comment in the --local branch above. Same
  # jq-based safe generator for the Nitro EIF path.
  if [ -n "$VENDOR_MANIFEST_SHA" ]; then
    jq -n \
      --arg pcr0 "$PCR0" \
      --arg pcr1 "$PCR1" \
      --arg pcr2 "$PCR2" \
      --arg version "$VERSION" \
      --arg commitHash "$COMMIT_HASH" \
      --arg verifiedAt "$TODAY" \
      --arg source "$SOURCE_LABEL" \
      --arg vendorManifestSha256 "$VENDOR_MANIFEST_SHA" \
      '{
        pcr0: $pcr0,
        pcr1: $pcr1,
        pcr2: $pcr2,
        version: $version,
        commitHash: $commitHash,
        verifiedAt: $verifiedAt,
        source: $source,
        vendorManifestSha256: $vendorManifestSha256
      }' > "$SCRIPT_DIR/measurement.json"
  else
    jq -n \
      --arg pcr0 "$PCR0" \
      --arg pcr1 "$PCR1" \
      --arg pcr2 "$PCR2" \
      --arg version "$VERSION" \
      --arg commitHash "$COMMIT_HASH" \
      --arg verifiedAt "$TODAY" \
      --arg source "$SOURCE_LABEL" \
      '{
        pcr0: $pcr0,
        pcr1: $pcr1,
        pcr2: $pcr2,
        version: $version,
        commitHash: $commitHash,
        verifiedAt: $verifiedAt,
        source: $source
      }' > "$SCRIPT_DIR/measurement.json"
  fi
fi

echo ""
echo "Measurement written to: $SCRIPT_DIR/measurement.json"
echo ""
echo "Next: run ./scripts/inject-measurement.sh to patch mobile/web apps."
