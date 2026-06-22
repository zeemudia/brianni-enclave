import { detectPII } from "./patterns";
import { PIITokeniser } from "./tokeniser";

/**
 * One piece of the outbound masking preview. `plain` is verbatim source text;
 * `masked` is a detected identifier that will be tokenised before the provider
 * call (rendered as its token, tappable to keep-visible); `kept` is an
 * identifier the user chose to send in the clear (rendered as the original,
 * tappable to re-mask).
 */
export type MaskPreviewSegment =
  | { kind: "plain"; text: string }
  | { kind: "masked"; token: string; original: string }
  | { kind: "kept"; original: string };

export interface MaskPreview {
  segments: MaskPreviewSegment[];
  /** Number of identifiers that will leave the device masked. */
  maskedCount: number;
  /** Number of identifiers the user chose to send in the clear. */
  keptCount: number;
}

/**
 * Pure, deterministic model for the interactive "what leaves your device"
 * preview, shared by web and mobile. Given the draft text and the set of
 * entity texts the user chose to keep visible (`dismissed`), it returns an
 * ordered list of segments that reconstruct the message — with each detected
 * identifier rendered either as its mask token (will be sent masked) or its
 * original (will be sent in the clear). Uses a FRESH tokeniser so it never
 * mutates the session tokeniser; token numbering is draft-local (from 1),
 * matching the existing read-only preview.
 */
export function buildMaskPreview(
  text: string,
  dismissed: ReadonlySet<string>,
): MaskPreview {
  // detectPII already returns non-overlapping, position-sorted entities.
  const entities = detectPII(text);
  const active = entities.filter((e) => !dismissed.has(e.text));
  const { tokens } = new PIITokeniser().mask(text, active);
  const tokenByStart = new Map(tokens.map((t) => [t.startIndex, t.token]));

  const segments: MaskPreviewSegment[] = [];
  let cursor = 0;
  let maskedCount = 0;
  let keptCount = 0;

  for (const entity of entities) {
    // Stryker disable next-line ConditionalExpression: equivalent — this guard is
    // unreachable for any real `detectPII` output. `detectPII` returns entities
    // sorted ascending by startIndex AND non-overlapping: it sorts by startIndex,
    // then appends an entity only when nothing in `filtered` overlaps it, and its
    // replace-in-place branch swaps a higher-confidence entity that — because
    // entities are processed start-sorted and `find` returns the first overlap —
    // provably keeps both the sort order and the non-overlap invariant (the
    // replacement entity ends at or before the next filtered entity's start).
    // Hence `entity.startIndex >= cursor (= previous entity.endIndex)` always
    // holds, so forcing the guard false never skips a real iteration. (Confirmed
    // by a ~99k-input fuzz over overlap-prone tokens: zero violations.)
    if (entity.startIndex < cursor) continue; // defensive: skip any overlap
    if (entity.startIndex > cursor) {
      segments.push({ kind: "plain", text: text.slice(cursor, entity.startIndex) });
    }
    const token = tokenByStart.get(entity.startIndex);
    if (token !== undefined) {
      segments.push({ kind: "masked", token, original: entity.text });
      maskedCount++;
    } else {
      segments.push({ kind: "kept", original: entity.text });
      keptCount++;
    }
    cursor = entity.endIndex;
  }
  if (cursor < text.length) {
    segments.push({ kind: "plain", text: text.slice(cursor) });
  }

  return { segments, maskedCount, keptCount };
}
