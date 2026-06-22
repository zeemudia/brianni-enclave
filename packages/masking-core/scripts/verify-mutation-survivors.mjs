#!/usr/bin/env node
/**
 * verify-mutation-survivors.mjs — ground-truth oracle for masking-core mutation
 * survivors, immune to Stryker's static-mutant nondeterminism.
 *
 * Background
 * ----------
 * Stryker 9.6.1 + Vitest 4.1.4 score most mutants reliably, but two failure
 * modes make a raw "Survived" verdict untrustworthy for this package:
 *
 *   1. The JSON `replacement` field is the mutated *AST node* text, NOT a full
 *      line. Pasting it back flat (e.g. an inner `&&`->`||`) re-associates the
 *      expression under JS operator precedence and produces a DIFFERENT mutation
 *      than the one Stryker actually ran (Stryker wraps each expression mutant
 *      in a parenthesised ternary, so grouping is preserved). Hand-checking a
 *      survivor by flat-pasting the replacement therefore yields false "killable"
 *      readings.
 *   2. Module-load-time ("static") mutants — `coveredBy: []` constants such as a
 *      whitelist entry or a regex-escape replacement string — flip Survived<->Killed
 *      run-to-run because Vitest caches the source module across Stryker's
 *      per-mutant re-evaluations.
 *
 * What this does
 * --------------
 * For each survivor in a Stryker JSON report it reconstructs the EXACT mutation
 * Stryker applied — splicing `(<replacement>)` over the precise character span
 * (raw for BlockStatement) so precedence matches the instrumented ternary — then
 * runs the package's full Vitest suite in a FRESH process (so the mutated module
 * is always re-evaluated, defeating the static-mutant cache flake). The verdict:
 *
 *   KILLED-BY-EXISTING  the current suite already fails on this mutation. If
 *                       Stryker reported it "Survived", that is a genuine harness
 *                       false-survivor (or a perTest-coverage miss).
 *   SURVIVES            no existing test fails. The mutant is either equivalent
 *                       or needs a new behavioural test (the script cannot tell
 *                       these apart — that is a human judgement, see the ledger).
 *
 * Usage:
 *   node scripts/verify-mutation-survivors.mjs [path-to-report.json] [--ids=1,2,3]
 *   (defaults to reports/mutation/masking-core.json)
 *
 * Exit code is always 0; this is a diagnostic, not a gate. Source files are
 * snapshot in memory and restored after every mutant, including on error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const reportArg = args.find((a) => !a.startsWith('--'));
const idsArg = args.find((a) => a.startsWith('--ids='));
const onlyIds = idsArg ? new Set(idsArg.slice('--ids='.length).split(',')) : null;
const reportPath = path.resolve(pkgRoot, reportArg ?? 'reports/mutation/masking-core.json');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const vitestBin = path.resolve(pkgRoot, '../../node_modules/.bin/vitest');

function lineOffsets(src) {
  const offs = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') offs.push(i + 1);
  return offs;
}
function offsetOf(offs, line, col) {
  return offs[line - 1] + (col - 1); // Stryker positions are 1-based.
}

const results = [];
for (const [relFile, fileReport] of Object.entries(report.files)) {
  const survivors = fileReport.mutants.filter(
    (m) => (m.status === 'Survived' || m.status === 'NoCoverage') && (!onlyIds || onlyIds.has(String(m.id))),
  );
  if (survivors.length === 0) continue;

  const absFile = path.resolve(pkgRoot, relFile);
  const original = fs.readFileSync(absFile, 'utf8');
  const offs = lineOffsets(original);

  try {
    for (const m of survivors) {
      const s = offsetOf(offs, m.location.start.line, m.location.start.column);
      const e = offsetOf(offs, m.location.end.line, m.location.end.column);
      const inject = m.mutatorName === 'BlockStatement' ? m.replacement : `(${m.replacement})`;
      const mutated = original.slice(0, s) + inject + original.slice(e);
      fs.writeFileSync(absFile, mutated);

      let verdict;
      try {
        execFileSync(vitestBin, ['run'], { cwd: pkgRoot, stdio: 'pipe' });
        verdict = 'SURVIVES'; // suite passed under the mutation
      } catch {
        verdict = 'KILLED-BY-EXISTING'; // a test failed -> mutation detected
      }
      results.push({
        file: relFile,
        id: m.id,
        loc: `L${m.location.start.line}:${m.location.start.column}`,
        mut: m.mutatorName,
        cov: (m.coveredBy || []).length,
        stryker: m.status,
        verdict,
      });
      process.stderr.write(`${verdict === 'KILLED-BY-EXISTING' ? '!' : '.'}`);
    }
  } finally {
    fs.writeFileSync(absFile, original);
  }
}
process.stderr.write('\n');

const killable = results.filter((r) => r.verdict === 'KILLED-BY-EXISTING');
console.log(JSON.stringify({ total: results.length, falseSurvivors: killable.length, results }, null, 1));
