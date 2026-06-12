import { describe, it, expect } from "vitest";
import { PIITokeniser } from "../tokeniser";
import { detectPII } from "../patterns";
import {
  maskHistoricalUserContent,
  buildMaskedOutboundHistory,
} from "../history";

describe("maskHistoricalUserContent (Codex LOW F20/F24)", () => {
  it("masks PII in hydrated user content that lost its maskedContent", () => {
    const tokeniser = new PIITokeniser();
    const out = maskHistoricalUserContent(
      "email me at alice@example.com",
      tokeniser,
    );
    expect(out).not.toContain("alice@example.com");
    expect(out).toMatch(/\[EMAIL_\d+\]/);
  });

  it("masks multiple direct-identifier types (the detectPII floor)", () => {
    const tokeniser = new PIITokeniser();
    const out = maskHistoricalUserContent(
      "reach me at bob@example.com or 415-555-0142",
      tokeniser,
    );
    expect(out).not.toContain("bob@example.com");
    expect(out).not.toContain("415-555-0142");
    expect(out).toMatch(/\[EMAIL_\d+\]/);
    expect(out).toMatch(/\[PHONE_\d+\]/);
  });

  it("returns content unchanged when there is no PII to mask", () => {
    const tokeniser = new PIITokeniser();
    expect(maskHistoricalUserContent("the capital of france", tokeniser)).toBe(
      "the capital of france",
    );
  });

  // claude-adv review — when a mixed outbound request contains a turn whose
  // maskedContent was already minted AND a re-masked turn echoing the same
  // identifier (e.g. an assistant turn), confirm the feared failure mode
  // (cross-contaminated substitutions) does not occur: no raw identifier
  // leaks, and every emitted token reverses to its correct original even if
  // the identifier maps to more than one token.
  it("never leaks the identifier and keeps every token reversible across a mixed history", () => {
    const tokeniser = new PIITokeniser();
    // Turn 1: stored maskedContent path (mints [EMAIL_1] on this tokeniser).
    const userTurn = tokeniser.mask(
      "contact alice@example.com",
      detectPII("contact alice@example.com"),
    ).masked;
    // Turn 2: re-masked hydrated/assistant turn echoing the same identifier.
    const assistantTurn = maskHistoricalUserContent(
      "sure, I'll email alice@example.com",
      tokeniser,
    );

    expect(userTurn).not.toContain("alice@example.com");
    expect(assistantTurn).not.toContain("alice@example.com");

    // No emitted EMAIL token reverses to the wrong value (no same-token-two-
    // values contamination); both turns rehydrate back to the real identifier.
    for (const { token, original } of tokeniser.getSubstitutions()) {
      if (token.startsWith("[EMAIL"))
        expect(original).toBe("alice@example.com");
    }
    expect(tokeniser.rehydrate(assistantTurn)).toContain("alice@example.com");
  });
});

describe("buildMaskedOutboundHistory (Codex LOW F20/F24 — the actual send-path build)", () => {
  it("re-masks every turn lacking maskedContent (incl. assistant) and passes stored maskedContent verbatim", () => {
    const tokeniser = new PIITokeniser();
    const out = buildMaskedOutboundHistory(
      [
        // Live turn with its already-computed masked representation → verbatim.
        {
          role: "user",
          content: "RAW SHOULD BE IGNORED",
          maskedContent: "hi [EMAIL_9]",
        },
        // Hydrated assistant turn (rehydrated display text echoing PII) → re-masked.
        { role: "assistant", content: "sure, I'll email alice@example.com" },
        // Hydrated user turn → re-masked.
        { role: "user", content: "and call 415-555-0142" },
      ],
      tokeniser,
    );

    // Stored maskedContent is sent verbatim, never the raw content.
    expect(out[0].content).toBe("hi [EMAIL_9]");
    expect(out[0].content).not.toContain("RAW SHOULD BE IGNORED");

    // Hydrated turns (assistant included) are masked.
    expect(out[1].content).toMatch(/\[EMAIL_\d+\]/);
    expect(out[2].content).toMatch(/\[PHONE_\d+\]/);

    // No raw identifier survives anywhere in the outbound payload.
    const joined = out.map((m) => m.content).join("\n");
    expect(joined).not.toContain("alice@example.com");
    expect(joined).not.toContain("415-555-0142");

    // Roles are preserved.
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("leaves PII-free hydrated content unchanged", () => {
    const tokeniser = new PIITokeniser();
    const out = buildMaskedOutboundHistory(
      [{ role: "assistant", content: "the capital of france is paris" }],
      tokeniser,
    );
    expect(out[0].content).toBe("the capital of france is paris");
  });
});
