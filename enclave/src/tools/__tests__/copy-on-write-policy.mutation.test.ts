import { describe, expect, it } from 'vitest';

import {
  canonicaliseFolderPath,
  resolveClientWrittenPath,
  resolveCopyOutputPath,
} from '../copy-on-write-policy';

// Mutation-hardening suite for the enclave copy-on-write path policy. These are
// the SECURITY boundary: a bad path canonicalisation lets a traversal /
// absolute / backslash path through to a folder write, and a wrong collision
// guard either overwrites an existing file (data loss) or rejects a legal
// client-allocated suffix (a real write reported as out-of-policy). All inputs
// are constructed objects, so every branch is reachable. See
// docs/quality/mutation-triage/enclave-agent-tools.md.

describe('canonicaliseFolderPath (path-traversal / absolute-path gate)', () => {
  it('accepts a simple relative path and a nested relative path', () => {
    expect(canonicaliseFolderPath('resume.docx')).toEqual({
      ok: true,
      path: 'resume.docx',
    });
    expect(canonicaliseFolderPath('Career/resume.docx')).toEqual({
      ok: true,
      path: 'Career/resume.docx',
    });
  });

  it('rejects a POSIX absolute path (leading "/")', () => {
    expect(canonicaliseFolderPath('/etc/passwd')).toEqual({ ok: false });
  });

  it('rejects a UNC path (leading "\\\\")', () => {
    expect(canonicaliseFolderPath('\\\\server\\share')).toEqual({ ok: false });
  });

  it('rejects a Windows drive-letter path (matches /^[A-Za-z]:/)', () => {
    expect(canonicaliseFolderPath('C:/Users')).toEqual({ ok: false });
    expect(canonicaliseFolderPath('z:relative')).toEqual({ ok: false });
    // The regex is anchored at the START — a drive-letter-looking token deeper
    // in the path is fine because it is a normal segment char set.
    expect(canonicaliseFolderPath('folder/Cnote')).toEqual({
      ok: true,
      path: 'folder/Cnote',
    });
  });

  it('rejects ANY backslash, not just a leading UNC prefix', () => {
    // Kills `path.includes("\\")` removal: an interior backslash must fail even
    // though it is neither a leading "/" nor a UNC nor a drive letter.
    expect(canonicaliseFolderPath('a\\b')).toEqual({ ok: false });
    expect(canonicaliseFolderPath('folder/sub\\file.txt')).toEqual({ ok: false });
  });

  it('rejects a path with a "." traversal segment', () => {
    expect(canonicaliseFolderPath('a/./b')).toEqual({ ok: false });
  });

  it('rejects a path with a ".." traversal segment', () => {
    expect(canonicaliseFolderPath('a/../b')).toEqual({ ok: false });
    expect(canonicaliseFolderPath('../secret')).toEqual({ ok: false });
  });

  it('rejects an empty segment from a doubled slash (kills the .some guard)', () => {
    // "a//b".split("/") => ["a","","b"]; the empty segment is unbounded, so the
    // whole path must be rejected. Kills `.some`→`.every` (every segment is NOT
    // unbounded, so `.every(!bounded)` would wrongly accept) and the empty-seg
    // rejection.
    expect(canonicaliseFolderPath('a//b')).toEqual({ ok: false });
  });

  it('rejects a trailing slash (empty final segment)', () => {
    expect(canonicaliseFolderPath('folder/')).toEqual({ ok: false });
  });

  it('rejects a path whose join-roundtrip differs from the input', () => {
    // The `normalised !== path` guard is a belt-and-braces re-serialisation
    // check. A control char inside a segment makes a segment unbounded first,
    // but this explicitly pins that canonicalisation is identity on valid input
    // (mutating `!==`→`===` would reject every valid path).
    const valid = 'Career/My Notes 2.md';
    expect(canonicaliseFolderPath(valid)).toEqual({ ok: true, path: valid });
  });
});

describe('resolveCopyOutputPath', () => {
  it('returns the requested path unadjusted when it is free and not the source', () => {
    expect(
      resolveCopyOutputPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: 'resume_ATS.md',
        existingPaths: [],
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'resume_ATS.md',
      outputPath: 'resume_ATS.md',
      pathAdjusted: false,
    });
  });

  it('rejects an invalid (absolute) SOURCE path before anything else', () => {
    expect(
      resolveCopyOutputPath({
        sourcePath: '/abs/source.docx',
        requestedOutputPath: 'out.md',
        existingPaths: [],
      }),
    ).toEqual({ ok: false, reason: 'INVALID_SOURCE_PATH' });
  });

  it('treats an empty-string sourcePath as "no source" (length-0 short circuit)', () => {
    // Kills `sourcePath.length > 0` → `>= 0`: with the mutated `>= 0`, an empty
    // string would be canonicalised (and fail), wrongly returning
    // INVALID_SOURCE_PATH. With the real `> 0`, empty source == no source and
    // the requested path is accepted.
    expect(
      resolveCopyOutputPath({
        sourcePath: '',
        requestedOutputPath: 'out.md',
        existingPaths: [],
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'out.md',
      outputPath: 'out.md',
      pathAdjusted: false,
    });
  });

  it('treats a null sourcePath as "no source"', () => {
    expect(
      resolveCopyOutputPath({
        sourcePath: null,
        requestedOutputPath: 'out.md',
        existingPaths: [],
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'out.md',
      outputPath: 'out.md',
      pathAdjusted: false,
    });
  });

  it('rejects an invalid (traversal) OUTPUT path', () => {
    expect(
      resolveCopyOutputPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: '../escape.md',
        existingPaths: [],
      }),
    ).toEqual({ ok: false, reason: 'INVALID_OUTPUT_PATH' });
  });

  it('only counts canonicalisable existing paths toward collisions', () => {
    // The `if (canonical.ok) taken.add(...)` guard: an absolute/garbage existing
    // path must NOT block a legal requested path. Kills the guard flip and the
    // empty existingPaths-loop body removal.
    expect(
      resolveCopyOutputPath({
        sourcePath: null,
        requestedOutputPath: 'out.md',
        existingPaths: ['/absolute/ignored', '..\\bad'],
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'out.md',
      outputPath: 'out.md',
      pathAdjusted: false,
    });
  });

  it('allocates a " copy" suffix when the requested path EQUALS the source', () => {
    // sameAsSource path: withCopySuffix(output, 1) => "resume copy.docx"
    expect(
      resolveCopyOutputPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: 'resume.docx',
        existingPaths: ['resume.docx'],
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'resume.docx',
      outputPath: 'resume copy.docx',
      pathAdjusted: true,
    });
  });

  it('allocates " copy 2" when both the source and "x copy" are taken', () => {
    // Drives the i=2 iteration of the sameAsSource loop and `withCopySuffix(.,2)`.
    expect(
      resolveCopyOutputPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: 'resume.docx',
        existingPaths: ['resume.docx', 'resume copy.docx'],
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'resume.docx',
      outputPath: 'resume copy 2.docx',
      pathAdjusted: true,
    });
  });

  it('allocates a NUMERIC suffix (starting at 2) when the output collides but is not the source', () => {
    // sameAsSource=false path: withNumericSuffix(output, i+1) with i=1 => " 2".
    expect(
      resolveCopyOutputPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: 'notes.md',
        existingPaths: ['notes.md'],
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'notes.md',
      outputPath: 'notes 2.md',
      pathAdjusted: true,
    });
  });

  it('skips a taken numeric suffix and uses the next free one ("notes 3")', () => {
    // i=1 => "notes 2" taken; i=2 => "notes 3" free. Kills `i + 1` arithmetic
    // and the loop `i <= 100` / `i < 100` boundary on the lower end.
    expect(
      resolveCopyOutputPath({
        sourcePath: null,
        requestedOutputPath: 'notes.md',
        existingPaths: ['notes.md', 'notes 2.md'],
      }),
    ).toEqual({
      ok: true,
      requestedOutputPath: 'notes.md',
      outputPath: 'notes 3.md',
      pathAdjusted: true,
    });
  });

  it('never allocates a candidate that equals the source path (copy collision case)', () => {
    // source = "x copy.docx"; requesting "x.docx" with "x.docx" taken means the
    // first sameAsSource? No — output ("x.docx") != source ("x copy.docx"), so
    // numeric path. But assert the candidate!=source guard via a constructed
    // case where the numeric candidate would equal the source.
    const result = resolveCopyOutputPath({
      sourcePath: 'notes 2.md',
      requestedOutputPath: 'notes.md',
      existingPaths: ['notes.md'],
    });
    // i=1 => "notes 2.md" which EQUALS the source → must be skipped; i=2 => "notes 3.md".
    expect(result).toEqual({
      ok: true,
      requestedOutputPath: 'notes.md',
      outputPath: 'notes 3.md',
      pathAdjusted: true,
    });
  });

  it('returns NO_AVAILABLE_COPY_PATH when every suffix 1..100 is taken', () => {
    // Exhausts the loop to pin the terminal `return NO_AVAILABLE_COPY_PATH`.
    const existing = ['notes.md'];
    for (let i = 2; i <= 101; i += 1) existing.push(`notes ${i}.md`);
    expect(
      resolveCopyOutputPath({
        sourcePath: null,
        requestedOutputPath: 'notes.md',
        existingPaths: existing,
      }),
    ).toEqual({ ok: false, reason: 'NO_AVAILABLE_COPY_PATH' });
  });
});

describe('resolveClientWrittenPath (verifies what the client actually wrote)', () => {
  it('accepts the written path equal to the enclave-approved path (pathAdjusted reflects requested)', () => {
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes 2.md',
        writtenPath: 'notes 2.md',
      }),
    ).toEqual({ ok: true, writtenPath: 'notes 2.md', pathAdjusted: true });
  });

  it('reports pathAdjusted=false when the written==enclave==requested path', () => {
    // Kills `written.path !== requested.path` → `===` on the enclave-match arm.
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'notes.md',
      }),
    ).toEqual({ ok: true, writtenPath: 'notes.md', pathAdjusted: false });
  });

  it('rejects a written path that is neither the enclave path nor a recognised suffix', () => {
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'totally-different.md',
      }),
    ).toEqual({ ok: false });
  });

  it('rejects when the requested OR enclave OR written path is invalid', () => {
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: '/abs.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'notes.md',
      }),
    ).toEqual({ ok: false });
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: '../x.md',
        writtenPath: 'notes.md',
      }),
    ).toEqual({ ok: false });
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'a\\b.md',
      }),
    ).toEqual({ ok: false });
  });

  it('rejects an invalid SOURCE path', () => {
    expect(
      resolveClientWrittenPath({
        sourcePath: '/abs/source.md',
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes 2.md',
        writtenPath: 'notes 2.md',
      }),
    ).toEqual({ ok: false });
  });

  it('rejects a written path that equals the SOURCE path (would overwrite the original)', () => {
    // The `written.path === sourcePath → return false` privacy/data-loss guard.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: 'resume.docx',
        enclaveOutputPath: 'resume copy.docx',
        writtenPath: 'resume.docx',
      }),
    ).toEqual({ ok: false });
  });

  it('accepts a numeric-collision suffix derived from the REQUESTED path', () => {
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'notes 2.md',
      }),
    ).toEqual({ ok: true, writtenPath: 'notes 2.md', pathAdjusted: true });
  });

  it('accepts a " copy" suffix only when the source equals the requested path', () => {
    // The middle OR-arm: sourcePath === requested.path && isCopyCollisionSuffix.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: 'resume.docx',
        enclaveOutputPath: 'resume copy.docx',
        writtenPath: 'resume copy.docx',
      }),
    ).toEqual({ ok: true, writtenPath: 'resume copy.docx', pathAdjusted: true });
  });

  it('does NOT accept a " copy" suffix when the source is unrelated to the requested path', () => {
    // Pins `sourcePath === requested.path` (kills `===`→`!==`): a copy-suffix is
    // only legitimate when the requested path collided with its own source.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'unrelated.docx',
        requestedOutputPath: 'resume.docx',
        enclaveOutputPath: 'resume.docx',
        writtenPath: 'resume copy.docx',
      }),
    ).toEqual({ ok: false });
  });

  it('accepts a numeric-collision suffix derived from the ENCLAVE path (third OR-arm)', () => {
    // requested="notes.md", enclave already adjusted to "notes 2.md", client
    // added a second suffix "notes 2 2.md" — only the enclave-derived check
    // matches. Kills removal of the third OR-arm.
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes 2.md',
        writtenPath: 'notes 2 2.md',
      }),
    ).toEqual({ ok: true, writtenPath: 'notes 2 2.md', pathAdjusted: true });
  });
});

describe('collision-suffix grammar boundaries (numeric + copy)', () => {
  // These drive isNumericCollisionSuffix / isCopyCollisionSuffix indirectly via
  // resolveClientWrittenPath so the private regex/index bounds are pinned.
  it('rejects a numeric suffix in a DIFFERENT directory (dir mismatch)', () => {
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'A/notes.md',
        enclaveOutputPath: 'A/notes.md',
        writtenPath: 'B/notes 2.md',
      }),
    ).toEqual({ ok: false });
  });

  it('rejects a numeric suffix with a DIFFERENT extension (ext mismatch)', () => {
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'notes 2.txt',
      }),
    ).toEqual({ ok: false });
  });

  it('rejects a numeric suffix whose stem prefix does not match the base stem', () => {
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'other 2.md',
      }),
    ).toEqual({ ok: false });
  });

  it('rejects a numeric suffix index below 2 (e.g. " 1")', () => {
    // isNumericCollisionSuffix requires index >= 2; "notes 1.md" must fail.
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'notes 1.md',
      }),
    ).toEqual({ ok: false });
  });

  it('accepts the numeric suffix at the upper bound (101) but rejects 102', () => {
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'notes 101.md',
      }),
    ).toEqual({ ok: true, writtenPath: 'notes 101.md', pathAdjusted: true });
    expect(
      resolveClientWrittenPath({
        requestedOutputPath: 'notes.md',
        enclaveOutputPath: 'notes.md',
        writtenPath: 'notes 102.md',
      }),
    ).toEqual({ ok: false });
  });

  it('accepts a numbered " copy N" suffix within bounds via the copy-collision arm', () => {
    // written != enclave so the enclave-match short circuit cannot accept it;
    // the bare-"copy" stem grammar (`${base.stem} copy`) and the numbered
    // `copy ([1-9][0-9]*)` grammar are both exercised through resolve.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: 'resume.docx',
        enclaveOutputPath: 'resume copy.docx',
        writtenPath: 'resume copy 2.docx',
      }),
    ).toEqual({ ok: true, writtenPath: 'resume copy 2.docx', pathAdjusted: true });
  });

  it('rejects a stem that contains " copy " but with a NON-numeric tail', () => {
    // isCopyCollisionSuffix `copy ([1-9][0-9]*)$` requires digits after "copy ".
    // "resume copy draft" is not a recognised allocation, and it is not the
    // bare "${stem} copy" either, so it must be rejected.
    expect(
      resolveClientWrittenPath({
        sourcePath: 'resume.docx',
        requestedOutputPath: 'resume.docx',
        enclaveOutputPath: 'resume copy.docx',
        writtenPath: 'resume copy draft.docx',
      }),
    ).toEqual({ ok: false });
  });
});
