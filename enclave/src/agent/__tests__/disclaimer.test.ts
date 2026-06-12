import { describe, expect, it } from "vitest";
import { GENERIC_DISCLAIMER } from "@calypso/chat-types";

import {
  HEALTH_DISCLAIMER,
  LEGAL_DISCLAIMER,
  disclaimerForPack,
  disclaimersForTopics,
  finalizeTopicControl,
  pendingDisclaimerSuffix,
  resolveTopicControl,
} from "../disclaimer";

describe("disclaimerForPack", () => {
  it("returns the legal disclaimer for the legal-tenant pack", () => {
    expect(disclaimerForPack("personal-agent.legal-tenant")).toBe(
      LEGAL_DISCLAIMER,
    );
  });

  it("returns the health disclaimer for the health pack", () => {
    expect(disclaimerForPack("personal-agent.health")).toBe(HEALTH_DISCLAIMER);
  });

  it("returns null for non-specialist packs", () => {
    expect(disclaimerForPack("personal-agent.default")).toBeNull();
    expect(disclaimerForPack("personal-agent.career")).toBeNull();
  });
});

describe("pendingDisclaimerSuffix (deterministic enclave append, mechanism B)", () => {
  it("appends the legal disclaimer when the legal pack answer omits it", () => {
    expect(
      pendingDisclaimerSuffix(
        "personal-agent.legal-tenant",
        "Your tenancy notice period is usually one month.",
      ),
    ).toBe(LEGAL_DISCLAIMER);
  });

  it("appends the health disclaimer when the health pack answer omits it", () => {
    expect(
      pendingDisclaimerSuffix(
        "personal-agent.health",
        "Paracetamol and ibuprofen work in different ways.",
      ),
    ).toBe(HEALTH_DISCLAIMER);
  });

  it("does NOT double-append when the model already included the disclaimer (mechanism A satisfied it)", () => {
    expect(
      pendingDisclaimerSuffix(
        "personal-agent.legal-tenant",
        `Your notice period is one month.\n\n${LEGAL_DISCLAIMER}`,
      ),
    ).toBeNull();
    expect(
      pendingDisclaimerSuffix(
        "personal-agent.health",
        `Drink fluids and rest.\n\n${HEALTH_DISCLAIMER}`,
      ),
    ).toBeNull();
  });

  it("does not append for non-specialist packs", () => {
    expect(
      pendingDisclaimerSuffix("personal-agent.default", "Here is a recipe."),
    ).toBeNull();
  });

  it("does not append when the pack produced no text at all", () => {
    expect(pendingDisclaimerSuffix("personal-agent.legal-tenant", "")).toBeNull();
  });
});

describe("resolveTopicControl (model-tag parser, chat path)", () => {
  it("parses a health token and strips it from the forwarded text", () => {
    const res = resolveTopicControl("[[topics:health]]\nYes, use a moisturizer.");
    expect(res).toEqual({
      done: true,
      topics: ["health"],
      rest: "Yes, use a moisturizer.",
    });
  });

  it("parses multiple topics, preserving the model's order (rendering canonicalises)", () => {
    const res = resolveTopicControl("[[topics:legal, health]]\nHere's the rundown.");
    expect(res).toEqual({
      done: true,
      topics: ["legal", "health"],
      rest: "Here's the rundown.",
    });
  });

  it("resolves `none` to no topics", () => {
    const res = resolveTopicControl("[[topics:none]]\nHere's a banana bread recipe.");
    expect(res).toEqual({
      done: true,
      topics: [],
      rest: "Here's a banana bread recipe.",
    });
  });

  it("keeps non-canonical domain slugs (open topic set)", () => {
    const res = resolveTopicControl("[[topics:health, financial]]\nAnswer.");
    expect(res).toEqual({
      done: true,
      topics: ["health", "financial"],
      rest: "Answer.",
    });
  });

  it("sanitises slugs and caps the count", () => {
    const res = resolveTopicControl(
      "[[topics: Health , a, b, c, d, e, f]]\nAnswer.",
    );
    expect(res.done).toBe(true);
    if (res.done) {
      expect(res.topics).toEqual(["health", "a", "b", "c", "d"]); // capped at 5
    }
  });

  it("keeps buffering while the prefix is still a possible token", () => {
    expect(resolveTopicControl("[[to")).toEqual({ done: false });
    expect(resolveTopicControl("[[topics:hea")).toEqual({ done: false });
  });

  it("buffers a short no-token prefix within the leading window, then flushes once past it", () => {
    // Short prefix could still be followed by a leading token → keep buffering.
    expect(resolveTopicControl("Hello there")).toEqual({ done: false });
    // Past the window with no opener → there is no token; forward verbatim.
    const long =
      "Sure! Here is a fairly long answer that clearly contains no control token at all.";
    expect(resolveTopicControl(long)).toEqual({
      done: true,
      topics: [],
      rest: long,
    });
  });

  // --- Leak-prevention: the control token must NEVER reach the user. ---

  it("strips a token that follows a short preamble, preserving the preamble", () => {
    const res = resolveTopicControl("Sure!\n[[topics:health]]\nUse a moisturizer.");
    expect(res.done).toBe(true);
    if (res.done) {
      expect(res.topics).toEqual(["health"]);
      expect(res.rest).toBe("Sure!\nUse a moisturizer.");
      expect(res.rest).not.toContain("[[topics");
    }
  });

  it("holds (never flushes) a partial opener straddling the window edge", () => {
    // Buffer fills the leading window (48 chars) and ends mid-opener — the token
    // may complete next chunk, so we stay UNRESOLVED, streaming the safe lead and
    // keeping ONLY the partial opener. The partial must never be forwarded.
    for (const partial of ["[[", "[[t", "[[topic", "[[topics"]) {
      const res = resolveTopicControl("x".repeat(48) + partial);
      expect(res.done).toBe(false);
      if (!res.done) {
        expect(res.keep).toBe(partial);
        expect(res.flush).toBe("x".repeat(48));
        expect(res.flush ?? "").not.toContain("[");
      }
    }
  });

  it("strips a token completing AFTER the window edge (no leak across the boundary)", () => {
    const preamble = "x".repeat(50);
    // Simulate the boundary-straddle: buffer ends in "[[", token completes next.
    const first = resolveTopicControl(`${preamble}[[`);
    expect(first.done).toBe(false);
    const res = resolveTopicControl(`${preamble}[[topics:health]]\nAnswer.`);
    expect(res.done).toBe(true);
    if (res.done) {
      expect(res.topics).toEqual(["health"]);
      expect(res.rest).toBe(`${preamble}Answer.`);
      expect(res.rest).not.toContain("[[topics");
    }
  });

  it("drains a long preamble while holding a multi-char partial opener (bounded, no leak)", () => {
    // Round-4 regression: a long preamble ending in a multi-char partial opener
    // ("[[topics") must stream the preamble out yet keep ONLY the partial, so the
    // completing token is still stripped — never latched-and-leaked at a cap.
    const preamble = "x".repeat(113);
    const res = resolveTopicControl(`${preamble}[[topics`);
    expect(res.done).toBe(false);
    if (!res.done) {
      expect(res.flush).toBe(preamble);
      expect(res.keep).toBe("[[topics");
    }
    // The completing token on the kept tail resolves and is stripped.
    expect(resolveTopicControl("[[topics:health]]\nAnswer.")).toEqual({
      done: true,
      topics: ["health"],
      rest: "Answer.",
    });
  });

  it("strips the token even when the model omits the trailing newline (space)", () => {
    const res = resolveTopicControl("[[topics:health]] Yes, use a moisturizer.");
    expect(res).toEqual({
      done: true,
      topics: ["health"],
      rest: "Yes, use a moisturizer.",
    });
  });

  it("strips the token when no whitespace follows the close at all", () => {
    const res = resolveTopicControl("[[topics:health]]Yes.");
    expect(res).toEqual({ done: true, topics: ["health"], rest: "Yes." });
  });

  it("drops a broken token line (newline before the closing ]])", () => {
    const res = resolveTopicControl("[[topics:health\nYes, use a moisturizer.");
    expect(res.done).toBe(true);
    if (res.done) {
      expect(res.rest).toBe("Yes, use a moisturizer.");
      expect(res.rest).not.toContain("[[topics");
    }
  });

  it("never leaks an unclosed opener that runs into prose", () => {
    const buffer = `[[topics:${"a long unclosed answer that just keeps going and going past the cap"}`;
    const res = resolveTopicControl(buffer);
    expect(res.done).toBe(true);
    if (res.done) {
      expect(res.rest).not.toContain("[[topics");
      expect(res.topics).toEqual([]);
    }
  });

  it("handles a stray ] inside the list without leaking", () => {
    const res = resolveTopicControl("[[topics:heal]th]]\nAnswer.");
    expect(res.done).toBe(true);
    if (res.done) expect(res.rest).not.toContain("[[topics");
  });
});

describe("finalizeTopicControl (end-of-stream flush)", () => {
  it("drops a partial token left buffering at stream end", () => {
    expect(finalizeTopicControl("[[topics:hea")).toEqual({
      topics: [],
      rest: "",
    });
    expect(finalizeTopicControl("[[to")).toEqual({ topics: [], rest: "" });
  });

  it("resolves a complete token normally", () => {
    expect(finalizeTopicControl("[[topics:health]]\nDone.")).toEqual({
      topics: ["health"],
      rest: "Done.",
    });
  });

  it("forwards a non-token answer unchanged", () => {
    expect(finalizeTopicControl("just an answer")).toEqual({
      topics: [],
      rest: "just an answer",
    });
  });
});

describe("disclaimersForTopics", () => {
  it("maps canonical topics to their reviewed lines in canonical order", () => {
    expect(disclaimersForTopics(["health"])).toEqual([HEALTH_DISCLAIMER]);
    // Input order legal-first, output canonical order health-first.
    expect(disclaimersForTopics(["legal", "health"])).toEqual([
      HEALTH_DISCLAIMER,
      LEGAL_DISCLAIMER,
    ]);
    expect(disclaimersForTopics([])).toEqual([]);
  });

  it("falls back to one generic line for non-canonical domains", () => {
    expect(disclaimersForTopics(["health", "financial", "tax"])).toEqual([
      HEALTH_DISCLAIMER,
      GENERIC_DISCLAIMER,
    ]);
  });
});
