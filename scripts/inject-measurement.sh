#!/bin/bash
# scripts/inject-measurement.sh
#
# Reads enclave/measurement.json and patches the PINNED_MEASUREMENT in both
# mobile and web measurement.ts files. Run after every enclave build.
#
# Usage:
#   ./scripts/inject-measurement.sh                     # reads enclave/measurement.json
#   ./scripts/inject-measurement.sh path/to/custom.json # reads custom file
#
# CI usage (after nitro-cli build-enclave):
#   nitro-cli describe-eif --eif-path enclave.eif --output-file enclave/measurement.json
#   ./scripts/inject-measurement.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
MEASUREMENT_FILE="${1:-$ROOT_DIR/enclave/measurement.json}"

if [ ! -f "$MEASUREMENT_FILE" ]; then
  echo "Error: Measurement file not found: $MEASUREMENT_FILE"
  echo "Run the enclave build first, or provide a measurement file."
  exit 1
fi

# Codex MEDIUM #18 — duplicate-key rejection. jq silently picks the
# LATER value for a duplicated key, so a measurement.json that was
# poisoned to contain two `pcr0` entries would otherwise patch the
# client-pinned PINNED_MEASUREMENT with the attacker's PCR0 (TEE
# trust-anchor compromise).
#
# Adversarial-review pass-1: the previous python3 implementation
# introduced an undeclared interpreter dependency. Minimal CI runners
# / distroless containers / nitro-cli builder images may not have
# python3 — a missing interpreter then masquerades as JSON corruption.
# Node IS already a hard dependency of this script (the patcher below
# uses `node -e`) so we use a Node.js implementation that explicitly
# detects duplicate keys by reviving with a tracking object. The JSON
# spec doesn't define duplicate-key behaviour; Node's JSON.parse
# silently overwrites, so we use a token-level scan keyed on the
# source text instead of the parsed tree.
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required to run the measurement-injection guard but was not found on PATH." >&2
  exit 1
fi
# Pass the file path via env var rather than `process.argv[1]`. While
# modern Node (18+) populates argv as `[node, <arg>]` under `-e`,
# older Node versions injected `[eval]` into the script slot, making
# argv[1] the literal string `[eval]`. Env var passing is stable across
# all supported Node versions.
DUPE_CHECK_RESULT=$(CALYPSO_MEASUREMENT_FILE="$MEASUREMENT_FILE" node -e '
const fs = require("node:fs");
const path = process.env.CALYPSO_MEASUREMENT_FILE;
if (!path) {
  console.error("internal: CALYPSO_MEASUREMENT_FILE env not set");
  process.exit(2);
}
const text = fs.readFileSync(path, "utf8");
// Validate it parses as JSON at all.
try { JSON.parse(text); } catch (e) {
  console.error(`malformed: ${e.message}`);
  process.exit(2);
}

// Adversarial-review pass-7 MEDIUM — token-scan for object-key
// duplicates at each nesting level, DECODING each key string to
// its canonical form before comparison. JSON allows the same key
// to be expressed via \uXXXX escapes; "pcr0" and "pcr0" are
// spec-equivalent but distinct as raw substrings. jq follows the
// last-write-wins on duplicates after decoding, so the attacker
// surface is exactly the decoded-key compare. Use JSON.parse on
// each individual key literal to normalise.
function decodeKey(rawLiteral) {
  // Wrap the raw key body in quotes and let JSON.parse handle all
  // valid string escapes (including \uXXXX). If it throws the JSON
  // itself was malformed and we already failed above.
  return JSON.parse(`"${rawLiteral}"`);
}

const stack = [new Set()];
let i = 0;
while (i < text.length) {
  const ch = text[i];
  if (ch === "{") {
    stack.push(new Set());
    i++;
  } else if (ch === "}") {
    stack.pop();
    i++;
  } else if (ch === "\"") {
    // String literal — may be a key or a value. Walk to the close
    // quote, handling escapes.
    const start = i + 1;
    let j = start;
    while (j < text.length) {
      if (text[j] === "\\") { j += 2; continue; }
      if (text[j] === "\"") break;
      j++;
    }
    const literal = text.slice(start, j);
    // Look-ahead: skip whitespace; if next non-ws is ":" treat as key.
    let k = j + 1;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] === ":") {
      // Compare on the DECODED key, not the raw literal — closes the
      // \u-escape duplicate bypass.
      const decoded = decodeKey(literal);
      const seen = stack[stack.length - 1];
      if (seen.has(decoded)) {
        console.error(`duplicate-key: ${decoded}`);
        process.exit(2);
      }
      seen.add(decoded);
    }
    i = j + 1;
  } else {
    i++;
  }
}
' 2>&1) || {
  echo "Error: measurement.json failed duplicate-key / well-formed JSON validation." >&2
  echo "       File: $MEASUREMENT_FILE" >&2
  echo "       Detail: $DUPE_CHECK_RESULT" >&2
  echo "       This guard exists because jq silently coerces a duplicated key" >&2
  echo "       (e.g. two 'pcr0' entries) and would patch the client-pinned" >&2
  echo "       PCR0 with the attacker-controlled later value." >&2
  exit 1
}

PCR0=$(jq -r '.pcr0' "$MEASUREMENT_FILE")
VERSION=$(jq -r '.version // "2.0.0"' "$MEASUREMENT_FILE")
COMMIT_HASH=$(jq -r '.commitHash // "unknown"' "$MEASUREMENT_FILE")
VERIFIED_AT=$(jq -r '.verifiedAt // "'$(date +%Y-%m-%d)'"' "$MEASUREMENT_FILE")

if [ -z "$PCR0" ] || [ "$PCR0" = "null" ]; then
  echo "Error: pcr0 field is empty or missing in $MEASUREMENT_FILE"
  exit 1
fi

# Codex MEDIUM #18 — value-level validation. Even with the
# duplicate-key guard above, a measurement.json with a structurally
# legal but malformed value (e.g. an embedded quote) could escape
# the node -e substitution below into the client measurement.ts file.
# Bound each value to its expected character set BEFORE patching.
# Nitro PCR0 is always 96 hex chars (SHA-384). Allow 60-128 for
# slack across short PCRs / future curves.
if ! [[ "$PCR0" =~ ^[0-9a-fA-F]{60,128}$ ]]; then
  echo "Error: PCR0 value is not hex (60-128 chars). Got: ${PCR0@Q}" >&2
  exit 1
fi
if ! [[ "$COMMIT_HASH" =~ ^[0-9a-fA-F]{7,40}$ ]] && [ "$COMMIT_HASH" != "unknown" ]; then
  echo "Error: commitHash is not a git short/long SHA or 'unknown'. Got: ${COMMIT_HASH@Q}" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9A-Za-z._+-]+$ ]]; then
  echo "Error: version contains characters outside [0-9A-Za-z._+-]. Got: ${VERSION@Q}" >&2
  exit 1
fi
if ! [[ "$VERIFIED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "Error: verifiedAt is not YYYY-MM-DD. Got: ${VERIFIED_AT@Q}" >&2
  exit 1
fi

echo "Injecting measurement:"
echo "  PCR0:       ${PCR0:0:16}...${PCR0: -16}"
echo "  Version:    $VERSION"
echo "  Commit:     $COMMIT_HASH"
echo "  Verified:   $VERIFIED_AT"

# Patch mobile measurement.ts
MOBILE_FILE="$ROOT_DIR/apps/mobile/lib/tee/measurement.ts"
if [ -f "$MOBILE_FILE" ]; then
  # Use node for reliable multiline replacement
  node -e "
    const fs = require('fs');
    let content = fs.readFileSync('$MOBILE_FILE', 'utf-8');
    content = content.replace(
      /PCR0:\s*['\"][^'\"]*['\"]/,
      \"PCR0: '$PCR0'\"
    );
    content = content.replace(
      /version:\s*['\"][^'\"]*['\"]/,
      \"version: '$VERSION'\"
    );
    content = content.replace(
      /commitHash:\s*['\"][^'\"]*['\"]/,
      \"commitHash: '$COMMIT_HASH'\"
    );
    content = content.replace(
      /verifiedAt:\s*['\"][^'\"]*['\"]/,
      \"verifiedAt: '$VERIFIED_AT'\"
    );
    fs.writeFileSync('$MOBILE_FILE', content);
  "
  echo "  Patched: $MOBILE_FILE"
fi

# Patch web measurement.ts (apps/web prettier config prefers double quotes;
# use them here to keep `yarn lint:check` clean after every re-injection).
WEB_FILE="$ROOT_DIR/apps/web/lib/tee/measurement.ts"
if [ -f "$WEB_FILE" ]; then
  node -e "
    const fs = require('fs');
    let content = fs.readFileSync('$WEB_FILE', 'utf-8');
    content = content.replace(
      /PCR0:\s*['\"][^'\"]*['\"]/,
      'PCR0: \"$PCR0\"'
    );
    content = content.replace(
      /version:\s*['\"][^'\"]*['\"]/,
      'version: \"$VERSION\"'
    );
    content = content.replace(
      /commitHash:\s*['\"][^'\"]*['\"]/,
      'commitHash: \"$COMMIT_HASH\"'
    );
    content = content.replace(
      /verifiedAt:\s*['\"][^'\"]*['\"]/,
      'verifiedAt: \"$VERIFIED_AT\"'
    );
    fs.writeFileSync('$WEB_FILE', content);
  "
  echo "  Patched: $WEB_FILE"
fi

echo "Done. Measurement injected into mobile and web."
