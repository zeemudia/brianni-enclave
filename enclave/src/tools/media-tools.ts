import { resolve } from 'node:path';

import { z } from 'zod';

import { PythonJsonlSidecar } from './python-jsonl-sidecar';

const MediaOperationSchema = z.enum([
  'image.inspect',
  'image.ocr',
  'image.transform',
  'audio.inspect',
  'audio.transcribe',
  'audio.transform',
  'video.inspect',
  'video.transcribe',
  'video.transform',
  'document.docx_transform',
  'document.pdf_transform',
]);

const MAX_IMAGE_RESIZE_BOUND = 8192;

const ImageTransformSchema = z.object({
  kind: z.literal('resize'),
  maxWidth: z.number().int().min(1).max(MAX_IMAGE_RESIZE_BOUND).optional(),
  maxHeight: z.number().int().min(1).max(MAX_IMAGE_RESIZE_BOUND).optional(),
  format: z.enum(['png', 'jpeg', 'webp']).default('png'),
}).superRefine((value, ctx) => {
  if (value.maxWidth === undefined && value.maxHeight === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'image resize requires maxWidth or maxHeight',
      path: ['maxWidth'],
    });
  }
}).transform((value) => ({
  ...value,
  maxWidth: value.maxWidth ?? MAX_IMAGE_RESIZE_BOUND,
  maxHeight: value.maxHeight ?? MAX_IMAGE_RESIZE_BOUND,
}));

const AudioTransformSchema = z.union([
  z.object({
    kind: z.literal('convert'),
    format: z.enum(['wav', 'mp3', 'm4a', 'ogg', 'flac']),
  }),
  z.object({
    kind: z.literal('extract_clip'),
    startSeconds: z.number().min(0),
    durationSeconds: z.number().min(0.1).max(60 * 60),
    format: z.enum(['wav', 'mp3', 'm4a']).default('wav'),
  }),
]);

const VideoTransformSchema = z.union([
  z.object({
    kind: z.literal('resize'),
    maxWidth: z.number().int().min(16).max(8192),
    maxHeight: z.number().int().min(16).max(8192),
    format: z.enum(['mp4', 'webm']).default('mp4'),
  }),
  z.object({
    kind: z.literal('extract_audio'),
    format: z.enum(['wav', 'mp3', 'm4a']).default('wav'),
  }),
]);

const DocxTransformSchema = z.union([
  z.object({
    kind: z.literal('replace_text'),
    search: z.string().min(1).max(4096),
    replacement: z.string().max(4096),
    maxReplacements: z.number().int().min(1).max(100),
  }),
  z.object({
    kind: z.literal('append_section'),
    heading: z.string().min(1).max(512),
    body: z.string().min(1).max(16_384),
  }),
]);

const PdfTransformSchema = z.union([
  z.object({
    kind: z.literal('annotate'),
    page: z
      .number()
      .int()
      .min(0)
      .describe('0-indexed page number; the FIRST page is 0 (not 1)'),
    text: z.string().min(1).max(2048),
    x: z.number().min(0),
    y: z.number().min(0),
  }),
  z.object({
    kind: z.literal('redact_text'),
    search: z.string().min(1).max(1024),
    maxReplacements: z.number().int().min(1).max(100),
  }),
  z.object({
    kind: z.literal('extract_pages'),
    pages: z
      .array(z.number().int().min(0))
      .min(1)
      .max(100)
      .describe('0-indexed page numbers; the FIRST page is 0 (not 1)'),
  }),
  z.object({
    kind: z.literal('compress'),
  }),
]);

export const MediaToolRequestSchema = z.object({
  operation: MediaOperationSchema,
  filename: z.string().min(1).max(512),
  inputB64: z.string().min(1),
  transform: z
    .union([
      ImageTransformSchema,
      AudioTransformSchema,
      VideoTransformSchema,
      DocxTransformSchema,
      PdfTransformSchema,
    ])
    .optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
export type MediaToolRequest = z.infer<typeof MediaToolRequestSchema>;

export const MediaToolResultSchema = z.object({
  contentKind: z.enum(['image', 'audio', 'video', 'document', 'pdf']),
  extractionStatus: z.enum(['ok', 'metadata_only', 'unsupported']).default('ok'),
  text: z.string().optional(),
  textTruncated: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  outputB64: z.string().optional(),
  outputMimeType: z.string().optional(),
  outputExtension: z.string().optional(),
  outputSha256Hex: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type MediaToolResult = z.infer<typeof MediaToolResultSchema>;

export class MediaToolsClient {
  private readonly sidecar: PythonJsonlSidecar<MediaToolRequest, MediaToolResult>;

  constructor(opts: { scriptPath?: string; timeoutMs?: number } = {}) {
    this.sidecar = new PythonJsonlSidecar<MediaToolRequest, MediaToolResult>({
      scriptPath:
        opts.scriptPath ??
        resolve(import.meta.dirname ?? __dirname, 'media_tools_service.py'),
      readyLine: 'MEDIA_TOOLS_READY',
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
  }

  start(): Promise<void> {
    return this.sidecar.start();
  }

  stop(): void {
    this.sidecar.stop();
  }

  isReady(): boolean {
    return this.sidecar.isReady();
  }

  async run(request: MediaToolRequest): Promise<MediaToolResult> {
    const parsed = MediaToolRequestSchema.parse(request);
    const result = await this.sidecar.request(parsed);
    return MediaToolResultSchema.parse(result);
  }
}
