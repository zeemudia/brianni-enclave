import { describe, expect, it } from "vitest";
import {
  GENERIC_DISCLAIMER,
  REGULATED_DISCLAIMERS,
  disclaimerLinesForTopics,
} from "../index";

describe("disclaimerLinesForTopics", () => {
  it("maps a canonical topic to its reviewed line", () => {
    expect(disclaimerLinesForTopics(["health"])).toEqual([
      REGULATED_DISCLAIMERS.health,
    ]);
  });

  it("orders canonical topics deterministically (health before legal)", () => {
    expect(disclaimerLinesForTopics(["legal", "health"])).toEqual([
      REGULATED_DISCLAIMERS.health,
      REGULATED_DISCLAIMERS.legal,
    ]);
  });

  it("collapses non-canonical domains to a single generic line", () => {
    expect(disclaimerLinesForTopics(["financial", "tax"])).toEqual([
      GENERIC_DISCLAIMER,
    ]);
  });

  it("combines canonical lines with one generic fallback", () => {
    expect(disclaimerLinesForTopics(["legal", "financial"])).toEqual([
      REGULATED_DISCLAIMERS.legal,
      GENERIC_DISCLAIMER,
    ]);
  });

  it("normalises casing/whitespace and dedupes", () => {
    expect(disclaimerLinesForTopics([" Health ", "HEALTH"])).toEqual([
      REGULATED_DISCLAIMERS.health,
    ]);
  });

  it("ignores `none` and empty slugs", () => {
    expect(disclaimerLinesForTopics(["none", "", "  "])).toEqual([]);
  });
});
