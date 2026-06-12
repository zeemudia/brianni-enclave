import { describe, expect, it } from 'vitest';
import type { SkillPack } from '@calypso/chat-types';
import { getEffectiveSkillPack } from '@calypso/chat-types/skills';

import {
  FREE_AGENT_MAX_TOOL_CALLS,
  FREE_AGENT_TOOL_SCOPES,
  scopePackToPlan,
} from '../agent/free-tier-tools';

// The real default pack a single-mode request resolves (read tools + web.fetch
// + media all co-located) — the thing FREE must be narrowed away from.
const defaultPack: SkillPack = getEffectiveSkillPack('personal-agent.default');

describe('FREE-tier agent tool scoping', () => {
  it('the default pack really co-locates the tools we are gating', () => {
    // Guard the fixture: if this ever stops being true, the test below is moot.
    expect(defaultPack.toolScopes).toContain('web.fetch');
    expect(defaultPack.toolScopes).toContain('file.read');
    expect(
      defaultPack.toolScopes.some((t) => t.startsWith('audio.')),
    ).toBe(true);
  });

  it('removes web.fetch and the media pipeline for FREE', () => {
    const free = scopePackToPlan(defaultPack, 'FREE');
    // Egress gone — closes both the read->egress exfil vector and the free
    // fetch-proxy cost.
    expect(free.toolScopes).not.toContain('web.fetch');
    // Media pipeline gone — no unpriced compute.
    for (const tool of free.toolScopes) {
      expect(/^(image|audio|video|document|pdf)\./.test(tool)).toBe(false);
    }
  });

  it('keeps the core "read your own data + draft/write" taste for FREE', () => {
    const free = scopePackToPlan(defaultPack, 'FREE');
    for (const tool of [
      'memory.read',
      'file.read',
      'folder.read',
      'folder.write',
    ] as const) {
      expect(free.toolScopes).toContain(tool);
    }
    // Every retained scope is in the allow-set (no leakage).
    for (const tool of free.toolScopes) {
      expect(FREE_AGENT_TOOL_SCOPES.has(tool)).toBe(true);
    }
    expect(free.toolScopes.length).toBeGreaterThan(0);
  });

  it('leaves PRO and MAX packs unchanged', () => {
    expect(scopePackToPlan(defaultPack, 'PRO')).toBe(defaultPack);
    expect(scopePackToPlan(defaultPack, 'MAX')).toBe(defaultPack);
  });

  it('does not mutate the input pack', () => {
    const before = [...defaultPack.toolScopes];
    scopePackToPlan(defaultPack, 'FREE');
    expect(defaultPack.toolScopes).toEqual(before);
  });

  it('caps FREE per-turn fan-out below the default (10)', () => {
    expect(FREE_AGENT_MAX_TOOL_CALLS).toBeLessThan(10);
    expect(FREE_AGENT_MAX_TOOL_CALLS).toBeGreaterThan(0);
  });
});
