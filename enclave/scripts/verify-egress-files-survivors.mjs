#!/usr/bin/env node
/**
 * verify-egress-files-survivors.mjs — ground-truth oracle for the
 * enclave-agent-egress-files mutation target (tools/egress-taint.ts +
 * tools/file-allowlist.ts), mirroring packages/masking-core's oracle.
 *
 * For each Survived / NoCoverage mutant in the Stryker JSON report it splices
 * the EXACT mutation Stryker applied — `(<replacement>)` over the precise
 * character span (raw for BlockStatement, so precedence matches Stryker's
 * parenthesised-ternary instrumentation) — then runs the TARGET's full Vitest
 * suite (vitest.mutation.enclave-agent-egress-files.config.ts) in a FRESH
 * process. Verdicts:
 *
 *   KILLED-BY-EXISTING  the current suite already fails on this mutation (so a
 *                       Stryker "Survived" is a harness false-survivor or a
 *                       perTest-coverage miss — never a real coverage gap).
 *   SURVIVES            no test fails. The mutant is either genuinely equivalent
 *                       / unreachable or still needs a behavioural test — that is
 *                       a human judgement recorded in the ledger.
 *
 * Usage:
 *   node scripts/verify-egress-files-survivors.mjs [report.json] [--ids=1,2] [--file=egress-taint.ts]
 *
 * Exit code is always 0; this is a diagnostic, not a gate. Source files are
 * snapshot in memory and restored after every mutant, including on error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const enclaveRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const reportArg = args.find((a) => !a.startsWith('--'));
const idsArg = args.find((a) => a.startsWith('--ids='));
const fileArg = args.find((a) => a.startsWith('--file='));
const onlyIds = idsArg ? new Set(idsArg.slice('--ids='.length).split(',')) : null;
const onlyFile = fileArg ? fileArg.slice('--file='.length) : null;
const reportPath = path.resolve(
  enclaveRoot,
  reportArg ?? 'reports/mutation/enclave-agent-egress-files.json',
);

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const vitestBin = path.resolve(enclaveRoot, '../node_modules/.bin/vitest');
const vitestConfig = 'vitest.mutation.enclave-agent-egress-files.config.ts';

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
  if (onlyFile && !relFile.endsWith(onlyFile)) continue;
  const survivors = fileReport.mutants.filter(
    (m) =>
      (m.status === 'Survived' || m.status === 'NoCoverage') &&
      (!onlyIds || onlyIds.has(String(m.id))),
  );
  if (survivors.length === 0) continue;

  const absFile = path.resolve(enclaveRoot, relFile);
  const original = fs.readFileSync(absFile, 'utf8');
  const offs = lineOffsets(original);

  try {
    for (const m of survivors) {
      const s = offsetOf(offs, m.location.start.line, m.location.start.column);
      const e = offsetOf(offs, m.location.end.line, m.location.end.column);
      const inject =
        m.mutatorName === 'BlockStatement' ? m.replacement : `(${m.replacement})`;
      const mutated = original.slice(0, s) + inject + original.slice(e);
      fs.writeFileSync(absFile, mutated);

      let verdict;
      try {
        execFileSync(vitestBin, ['run', '--config', vitestConfig], {
          cwd: enclaveRoot,
          stdio: 'pipe',
        });
        verdict = 'SURVIVES';
      } catch {
        verdict = 'KILLED-BY-EXISTING';
      }
      results.push({
        file: relFile.replace(/^.*\//, ''),
        id: m.id,
        loc: `L${m.location.start.line}:${m.location.start.column}`,
        mut: m.mutatorName,
        repl: m.replacement.slice(0, 50),
        cov: (m.coveredBy || []).length,
        stryker: m.status,
        verdict,
      });
      process.stderr.write(verdict === 'KILLED-BY-EXISTING' ? '!' : '.');
    }
  } finally {
    fs.writeFileSync(absFile, original);
  }
}
process.stderr.write('\n');

const killable = results.filter((r) => r.verdict === 'KILLED-BY-EXISTING');
console.log(
  JSON.stringify(
    { total: results.length, falseSurvivors: killable.length, results },
    null,
    1,
  ),
);
