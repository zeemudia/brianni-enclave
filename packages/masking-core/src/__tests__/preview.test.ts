import { describe, it, expect } from "vitest";
import { buildMaskPreview } from "../preview";

describe("buildMaskPreview — interactive outbound preview model", () => {
  it("emits plain text around a masked identifier", () => {
    const { segments, maskedCount, keptCount } = buildMaskPreview(
      "Email me at a@b.com please",
      new Set(),
    );
    expect(segments).toEqual([
      { kind: "plain", text: "Email me at " },
      { kind: "masked", token: "[EMAIL_1]", original: "a@b.com" },
      { kind: "plain", text: " please" },
    ]);
    expect(maskedCount).toBe(1);
    expect(keptCount).toBe(0);
  });

  it("renders a dismissed identifier as 'kept' (shown in the clear) not masked", () => {
    const { segments, maskedCount, keptCount } = buildMaskPreview(
      "Email me at a@b.com please",
      new Set(["a@b.com"]),
    );
    expect(segments).toEqual([
      { kind: "plain", text: "Email me at " },
      { kind: "kept", original: "a@b.com" },
      { kind: "plain", text: " please" },
    ]);
    expect(maskedCount).toBe(0);
    expect(keptCount).toBe(1);
  });

  it("returns no entity segments when there is no PII", () => {
    const { segments, maskedCount, keptCount } = buildMaskPreview(
      "the weather is nice today",
      new Set(),
    );
    expect(segments).toEqual([{ kind: "plain", text: "the weather is nice today" }]);
    expect(maskedCount).toBe(0);
    expect(keptCount).toBe(0);
  });

  it("handles multiple identifiers with mixed keep-visible decisions", () => {
    const text = "ping a@b.com and call +44 7700 900123 now";
    const { maskedCount, keptCount, segments } = buildMaskPreview(
      text,
      new Set(["a@b.com"]),
    );
    // email kept-visible, phone masked
    expect(maskedCount).toBe(1);
    expect(keptCount).toBe(1);
    expect(segments.some((s) => s.kind === "kept" && s.original === "a@b.com")).toBe(true);
    expect(
      segments.some((s) => s.kind === "masked" && s.original === "+44 7700 900123"),
    ).toBe(true);
  });

  it("is reconstructible: joining display text round-trips to the masked output, joining originals round-trips to the source", () => {
    const text = "Email me at a@b.com please";
    const { segments } = buildMaskPreview(text, new Set());
    const display = segments
      .map((s) =>
        s.kind === "plain" ? s.text : s.kind === "masked" ? s.token : s.original,
      )
      .join("");
    const original = segments
      .map((s) => (s.kind === "plain" ? s.text : s.original))
      .join("");
    expect(display).toBe("Email me at [EMAIL_1] please");
    expect(original).toBe(text);
  });
});
