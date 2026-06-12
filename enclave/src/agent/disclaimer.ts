// Not-advice disclaimers for the regulated-information skill packs.
//
// Policy (founder decision 2026-06-03): Calypso MAY provide general legal and
// health *information* — in keeping with the rest of the industry — as long as
// each such response carries a clear "not professional advice" disclaimer. It
// must NOT impersonate a licensed professional or give binding advice.
//
// Two enforcement layers:
//   A) The model is instructed to append the disclaimer (global rule in
//      `assembleSystemPrompt` + each specialist pack's systemPromptBlock).
//   B) This deterministic enclave append guarantees the disclaimer is present
//      on the dedicated legal/health personas even if the model omits it. The
//      append is keyed on the active pack id (precise, no content guessing) and
//      de-duplicates against a disclaimer the model already produced under (A).
//
// The exact disclaimer copy lives in @calypso/chat-types so the enclave and the
// clients (which render the chat-path banner) never drift apart.

import {
  REGULATED_DISCLAIMERS,
  disclaimerLinesForTopics,
  type RegulatedTopic,
} from "@calypso/chat-types";

export type { RegulatedTopic };

export const LEGAL_DISCLAIMER = REGULATED_DISCLAIMERS.legal;

export const HEALTH_DISCLAIMER = REGULATED_DISCLAIMERS.health;

/** The disclaimer a given skill pack must carry, or null if the pack is unregulated. */
export function disclaimerForPack(packId: string): string | null {
  if (packId === "personal-agent.legal-tenant") return LEGAL_DISCLAIMER;
  if (packId === "personal-agent.health") return HEALTH_DISCLAIMER;
  return null;
}

/**
 * Returns the disclaimer to append to the turn's final text, or null when no
 * append is needed. Null when: the pack is unregulated; the model already
 * included the disclaimer (mechanism A satisfied it); or the turn produced no
 * text (nothing to disclaim — e.g. a pure tool/error turn).
 */
export function pendingDisclaimerSuffix(
  packId: string,
  emittedText: string,
): string | null {
  const disclaimer = disclaimerForPack(packId);
  if (!disclaimer) return null;
  if (emittedText.trim().length === 0) return null;

  const normalized = emittedText.toLowerCase();
  // The disclaimer's own distinctive clause is the de-dup signal: if the model
  // already appended it under mechanism A, do not stack a second copy.
  if (packId === "personal-agent.legal-tenant" && normalized.includes("not legal advice")) {
    return null;
  }
  if (packId === "personal-agent.health" && normalized.includes("not medical advice")) {
    return null;
  }
  return disclaimer;
}

// ---------------------------------------------------------------------------
// Model-tagged topic detection (chat path)
//
// The plain chat path carries no skill pack, so the pack-keyed mechanisms above
// can't fire there. Instead of guessing the topic with a keyword classifier, we
// ask the MODEL — which understands context far better — to declare the
// regulated domain(s) its answer addresses. The model emits a machine-readable
// control token as the FIRST line of its response; the enclave parses it,
// strips it from the user-visible stream, and emits a structured `disclaimer`
// signal the client renders as a banner.
//
// Tradeoff (accepted, founder call 2026-06-08): detection now rides on per-model
// instruction-following, which is weakest on the low-cost free-tier models — so
// some health answers may surface with no banner. There is no deterministic
// floor on this path.
// ---------------------------------------------------------------------------

// The enclave-authored system instruction prepended to chat requests. It is the
// ONLY system prompt on the chat path; keep it tightly scoped to the control
// token so it does not perturb answer style. The token is on its own first line
// so the parser can strip exactly one line.
export const TOPIC_CONTROL_INSTRUCTION = [
  "Before anything else, output a single control line and nothing else on that line:",
  "[[topics:LIST]]",
  "where LIST is a comma-separated list of short lowercase slugs naming every regulated or professional-advice domain your answer gives information or guidance on, or the word `none` if it addresses none.",
  "Use the exact slug `health` for any medical, mental-health, fitness, nutrition, skincare/dermatology, or medication content, and `legal` for any law, contracts, or tenancy content.",
  "For other regulated domains use a natural one-word slug, e.g. `financial`, `tax`, `security`, `safety`.",
  "Put this line FIRST, on its own line, then a newline, then your normal answer.",
  "Do not mention, explain, or repeat this control line anywhere in your answer — the user never sees it.",
].join("\n");

const CONTROL_TOKEN_PREFIX = "[[topics:";
// Bound the list portion: a real token is short, so once the text after the
// opener exceeds this with no closing `]]`, the model has run the opener into
// its answer and it is no longer a token.
const CONTROL_LIST_MAX = 64;

// Topics are open slugs (not a closed health/legal set) so the model can flag
// any regulated domain it judges relevant. Sanitised to short lowercase slugs
// and bounded in count so a confused model can't smuggle prose or spam through.
const MAX_TOPICS = 5;

function parseTopicList(raw: string): RegulatedTopic[] {
  const seen = new Set<string>();
  const out: RegulatedTopic[] = [];
  for (const part of raw.split(",")) {
    const slug = part
      .trim()
      .toLowerCase()
      .replace(/[^a-z-]/g, "")
      .slice(0, 32);
    if (!slug || slug === "none" || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

export type TopicControlResolution =
  // Keep buffering. If `flush` is set, emit it as content now and reset the
  // buffer to `keep` (the trailing partial-opener bytes) — used to stream out a
  // long preamble while still holding a possible opener that may complete next
  // chunk, so the buffer never grows without bound and a token never leaks.
  | { done: false; flush?: string; keep?: string }
  | { done: true; topics: RegulatedTopic[]; rest: string };

// Bounded leading window. While no opener has appeared we keep buffering up to
// this many characters so a token that follows a SHORT preamble — possibly
// arriving in a later stream chunk — is still stripped rather than leaked. Past
// the window we assume there is no leading token and flush, so first-paint
// latency is bounded. A compliant model emits the token first and resolves on
// its closing `]]` long before the window; only a model that ignores the
// "first line" instruction pays the full window delay.
const CONTROL_PREAMBLE_WINDOW = 48;

// True when a suffix of `s` is a (proper) prefix of the opener — i.e. the opener
// may be starting at a chunk boundary (e.g. `s` ends with "[" or "[[to"), so the
// token could complete on the next chunk and must not be flushed yet.
function tailMayStartOpener(s: string): boolean {
  const max = Math.min(s.length, CONTROL_TOKEN_PREFIX.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (CONTROL_TOKEN_PREFIX.startsWith(s.slice(s.length - len))) return true;
  }
  return false;
}

// Drop a trailing partial-opener fragment (e.g. "[[" / "[[to") from `s`.
function trimTrailingOpenerPrefix(s: string): string {
  const max = Math.min(s.length, CONTROL_TOKEN_PREFIX.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (CONTROL_TOKEN_PREFIX.startsWith(s.slice(s.length - len))) {
      return s.slice(0, s.length - len);
    }
  }
  return s;
}

/**
 * Incrementally resolve the topic-control token from a streamed answer. Call
 * with the accumulated prefix text as chunks arrive:
 *   - `{ done: false }` — keep buffering; nothing should be forwarded yet.
 *   - `{ done: true, topics, rest }` — resolved. `topics` is the declared set
 *     (empty for `none` / when the model omitted the token); `rest` is the
 *     user-visible text to forward with the token already STRIPPED (any
 *     preamble before the token is preserved).
 *
 * The token is `[[topics:<list>]]`. The opener is located ANYWHERE in the
 * buffered lead (not just at offset 0), so a model that prepends text —
 * `Sure!\n[[topics:health]]\nAnswer` — gets the token stripped, not leaked,
 * even when the preamble and token arrive in different stream chunks (we buffer
 * through a bounded leading window). Resolution keys on the closing `]]`, not a
 * trailing newline, so an inline `[[topics:health]] answer` is handled too.
 */
export function resolveTopicControl(buffer: string): TopicControlResolution {
  const openerIdx = buffer.indexOf(CONTROL_TOKEN_PREFIX);
  if (openerIdx === -1) {
    // No full opener yet. Keep buffering through the bounded window so a token
    // after a short preamble (possibly in a later chunk) is still caught.
    if (buffer.length < CONTROL_PREAMBLE_WINDOW) return { done: false };
    if (tailMayStartOpener(buffer)) {
      // The buffer ends in a PARTIAL opener (e.g. "[[") that may complete on the
      // next chunk. Stream out everything before it as content, but hold ONLY
      // the partial-opener bytes and stay unresolved — so the completing token
      // is still stripped, never latched-and-leaked, and the buffer self-drains
      // to a few bytes (no hard cap needed, no unbounded growth).
      const flush = trimTrailingOpenerPrefix(buffer);
      return { done: false, flush, keep: buffer.slice(flush.length) };
    }
    // Past the window with no opener and no partial-opener tail — no token.
    return { done: true, topics: [], rest: buffer };
  }

  const preamble = buffer.slice(0, openerIdx);
  const afterOpener = buffer.slice(openerIdx + CONTROL_TOKEN_PREFIX.length);
  const closeIdx = afterOpener.indexOf("]]");
  const newlineIdx = afterOpener.indexOf("\n");

  if (closeIdx !== -1 && (newlineIdx === -1 || closeIdx < newlineIdx)) {
    // Closed token. Strip opener..]] plus one optional trailing space/newline;
    // keep the preamble. parseTopicList sanitises the list, so a stray `]` or
    // junk inside degrades safely.
    const tail = afterOpener.slice(closeIdx + 2).replace(/^[ \t]*\r?\n?/, "");
    return {
      done: true,
      topics: parseTopicList(afterOpener.slice(0, closeIdx)),
      rest: preamble + tail,
    };
  }

  if (newlineIdx !== -1) {
    // The token line broke (newline before any closing `]]`) — malformed. Drop
    // the broken token but keep the preamble and everything after the newline.
    return {
      done: true,
      topics: [],
      rest: preamble + afterOpener.slice(newlineIdx + 1),
    };
  }

  if (afterOpener.length > CONTROL_LIST_MAX) {
    // Opener ran into the answer without ever closing. Drop only the opener so
    // no token text leaks; keep the preamble and the trailing prose.
    return { done: true, topics: [], rest: preamble + afterOpener };
  }

  // Could still complete into a valid token — keep buffering.
  return { done: false };
}

/**
 * Force-resolve at end of stream when {@link resolveTopicControl} is still
 * buffering. Keeps any preamble, drops an incomplete token / partial opener so
 * no token fragment can reach the user.
 */
export function finalizeTopicControl(buffer: string): {
  topics: RegulatedTopic[];
  rest: string;
} {
  const resolution = resolveTopicControl(buffer);
  if (resolution.done) {
    return { topics: resolution.topics, rest: resolution.rest };
  }
  // Still buffering at EOS — emit only the safe content and drop any incomplete
  // token / partial-opener fragment so nothing token-like reaches the user.
  if (resolution.flush !== undefined) {
    return { topics: [], rest: resolution.flush };
  }
  const openerIdx = buffer.indexOf(CONTROL_TOKEN_PREFIX);
  const rest =
    openerIdx === -1
      ? trimTrailingOpenerPrefix(buffer)
      : buffer.slice(0, openerIdx);
  return { topics: [], rest };
}

/** Map a resolved topic set to the disclaimer lines a client should surface. */
export function disclaimersForTopics(topics: readonly RegulatedTopic[]): string[] {
  return disclaimerLinesForTopics(topics);
}
