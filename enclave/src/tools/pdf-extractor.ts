import { capExtractedText, type ExtractedText } from './rtf-extractor';

const MAX_PDF_TEXT_PAGES = 200;
const PDF_EXTRACTION_TIMEOUT_MS = 10_000;

interface PdfTextItem {
  str?: unknown;
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy?: () => Promise<void> | void;
}

interface PdfJsLike {
  getDocument(params: Record<string, unknown>): PdfLoadingTaskLike;
}

export async function extractPdfPlainText(
  bytes: Uint8Array,
): Promise<ExtractedText | null> {
  return extractPdfPlainTextWithTimeout(bytes, PDF_EXTRACTION_TIMEOUT_MS);
}

async function extractPdfPlainTextWithTimeout(
  bytes: Uint8Array,
  timeoutMs: number,
): Promise<ExtractedText | null> {
  let loadingTask: PdfLoadingTaskLike | undefined;
  let doc: PdfDocumentLike | undefined;
  let destroyed = false;
  const destroyOnce = async () => {
    if (destroyed) return;
    destroyed = true;
    if (doc) {
      await doc.destroy();
      return;
    }
    await loadingTask?.destroy?.();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      void destroyOnce();
      resolve(null);
    }, timeoutMs);
  });
  const extraction = (async () => {
    try {
      const pdfjs = (await import(
        'pdfjs-dist/legacy/build/pdf.mjs'
      )) as PdfJsLike;
      loadingTask = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        disableWorker: true,
        isEvalSupported: false,
        useSystemFonts: false,
      });
      doc = await loadingTask.promise;
      if (destroyed) {
        await doc.destroy();
        return null;
      }
      const pages: string[] = [];
      const pageCount = Math.min(
        Number.isFinite(doc.numPages) ? doc.numPages : 0,
        MAX_PDF_TEXT_PAGES,
      );
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => (typeof item.str === 'string' ? item.str : ''))
          .filter(Boolean)
          .join(' ')
          .trim();
        if (pageText.length > 0) pages.push(pageText);
      }
      if (pages.length === 0) return null;
      return capExtractedText(pages.join('\n'));
    } catch {
      return null;
    } finally {
      await destroyOnce();
    }
  })();

  try {
    return await Promise.race([extraction, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
