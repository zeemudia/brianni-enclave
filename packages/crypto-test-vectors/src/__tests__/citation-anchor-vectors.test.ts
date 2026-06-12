import { describe, expect, it } from "vitest";
import {
  CITATION_ANCHOR_HMAC_INFO,
  CITATION_ANCHOR_HMAC_SALT,
  CITATION_ANCHOR_KEY_LENGTH,
  CITATION_ANCHOR_VECTORS,
} from "../citation-anchor-vectors";

describe("citation anchor vectors", () => {
  it("pin the approved HKDF parameters and rejection cases", () => {
    expect(CITATION_ANCHOR_HMAC_SALT).toBe(
      "brianni:citation-anchor-hmac:salt:v1",
    );
    expect(CITATION_ANCHOR_HMAC_INFO).toBe("brianni:citation-anchor-hmac:v1");
    expect(CITATION_ANCHOR_KEY_LENGTH).toBe(32);
    expect(CITATION_ANCHOR_VECTORS.map((v) => v.name)).toEqual([
      "ascii-span",
      "astral-plane-valid-span",
      "surrogate-splitting-boundary-rejected",
      "lone-surrogate-in-range-rejected",
    ]);
  });
});
