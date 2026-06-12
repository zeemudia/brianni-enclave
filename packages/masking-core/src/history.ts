import { detectPII } from "./patterns";
import type { PIITokeniser } from "./tokeniser";

/**
 * Re-mask a persisted/hydrated user message before it is resent as API
 * history.
 *
 * Persisted conversations only carry plaintext `content`; the in-memory
 * `maskedContent` field is never persisted and is therefore lost when a
 * conversation is reloaded from storage or selected from the drawer. Without
 * re-masking, a follow-up turn would resend the original PII as plaintext on
 * the Phase-1 / direct-transport path, defeating the on-device masking
 * invariant (Codex LOW F20 / F24).
 *
 * Scope: this is the detectPII DIRECT-IDENTIFIER floor (email, phone, SSN,
 * card, address, …) — strictly better than resending raw plaintext, but NOT
 * full parity with the interactive send pipeline, which can also layer
 * on-device NER (names) and the user's per-entity chip decisions. Those
 * signals are draft-scoped and not reproducible from persisted history, so
 * hydrated turns get the regex floor; the residual gap is NER-only entities
 * (e.g. names).
 *
 * That residual gap only matters on the Phase-1 / direct-transport path. In
 * production the client uses the Phase-2 TEE transport (attestation-gated,
 * host-blind) and direct transport is reached only when attestation is
 * unavailable (non-TEE / dev). So this floor is defense-in-depth before the
 * TEE and the leak-prevention guarantee for any non-TEE deployment; closing
 * the NER gap fully would require restoring full masked state at hydration
 * (deliberately not persisted today). Masking uses the caller's shared
 * tokeniser so numbering stays within the request.
 */
export function maskHistoricalUserContent(
  content: string,
  tokeniser: Pick<PIITokeniser, "mask">,
): string {
  const entities = detectPII(content);
  return entities.length > 0
    ? tokeniser.mask(content, entities).masked
    : content;
}

export interface OutboundHistoryMessage {
  role: string;
  content: string;
  /** Masked API representation; in-memory only, absent on hydrated turns. */
  maskedContent?: string;
}

/**
 * Build the masked message history sent to the model. A turn that still has its
 * in-memory `maskedContent` (computed by the live send pipeline) is sent
 * verbatim; any turn lacking it — every hydrated turn, and every assistant turn
 * (which stores rehydrated display text) — is re-masked via
 * {@link maskHistoricalUserContent} so raw PII is never resent as plaintext on
 * the Phase-1 / direct-transport path (Codex LOW F20/F24). Shared by the web
 * and mobile send paths so the outbound-masking invariant has one
 * implementation and one behavioral test.
 */
export function buildMaskedOutboundHistory<T extends OutboundHistoryMessage>(
  messages: readonly T[],
  tokeniser: Pick<PIITokeniser, "mask">,
): { role: T["role"]; content: string }[] {
  return messages.map((m) =>
    m.maskedContent === undefined
      ? {
          role: m.role,
          content: maskHistoricalUserContent(m.content, tokeniser),
        }
      : { role: m.role, content: m.maskedContent },
  );
}
