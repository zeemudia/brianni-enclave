import { describe, it, expect } from "vitest";

import { extractRtfPlainText } from "../tools/rtf-extractor";

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("extractRtfPlainText unicode handling", () => {
  it("decodes a valid \\u escape correctly", () => {
    const result = extractRtfPlainText(utf8("{\\rtf1\\ansi caf\\u233 e}"));
    expect(result).not.toBeNull();
    // \u233 -> é
    expect(result?.text).toContain("café");
  });

  it("does not throw on an out-of-range \\u code point (> 0x10FFFF)", () => {
    expect(() =>
      extractRtfPlainText(utf8("{\\rtf1\\ansi A\\u99999999 B}")),
    ).not.toThrow();
    const result = extractRtfPlainText(utf8("{\\rtf1\\ansi A\\u99999999 B}"));
    expect(result).not.toBeNull();
    // Surrounding text must still survive the bad escape.
    expect(result?.text).toContain("A");
    expect(result?.text).toContain("B");
  });

  it("does not throw on a large-negative \\u code point (0x10000 + n < 0)", () => {
    expect(() =>
      extractRtfPlainText(utf8("{\\rtf1\\ansi A\\u-9999999 B}")),
    ).not.toThrow();
    const result = extractRtfPlainText(utf8("{\\rtf1\\ansi A\\u-9999999 B}"));
    expect(result).not.toBeNull();
    expect(result?.text).toContain("A");
    expect(result?.text).toContain("B");
  });

  it("does not throw on a lone-surrogate \\u code point (0xD800-0xDFFF)", () => {
    // 55296 == 0xD800, a lone high surrogate -> not a valid scalar value.
    expect(() =>
      extractRtfPlainText(utf8("{\\rtf1\\ansi A\\u55296 B}")),
    ).not.toThrow();
    const result = extractRtfPlainText(utf8("{\\rtf1\\ansi A\\u55296 B}"));
    expect(result).not.toBeNull();
    expect(result?.text).toContain("A");
    expect(result?.text).toContain("B");
  });

  it("still extracts plain text from a normal RTF document", () => {
    const result = extractRtfPlainText(utf8("{\\rtf1\\ansi Hello\\par World}"));
    expect(result?.text).toBe("Hello\nWorld");
  });
});
