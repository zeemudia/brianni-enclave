import { describe, expect, it } from 'vitest';

import type { SkillPack } from '@calypso/chat-types';

import { isToolBanned, isToolInScope } from '../scope-check';

// Mutation-hardening supplement for the tool allow/deny gate. isToolInScope is
// fail-closed: a tool must be (a) not banned, (b) a known tool name, AND (c)
// listed in the pack's scopes. We pin each rejection arm as INDEPENDENTLY
// observable so a dropped guard cannot silently authorise a tool.

describe('isToolInScope — independent rejection arms', () => {
  it('rejects an INVALID tool name even when a malformed pack lists it in scope', () => {
    // Kills `if (!VALID_TOOL_NAMES.has(toolName)) return false` → `if (false)`.
    // A pack that erroneously lists a non-existent tool name must NOT authorise
    // it: the valid-name gate is the sole rejection point here (the name is not
    // banned and IS in toolScopes), so removing the gate would authorise garbage.
    const malformedPack: Pick<SkillPack, 'toolScopes'> = {
      toolScopes: ['memory.list', 'not.a.real.tool'] as never as SkillPack['toolScopes'],
    };
    expect(isToolInScope('not.a.real.tool', malformedPack)).toBe(false);
  });

  it('rejects a valid, in-scope-listed tool whose name is BANNED', () => {
    // The banned check fires before the scope check. Even if a pack erroneously
    // lists a banned Tier C/D tool in scope, authorisation must fail closed.
    const widePack: Pick<SkillPack, 'toolScopes'> = {
      toolScopes: [
        'memory.list',
        'mailbox.read',
        'email.send',
        'plaid.connect',
      ] as never as SkillPack['toolScopes'],
    };
    expect(isToolInScope('mailbox.read', widePack)).toBe(false);
    expect(isToolInScope('email.send', widePack)).toBe(false);
    expect(isToolInScope('plaid.connect', widePack)).toBe(false);
  });

  it('rejects a valid, non-banned tool that is NOT in the pack scopes', () => {
    // Kills dropping the final `pack.toolScopes.includes(toolName)` arm.
    const narrowPack: Pick<SkillPack, 'toolScopes'> = {
      toolScopes: ['memory.list', 'memory.read'],
    };
    expect(isToolInScope('folder.write', narrowPack)).toBe(false);
    expect(isToolInScope('email.draft', narrowPack)).toBe(false);
  });

  it('authorises a valid, non-banned, in-scope tool', () => {
    const pack: Pick<SkillPack, 'toolScopes'> = {
      toolScopes: ['memory.list', 'memory.read', 'folder.read'],
    };
    expect(isToolInScope('memory.read', pack)).toBe(true);
    expect(isToolInScope('folder.read', pack)).toBe(true);
  });
});

describe('isToolBanned — positive list, exhaustive', () => {
  it.each([
    'mailbox.read',
    'calendar.read',
    'email.send',
    'event.create',
    'form.submit',
    'web.automation',
    'browser.use',
    'plaid.connect',
  ])('flags %s as banned', (name) => {
    expect(isToolBanned(name)).toBe(true);
  });

  it('does not flag a near-miss of a banned name (exact-match set membership)', () => {
    // Kills any substring/relaxation of the Set.has check.
    expect(isToolBanned('email.sender')).toBe(false);
    expect(isToolBanned('mailbox.read.all')).toBe(false);
    expect(isToolBanned('mailbox')).toBe(false);
    expect(isToolBanned('')).toBe(false);
  });
});
