/**
 * Tests for the shared style-suggestion page handlers.
 *
 * These pure helpers are imported by both apps/mobile/app/(app)/index.tsx
 * and apps/web/app/page.tsx and exercised verbatim by both ghost-mode
 * "no trace" tests. The contract under test is:
 *   - acceptStyleSuggestion: text mutation + accept(id) when slice matches
 *   - acceptStyleSuggestion: silent dismiss(id) when slice is stale
 *   - acceptStyleSuggestion: no-op when id is unknown
 *   - applyAllStyleSuggestions: partition pending into valid + stale, accept
 *     valid, dismiss stale (no ghost-accepts)
 *   - applyAllStyleSuggestions: no-op when no pending
 *   - dismissStyleSuggestion / dismissAllStyleSuggestions: forward to deps
 *
 * The helpers MUST stay pure — no React, no storage, no platform globals.
 * The ghost-mode tests in apps/* depend on this purity to make their
 * throwing storage tripwires meaningful.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  acceptStyleSuggestion,
  applyAllStyleSuggestions,
  dismissAllStyleSuggestions,
  dismissStyleSuggestion,
  type StyleHandlerDeps,
  type StyleSuggestionStatus,
} from '../style-handlers';
import type { StyleSuggestion } from '../stylometric/types';

// ---------------------------------------------------------------------------
// Test fixtures + factory
// ---------------------------------------------------------------------------

function makeSuggestion(partial: Partial<StyleSuggestion>): StyleSuggestion {
  return {
    id: 'sugg-1',
    category: 'punctuation',
    original: 'Hello!!!',
    replacement: 'Hello!',
    startIndex: 0,
    endIndex: 8,
    confidence: 1,
    ...partial,
  };
}

interface TestRig {
  textState: { value: string };
  deps: StyleHandlerDeps;
  setTextSpy: ReturnType<typeof vi.fn>;
  acceptSpy: ReturnType<typeof vi.fn>;
  dismissSpy: ReturnType<typeof vi.fn>;
  dismissAllSpy: ReturnType<typeof vi.fn>;
}

function buildRig(opts: {
  initialText: string;
  suggestions: StyleSuggestion[];
  statuses?: Record<string, StyleSuggestionStatus>;
}): TestRig {
  const textState = { value: opts.initialText };
  const setTextSpy = vi.fn((next: string) => {
    textState.value = next;
  });
  const acceptSpy = vi.fn();
  const dismissSpy = vi.fn();
  const dismissAllSpy = vi.fn();
  const deps: StyleHandlerDeps = {
    getText: () => textState.value,
    setText: setTextSpy,
    suggestions: opts.suggestions,
    statuses: opts.statuses ?? {},
    accept: acceptSpy,
    dismiss: dismissSpy,
    dismissAll: dismissAllSpy,
  };
  return { textState, deps, setTextSpy, acceptSpy, dismissSpy, dismissAllSpy };
}

// ---------------------------------------------------------------------------
// acceptStyleSuggestion
// ---------------------------------------------------------------------------

describe('acceptStyleSuggestion', () => {
  it('mutates text and accepts the id when the slice matches `original`', () => {
    const sugg = makeSuggestion({
      id: 'fix-bang',
      original: 'wow!!!',
      replacement: 'wow!',
      startIndex: 0,
      endIndex: 6,
    });
    const rig = buildRig({ initialText: 'wow!!! today', suggestions: [sugg] });

    acceptStyleSuggestion(rig.deps, 'fix-bang');

    expect(rig.setTextSpy).toHaveBeenCalledTimes(1);
    expect(rig.setTextSpy).toHaveBeenCalledWith('wow! today');
    expect(rig.textState.value).toBe('wow! today');
    expect(rig.acceptSpy).toHaveBeenCalledExactlyOnceWith('fix-bang');
    expect(rig.dismissSpy).not.toHaveBeenCalled();
  });

  it('silently dismisses (no text mutation, no accept) when the slice is stale', () => {
    const sugg = makeSuggestion({
      id: 'stale',
      original: 'wow!!!',
      replacement: 'wow!',
      startIndex: 0,
      endIndex: 6,
    });
    // User edited the span in the debounce window — slice no longer matches.
    const rig = buildRig({ initialText: 'meh!!! today', suggestions: [sugg] });

    acceptStyleSuggestion(rig.deps, 'stale');

    expect(rig.setTextSpy).not.toHaveBeenCalled();
    expect(rig.acceptSpy).not.toHaveBeenCalled();
    expect(rig.dismissSpy).toHaveBeenCalledExactlyOnceWith('stale');
    expect(rig.textState.value).toBe('meh!!! today');
  });

  it('is a no-op when the id is not in suggestions', () => {
    const rig = buildRig({
      initialText: 'wow!!! today',
      suggestions: [makeSuggestion({ id: 'real' })],
    });

    acceptStyleSuggestion(rig.deps, 'unknown-id');

    expect(rig.setTextSpy).not.toHaveBeenCalled();
    expect(rig.acceptSpy).not.toHaveBeenCalled();
    expect(rig.dismissSpy).not.toHaveBeenCalled();
  });

  it('reads text via getText on each call (not from a captured snapshot)', () => {
    const sugg = makeSuggestion({
      id: 'live',
      original: 'wow!!!',
      replacement: 'wow!',
      startIndex: 0,
      endIndex: 6,
    });
    const textState = { value: 'wow!!! today' };
    const getText = vi.fn(() => textState.value);
    const setText = vi.fn((next: string) => {
      textState.value = next;
    });
    const accept = vi.fn();
    const dismiss = vi.fn();
    const deps: StyleHandlerDeps = {
      getText,
      setText,
      suggestions: [sugg],
      statuses: {},
      accept,
      dismiss,
      dismissAll: vi.fn(),
    };

    acceptStyleSuggestion(deps, 'live');
    expect(getText).toHaveBeenCalled();
    expect(accept).toHaveBeenCalledOnce();

    // Mutate underlying text out-of-band; the next call should observe it.
    textState.value = 'changed! again';
    acceptStyleSuggestion(deps, 'live');
    // Slice [0,6) is now 'change' — stale, so dismiss fires.
    expect(dismiss).toHaveBeenCalledExactlyOnceWith('live');
  });
});

// ---------------------------------------------------------------------------
// dismissStyleSuggestion
// ---------------------------------------------------------------------------

describe('dismissStyleSuggestion', () => {
  it('forwards to deps.dismiss with the id', () => {
    const rig = buildRig({ initialText: 'x', suggestions: [] });
    dismissStyleSuggestion(rig.deps, 'some-id');
    expect(rig.dismissSpy).toHaveBeenCalledExactlyOnceWith('some-id');
    expect(rig.setTextSpy).not.toHaveBeenCalled();
    expect(rig.acceptSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// applyAllStyleSuggestions
// ---------------------------------------------------------------------------

describe('applyAllStyleSuggestions', () => {
  it('is a no-op when no suggestions are pending', () => {
    const sugg = makeSuggestion({ id: 'x' });
    const rig = buildRig({
      initialText: 'Hello!!!',
      suggestions: [sugg],
      statuses: { x: 'accepted' },
    });

    applyAllStyleSuggestions(rig.deps);

    expect(rig.setTextSpy).not.toHaveBeenCalled();
    expect(rig.acceptSpy).not.toHaveBeenCalled();
    expect(rig.dismissSpy).not.toHaveBeenCalled();
  });

  it('applies all valid pending suggestions and accepts each id', () => {
    // Two suggestions both pending, both with matching slices.
    const a = makeSuggestion({
      id: 'a',
      original: 'wow!!!',
      replacement: 'wow!',
      startIndex: 0,
      endIndex: 6,
    });
    const b = makeSuggestion({
      id: 'b',
      original: 'BIG',
      replacement: 'big',
      startIndex: 12,
      endIndex: 15,
    });
    // text: "wow!!! this BIG"
    //        0         1
    //        0123456789012345
    const rig = buildRig({
      initialText: 'wow!!! this BIG',
      suggestions: [a, b],
    });

    applyAllStyleSuggestions(rig.deps);

    // applyAccepted runs right-to-left: 'wow!!! this BIG' -> 'wow! this big'
    expect(rig.setTextSpy).toHaveBeenCalledTimes(1);
    expect(rig.setTextSpy).toHaveBeenCalledWith('wow! this big');
    expect(rig.acceptSpy).toHaveBeenCalledTimes(2);
    expect(rig.acceptSpy).toHaveBeenNthCalledWith(1, 'a');
    expect(rig.acceptSpy).toHaveBeenNthCalledWith(2, 'b');
    expect(rig.dismissSpy).not.toHaveBeenCalled();
  });

  it('dismisses stale suggestions (slice no longer matches) and accepts only valid ones', () => {
    const valid = makeSuggestion({
      id: 'valid',
      original: 'wow!!!',
      replacement: 'wow!',
      startIndex: 0,
      endIndex: 6,
    });
    const stale = makeSuggestion({
      id: 'stale',
      original: 'BIG',
      replacement: 'big',
      startIndex: 12,
      endIndex: 15,
    });
    // User changed the span 12-15 from 'BIG' to 'big' (or anything else)
    // before applyAll fired. text below has 'big' there, so the 'stale'
    // suggestion's slice no longer matches its `original`.
    const rig = buildRig({
      initialText: 'wow!!! this big',
      suggestions: [valid, stale],
    });

    applyAllStyleSuggestions(rig.deps);

    expect(rig.setTextSpy).toHaveBeenCalledExactlyOnceWith('wow! this big');
    expect(rig.acceptSpy).toHaveBeenCalledExactlyOnceWith('valid');
    expect(rig.dismissSpy).toHaveBeenCalledExactlyOnceWith('stale');
  });

  it('skips already-actioned suggestions (only operates on pending)', () => {
    const accepted = makeSuggestion({
      id: 'a',
      original: 'wow!!!',
      replacement: 'wow!',
      startIndex: 0,
      endIndex: 6,
    });
    const dismissed = makeSuggestion({
      id: 'd',
      original: 'BIG',
      replacement: 'big',
      startIndex: 12,
      endIndex: 15,
    });
    const pending = makeSuggestion({
      id: 'p',
      original: 'today',
      replacement: 'now',
      startIndex: 16,
      endIndex: 21,
    });
    const rig = buildRig({
      initialText: 'wow!!! this BIG today',
      suggestions: [accepted, dismissed, pending],
      statuses: { a: 'accepted', d: 'dismissed' },
    });

    applyAllStyleSuggestions(rig.deps);

    expect(rig.setTextSpy).toHaveBeenCalledExactlyOnceWith(
      'wow!!! this BIG now',
    );
    expect(rig.acceptSpy).toHaveBeenCalledExactlyOnceWith('p');
    expect(rig.dismissSpy).not.toHaveBeenCalled();
  });

  it('does not call setText when applyAccepted yields the same text', () => {
    // Both suggestions are stale — validPending is empty, so setText never
    // fires. Stale suggestions get dismissed.
    const stale = makeSuggestion({
      id: 'stale',
      original: 'wow!!!',
      replacement: 'wow!',
      startIndex: 0,
      endIndex: 6,
    });
    const rig = buildRig({
      initialText: 'edited and gone',
      suggestions: [stale],
    });

    applyAllStyleSuggestions(rig.deps);

    expect(rig.setTextSpy).not.toHaveBeenCalled();
    expect(rig.acceptSpy).not.toHaveBeenCalled();
    expect(rig.dismissSpy).toHaveBeenCalledExactlyOnceWith('stale');
  });
});

// ---------------------------------------------------------------------------
// dismissAllStyleSuggestions
// ---------------------------------------------------------------------------

describe('dismissAllStyleSuggestions', () => {
  it('forwards to deps.dismissAll', () => {
    const rig = buildRig({ initialText: 'x', suggestions: [] });
    dismissAllStyleSuggestions(rig.deps);
    expect(rig.dismissAllSpy).toHaveBeenCalledExactlyOnceWith();
    expect(rig.setTextSpy).not.toHaveBeenCalled();
    expect(rig.acceptSpy).not.toHaveBeenCalled();
    expect(rig.dismissSpy).not.toHaveBeenCalled();
  });
});
