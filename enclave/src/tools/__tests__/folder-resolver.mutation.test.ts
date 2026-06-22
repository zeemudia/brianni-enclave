import { describe, expect, it } from 'vitest';

import type { AgentLinkedFolderContext } from '@calypso/chat-types';

import { resolveLinkedFolder } from '../folder-resolver';

// Mutation-hardening supplement for the folder authorisation repair. A wrong
// guard here either widens access (resolving to a folder the model did not name)
// or breaks legitimate label resolution. Every branch is reachable with
// constructed inputs.

const work: AgentLinkedFolderContext = {
  folderId: 'fld_work_01',
  displayName: 'Work Folder',
  status: 'granted',
};
const personal: AgentLinkedFolderContext = {
  folderId: 'fld_personal_02',
  displayName: 'Personal',
  status: 'granted',
};

describe('resolveLinkedFolder — normaliseLabel + guard boundaries', () => {
  it('matches a displayName case-insensitively (toLowerCase, not toUpperCase/identity)', () => {
    // Kills `value.trim().toLowerCase()` → `.toUpperCase()` / identity: the
    // model supplies "WORK FOLDER" and the stored label is "Work Folder";
    // resolution requires BOTH sides normalised to the SAME case.
    const r = resolveLinkedFolder({ displayName: 'WORK FOLDER' }, [
      work,
      personal,
    ]);
    expect(r).toEqual({ folderId: 'fld_work_01', displayName: 'Work Folder' });
  });

  it('trims surrounding whitespace before comparing labels', () => {
    // Kills `value.trim()` removal in normaliseLabel.
    const r = resolveLinkedFolder({ displayName: '   Personal   ' }, [
      work,
      personal,
    ]);
    expect(r).toEqual({ folderId: 'fld_personal_02', displayName: 'Personal' });
  });

  it('treats a non-string label as empty (no resolution) for a multi-folder set', () => {
    // normaliseLabel returns '' for a non-string; with >1 folder and no real id
    // and no label, the result is null. Kills the `typeof value === 'string'`
    // guard flip (which would throw or coerce).
    const r = resolveLinkedFolder(
      { folderId: 123 as unknown as string, displayName: {} as unknown as string },
      [work, personal],
    );
    expect(r).toBeNull();
  });

  it('does NOT consult linked folders when the context list is empty (length > 0 guard)', () => {
    // Kills `linkedFolders.length > 0` → `>= 0` / `true`: with an empty list the
    // function must go straight to legacy passthrough, returning the model id.
    const r = resolveLinkedFolder(
      { folderId: 'fld_raw_id', displayName: 'X' },
      [],
    );
    expect(r).toEqual({ folderId: 'fld_raw_id', displayName: 'X' });
  });

  it('resolves a label stuffed in the folderId field (both candidate labels checked)', () => {
    // The candidateLabels array tries [displayName, folderId]; here the label is
    // in folderId. Kills dropping the rawFolderId candidate from the array.
    const r = resolveLinkedFolder({ folderId: 'Personal' }, [work, personal]);
    expect(r).toEqual({ folderId: 'fld_personal_02', displayName: 'Personal' });
  });

  it('prefers a real folderId match over a label match (resolution order)', () => {
    // The model passes a real id AND a conflicting displayName; the id wins and
    // the TRUSTED displayName is returned, not the model-supplied one. Kills the
    // `byId` early-return removal.
    const r = resolveLinkedFolder(
      { folderId: 'fld_work_01', displayName: 'Personal' },
      [work, personal],
    );
    expect(r).toEqual({ folderId: 'fld_work_01', displayName: 'Work Folder' });
  });

  it('drops empty candidate labels before matching (length > 0 filter)', () => {
    // Kills `label.length > 0` → `>= 0`: an empty label must NOT be used to
    // match (which would match a folder whose normalised label is ''). With a
    // sole-folder fallback disabled (multi-folder) and only empty labels, the
    // result is null rather than an accidental match.
    const blankNamed: AgentLinkedFolderContext = {
      folderId: 'fld_blank',
      displayName: '',
      status: 'granted',
    };
    const r = resolveLinkedFolder({ folderId: '', displayName: '' }, [
      blankNamed,
      personal,
    ]);
    expect(r).toBeNull();
  });

  it('requires a UNIQUE label match — an ambiguous duplicate label does not resolve', () => {
    const dupA: AgentLinkedFolderContext = {
      folderId: 'fld_a',
      displayName: 'Shared',
      status: 'granted',
    };
    const dupB: AgentLinkedFolderContext = {
      folderId: 'fld_b',
      displayName: 'Shared',
      status: 'granted',
    };
    expect(resolveLinkedFolder({ displayName: 'Shared' }, [dupA, dupB])).toBeNull();
  });

  it('trims the STORED displayName inside normaliseLabel (internal .trim is load-bearing)', () => {
    // The stored label carries surrounding whitespace; the model supplies the
    // clean label. The match only succeeds because normaliseLabel('  Spaced  ')
    // trims the STORED value (the call-site trim only touches the MODEL input).
    // Kills `value.trim().toLowerCase()` → `value.toLowerCase()` (drops trim).
    const spaced: AgentLinkedFolderContext = {
      folderId: 'fld_spaced',
      displayName: '  Spaced Label  ',
      status: 'granted',
    };
    const r = resolveLinkedFolder({ displayName: 'spaced label' }, [
      spaced,
      personal,
    ]);
    expect(r).toEqual({
      folderId: 'fld_spaced',
      displayName: '  Spaced Label  ',
    });
  });

  it('trims a whitespace-padded folderId so it still matches a real linked id', () => {
    // Kills `args.folderId.trim()` → `args.folderId` (drop call-site trim): the
    // model pads the id with spaces; without the trim the byId lookup misses and
    // resolution falls through. With the real trim it matches the trusted entry.
    const real: AgentLinkedFolderContext = {
      folderId: 'fld_realid',
      displayName: 'Real',
      status: 'granted',
    };
    const r = resolveLinkedFolder({ folderId: '  fld_realid  ' }, [
      real,
      personal,
    ]);
    expect(r).toEqual({ folderId: 'fld_realid', displayName: 'Real' });
  });
});
