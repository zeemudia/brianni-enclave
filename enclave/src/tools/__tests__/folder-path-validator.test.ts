import { describe, expect, it } from 'vitest';

import {
  isBoundedFolderPathSegment,
  MAX_FOLDER_PATH_SEGMENT_BYTES,
} from '../folder-path-validator';

describe('isBoundedFolderPathSegment', () => {
  it('accepts a plain ASCII segment', () => {
    expect(isBoundedFolderPathSegment('resume')).toBe(true);
    expect(isBoundedFolderPathSegment('resume.docx')).toBe(true);
    expect(isBoundedFolderPathSegment('My Folder 2')).toBe(true);
  });

  it('rejects an empty segment', () => {
    expect(isBoundedFolderPathSegment('')).toBe(false);
  });

  it('rejects the dot and dot-dot traversal segments', () => {
    expect(isBoundedFolderPathSegment('.')).toBe(false);
    expect(isBoundedFolderPathSegment('..')).toBe(false);
  });

  it('accepts a single dot prefix that is not exactly "." (dotfile)', () => {
    // Guards the `=== '.'` strict equality — a `.gitignore`-style dotfile is a
    // legal segment and must NOT be rejected by the traversal check.
    expect(isBoundedFolderPathSegment('.hidden')).toBe(true);
    expect(isBoundedFolderPathSegment('...')).toBe(true);
  });

  it('rejects forward-slash and backslash path separators inside a segment', () => {
    expect(isBoundedFolderPathSegment('a/b')).toBe(false);
    expect(isBoundedFolderPathSegment('a\\b')).toBe(false);
    expect(isBoundedFolderPathSegment('/leading')).toBe(false);
    expect(isBoundedFolderPathSegment('trailing\\')).toBe(false);
  });

  it('rejects leading or trailing whitespace (trim mismatch)', () => {
    expect(isBoundedFolderPathSegment(' leading')).toBe(false);
    expect(isBoundedFolderPathSegment('trailing ')).toBe(false);
    expect(isBoundedFolderPathSegment('\ttab')).toBe(false);
    // Interior whitespace is fine.
    expect(isBoundedFolderPathSegment('a b')).toBe(true);
  });

  it('rejects a non-NFC-normalised segment (Unicode confusable)', () => {
    // U+0065 U+0301 (e + combining acute) is NFC-normalised to U+00E9 (é), so
    // the decomposed form fails the `normalize('NFC') !== segment` guard.
    const decomposed = 'café';
    expect(decomposed.normalize('NFC')).not.toBe(decomposed);
    expect(isBoundedFolderPathSegment(decomposed)).toBe(false);
    // The composed form (U+00E9) passes.
    expect(isBoundedFolderPathSegment('café')).toBe(true);
  });

  it('rejects C0 / C1 / DEL control characters at the pattern boundaries', () => {
    expect(isBoundedFolderPathSegment(`a${String.fromCharCode(0x00)}b`)).toBe(false); // NUL (C0 lower bound)
    expect(isBoundedFolderPathSegment(`a${String.fromCharCode(0x1f)}b`)).toBe(false); // unit separator (C0 upper bound)
    expect(isBoundedFolderPathSegment(`a${String.fromCharCode(0x7f)}b`)).toBe(false); // DEL (C1 lower bound)
    expect(isBoundedFolderPathSegment(`a${String.fromCharCode(0x9f)}b`)).toBe(false); // APC (C1 upper bound)
    expect(isBoundedFolderPathSegment('a\nb')).toBe(false); // newline (interior — not caught by trim)
    expect(isBoundedFolderPathSegment('a\rb')).toBe(false); // carriage return (interior)
    // Just OUTSIDE the control range '!' (U+0021) is an ordinary character.
    expect(isBoundedFolderPathSegment('a!b')).toBe(true);
  });

  it('rejects a Unicode format-control character (bidi / zero-width)', () => {
    expect(isBoundedFolderPathSegment(`a${String.fromCharCode(0x200b)}b`)).toBe(false); // ZERO WIDTH SPACE (Cf)
    expect(isBoundedFolderPathSegment(`a${String.fromCharCode(0x202e)}b`)).toBe(false); // RIGHT-TO-LEFT OVERRIDE (Cf)
    expect(isBoundedFolderPathSegment(`a${String.fromCharCode(0x200e)}b`)).toBe(false); // LEFT-TO-RIGHT MARK (Cf)
  });

  it('enforces the byte-length cap at exactly MAX_FOLDER_PATH_SEGMENT_BYTES (boundary)', () => {
    const atCap = 'a'.repeat(MAX_FOLDER_PATH_SEGMENT_BYTES);
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(MAX_FOLDER_PATH_SEGMENT_BYTES);
    expect(isBoundedFolderPathSegment(atCap)).toBe(true);

    const overCap = 'a'.repeat(MAX_FOLDER_PATH_SEGMENT_BYTES + 1);
    expect(isBoundedFolderPathSegment(overCap)).toBe(false);
  });

  it('counts UTF-8 BYTES, not code units, for the length cap', () => {
    // Each emoji is 4 UTF-8 bytes but 2 UTF-16 code units. 65 emoji = 260 bytes
    // (> 256 cap) but only 130 .length — a code-unit-based check (`.length`)
    // would wrongly accept it. Pins `Buffer.byteLength(...,'utf8')`.
    const sixtyFiveEmoji = '\u{1f600}'.repeat(65);
    expect(sixtyFiveEmoji.length).toBe(130);
    expect(Buffer.byteLength(sixtyFiveEmoji, 'utf8')).toBe(260);
    expect(isBoundedFolderPathSegment(sixtyFiveEmoji)).toBe(false);
  });

  it('exposes the documented cap constant', () => {
    expect(MAX_FOLDER_PATH_SEGMENT_BYTES).toBe(256);
  });
});
