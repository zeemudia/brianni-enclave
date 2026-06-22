import { describe, expect, it } from 'vitest';

import {
  canonicaliseFolderPath,
  resolveClientWrittenPath,
  resolveCopyOutputPath,
} from '../copy-on-write-policy';

// Precision boundary suite for the copy-on-write collision grammar, driven
// entirely through the public API. Each test isolates ONE branch/operator so a
// surviving mutant is killed without needing to export the private helpers
// (keeping the enclave source untouched → no PCR0 rotation).

describe('resolveCopyOutputPath — first-return and loop boundaries', () => {
  it('does NOT return the requested path unadjusted when it EQUALS the source (even if free)', () => {
    // output.path === sourcePath, and the path is NOT in existingPaths. The real
    // code must skip the unadjusted first-return (because output===source) and
    // allocate a " copy" suffix. Kills `output.path !== sourcePath` → `true`.
    expect(
      resolveCopyOutputPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: 'resume.docx',
        existingPaths: [],
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'resume.docx',
      outputPath: 'resume copy.docx',
      pathAdjusted: true,
    });
  });

  it('allocates the suffix at the TOP of the loop range ("notes 101")', () => {
    // existing: notes.md + notes 2..notes 100 (so i=1..99 produce taken
    // candidates notes 2..notes 100), i=100 → withNumericSuffix(.,101) = "notes
    // 101.md" which is free. This requires the loop to reach i=100, pinning the
    // `i <= 100` upper bound (a `i < 100` mutant would stop at i=99 → notes 100
    // taken → NO_AVAILABLE).
    const existing = ['notes.md'];
    for (let n = 2; n <= 100; n += 1) existing.push(`notes ${n}.md`);
    expect(
      resolveCopyOutputPath({
        sourcePath: null,
        requestedOutputPath: 'notes.md',
        existingPaths: existing,
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'notes.md',
      outputPath: 'notes 101.md',
      pathAdjusted: true,
    });
  });

  it('allocates the " copy 100" suffix at the TOP of the sameAsSource loop range', () => {
    // sameAsSource: output===source. existing has the source + "x copy" +
    // "x copy 2".."x copy 99" taken → i=1..99 produce taken, i=100 →
    // withCopySuffix(.,100) = "x copy 100" free.
    const existing = ['doc.md', 'doc copy.md'];
    for (let n = 2; n <= 99; n += 1) existing.push(`doc copy ${n}.md`);
    expect(
      resolveCopyOutputPath({
        sourcePath: 'doc.md',
        requestedOutputPath: 'doc.md',
        existingPaths: existing,
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'doc.md',
      outputPath: 'doc copy 100.md',
      pathAdjusted: true,
    });
  });
});

describe('resolveClientWrittenPath — numeric collision grammar boundaries', () => {
  const numeric = (writtenStem: string) =>
    resolveClientWrittenPath({
      requestedOutputPath: 'notes.md',
      enclaveOutputPath: 'notes.md',
      writtenPath: `${writtenStem}.md`,
    });

  it('accepts "notes 2" (anchored start + end, multi-digit allowed)', () => {
    expect(numeric('notes 2')).toEqual({
      ok: true,
      writtenPath: 'notes 2.md',
      pathAdjusted: true,
    });
    expect(numeric('notes 23')).toEqual({
      ok: true,
      writtenPath: 'notes 23.md',
      pathAdjusted: true,
    });
  });

  it('rejects a number with a NON-numeric prefix attached to the stem (anchored ^)', () => {
    // Kills `^(.*) ([1-9][0-9]*)$` → `(.*) ([1-9][0-9]*)$` (un-anchored start is
    // identical because .* is greedy) — instead pin via a stem mismatch: the
    // capture group (.*) must equal the base stem "notes". "xnotes 2" → match[1]
    // = "xnotes" ≠ "notes" → reject.
    expect(numeric('xnotes 2')).toEqual({ ok: false });
  });

  it('rejects a trailing non-digit after the number (anchored $)', () => {
    // Kills `...([1-9][0-9]*)$` → `...([1-9][0-9]*)` (un-anchored end): with the
    // anchor removed, "notes 2x" would partially match; the real anchored regex
    // rejects it.
    expect(numeric('notes 2x')).toEqual({ ok: false });
  });

  it('rejects a leading-zero index (first digit class [1-9])', () => {
    // "notes 02" — the regex first digit is [1-9], so "02" does not match.
    expect(numeric('notes 02')).toEqual({ ok: false });
  });

  it('rejects index 1 and accepts index 2 (lower bound index >= 2)', () => {
    expect(numeric('notes 1')).toEqual({ ok: false });
    expect(numeric('notes 2')).toEqual({
      ok: true,
      writtenPath: 'notes 2.md',
      pathAdjusted: true,
    });
  });

  it('rejects a directory mismatch and an extension mismatch independently', () => {
    // dir mismatch:
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'A/notes.md',
        enclaveOutputPath: 'A/notes.md',
        writtenPath: 'B/notes 2.md',
      }),
    ).toEqual({ ok: false });
    // ext mismatch:
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'notes 2.txt',
      }),
    ).toEqual({ ok: false });
    // BOTH dir and ext equal but stem differs → reject (pins the && in the
    // dir/ext guard: an `||`→`&&` weakening would accept some mismatches).
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'A/notes.md',
        enclaveOutputPath: 'A/notes.md',
        writtenPath: 'A/other 2.md',
      }),
    ).toEqual({ ok: false });
  });
});

describe('resolveClientWrittenPath — copy collision grammar boundaries', () => {
  // Drive the copy-collision arm (sourcePath === requested.path) with
  // written != enclave so the enclave-match short circuit cannot mask the arm.
  const copy = (writtenStem: string) =>
    resolveClientWrittenPath({
      sourcePath: 'doc.md',
      requestedOutputPath: 'doc.md',
      enclaveOutputPath: 'doc copy.md',
      writtenPath: `${writtenStem}.md`,
    });

  it('accepts the bare "doc copy" form', () => {
    expect(copy('doc copy')).toEqual({
      ok: true,
      writtenPath: 'doc copy.md',
      pathAdjusted: true,
    });
  });

  it('accepts a numbered "doc copy 2" form', () => {
    expect(copy('doc copy 2')).toEqual({
      ok: true,
      writtenPath: 'doc copy 2.md',
      pathAdjusted: true,
    });
  });

  it('rejects a numbered copy with a leading-zero index ([1-9] first digit)', () => {
    expect(copy('doc copy 02')).toEqual({ ok: false });
  });

  it('rejects a numbered copy with a trailing non-digit (anchored $)', () => {
    expect(copy('doc copy 2x')).toEqual({ ok: false });
  });

  it('rejects a numbered copy whose stem prefix is not the base stem', () => {
    // "xdoc copy 2" → match[1]="xdoc" ≠ "doc". Pins `match[1] === base.stem`.
    expect(copy('xdoc copy 2')).toEqual({ ok: false });
  });

  it('rejects a copy-collision suffix written in a DIFFERENT directory (folder-scope guard)', () => {
    // SECURITY: the copy-collision arm (sourcePath === requested.path) must NOT
    // accept a write that lands in a different folder. Without the dir/ext guard
    // in isCopyCollisionSuffix (`||` → `&&`), a malicious bridge result could
    // write "B/doc copy 2.md" while the request targeted folder "A" — a
    // folder-scope widening / cross-folder exfiltration. Kills the `||` → `&&`
    // weakening AND the dir-equality operand of isCopyCollisionSuffix@161.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'A/doc.md',
        requestedOutputPath: 'A/doc.md',
        enclaveOutputPath: 'A/doc copy.md',
        writtenPath: 'B/doc copy 2.md',
      }),
    ).toEqual({ ok: false });
    // Bare-copy form in a different directory must also be rejected.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'A/doc.md',
        requestedOutputPath: 'A/doc.md',
        enclaveOutputPath: 'A/other.md',
        writtenPath: 'B/doc copy.md',
      }),
    ).toEqual({ ok: false });
  });

  it('rejects a copy-collision suffix with a DIFFERENT extension (ext guard)', () => {
    // Pins the ext-equality operand of isCopyCollisionSuffix@161: a "copy"
    // suffix with a mismatched extension must be rejected. Keep written != enclave
    // and same dir so only the copy arm can match, isolating the ext check.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'doc.md',
        requestedOutputPath: 'doc.md',
        enclaveOutputPath: 'other.md',
        writtenPath: 'doc copy.txt',
      }),
    ).toEqual({ ok: false });
    expect(
      resolveClientWrittenPath({
        sourcePath: 'doc.md',
        requestedOutputPath: 'doc.md',
        enclaveOutputPath: 'other.md',
        writtenPath: 'doc copy 2.txt',
      }),
    ).toEqual({ ok: false });
  });

  it('ACCEPTS a same-dir same-ext copy suffix (positive control for the guard)', () => {
    // Confirms the rejections above are due to the dir/ext mismatch, not a
    // blanket reject: the same suffix in the SAME folder/ext is accepted.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'A/doc.md',
        requestedOutputPath: 'A/doc.md',
        enclaveOutputPath: 'A/doc copy.md',
        writtenPath: 'A/doc copy 2.md',
      }),
    ).toEqual({ ok: true, writtenPath: 'A/doc copy 2.md', pathAdjusted: true });
  });

  // The two acceptances below route through the COPY arm ONLY: the enclave path
  // has a different stem ("other.md") so the enclave numeric arm cannot match,
  // forcing the bare-"copy" and numbered-"copy N" grammar to do the work. This
  // isolates the copy-collision regex/index branches (which the same-stem
  // positive control above would otherwise mask via the enclave numeric arm).
  it('ACCEPTS the bare "doc copy" form via the copy arm (enclave stem differs)', () => {
    // Kills `candidate.stem === `${base.stem} copy`` → `false` / template→``:
    // without the bare-copy branch, "doc copy.md" would be rejected even though
    // it is the canonical first copy allocation.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'doc.md',
        requestedOutputPath: 'doc.md',
        enclaveOutputPath: 'other.md',
        writtenPath: 'doc copy.md',
      }),
    ).toEqual({ ok: true, writtenPath: 'doc copy.md', pathAdjusted: true });
  });

  it('ACCEPTS "doc copy 2" via the copy arm at the lower index bound (index === 2)', () => {
    // Kills the copy index lower bound `index >= 2` → `index > 2`: index 2 is the
    // first numbered copy and must be accepted. Routed through the copy arm only
    // (enclave stem differs) so the numeric arm cannot mask it.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'doc.md',
        requestedOutputPath: 'doc.md',
        enclaveOutputPath: 'other.md',
        writtenPath: 'doc copy 2.md',
      }),
    ).toEqual({ ok: true, writtenPath: 'doc copy 2.md', pathAdjusted: true });
  });

  it('rejects a copy stem with a leading-zero / trailing-junk index via the copy arm', () => {
    // Pins the copy regex digit class + anchor through the copy arm only.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'doc.md',
        requestedOutputPath: 'doc.md',
        enclaveOutputPath: 'other.md',
        writtenPath: 'doc copy 02.md',
      }),
    ).toEqual({ ok: false });
    expect(
      resolveClientWrittenPath({
        sourcePath: 'doc.md',
        requestedOutputPath: 'doc.md',
        enclaveOutputPath: 'other.md',
        writtenPath: 'doc copy 2x.md',
      }),
    ).toEqual({ ok: false });
  });

  it('rejects a copy index at the upper bound + 1 (index <= 100)', () => {
    // "doc copy 101" must NOT be accepted by the copy arm. Keep dir/ext equal to
    // the enclave path so the enclave numeric arm cannot rescue it: enclave is
    // "doc copy.md" → numeric check base.stem="doc copy", candidate stem
    // "doc copy 101" → match[1]="doc copy" === enclave base stem → that arm
    // WOULD accept. So instead test the bound by making the enclave path differ
    // in stem so only the copy arm can match.
    const r = resolveClientWrittenPath({
      sourcePath: 'doc.md',
      requestedOutputPath: 'doc.md',
      enclaveOutputPath: 'doc.md',
      writtenPath: 'doc copy 101.md',
    });
    expect(r).toEqual({ ok: false });
  });

  it('accepts a copy index at the upper bound (index === 100) via the copy arm', () => {
    const r = resolveClientWrittenPath({
      sourcePath: 'doc.md',
      requestedOutputPath: 'doc.md',
      enclaveOutputPath: 'doc.md',
      writtenPath: 'doc copy 100.md',
    });
    expect(r).toEqual({ ok: true, writtenPath: 'doc copy 100.md', pathAdjusted: true });
  });
});

describe('resolveClientWrittenPath — source-equality guard is load-bearing', () => {
  it('rejects written===source EVEN when written is a valid numeric suffix of requested', () => {
    // Without the `written.path === sourcePath → return false` guard, the
    // numeric-collision arm would ACCEPT this (writing over the original source
    // file = data loss). The guard must win. requested="notes.md",
    // source="notes 2.md", written="notes 2.md" (=source AND a numeric suffix of
    // requested). Real → reject; a dropped guard → accept. Kills
    // `written.path === sourcePath` → `false`.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'notes 2.md',
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes 3.md',
        writtenPath: 'notes 2.md',
      }),
    ).toEqual({ ok: false });
  });
});

describe('canonicaliseFolderPath — drive-letter regex is load-bearing', () => {
  it('rejects a Windows drive-letter path with NO slash ("C:x") that the segment check would otherwise accept', () => {
    // "C:x" is a single bounded segment (":" is a legal segment char), so the
    // ONLY thing rejecting it is `/^[A-Za-z]:/`. Kills the regex mutation and
    // pins that the drive-letter guard is not redundant with the segment check.
    expect(canonicaliseFolderPath('C:x')).toEqual({ ok: false });
    expect(canonicaliseFolderPath('z:notes.md')).toEqual({ ok: false });
  });

  it('accepts a colon in a NON-leading position (regex is anchored at start)', () => {
    // Pins the `^` anchor of `/^[A-Za-z]:/`: a colon deeper in the path is a
    // legal segment char and must NOT be rejected.
    expect(canonicaliseFolderPath('folder/C:note')).toEqual({
      ok: true,
      path: 'folder/C:note',
    });
  });
});

describe('canonicaliseFolderPath via resolve — splitPathParts dir/ext handling', () => {
  it('handles a nested directory in the collision check (dir extraction)', () => {
    // requested/enclave/written all in "Sub/" — the numeric arm must compare the
    // SAME dir. Pins `splitPathParts` dir slicing (slash >= 0 branch).
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'Sub/notes.md',
        enclaveOutputPath: 'Sub/notes.md',
        writtenPath: 'Sub/notes 2.md',
      }),
    ).toEqual({ ok: true, writtenPath: 'Sub/notes 2.md', pathAdjusted: true });
  });

  it('handles an extension-less basename (dot <= 0 branch)', () => {
    // "README" has no extension; "README 2" is a valid numeric collision with an
    // empty ext on both sides. Pins the `dot <= 0` branch of splitPathParts.
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'README',
        enclaveOutputPath: 'README',
        writtenPath: 'README 2',
      }),
    ).toEqual({ ok: true, writtenPath: 'README 2', pathAdjusted: true });
  });

  it('treats a dotfile as having no extension (dot === 0 → dot <= 0 branch)', () => {
    // ".env" has its only dot at index 0; splitPathParts must treat the whole
    // basename as the stem (ext=""), so ".env 2" is a numeric collision.
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: '.env',
        enclaveOutputPath: '.env',
        writtenPath: '.env 2',
      }),
    ).toEqual({ ok: true, writtenPath: '.env 2', pathAdjusted: true });
  });
});
