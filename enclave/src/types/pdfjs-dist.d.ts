declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface PdfJsLoadingTask {
    promise: Promise<unknown>;
    destroy?: () => Promise<void> | void;
  }

  export function getDocument(params: Record<string, unknown>): PdfJsLoadingTask;
}
