import { getCapabilityForExtension } from '@calypso/chat-types';

import { parseGoogleStub } from './google-stub';
import { extractIWorkPreviewText } from './iwork-extractor';
import { extractDocxPlainText } from './ooxml-validator';
import { extractPdfPlainText } from './pdf-extractor';
import {
  capExtractedText,
  extractRtfPlainText,
  type ExtractedText,
} from './rtf-extractor';

export type ContentKind =
  | 'text'
  | 'document'
  | 'apple-iwork'
  | 'google-stub'
  | 'image'
  | 'audio'
  | 'video';

export type ExtractionStatus =
  | 'ok'
  | 'metadata_only'
  | 'requires_google_export'
  | 'unsupported';

export interface FileContentExtraction {
  contentKind: ContentKind;
  extractionStatus: ExtractionStatus;
  text?: string;
  textTruncated?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export async function extractFileContent(input: {
  filename: string;
  bytes: Uint8Array;
}): Promise<FileContentExtraction> {
  const extension = extensionOf(input.filename);
  const capability = extension ? getCapabilityForExtension(extension) : null;
  switch (capability?.id) {
    case 'text':
      return textExtraction(input.bytes);
    case 'office-document':
      return docxExtraction(input.bytes);
    case 'pdf':
      return documentExtraction(await extractPdfPlainText(input.bytes));
    case 'rtf':
      return documentExtraction(extractRtfPlainText(input.bytes));
    case 'apple-iwork':
      return iWorkExtraction(input.bytes);
    case 'google-stub':
      return googleStubExtraction(input.filename, input.bytes);
    case 'image':
      return { contentKind: 'image', extractionStatus: 'metadata_only' };
    case 'audio':
      return { contentKind: 'audio', extractionStatus: 'metadata_only' };
    case 'video':
      return { contentKind: 'video', extractionStatus: 'metadata_only' };
    default:
      return { contentKind: 'text', extractionStatus: 'unsupported' };
  }
}

function googleStubExtraction(
  filename: string,
  bytes: Uint8Array,
): FileContentExtraction {
  try {
    return {
      contentKind: 'google-stub',
      extractionStatus: 'requires_google_export',
      metadata: parseGoogleStub(filename, bytes),
    };
  } catch {
    return { contentKind: 'google-stub', extractionStatus: 'metadata_only' };
  }
}

function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  return filename.slice(dot).toLowerCase();
}

function textExtraction(bytes: Uint8Array): FileContentExtraction {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const extracted = capExtractedText(text);
  return {
    contentKind: 'text',
    extractionStatus: extracted.text.length > 0 ? 'ok' : 'metadata_only',
    ...(extracted.text.length > 0
      ? { text: extracted.text, textTruncated: extracted.truncated }
      : {}),
  };
}

function docxExtraction(bytes: Uint8Array): FileContentExtraction {
  const extracted = extractDocxPlainText(bytes);
  if (!extracted.ok || extracted.text.length === 0) {
    return { contentKind: 'document', extractionStatus: 'metadata_only' };
  }
  return {
    contentKind: 'document',
    extractionStatus: 'ok',
    text: extracted.text,
    textTruncated: extracted.truncated,
  };
}

function documentExtraction(
  extracted: ExtractedText | null,
): FileContentExtraction {
  if (!extracted || extracted.text.length === 0) {
    return { contentKind: 'document', extractionStatus: 'metadata_only' };
  }
  return {
    contentKind: 'document',
    extractionStatus: 'ok',
    text: extracted.text,
    textTruncated: extracted.truncated,
  };
}

async function iWorkExtraction(
  bytes: Uint8Array,
): Promise<FileContentExtraction> {
  const extracted = await extractIWorkPreviewText(bytes);
  if (!extracted || extracted.text.length === 0) {
    return { contentKind: 'apple-iwork', extractionStatus: 'metadata_only' };
  }
  return {
    contentKind: 'apple-iwork',
    extractionStatus: 'ok',
    text: extracted.text,
    textTruncated: extracted.truncated,
  };
}
