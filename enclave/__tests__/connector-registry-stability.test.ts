/**
 * Connector catalog stability gate — static Dockerfile + signed-pair regression.
 *
 * MIRRORS p8-registry-stability.test.ts. Where P8 protects providers.json, this
 * protects the agent CONNECTOR catalog (connectors.json + connectors-verify-key.pem).
 *
 * INVARIANT: "Adding or removing agent connectors (connector #2..N) does not
 * change the enclave attestation hash (PCR0)."
 *
 * The invariant holds by CONSTRUCTION: connectors.json is fetched at enclave
 * boot from the host-side connectors-broker sidecar (vsock:8106, signature-
 * verified against connectors-verify-key.pem) and is NOT baked into the EIF.
 * The verify KEY is baked (it is the measured verification anchor — adding it
 * names/bakes no connector); the catalog DATA is not. The moment someone adds
 * `COPY enclave/src/connectors/connectors.json …` to the final runtime stage of
 * infra/docker/Dockerfile.enclave — or sweeps it in via a directory-level COPY
 * — PCR0 becomes a function of the catalog content and the invariant breaks
 * silently: "add a connector that uses an existing client" would rotate PCR0
 * and force the whole client attestation fleet to re-pin.
 *
 * This test locks the construction down on three axes:
 *   (a) connectors-verify-key.pem IS copied into the final runtime stage
 *       (the measured/baked allowlist) — without it the enclave cannot verify
 *       the broker-fetched catalog signature, and the rotation-free property
 *       collapses.
 *   (b) connectors.json is NOT baked into the image — neither a literal COPY of
 *       the file in any stage, nor a directory-level `COPY enclave/src/connectors …`
 *       into the final stage that would sweep the catalog in. The ONLY
 *       connectors/ file allowed through to the final stage is the specific
 *       connectors-verify-key.pem.
 *   (c) the committed connectors.json + connectors-verify-key.pem are a
 *       CONSISTENT signed pair — the catalog schema-validates AND its Ed25519
 *       signature verifies against the committed key. This guards against the
 *       two files drifting out of sync (critical because a later task re-signs
 *       the catalog with a prod key; if the key and catalog are not re-committed
 *       together, this test bites). It exercises the REAL
 *       loadAndVerifyConnectorCatalog, the same code the enclave runs at boot.
 *
 * The p8 test's --from=builder allowlist already lists the connector verify key
 * (so a drop/bake there is caught too) — this test asserts the connector-
 * specific properties directly so a future Dockerfile edit is caught by a
 * connector-NAMED gate, not only buried in the provider allowlist.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ConnectorCatalogSchema,
  MIN_CONNECTOR_CATALOG_VERSION,
} from '@calypso/chat-types';
import { loadAndVerifyConnectorCatalog } from '../src/connectors/registry';

const __dirname = dirname(fileURLToPath(import.meta.url));

// enclave/__tests__/ → repo root is two levels up.
const REPO_ROOT = resolve(__dirname, '..', '..');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'infra/docker/Dockerfile.enclave');
const CATALOG_PATH = resolve(REPO_ROOT, 'enclave/src/connectors/connectors.json');
const VERIFY_KEY_PATH = resolve(
  REPO_ROOT,
  'enclave/src/connectors/connectors-verify-key.pem',
);

/**
 * Split a Dockerfile into an ordered list of stages. A "stage" starts at a
 * `FROM <image> [AS <alias>]` line and ends at the next FROM (or EOF). The
 * FINAL runtime stage is the last entry — this is what goes into the EIF.
 *
 * Copied verbatim from p8-registry-stability.test.ts (local helpers, not
 * exported) — deliberately NOT refactored so the two gates stay independent.
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
 * (minus --flags and the final destination).
 */
function copySourcePaths(copyLine: string): string[] {
  const tokens = copyLine.split(/\s+/).slice(1);
  const nonFlagTokens = tokens.filter((t) => !t.startsWith('--'));
  if (nonFlagTokens.length < 2) return [];
  return nonFlagTokens.slice(0, -1);
}

/**
 * Detector for "this COPY source would bake the connector catalog". Matches the
 * literal connectors.json (any depth), the connectors/ directory itself, or a
 * parent path that transitively includes it — EXCEPT the specific
 * connectors-verify-key.pem, which is the one connectors/ file allowed through
 * to the final stage. Mirrors p8's widened providers/ matcher.
 */
function sourceWouldBakeCatalog(src: string): boolean {
  const normalized = src.replace(/^\/+|\/+$/g, '');
  // Literal connectors.json file (any depth).
  if (/(^|\/)connectors\.json$/.test(normalized)) return true;
  // The connectors/ directory itself (sweeps the catalog in).
  if (/connectors$/.test(normalized)) return true;
  // A path under connectors/ that is NOT the allowed verify key.
  if (/connectors\/(?!connectors-verify-key\.pem$)/.test(normalized)) return true;
  return false;
}

describe('Connector catalog stability — Dockerfile.enclave must bake the verify key but NOT the catalog', () => {
  const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
  const stages = parseStages(dockerfile);
  const finalStage = stages[stages.length - 1];
  const allCopyLines = stages.flatMap(extractCopyInstructions);
  const finalStageCopyLines = extractCopyInstructions(finalStage);

  it('parses at least two stages (multi-stage build)', () => {
    expect(stages.length).toBeGreaterThanOrEqual(2);
  });

  // ── (a) the verify key IS baked into the final runtime stage ──────────────
  it('final runtime stage copies connectors-verify-key.pem (so the enclave can verify the broker-fetched catalog signature)', () => {
    const hasVerifyKey = finalStageCopyLines.some((line) =>
      /connectors-verify-key\.pem/.test(line),
    );
    expect(
      hasVerifyKey,
      `final stage must COPY connectors-verify-key.pem — without it the enclave cannot verify the signed connectors.json from the host connectors-broker (vsock:8106), and the "config-only connector changes" / PCR0-rotation-free property collapses`,
    ).toBe(true);
  });

  // ── (b) the catalog DATA is NOT baked, in any form ────────────────────────
  it('final runtime stage contains no COPY whose source references connectors.json OR its parent connectors/ directory', () => {
    // A directory-level COPY like `COPY enclave/src/connectors ./dist/connectors`
    // would slip past a literal-string match, sweep connectors.json into the
    // final image, and silently rotate PCR0 on every connector add. The only
    // connectors/ file allowed through the final stage is the specific
    // connectors-verify-key.pem.
    const offenders = finalStageCopyLines.filter((line) =>
      copySourcePaths(line).some(sourceWouldBakeCatalog),
    );
    expect(
      offenders,
      `final-stage COPY line references connectors.json, the connectors/ directory, or a parent path that would transitively bake the catalog into the EIF — rotates PCR0 on every connector add. Only the specific file connectors-verify-key.pem is allowed through to the final stage.`,
    ).toEqual([]);
  });

  it('no stage at all contains a COPY whose source references connectors.json (direct literal match, any stage)', () => {
    // Even a builder-stage bake would be suspect — it would mean someone
    // intended connectors.json to travel through the build somehow. Builder
    // stages legitimately COPY broad directory trees (e.g. `COPY enclave/ …`)
    // — that is fine; the final-stage narrow allowlist is what protects the
    // rotation-free guarantee. This narrower check flags only a deliberate,
    // by-name bake of the catalog file.
    const offenders = allCopyLines.filter((line) => /connectors\.json/.test(line));
    expect(
      offenders,
      `some stage copies connectors.json literally — if it transits via COPY --from=builder into the final stage, the PCR0-rotation-free property for connector #2..N breaks`,
    ).toEqual([]);
  });

  it('final-stage build-context COPYs (no --from=<stage>) cannot sweep in the connectors/ catalog', () => {
    // A regression like `COPY enclave/src/connectors ./dist/connectors` in the
    // final stage is a build-context COPY — it reads from the Docker build
    // context (the source root) rather than from the builder stage, so the
    // --from=builder allowlist check would miss it. Assert no build-context
    // COPY source would bake the catalog.
    const buildContextCopies = finalStageCopyLines.filter(
      (l) => !/--from=\w+/.test(l),
    );
    const offenders = buildContextCopies.filter((line) =>
      copySourcePaths(line).some(sourceWouldBakeCatalog),
    );
    expect(
      offenders,
      `a final-stage build-context COPY would sweep the connectors/ catalog directly from the build context, bypassing the --from=builder allowlist and baking connectors.json into the EIF`,
    ).toEqual([]);
  });

  it('the final-stage connectors-verify-key.pem COPY is the ONLY connectors/ source allowed through', () => {
    // Belt-and-braces: enumerate every connectors/ source that reaches the
    // final stage and assert each is exactly the verify key. This catches a
    // future edit that bakes the key AND something else under connectors/.
    const connectorSources = finalStageCopyLines
      .flatMap(copySourcePaths)
      .filter((src) => /(^|\/)connectors\//.test(src.replace(/^\/+/, '')));
    const disallowed = connectorSources.filter(
      (src) => !/connectors\/connectors-verify-key\.pem$/.test(src.replace(/\/+$/, '')),
    );
    expect(
      disallowed,
      `the only connectors/ artefact permitted in the final stage is connectors-verify-key.pem — any other connectors/ source (especially the catalog) breaks the rotation-free guarantee`,
    ).toEqual([]);
  });

  // ── (c) consistency guard: committed catalog + key are a signed pair ──────
  it('committed connectors.json schema-validates AND its signature verifies against the committed connectors-verify-key.pem', () => {
    const catalogText = readFileSync(CATALOG_PATH, 'utf-8');
    const pemText = readFileSync(VERIFY_KEY_PATH, 'utf-8');

    // Exercise the REAL enclave-boot verifier (NOT a re-implementation): it
    // schema-validates against ConnectorCatalogSchema, checks the version
    // floor, and verifies the Ed25519 signature over the raw pre-default shape.
    // It THROWS on any failure (bad signature, version-below-floor, malformed).
    let connectors: ReturnType<typeof loadAndVerifyConnectorCatalog> | undefined;
    expect(
      () => {
        connectors = loadAndVerifyConnectorCatalog(JSON.parse(catalogText), pemText);
      },
      `committed connectors.json does NOT verify against committed connectors-verify-key.pem — the catalog and verify key have drifted out of sync (re-sign the catalog with the matching key, or re-commit the matching public key). This is the signed-pair consistency guard.`,
    ).not.toThrow();

    expect(
      connectors,
      'loadAndVerifyConnectorCatalog returned a non-empty connector list',
    ).toBeDefined();
    expect((connectors ?? []).length).toBeGreaterThan(0);
  });

  it('committed connectors.json version is at or above MIN_CONNECTOR_CATALOG_VERSION (anti-rollback floor)', () => {
    const catalogText = readFileSync(CATALOG_PATH, 'utf-8');
    const parsed = ConnectorCatalogSchema.parse(JSON.parse(catalogText));
    expect(parsed.version).toBeGreaterThanOrEqual(MIN_CONNECTOR_CATALOG_VERSION);
  });

  // ── negative / contrived-regression tests (prove the detectors bite) ──────
  it('negative: detector flags a contrived final-stage bake of connectors.json', () => {
    const regressionSnippet = [
      'FROM node:22-slim AS builder',
      'COPY enclave/ ./enclave/',
      'RUN echo build',
      '',
      'FROM node:22-slim',
      'COPY --from=builder /app/enclave/dist ./dist',
      // ↓ THE regression — straight bake of the catalog.
      'COPY enclave/src/connectors/connectors.json ./dist/connectors/connectors.json',
      'CMD ["node", "dist/index.js"]',
    ].join('\n');

    const contrivedStages = parseStages(regressionSnippet);
    const contrivedFinalCopies = extractCopyInstructions(
      contrivedStages[contrivedStages.length - 1],
    );

    // Literal-match detector flags it.
    const literalCaught = contrivedFinalCopies.filter((l) =>
      /connectors\.json/.test(l),
    );
    expect(
      literalCaught.length,
      'literal connectors.json detector must flag the contrived bake — if this fails, real regressions slip through',
    ).toBeGreaterThan(0);

    // Source-level detector flags it too.
    const sourceCaught = contrivedFinalCopies.filter((line) =>
      copySourcePaths(line).some(sourceWouldBakeCatalog),
    );
    expect(sourceCaught.length).toBeGreaterThan(0);
  });

  it('negative: detector flags a contrived directory-level COPY of the connectors/ directory (the literal-regex-misses case)', () => {
    const regressionSnippet = [
      'FROM node:22-slim AS builder',
      'COPY enclave/ ./enclave/',
      '',
      'FROM node:22-slim',
      'WORKDIR /app',
      'COPY --from=builder /app/enclave/dist ./dist',
      // ↓ THE regression — build-context COPY, directory-level. No
      // --from=builder, no literal connectors.json, but sweeps the whole
      // connectors/ directory (including connectors.json) into the final image.
      'COPY enclave/src/connectors ./dist/connectors',
      'CMD ["node", "dist/index.js"]',
    ].join('\n');

    const contrivedStages = parseStages(regressionSnippet);
    const contrivedFinalCopies = extractCopyInstructions(
      contrivedStages[contrivedStages.length - 1],
    );

    // (a) flagged as a build-context COPY (no --from=<stage>).
    const buildContextRegression = contrivedFinalCopies.filter(
      (l) => !/--from=\w+/.test(l),
    );
    expect(
      buildContextRegression.length,
      'build-context COPY check must flag any final-stage COPY reading from the Docker build context',
    ).toBeGreaterThan(0);

    // (b) source-level catalog detector flags the directory source — the
    // literal `connectors.json` regex alone would MISS this.
    const sourceCaught = contrivedFinalCopies.filter((line) =>
      copySourcePaths(line).some(sourceWouldBakeCatalog),
    );
    expect(
      sourceCaught.length,
      'widened connectors/ match must catch the directory-level source path — literal connectors.json regex alone is insufficient',
    ).toBeGreaterThan(0);
  });

  it('negative: detector does NOT flag the legitimate connectors-verify-key.pem COPY', () => {
    // Guard against a too-greedy detector: the one connectors/ artefact that
    // SHOULD pass must not be mistaken for the catalog.
    const verifyKeyCopy =
      'COPY --from=builder /app/enclave/src/connectors/connectors-verify-key.pem ./dist/connectors/connectors-verify-key.pem';
    const sources = copySourcePaths(verifyKeyCopy);
    expect(sources.some(sourceWouldBakeCatalog)).toBe(false);
  });

  it('negative: consistency guard rejects a catalog whose signature does not verify', () => {
    // Prove the signed-pair check actually verifies the signature (not just the
    // schema). A wrong-bytes signature fails Ed25519 verification identically to
    // one produced by a different keypair — verification MUST throw.
    const catalogText = readFileSync(CATALOG_PATH, 'utf-8');
    const committed = JSON.parse(catalogText) as Record<string, unknown>;

    // Swap in a deterministically-wrong signature (valid base64, wrong bytes)
    // so the schema still parses but the Ed25519 verify fails.
    const tampered = {
      ...committed,
      signature: Buffer.alloc(64, 7).toString('base64'),
    };
    const pemText = readFileSync(VERIFY_KEY_PATH, 'utf-8');
    expect(() => loadAndVerifyConnectorCatalog(tampered, pemText)).toThrow();
  });
});
