/**
 * Egress taint ledger — content-level exfiltration guard for the agent
 * `web.fetch` tool.
 *
 * The default skill pack grants sensitive read scopes (memory.read,
 * folder.read, file.read) alongside `web.fetch`. A prompt-injected model
 * could read a user's private memory/files and then smuggle that content
 * out by embedding it in a `web.fetch` URL or query. This ledger harvests
 * the plaintext returned by read tools during a session and blocks any
 * subsequent `web.fetch` whose URL/query reproduces that content.
 *
 * Detection (deliberately heuristic — this is defence-in-depth, not a
 * complete information-flow tracker):
 *  - normalise text via NFKC-fold + lowercase, keeping letters/numbers from
 *    ANY script (so non-ASCII secrets are not erased),
 *  - flag if the egress shares any contiguous normalised window of
 *    >= NGRAM chars with harvested content (catches phrase/sentence leaks),
 *  - flag if the egress contains a harvested "distinctive token" — a
 *    whitespace-delimited chunk (or email address) that normalises to
 *    >= MIN_TOKEN chars (catches identifiers/emails shorter than NGRAM).
 *
 * Every read is harvested (no harvest cap that could be filled to freeze
 * updates); the working set is bounded by FIFO eviction so the most-recent
 * content is always retained.
 *
 * Before matching, the egress URL/query is canonicalised across common
 * REVERSIBLE encodings — repeated percent-decoding, base64 / base64url, and
 * hex (incl. percent-then-base64 layering, all four base64 group alignments,
 * and a delimiter-tolerant pass that rejoins payloads split by whitespace or
 * structural separators) — so a model cannot evade the literal check by
 * re-encoding harvested/replayed private content.
 *
 * Trade-offs: short, low-entropy leaks (a single common word, a 4-digit
 * number) are intentionally NOT flagged to avoid false positives on
 * legitimate "look up the topic of my note" flows. Canonicalisation covers
 * encodings only: compression (gzip), custom ciphers/char-shifts, deeper
 * nesting than the bounded layers above, and a secret split across multiple
 * fetches are NOT reversed and can still evade — true prevention needs the
 * model to never see private data and egress in the same context.
 */

const NGRAM = 20;
const MIN_TOKEN = 12;
// Memory bounds. These EVICT oldest entries (FIFO) rather than freezing
// harvesting — freezing would let an injected model fill the budget with a
// large benign read and then exfiltrate a later secret that never got
// tainted. Eviction keeps the most-recently-read content (incl. the secret)
// while bounding the working set.
const MAX_GRAMS = 200_000;
const MAX_TOKENS = 50_000;

// Bounded quantifiers — an unbounded `+` here backtracks catastrophically on
// a long run of local-part characters with no `@` (e.g. a big text blob),
// which is both a CPU-DoS and was observed to hang harvesting.
const EMAIL_RE = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}.-]{1,255}\.[\p{L}]{2,24}/gu;

/**
 * Unicode-aware normalisation: NFKC-fold, lowercase, then keep only letters
 * and numbers from ANY script. Stripping to `[a-z0-9]` would erase CJK /
 * Arabic / Cyrillic / accented secrets entirely, giving a language-dependent
 * bypass of the egress guard.
 */
function normalise(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Reversible-encoding canonicalisation for the egress check (codex HIGH:
// a model can base64/hex/double-percent-encode harvested or replayed private
// content to dodge the literal-text taint match). Before matching, the guard
// derives a bounded set of decoded forms of the URL/query and checks each.
// This canonicalises ENCODINGS only — it does not (and cannot) reverse
// compression, ciphers, or content split across multiple fetches; those
// remain out of scope for this heuristic defence-in-depth guard.
// Scan cap. Upstream caps web.fetch `url` and `query` at 2048 chars each
// (server/src/routes/agent-web-fetch.ts), so legitimate combined egress is
// ~4 KB; 8 KB leaves headroom. isEgressTainted FAILS CLOSED above this — an
// over-cap egress after private content has been harvested is treated as
// tainted rather than silently passed (no suffix-drop fail-open).
const MAX_EGRESS_SCAN = 8_192;
const MAX_PERCENT_PASSES = 3; // unwind nested %25.. encodings
// Maximal base64/base64url run (keeps internal '+' and '/' so STANDARD base64
// stays intact). Bounded quantifier — no catastrophic backtracking on a long
// alnum blob (cf. EMAIL_RE note above). Upper bound >= the scan cap so a single
// in-cap blob is never split mid-run.
const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{16,8192}={0,2}/g;
// Maximal hex run (alignment + even-length handled at decode time).
const HEX_RUN_RE = /[0-9a-fA-F]{24,8192}/g;
// Everything OUTSIDE the combined base64/base64url/hex alphabet. Stripping
// these rejoins a payload the model split with structural separators or
// (percent-decoded) whitespace — e.g. base64 chunked every 4 chars with
// `%0A`. Decoding the compacted form at every alignment then recovers it.
// This KEEPS '-' and '_' (base64url data chars) so a genuine base64url blob
// survives.
const NON_ENCODE_ALPHABET_RE = /[^A-Za-z0-9+/=_-]+/g;
// As above but ALSO treats '-' and '_' as separators (stripped). A model can
// split STANDARD base64 or hex with '-'/'_' (e.g. `c2Vj-cmV0-...`); the
// receiving endpoint just removes them before decoding. Because '-'/'_' are
// also base64url data chars, this is a SEPARATE candidate (the pass above still
// covers genuine base64url), not a replacement — both run, neither regresses.
const NON_ENCODE_ALPHABET_NO_SEP_RE = /[^A-Za-z0-9+/=]+/g;

/**
 * Percent-decode every run of valid `%HH` triplets PIECEWISE, leaving any
 * malformed escape (e.g. `%zz`) literal. Unlike `decodeURIComponent`, one bad
 * escape cannot abort decoding of the valid escapes around it — so a malformed
 * prefix can't be used to smuggle a percent-encoded secret past the guard.
 * Consecutive triplets are decoded together as a byte buffer so multi-byte
 * UTF-8 sequences (e.g. Cyrillic `%D0%9F`) survive.
 */
function safePercentDecode(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    const bytes: number[] = [];
    for (let i = 0; i < seq.length; i += 3) {
      bytes.push(parseInt(seq.slice(i + 1, i + 3), 16));
    }
    try {
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return seq;
    }
  });
}

/** Repeated piecewise percent-decode, returning every distinct level. */
function percentDecodeLevels(s: string): string[] {
  const levels = [s];
  let cur = s;
  for (let i = 0; i < MAX_PERCENT_PASSES; i++) {
    const next = safePercentDecode(cur);
    if (next === cur) break;
    levels.push(next);
    cur = next;
  }
  return levels;
}

function decodeBase64Chunk(chunk: string): string | null {
  let b = chunk.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const rem = b.length % 4;
  if (rem === 1) return null; // not a valid base64 length
  if (rem) b = b + '='.repeat(4 - rem);
  try {
    const buf = Buffer.from(b, 'base64');
    if (buf.length < 6) return null; // too short to be a meaningful secret
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Decode a base64-ish run at ALL FOUR group alignments. A payload preceded by
 * an attacker-controlled prefix (e.g. a URL path `/x/<b64>`) only decodes
 * cleanly when the 4-char group boundary lands on it; trying offsets 0..3
 * guarantees one alignment recovers the payload (any remaining leading prefix
 * is then a whole number of groups whose garbage bytes `normalise` strips).
 * This closes the standard-base64-in-path alignment bypass without needing to
 * split on '/'/'+'(which would fragment standard base64).
 */
function decodeBase64Aligned(run: string): string[] {
  const out: string[] = [];
  for (let off = 0; off < 4 && run.length - off >= 16; off += 1) {
    const decoded = decodeBase64Chunk(run.slice(off));
    if (decoded) out.push(decoded);
  }
  return out;
}

function decodeHexAligned(run: string): string[] {
  const out: string[] = [];
  for (let off = 0; off < 2; off += 1) {
    const chunk = run.slice(off);
    if (chunk.length < 24 || !/^[0-9a-fA-F]+$/.test(chunk)) continue;
    const h = chunk.length % 2 === 0 ? chunk : chunk.slice(0, -1);
    try {
      const buf = Buffer.from(h, 'hex');
      if (buf.length >= 6) out.push(buf.toString('utf8'));
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Derive decoded candidate strings from one egress string by reversing
 * base64/base64url and hex (one layer, at every group alignment). EVERY
 * in-cap run is decoded — there is no per-call candidate budget that an
 * attacker could exhaust with benign filler to hide the real payload. Cost is
 * bounded by the scan cap: maximal runs are non-overlapping, so total decode
 * work is O(input length) (×4/×2 fixed alignment factors). Callers run this on
 * each percent-decode level so percent-then-base64 layering is also covered.
 */
function reversibleDecodeCandidates(s: string): string[] {
  const out: string[] = [];
  for (const run of s.match(BASE64_RUN_RE) ?? []) out.push(...decodeBase64Aligned(run));
  for (const run of s.match(HEX_RUN_RE) ?? []) out.push(...decodeHexAligned(run));
  // Delimiter-tolerant pass: strip non-alphabet separators/whitespace to
  // rejoin a payload split into sub-threshold fragments, then decode the
  // compacted form at every alignment. Skipped when nothing was stripped
  // (the runs above already cover the contiguous case).
  const compact = s.replace(NON_ENCODE_ALPHABET_RE, '');
  if (compact.length >= 16 && compact.length !== s.length) {
    for (const run of compact.match(BASE64_RUN_RE) ?? []) out.push(...decodeBase64Aligned(run));
    for (const run of compact.match(HEX_RUN_RE) ?? []) out.push(...decodeHexAligned(run));
  }
  // Second compaction that ALSO strips '-'/'_' as separators, recovering a
  // STANDARD-base64 or hex payload split with hyphens/underscores. Distinct
  // from `compact` (which keeps them as base64url data), so only run it when it
  // actually removed a '-'/'_'.
  const compactNoSep = s.replace(NON_ENCODE_ALPHABET_NO_SEP_RE, '');
  if (compactNoSep.length >= 16 && compactNoSep.length !== compact.length) {
    for (const run of compactNoSep.match(BASE64_RUN_RE) ?? []) out.push(...decodeBase64Aligned(run));
    for (const run of compactNoSep.match(HEX_RUN_RE) ?? []) out.push(...decodeHexAligned(run));
  }
  return out;
}

export class EgressTaintLedger {
  private readonly grams = new Set<string>();
  private readonly tokens = new Set<string>();
  private observedPrivateRead = false;
  // User-promoted data: the grams + tokens of the specific datums the user has
  // EXPLICITLY authorised to cross the egress boundary (consent-gated bridge).
  // Whitelisting at the SAME gram/token granularity the guard matches — rather
  // than only stripping the exact full promoted string — lets a legitimate web
  // lookup send a SUBSET of an approved datum (e.g. just `Hargreaves Lettings
  // Ltd` out of an approved folder-read summary) and still pass, while every
  // UN-promoted harvested gram/token stays blocked. Bounded FIFO.
  private readonly promotedGrams = new Set<string>();
  private readonly promotedTokens = new Set<string>();

  /**
   * Record that a private read tool was successfully dispatched this turn,
   * INDEPENDENT of content length/shape. addText only stores 20-char grams and
   * 12+ char tokens, so a short secret (a PIN `1234`, `PIN 7`, a tiny filename)
   * harvests nothing — yet the model still saw private output. The single-mode
   * egress lock keys off this flag so a short read still blocks later egress.
   */
  markPrivateReadObserved(): void {
    this.observedPrivateRead = true;
  }

  /** True once any private read tool ran ok this turn (content-independent). */
  hasObservedPrivateRead(): boolean {
    return this.observedPrivateRead;
  }

  /**
   * True once ANY private read has harvested matchable content this turn.
   * Retained for callers that need the content-based signal; the single-mode
   * lock uses {@link hasObservedPrivateRead} instead (short reads harvest none).
   */
  hasHarvestedAnyPrivateContent(): boolean {
    return this.grams.size > 0 || this.tokens.size > 0;
  }

  private addGram(g: string): void {
    if (this.grams.has(g)) return;
    this.grams.add(g);
    if (this.grams.size > MAX_GRAMS) {
      const oldest = this.grams.values().next().value;
      if (oldest !== undefined) this.grams.delete(oldest);
    }
  }

  private addToken(t: string): void {
    if (this.tokens.has(t)) return;
    this.tokens.add(t);
    if (this.tokens.size > MAX_TOKENS) {
      const oldest = this.tokens.values().next().value;
      if (oldest !== undefined) this.tokens.delete(oldest);
    }
  }

  /**
   * Harvest sensitive plaintext returned by a read tool. EVERY read is
   * harvested (no global cap that could be filled to freeze updates); memory
   * is bounded by FIFO eviction in addGram/addToken. Cost is O(text length),
   * itself bounded by the gateway's per-tool plaintext caps
   * (MAX_TOOL_AGGREGATE_PLAINTEXT_BYTES) and the per-turn tool-call budget.
   */
  addText(text: string): void {
    if (!text) return;

    const norm = normalise(text);
    for (let i = 0; i + NGRAM <= norm.length; i++) {
      this.addGram(norm.slice(i, i + NGRAM));
    }

    for (const chunk of text.split(/\s+/)) {
      const n = normalise(chunk);
      if (n.length >= MIN_TOKEN) this.addToken(n);
    }
    for (const email of text.match(EMAIL_RE) ?? []) {
      const n = normalise(email);
      if (n.length >= MIN_TOKEN) this.addToken(n);
    }
  }

  /**
   * Promote a specific datum across the egress boundary (consent-gated bridge).
   * Whitelists the datum's grams + tokens (same granularity the guard matches),
   * so an egress that reproduces this datum OR ANY SUBSET of it is no longer
   * tainted, while every un-promoted harvested gram/token stays blocked. No-op
   * for input too short to harvest. FIFO-bounded.
   */
  promote(datum: string): void {
    const norm = normalise(datum);
    if (norm.length < MIN_TOKEN) return; // too short to harvest/scope
    for (let i = 0; i + NGRAM <= norm.length; i++) {
      this.addPromotedGram(norm.slice(i, i + NGRAM));
    }
    // The whole normalised datum, plus each whitespace-delimited word, as tokens
    // — mirrors addText so a word- or full-string token match is whitelisted.
    if (norm.length >= MIN_TOKEN) this.addPromotedToken(norm);
    for (const chunk of datum.split(/\s+/)) {
      const n = normalise(chunk);
      if (n.length >= MIN_TOKEN) this.addPromotedToken(n);
    }
  }

  private addPromotedGram(g: string): void {
    if (this.promotedGrams.has(g)) return;
    this.promotedGrams.add(g);
    if (this.promotedGrams.size > MAX_GRAMS) {
      const oldest = this.promotedGrams.values().next().value;
      if (oldest !== undefined) this.promotedGrams.delete(oldest);
    }
  }

  private addPromotedToken(t: string): void {
    if (this.promotedTokens.has(t)) return;
    this.promotedTokens.add(t);
    if (this.promotedTokens.size > MAX_TOKENS) {
      const oldest = this.promotedTokens.values().next().value;
      if (oldest !== undefined) this.promotedTokens.delete(oldest);
    }
  }

  /** True if `egress` (already normalised) reproduces harvested content. */
  private matchesNormalised(egress: string): boolean {
    if (egress.length === 0) return false;
    if (egress.length >= NGRAM) {
      for (let i = 0; i + NGRAM <= egress.length; i++) {
        const gram = egress.slice(i, i + NGRAM);
        // A user-promoted gram is authorised to cross — skip it.
        if (this.grams.has(gram) && !this.promotedGrams.has(gram)) return true;
      }
    }
    for (const token of this.tokens) {
      // A user-promoted token is authorised to cross — skip it.
      if (this.promotedTokens.has(token)) continue;
      if (egress.includes(token)) return true;
    }
    return false;
  }

  /**
   * True if the web.fetch URL/query reproduces harvested sensitive content —
   * either literally, or after reversing common reversible encodings. The
   * raw form is checked first (fast path), then each percent-decode level and
   * its base64/base64url/hex decodes, so a model cannot dodge the guard by
   * re-encoding replayed/harvested private content (codex HIGH).
   */
  isEgressTainted(url: string, query: string): boolean {
    if (this.grams.size === 0 && this.tokens.size === 0) return false;

    const combined = `${url} ${query}`;
    // Fail CLOSED on over-cap egress. Legit web.fetch url+query is bounded
    // (<=2048 each upstream); an egress larger than the scan cap AFTER private
    // content has been harvested is treated as tainted rather than silently
    // truncated-and-passed (which would let a padded suffix exfiltrate).
    if (combined.length > MAX_EGRESS_SCAN) return true;

    const percentLevels = percentDecodeLevels(combined);

    for (const level of percentLevels) {
      if (this.matchesNormalised(normalise(level))) return true;
      for (const decoded of reversibleDecodeCandidates(level)) {
        if (this.matchesNormalised(normalise(decoded))) return true;
      }
    }
    return false;
  }
}
