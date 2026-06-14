/**
 * Privacy invariant P8 — static Dockerfile regression gate.
 *
 * INVARIANT P8: "Adding or removing LLM providers does not change the enclave
 * attestation hash (PCR0)."
 *
 * The invariant holds by CONSTRUCTION: providers.json is fetched at enclave
 * boot from the host-side registry-broker sidecar (signature-verified against
 * registry-verify-key.pem) and is NOT baked into the EIF. The moment someone
 * adds `COPY enclave/src/providers/providers.json …` to the final runtime
 * stage of infra/docker/Dockerfile.enclave, PCR0 becomes a function of the
 * registry content and the invariant breaks silently — "add a provider that
 * uses an existing adapter" would rotate PCR0 and force the whole client
 * attestation fleet to re-pin.
 *
 * This test locks the construction down. It parses Dockerfile.enclave as
 * text, identifies the final runtime stage, enumerates every COPY line in
 * that stage, and asserts:
 *   1. None of the COPY source paths references providers.json (in any stage).
 *   2. registry-verify-key.pem IS copied — without it the enclave cannot
 *      verify the signed registry from the broker, which is P8-adjacent.
 *   3. The set of COPY --from=builder source paths is a SUPERSET of a known
 *      allowlist and contains no paths outside an expected prefix set.
 *      This catches "someone added a broad COPY that pulls in the whole
 *      enclave/src/ tree" regressions.
 *
 * Layer 2 (live byte-identical PCR0 proof) lives in
 * p8-byte-identical-pcr0.nitro.test.ts and runs only on Nitro hosts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// enclave/__tests__/ → repo root is two levels up.
const REPO_ROOT = resolve(__dirname, '..', '..');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'infra/docker/Dockerfile.enclave');

/**
 * Split a Dockerfile into an ordered list of stages. A "stage" starts at a
 * `FROM <image> [AS <alias>]` line and ends at the next FROM (or EOF). The
 * FINAL runtime stage is the last entry — this is what goes into the EIF.
 *
 * We deliberately keep the parser simple (regex + line-by-line scan) because
 * Dockerfile.enclave uses only the canonical multi-stage pattern. If this
 * ever grows heredoc-driven stage bodies or BuildKit frontend syntax, swap
 * this out for @docker/dockerfile-ast — for today, regex is clearer.
 */
interface Stage {
  index: number;
  fromLine: string;
  bodyLines: string[];
}

function parseStages(dockerfile: string): Stage[] {
  const lines = dockerfile.split('\n');
  const stages: Stage[] = [];
  let current: Stage | null = null;

  for (const line of lines) {
    // Strip leading whitespace for the FROM match only (Dockerfile allows
    // indented instructions — unusual but legal).
    if (/^\s*FROM\s+/i.test(line)) {
      if (current) stages.push(current);
      current = { index: stages.length, fromLine: line, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) stages.push(current);

  return stages;
}

/**
 * Collapse line-continuations (backslash-newline) into one logical line, then
 * return every logical COPY instruction in the stage.
 */
function extractCopyInstructions(stage: Stage): string[] {
  // Join continuation lines: any line ending with `\` (maybe trailing space)
  // merges into the next.
  const joined: string[] = [];
  let buffer = '';
  for (const line of stage.bodyLines) {
    if (/\\\s*$/.test(line)) {
      buffer += line.replace(/\\\s*$/, ' ');
    } else {
      joined.push((buffer + line).trim());
      buffer = '';
    }
  }
  if (buffer) joined.push(buffer.trim());

  return joined.filter((l) => /^COPY\b/i.test(l));
}

/**
 * A COPY instruction's source paths are everything after the COPY keyword
 * (minus --flags and the final destination). We don't need full shell parsing
 * — Dockerfile.enclave only uses `COPY [--from=X] src [src...] dst`.
 */
function copySourcePaths(copyLine: string): string[] {
  // Strip "COPY" and any leading flags.
  const tokens = copyLine.split(/\s+/).slice(1);
  const nonFlagTokens = tokens.filter((t) => !t.startsWith('--'));
  // Last token is destination; everything before is source.
  if (nonFlagTokens.length < 2) return [];
  return nonFlagTokens.slice(0, -1);
}

describe('Privacy invariant P8 — Dockerfile.enclave must not bake providers.json', () => {
  const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
  const stages = parseStages(dockerfile);
  const finalStage = stages[stages.length - 1];
  const allCopyLines = stages.flatMap(extractCopyInstructions);
  const finalStageCopyLines = extractCopyInstructions(finalStage);

  it('parses at least two stages (multi-stage build)', () => {
    expect(stages.length).toBeGreaterThanOrEqual(2);
  });

  it('final runtime stage contains no COPY whose source references providers.json OR its parent providers/ directory', () => {
    // Codex review HIGH (Chunk 9 pass 1): the previous regex matched
    // `providers.json` literally, so a directory-level COPY like
    // `COPY enclave/src/providers ./dist/providers` would slip past,
    // sweep providers.json into the final image, and silently break P8.
    // Widen the match to any source path that IS providers.json, IS a
    // parent path that transitively includes it, or is the providers/
    // directory itself. The registry-verify-key.pem COPY is a specific
    // file and is allowed through the final stage explicitly.
    const offenders = finalStageCopyLines.filter((line) => {
      const sources = copySourcePaths(line);
      return sources.some((src) => {
        // Strip leading slash and trailing slash for consistent matching.
        const normalized = src.replace(/^\/+|\/+$/g, '');
        // Literal providers.json file (any depth).
        if (/(^|\/)providers\.json$/.test(normalized)) return true;
        // Parent path is enclave/src/providers (any prefix) AND this is
        // NOT the specific registry-verify-key.pem file.
        if (/providers$/.test(normalized)) return true;
        if (/providers\/(?!registry-verify-key\.pem$)/.test(normalized)) return true;
        return false;
      });
    });
    expect(offenders, `final-stage COPY line references providers.json, the providers/ directory, or a parent path that would transitively bake the registry into the EIF — rotates PCR0 on every provider add (breaks P8). Only the specific file registry-verify-key.pem is allowed through to the final stage.`).toEqual([]);
  });

  it('no stage at all contains a COPY whose source references providers.json (direct literal match, any stage)', () => {
    // Even a builder-stage bake would be suspect — it would mean someone
    // intended for providers.json to travel through the build somehow.
    // Narrower than the final-stage check above (builder stages legitimately
    // COPY broad directory trees like `enclave/` into the builder stage,
    // which is fine — the final stage's narrow allowlist is what protects
    // P8).
    const offenders = allCopyLines.filter((line) => /providers\.json/.test(line));
    expect(offenders, `some stage copies providers.json literally — if it transits via COPY --from=builder into the final stage, P8 breaks`).toEqual([]);
  });

  it('final-stage build-context COPYs (no --from=<stage>) are restricted to an explicit allowlist', () => {
    // Codex review HIGH (Chunk 9 pass 1): a regression like
    // `COPY enclave/src/providers ./dist/providers` in the final stage
    // is a build-context COPY — it reads from the Docker build context
    // (the source root) rather than from the builder stage. The
    // --from=builder allowlist test above only catches builder-stage
    // COPYs. For Dockerfile.enclave the final-stage contract is that
    // build-context COPYs are restricted to an explicit file-level
    // allowlist — currently just the attested-KMS binary + encrypted
    // key blob, both of which must bake into the EIF by design.
    const ALLOWED_BUILD_CONTEXT_SOURCES = [
      // Vendored dependency tree — populated by
      // infra/docker/vendor-deps.sh with apt .debs, pip wheels, yarn
      // cache. Does NOT contain providers.json (the vendor script only
      // vendors toolchain inputs). If a future revision of
      // vendor-deps.sh starts including anything provider-related,
      // update this test comment with the rationale.
      '${VENDOR_DIR}/',
      // Static Python runtime dependency manifest. It pins extractor /
      // transform wheels for reproducible pip installs and contains no
      // runtime provider configuration or secret-bearing material.
      'infra/docker/enclave-pip-requirements.txt',
      // Attested-KMS binaries — must bake into the EIF because the
      // enclave has no host filesystem access at runtime. Both are
      // measured into PCR0.
      'infra/enclave-artefacts/kmstool_enclave_cli',
      'infra/enclave-artefacts/libnsm.so',
      // NOTE: the encrypted provider key blob used to be baked into
      // the EIF (pre-Chunk-12). It is now host-served via
      // infra/host/keys-broker.py on vsock:8102 and fetched by
      // enclave/src/keys-client.ts at EnclaveRouter.init() time.
      // The providers.json registry (also host-served) follows the
      // same pattern. If a future revision re-introduces a build-
      // context COPY for either file, that is an architectural
      // regression that this gate MUST catch.
    ];

    const buildContextCopies = finalStageCopyLines.filter(
      (l) => !/--from=\w+/.test(l),
    );
    const buildContextSources = buildContextCopies.flatMap(copySourcePaths);
    const extraneous = buildContextSources.filter(
      (src) => !ALLOWED_BUILD_CONTEXT_SOURCES.includes(src),
    );
    expect(
      extraneous,
      `unexpected build-context COPY source(s) in the final stage. Any file pulled directly from the build context bypasses the --from=builder allowlist. Expected only: ${ALLOWED_BUILD_CONTEXT_SOURCES.join(', ')}. If adding a new one is deliberate, extend this allowlist AND confirm the file cannot transitively include providers.json.`,
    ).toEqual([]);
  });

  it('final runtime stage copies registry-verify-key.pem (so the enclave can verify the broker-fetched registry signature)', () => {
    const hasVerifyKey = finalStageCopyLines.some((line) =>
      /registry-verify-key\.pem/.test(line),
    );
    expect(
      hasVerifyKey,
      `final stage must COPY registry-verify-key.pem — without it the enclave cannot verify signed providers.json from the host registry-broker, and P8's "config-only provider changes" property collapses`,
    ).toBe(true);
  });

  it('final-stage COPY --from=builder source paths are all within the expected allowlist', () => {
    // P8 depends on the final stage pulling ONLY a narrow set of builder
    // artefacts. A broad COPY like `COPY --from=builder /app/enclave ./`
    // would drag providers.json along for the ride. This test pins the
    // allowlist of path-prefixes that may appear as COPY --from=builder
    // sources.
    const ALLOWED_PREFIXES = [
      '/app/enclave/dist',
      '/app/node_modules',
      '/app/packages',
      '/app/enclave/src/tools/media_tools_service.py',
      '/app/enclave/src/nsm_helper.py',
      '/app/enclave/src/providers/registry-verify-key.pem',
      // Skill-prompts verify key — same role as the registry verify key: the
      // signed skill-prompts bundle is host-served (NOT baked), and this public
      // key is the verification anchor. Adding it bakes no prompt.
      '/app/enclave/src/skills/skill-prompts-verify-key.pem',
    ];

    const fromBuilderCopies = finalStageCopyLines.filter((l) =>
      /--from=builder/.test(l),
    );
    const fromBuilderSources = fromBuilderCopies.flatMap(copySourcePaths);

    // At least one of each expected prefix should be present (catches a
    // deletion regression too).
    for (const expectedPrefix of ALLOWED_PREFIXES) {
      expect(
        fromBuilderSources,
        `expected COPY --from=builder ${expectedPrefix} — deletion would break the enclave runtime or remove a verification anchor`,
      ).toContain(expectedPrefix);
    }

    // No source outside the allowlist.
    const extraneous = fromBuilderSources.filter(
      (src) => !ALLOWED_PREFIXES.includes(src),
    );
    expect(
      extraneous,
      `unexpected COPY --from=builder source(s) in final stage — update the allowlist deliberately AND confirm P8 still holds byte-for-byte before merging`,
    ).toEqual([]);
  });

  it('negative: parser detects a contrived regression where providers.json is baked', () => {
    // Hermetic inline Dockerfile snippet — no temp file, no filesystem touch.
    const regressionSnippet = [
      'FROM node:22-slim AS builder',
      'COPY enclave/ ./enclave/',
      'RUN echo build',
      '',
      'FROM node:22-slim',
      'COPY --from=builder /app/enclave/dist ./dist',
      // ↓ THE regression — straight bake.
      'COPY enclave/src/providers/providers.json ./dist/providers/providers.json',
      'CMD ["node", "dist/index.js"]',
    ].join('\n');

    const contrivedStages = parseStages(regressionSnippet);
    const contrivedCopy = extractCopyInstructions(
      contrivedStages[contrivedStages.length - 1],
    );
    const caught = contrivedCopy.filter((l) => /providers\.json/.test(l));
    expect(
      caught.length,
      'parser must flag the contrived regression input — if this fails, the detection logic is broken and real regressions would slip through',
    ).toBeGreaterThan(0);
  });

  it('negative: parser detects a direct build-context COPY of the providers/ directory (the originally-missed case)', () => {
    // Codex review HIGH (Chunk 9 pass 1) gap: literal `providers.json`
    // is not the only way to regress P8. A directory-level COPY from
    // the build context would do the same damage without matching a
    // simple regex. This locks that hole shut.
    const regressionSnippet = [
      'FROM node:22-slim AS builder',
      'COPY enclave/ ./enclave/',
      '',
      'FROM node:22-slim',
      'WORKDIR /app',
      'COPY --from=builder /app/enclave/dist ./dist',
      // ↓ THE regression — build-context COPY, directory-level. No
      // --from=builder flag, no literal providers.json, but sweeps the
      // whole providers/ directory (including providers.json) into the
      // final image.
      'COPY enclave/src/providers ./dist/providers',
      'CMD ["node", "dist/index.js"]',
    ].join('\n');

    const contrivedStages = parseStages(regressionSnippet);
    const contrivedFinalCopies = extractCopyInstructions(
      contrivedStages[contrivedStages.length - 1],
    );

    // (a) Must be flagged as a build-context COPY (no --from=<stage>).
    const buildContextRegression = contrivedFinalCopies.filter(
      (l) => !/--from=\w+/.test(l),
    );
    expect(
      buildContextRegression.length,
      'build-context COPY check must flag any final-stage COPY that reads from the Docker build context — this is the specific regression Codex HIGH surfaced',
    ).toBeGreaterThan(0);

    // (b) Widened providers/ check must also flag the directory source.
    const providersMatches = contrivedFinalCopies.filter((line) => {
      const sources = copySourcePaths(line);
      return sources.some((src) => {
        const normalized = src.replace(/^\/+|\/+$/g, '');
        if (/(^|\/)providers\.json$/.test(normalized)) return true;
        if (/providers$/.test(normalized)) return true;
        if (/providers\/(?!registry-verify-key\.pem$)/.test(normalized)) return true;
        return false;
      });
    });
    expect(
      providersMatches.length,
      'widened providers/ match must catch the directory-level source path — literal providers.json regex alone is insufficient',
    ).toBeGreaterThan(0);
  });

  it('negative: parser detects a regression where providers.json is copied via a broad COPY --from=builder', () => {
    // A subtler regression: no literal `providers.json` string, but the
    // source path is broad enough to sweep it in. This is what the
    // allowlist test catches.
    const regressionSnippet = [
      'FROM node:22-slim AS builder',
      'COPY enclave/ ./enclave/',
      '',
      'FROM node:22-slim',
      'WORKDIR /app',
      'COPY --from=builder /app/enclave/dist ./dist',
      // ↓ THE regression — broad source pulls providers.json in.
      'COPY --from=builder /app/enclave/src ./src',
      'COPY --from=builder /app/node_modules ./node_modules',
      'COPY --from=builder /app/packages ./packages',
      'COPY --from=builder /app/enclave/src/nsm_helper.py ./dist/nsm_helper.py',
      'COPY --from=builder /app/enclave/src/providers/registry-verify-key.pem ./dist/providers/registry-verify-key.pem',
      'CMD ["node", "dist/index.js"]',
    ].join('\n');

    const contrivedStages = parseStages(regressionSnippet);
    const contrivedFinalCopies = extractCopyInstructions(
      contrivedStages[contrivedStages.length - 1],
    );
    const fromBuilderSources = contrivedFinalCopies
      .filter((l) => /--from=builder/.test(l))
      .flatMap(copySourcePaths);

    const ALLOWED_PREFIXES = [
      '/app/enclave/dist',
      '/app/node_modules',
      '/app/packages',
      '/app/enclave/src/nsm_helper.py',
      '/app/enclave/src/providers/registry-verify-key.pem',
    ];
    const extraneous = fromBuilderSources.filter(
      (src) => !ALLOWED_PREFIXES.includes(src),
    );
    expect(
      extraneous.length,
      'parser must flag the broad COPY --from=builder /app/enclave/src regression — it sweeps providers.json into the final stage',
    ).toBeGreaterThan(0);
  });
});
