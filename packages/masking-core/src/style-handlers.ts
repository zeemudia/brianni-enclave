/**
 * Shared, pure handlers for style-suggestion accept / dismiss / applyAll
 * lifecycles. Consumed by both apps/mobile/app/(app)/index.tsx and
 * apps/web/app/page.tsx so the two pages share a single source of truth
 * (matching slice/stale partition logic, replacement order, and per-id
 * accept/dismiss bookkeeping).
 *
 * Privacy contract: this module imports nothing from React, no platform
 * globals, and no storage adapters. It is pure logic over the existing
 * `StyleSuggestion` type and the hook's per-id callback signatures. The
 * ghost-mode "no trace" tests in apps/* depend on this purity to make
 * their throwing storage tripwires meaningful — if anyone later adds
 * a `storage.save(...)` call inside any helper here, those tripwires
 * fire because the page handlers (and the tests) execute the same code.
 */

import { applyAccepted } from './stylometric';
import type { StyleSuggestion } from './stylometric/types';

export type StyleSuggestionStatus = 'pending' | 'accepted' | 'dismissed';

/**
 * Dependencies the page must inject when calling any handler. The shape is
 * deliberately minimal so the helpers stay pure and testable without React.
 *
 * - `getText` is read on every call (mobile passes a ref-derived getter,
 *   web passes a closure over `composerText`). Always re-read so stale-text
 *   detection stays accurate.
 * - `setText` is the platform write boundary (web: `setComposerText`,
 *   mobile: `composerRef.current?.replaceText(...)`).
 * - `suggestions` and `statuses` come straight from `useStyleAnalysis` after
 *   PII filtering.
 * - `accept` / `dismiss` / `dismissAll` are the hook's per-id setters.
 */
export interface StyleHandlerDeps {
  /** Current composer text. Re-read on every call. */
  getText: () => string;
  /** Mutate composer text. */
  setText: (next: string) => void;
  /** All current suggestions (the hook's `suggestions`, post-PII-filter). */
  suggestions: readonly StyleSuggestion[];
  /** Map of statuses (the hook's `statuses`). Default per-id = 'pending'. */
  statuses: Readonly<Record<string, StyleSuggestionStatus>>;
  /** Per-id accept callback (the hook's `accept`). */
  accept: (id: string) => void;
  /** Per-id dismiss callback (the hook's `dismiss`). */
  dismiss: (id: string) => void;
  /** Dismiss-all callback (the hook's `dismissAll`). */
  dismissAll: () => void;
}

/**
 * Accept a single style suggestion by id.
 *
 * Stale-text guard: if the slice at `[startIndex, endIndex)` no longer
 * matches `original` (user edited the span away inside the debounce
 * window), silently dismiss(id) instead of replacing — otherwise we'd
 * splice the wrong substring.
 *
 * No-op when `id` is not in `suggestions` (race between render + click).
 */
export function acceptStyleSuggestion(
  deps: StyleHandlerDeps,
  id: string,
): void {
  const suggestion = deps.suggestions.find((s) => s.id === id);
  if (!suggestion) return;
  const current = deps.getText();
  const { startIndex, endIndex, original, replacement } = suggestion;
  if (current.slice(startIndex, endIndex) !== original) {
    deps.dismiss(id);
    return;
  }
  const next =
    current.slice(0, startIndex) + replacement + current.slice(endIndex);
  deps.setText(next);
  deps.accept(id);
}

/**
 * Dismiss a single style suggestion by id. Pure forward to `deps.dismiss`.
 */
export function dismissStyleSuggestion(
  deps: StyleHandlerDeps,
  id: string,
): void {
  deps.dismiss(id);
}

/**
 * Apply all currently-pending style suggestions.
 *
 * Partitions pending suggestions into:
 *   - validPending: slice still matches `original` — apply via
 *     `applyAccepted` (right-to-left, span-shift safe), then per-id accept.
 *   - stalePending: slice no longer matches — per-id dismiss.
 *
 * We do NOT call `styleAnalysis.applyAll()` here: that would mark every
 * visible id 'accepted', including stale ids whose text was never replaced
 * — a ghost-accept. Instead we per-id accept the valid ones (matching what
 * `applyAccepted` actually mutated) and per-id dismiss the stale ones
 * (matching the per-suggestion handler's silent-dismiss-on-stale behaviour).
 */
export function applyAllStyleSuggestions(deps: StyleHandlerDeps): void {
  const pending = deps.suggestions.filter(
    (s) => (deps.statuses[s.id] ?? 'pending') === 'pending',
  );
  if (pending.length === 0) return;
  const current = deps.getText();
  const validPending = pending.filter(
    (s) => current.slice(s.startIndex, s.endIndex) === s.original,
  );
  const stalePending = pending.filter(
    (s) => current.slice(s.startIndex, s.endIndex) !== s.original,
  );
  if (validPending.length > 0) {
    const next = applyAccepted(current, validPending);
    if (next !== current) deps.setText(next);
    for (const s of validPending) deps.accept(s.id);
  }
  for (const s of stalePending) deps.dismiss(s.id);
}

/**
 * Dismiss all suggestions. Pure forward to `deps.dismissAll`.
 */
export function dismissAllStyleSuggestions(deps: StyleHandlerDeps): void {
  deps.dismissAll();
}
