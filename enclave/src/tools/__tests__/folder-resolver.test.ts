import { describe, it, expect } from 'vitest';
import type {
  AgentLinkedFolderContext,
  ToolInvocationFrame,
} from '@calypso/chat-types';

import { resolveLinkedFolder, withResolvedFolder } from '../folder-resolver';

const work: AgentLinkedFolderContext = {
  folderId: 'fld_work_01',
  displayName: 'Work folder',
  status: 'granted',
};
const personal: AgentLinkedFolderContext = {
  folderId: 'fld_personal_02',
  displayName: 'Personal',
  status: 'granted',
};

describe('resolveLinkedFolder', () => {
  describe('with linked-folder context', () => {
    it('keeps a real folderId and returns the trusted displayName', () => {
      const r = resolveLinkedFolder(
        { folderId: 'fld_work_01', displayName: 'whatever the model said' },
        [work, personal],
      );
      expect(r).toEqual({ folderId: 'fld_work_01', displayName: 'Work folder' });
    });

    it('resolves a displayName supplied in the displayName field', () => {
      const r = resolveLinkedFolder({ displayName: 'Personal' }, [
        work,
        personal,
      ]);
      expect(r).toEqual({ folderId: 'fld_personal_02', displayName: 'Personal' });
    });

    it('resolves a displayName the model stuffed into the folderId field', () => {
      // The observed failure: the model passes the human label where the
      // opaque id belongs.
      const r = resolveLinkedFolder({ folderId: 'Work folder' }, [
        work,
        personal,
      ]);
      expect(r).toEqual({ folderId: 'fld_work_01', displayName: 'Work folder' });
    });

    it('matches displayName case-insensitively and trims whitespace', () => {
      const r = resolveLinkedFolder({ displayName: '  WORK FOLDER  ' }, [
        work,
        personal,
      ]);
      expect(r).toEqual({ folderId: 'fld_work_01', displayName: 'Work folder' });
    });

    it('falls back to the sole linked folder when the id is empty', () => {
      const r = resolveLinkedFolder({ folderId: '', displayName: '' }, [work]);
      expect(r).toEqual({ folderId: 'fld_work_01', displayName: 'Work folder' });
    });

    it('falls back to the sole linked folder when the model id is garbage', () => {
      const r = resolveLinkedFolder({ folderId: 'the linked folder' }, [work]);
      expect(r).toEqual({ folderId: 'fld_work_01', displayName: 'Work folder' });
    });

    it('does NOT guess among multiple folders on an unmatched empty id', () => {
      // Multiple folders + nothing to match => caller emits INVALID_ARGS.
      const r = resolveLinkedFolder({ folderId: '', displayName: '' }, [
        work,
        personal,
      ]);
      expect(r).toBeNull();
    });

    it('passes through an unknown non-empty id when multiple folders are linked', () => {
      // Preserves legacy behaviour: the enclave forwards a non-empty id it
      // can't vet here; the client still validates the binding.
      const r = resolveLinkedFolder({ folderId: 'fld_unknown', displayName: 'X' }, [
        work,
        personal,
      ]);
      expect(r).toEqual({ folderId: 'fld_unknown', displayName: 'X' });
    });

    it('requires a UNIQUE label match — duplicate display names do not resolve', () => {
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
      const r = resolveLinkedFolder({ displayName: 'Shared' }, [dupA, dupB]);
      // Ambiguous label, no real id, >1 folder => unresolved.
      expect(r).toBeNull();
    });
  });

  describe('without linked-folder context (legacy passthrough)', () => {
    it('passes a non-empty folderId through unchanged', () => {
      const r = resolveLinkedFolder(
        { folderId: 'fld_01', displayName: 'Career' },
        [],
      );
      expect(r).toEqual({ folderId: 'fld_01', displayName: 'Career' });
    });

    it('returns null when the folderId is empty and there is no context', () => {
      const r = resolveLinkedFolder({ folderId: '', displayName: 'Career' }, []);
      expect(r).toBeNull();
    });

    it('returns null when folderId is missing entirely', () => {
      const r = resolveLinkedFolder({ displayName: 'Career' }, []);
      expect(r).toBeNull();
    });
  });
});

describe('withResolvedFolder', () => {
  it('injects the resolved folderId + displayName, preserving other args', () => {
    const frame: ToolInvocationFrame = {
      invocationId: 'inv1',
      agentTurnId: 't1',
      toolName: 'file.read',
      args: { folderId: 'Work folder', filename: 'offer.md', extra: 1 },
    };
    const out = withResolvedFolder(frame, {
      folderId: 'fld_work_01',
      displayName: 'Work folder',
    });
    expect(out.args).toEqual({
      folderId: 'fld_work_01',
      displayName: 'Work folder',
      filename: 'offer.md',
      extra: 1,
    });
    // Original frame untouched.
    expect((frame.args as { folderId: string }).folderId).toBe('Work folder');
  });
});
