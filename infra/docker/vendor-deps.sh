#!/usr/bin/env bash
# infra/docker/vendor-deps.sh
# Vendor all dependencies for offline Docker builds.
#
# Run on a network-connected machine. Emits VENDOR-MANIFEST.sha256
# (a deterministic hash of every file pulled) that cross-host
# reproducibility proofs compare to confirm two builders started
# from the same dependency set.
#
# Usage: ./infra/docker/vendor-deps.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENDOR_DIR="$ROOT_DIR/infra/docker/vendor"
MANIFEST_PATH="$SCRIPT_DIR/VENDOR-MANIFEST.sha256"

# macOS ships `shasum -a 256`; Linux ships `sha256sum`. Wrap both so the
# manifest step works on whichever host runs vendor-deps.
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD="shasum -a 256"
else
  echo "error: neither sha256sum nor shasum found on PATH" >&2
  exit 1
fi

echo "=== Vendoring apt (.deb) packages ==="
# Needed for --network=none builds: both stages of Dockerfile.enclave
# apt-get install system libs. We split into two vendor sub-trees so
# each stage only ingests the .deb set it needs — otherwise dpkg -i
# trips on unmet transitive deps for packages the stage doesn't use.
#
# Match the base image digest pinned in Dockerfile.enclave. When that
# digest changes, bump here so the apt repo snapshot follows.
APT_BASE_IMAGE="node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383"

# Debian snapshot timestamps. Pinned so repeated vendoring runs — even weeks
# apart, across hosts — resolve apt-get to byte-identical .deb packages.
# Without this, apt-get picks whatever the live mirror has right now and
# security updates between build hosts diverge the vendor manifest.
# To refresh: pick a newer snapshot from http://snapshot.debian.org/ and
# update both values. Release file "expiry" is ignored (see apt args below).
DEBIAN_SNAPSHOT="20260416T204212Z"
DEBIAN_SECURITY_SNAPSHOT="20260416T171256Z"

# The vendor directory is generated state, not source. Start from an empty tree
# so removed dependency families cannot survive a rerun and poison PCR0.
rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"

download_apt_debs() {
  local out_dir="$1"
  shift
  mkdir -p "$out_dir"
  # apt-get install -d populates the cache with every .deb required to
  # satisfy the declared deps transitively, which is exactly what a
  # clean dpkg -i on the target stage needs.
  #
  # Packages to download are joined into a single arg and passed via env var
  # so the bash -c body can stay single-quoted (no outer-shell interpolation
  # inside the container script).
  local pkgs="$*"
  docker run --rm --platform linux/amd64 \
    -v "$out_dir:/out" \
    -e DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT" \
    -e DEBIAN_SECURITY_SNAPSHOT="$DEBIAN_SECURITY_SNAPSHOT" \
    -e APT_PKGS="$pkgs" \
    "$APT_BASE_IMAGE" \
    bash -c '
      set -e
      # Overwrite the live mirror with pinned snapshot URLs. Release files
      # on snapshot.debian.org carry an explicit Valid-Until that has long
      # since expired for older snapshots, so force apt to ignore it.
      cat > /etc/apt/sources.list <<SOURCES
deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm main
deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SECURITY_SNAPSHOT}/ bookworm-security main
SOURCES
      rm -rf /etc/apt/sources.list.d
      apt-get -o Acquire::Check-Valid-Until=false update -qq
      # shellcheck disable=SC2086 — APT_PKGS is a whitespace-separated list.
      apt-get install -y --no-install-recommends -d \
        -o Debug::NoLocking=true -o Dir::Cache::Archives=/out \
        -o Acquire::Check-Valid-Until=false \
        ${APT_PKGS}
      chmod -R a+rw /out
    '
}

# Builder stage: vsock-native native addon build tools.
rm -rf "$VENDOR_DIR/apt-builder"
download_apt_debs "$VENDOR_DIR/apt-builder" python3 make g++ libc6-dev

# Runtime stage: python + pip + CA bundle for the in-enclave helpers.
rm -rf "$VENDOR_DIR/apt-runtime"
download_apt_debs "$VENDOR_DIR/apt-runtime" python3 python3-pip python3-wheel ca-certificates ffmpeg libheif1 tesseract-ocr tesseract-ocr-eng

echo "=== Vendoring corepack (yarn) ==="
# `corepack enable` inside the offline build needs the yarn binary
# locally — without this, it tries to fetch from repo.yarnpkg.com and
# --network=none trips it. We pre-populate the corepack cache here so
# COREPACK_HOME inside the image resolves yarn offline.
rm -rf "$VENDOR_DIR/corepack"
mkdir -p "$VENDOR_DIR/corepack"
# Read the pinned yarn version from the repo's packageManager field so
# the vendor tree rotates automatically when Yarn bumps.
YARN_VERSION=$(node -e "process.stdout.write(require('$ROOT_DIR/package.json').packageManager.split('@')[1].split('+')[0])")
COREPACK_HOME="$VENDOR_DIR/corepack" corepack prepare "yarn@$YARN_VERSION"

echo "=== Vendoring node headers for native addon builds ==="
# node-gyp downloads node-v$VER-headers.tar.gz at build time to compile
# vsock-native's C++ addon. Under --network=none that fetch fails, so we
# pre-stage the headers here. Version must match the base image exactly —
# read it from the pinned image instead of hard-coding, so a digest bump
# can't silently desync the headers from the runtime.
mkdir -p "$VENDOR_DIR/node-headers"
NODE_VERSION=$(docker run --rm --platform linux/amd64 "$APT_BASE_IMAGE" \
  node --version | tr -d '[:space:]' | sed 's/^v//')
echo "Base image node version: $NODE_VERSION"
curl -fL --output "$VENDOR_DIR/node-headers/node-v${NODE_VERSION}-headers.tar.gz" \
  "https://nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-headers.tar.gz"

echo "=== Vendoring npm dependencies ==="
rm -rf "$VENDOR_DIR/npm"
mkdir -p "$VENDOR_DIR/npm"
cd "$ROOT_DIR"
# Yarn 4 (Berry): override cache folder via env var for this invocation.
# This downloads all packages into the vendor directory for offline builds.
# --immutable refuses to modify yarn.lock — without it, a host whose lockfile
# drifts could silently vendor a different dep set and PCR0 would diverge.
# --mode=skip-build defers postinstall scripts (node-gyp etc.) — those run
# inside the Dockerfile builder stage where the native toolchain exists.
YARN_ENABLE_GLOBAL_CACHE=false \
YARN_CACHE_FOLDER="$VENDOR_DIR/npm" \
  yarn install --immutable --mode=skip-build

echo "=== Vendoring pip dependencies ==="
rm -rf "$VENDOR_DIR/pip"
mkdir -p "$VENDOR_DIR/pip"
# Target the enclave image's python. node:22-slim is Debian bookworm, whose
# python3 package is 3.11 — so cp311 wheels, not cp312. Without these flags
# `pip download` grabs wheels for the host's arch/Python and the offline
# docker build fails with "no matching distribution" at install time.
#
# Every wheel — including transitive deps — is pinned in
# infra/docker/enclave-pip-requirements.txt. --no-deps enforces the pin: if
# a transitive is missing from the file, pip errors here instead of silently
# resolving a drifted version and corrupting the vendor manifest.
# Platform allowlist is ordered cheapest-glibc-first so pip prefers the
# older manylinux_2_17 wheels where a package ships them, and only falls
# back to manylinux_2_28 for packages that publish ONLY the newer tag
# (e.g. PyMuPDF>=1.26.1 moved its abi3 wheel to manylinux_2_28). The
# enclave base image (node:22-slim = Debian bookworm) ships glibc 2.36,
# so a 2_28 wheel runs fine; the build stays byte-reproducible because
# the resolution is deterministic for a fixed pip + requirements set.
# `srt` is excluded from the binary-only download below: it ships sdist-only on
# PyPI (no wheel, any version) yet is a hard runtime dep of vosk — vosk/__init__
# does `import srt` at module load. It is built from its pinned sdist into a
# pure-Python wheel in the dedicated step that follows.
SRT_PIN="$(grep -E '^srt==' "$SCRIPT_DIR/enclave-pip-requirements.txt" || true)"
WHEEL_ONLY_REQS="$(mktemp)"
trap 'rm -f "$WHEEL_ONLY_REQS"' EXIT
grep -vE '^srt==' "$SCRIPT_DIR/enclave-pip-requirements.txt" > "$WHEEL_ONLY_REQS"

pip download \
  --dest "$VENDOR_DIR/pip" \
  --python-version 3.11 \
  --platform manylinux2014_x86_64 \
  --platform manylinux_2_17_x86_64 \
  --platform manylinux_2_28_x86_64 \
  --implementation cp \
  --abi cp311 \
  --only-binary=:all: \
  --no-deps \
  -r "$WHEEL_ONLY_REQS"

# Build srt's pure-Python wheel from its pinned sdist into the same vendor dir
# so the offline --no-index/--find-links install in Dockerfile.enclave picks it
# up like any other vendored wheel. SOURCE_DATE_EPOCH=0 normalises the zip mtimes
# for byte-stable output; the wheel is py3-none-any (interpreter-independent).
if [ -n "$SRT_PIN" ]; then
  echo "=== Building srt wheel from sdist ($SRT_PIN) ==="
  docker run --rm --platform linux/amd64 \
    -v "$VENDOR_DIR/apt-runtime:/apt-runtime:ro" \
    -v "$VENDOR_DIR/pip:/out" \
    -e SRT_PIN="$SRT_PIN" \
    -e SOURCE_DATE_EPOCH=0 \
    "$APT_BASE_IMAGE" \
    bash -c '
      set -e
      dpkg --install --force-depends /apt-runtime/*.deb >/tmp/dpkg-install.log 2>&1 || true
      dpkg --configure -a
      python3 -m pip wheel --no-cache-dir --no-deps "$SRT_PIN" -w /out
      chmod -R a+rw /out
    '
fi

# NOTE: the spaCy NER model (en_core_web_lg) is no longer vendored — the
# in-enclave Presidio/spaCy PII-masking sidecar was removed (de-identification
# is on-device only). The orphaned presidio/spacy wheels still present under
# vendor/pip and vendor/spacy from prior passes are dropped when this script
# is re-run against the pruned enclave-pip-requirements.txt.

echo "=== Downloading Vosk transcription model ==="
rm -rf "$VENDOR_DIR/vosk"
mkdir -p "$VENDOR_DIR/vosk"
VOSK_MODEL_VERSION="0.15"
VOSK_MODEL_NAME="vosk-model-small-en-us-${VOSK_MODEL_VERSION}"
VOSK_MODEL_URL="https://alphacephei.com/vosk/models/${VOSK_MODEL_NAME}.zip"
curl -fL --output "$VENDOR_DIR/vosk/${VOSK_MODEL_NAME}.zip" \
  "$VOSK_MODEL_URL"

echo "=== Computing vendor manifest ==="
# Manifest is sha256-of-path → sha256-of-file-contents, sorted by path.
# The manifest file itself is committed (vendor/ is gitignored); verifiers
# diff MANIFEST across hosts and recompute the inner hashes to confirm the
# bytes match.
( cd "$VENDOR_DIR" && \
  find . -type f -print0 | \
  LC_ALL=C sort -z | \
  xargs -0 $SHA256_CMD | \
  awk '{ printf "%s  %s\n", $1, $2 }' \
) > "$MANIFEST_PATH"

MANIFEST_HASH=$($SHA256_CMD "$MANIFEST_PATH" | awk '{print $1}')
echo ""
echo "=== Vendoring complete ==="
echo "Vendor directory:   $VENDOR_DIR"
echo "Manifest file:      $MANIFEST_PATH"
echo "Manifest SHA256:    $MANIFEST_HASH"
echo ""
echo "Next: ./enclave/build.sh --offline"
