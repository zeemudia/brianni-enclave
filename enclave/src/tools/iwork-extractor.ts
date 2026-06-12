import { inflateZipMember } from './ooxml-validator';
import { extractPdfPlainText } from './pdf-extractor';
import type { ExtractedText } from './rtf-extractor';

export async function extractIWorkPreviewText(
  bytes: Uint8Array,
): Promise<ExtractedText | null> {
  const previewPdf = inflateZipMember(bytes, 'QuickLook/Preview.pdf');
  if (!previewPdf) return null;
  return extractPdfPlainText(previewPdf);
}
