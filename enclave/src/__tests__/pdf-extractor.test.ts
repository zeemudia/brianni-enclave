import { beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();
const getPage = vi.fn();
const destroy = vi.fn();

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument,
}));

describe("extractPdfPlainText", () => {
  beforeEach(() => {
    getDocument.mockReset();
    getPage.mockReset();
    destroy.mockReset();
  });

  it("disables pdfjs workers/eval and caps page iteration", async () => {
    getPage.mockResolvedValue({
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: "page text" }],
      }),
    });
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 250,
        getPage,
        destroy,
      }),
    });
    const { extractPdfPlainText } = await import("../tools/pdf-extractor");

    const result = await extractPdfPlainText(new Uint8Array([1, 2, 3]));

    expect(result?.text).toContain("page text");
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        disableWorker: true,
        isEvalSupported: false,
        useSystemFonts: false,
      }),
    );
    expect(getPage).toHaveBeenCalledTimes(200);
    expect(getPage).toHaveBeenLastCalledWith(200);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
