import { z } from "zod";

import { ToolNameSchema } from "./skill-pack";

const InvocationIdSchema = z.string().min(1).max(64);
const AgentTurnIdSchema = z.string().min(1).max(64);

export const ToolResultOutcomeSchema = z.enum([
  "ok",
  "denied_by_user",
  "gateway_rejected",
  "error",
]);
export type ToolResultOutcome = z.infer<typeof ToolResultOutcomeSchema>;

export const ToolInvocationFrameSchema = z.object({
  invocationId: InvocationIdSchema,
  agentTurnId: AgentTurnIdSchema,
  toolName: ToolNameSchema,
  args: z.record(z.string(), z.unknown()),
});
export type ToolInvocationFrame = z.infer<typeof ToolInvocationFrameSchema>;

export const ToolResultFrameSchema = z.object({
  invocationId: InvocationIdSchema,
  outcome: ToolResultOutcomeSchema,
  resultB64: z.string().optional(),
  resultJson: z.unknown().optional(),
  reason: z.string().max(256).optional(),
});
export type ToolResultFrame = z.infer<typeof ToolResultFrameSchema>;

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
// A binary work item always carries at least one byte: chunk frames require
// `chunkB64.min(1)` + `chunkCount.min(1)`, and no media artefact (image/
// audio/video/document/pdf) is meaningfully zero-length. `.min(1)` makes the
// "Positive" name truthful and rejects empty items.
const PositiveByteLengthSchema = z.number().int().min(1);

export const BinaryWorkItemToolNameSchema = z.enum([
  "image.inspect",
  "image.ocr",
  "image.transform",
  // Generated-image outputs (text→image and image→image edit). These produce
  // a binary image artefact delivered over the same write_request/chunk frames
  // as image.transform; the client routes the bytes by outputId, so the name is
  // a telemetry/label distinction only.
  "image.generate",
  "image.edit",
  "audio.inspect",
  "audio.transcribe",
  "audio.transform",
  "video.inspect",
  "video.transcribe",
  "video.transform",
  // Generated-video outputs (text→video). Produces a binary video artefact
  // delivered over the same write_request/chunk frames as video.transform; the
  // client routes the bytes by outputId, so the name is a telemetry/label only.
  "video.generate",
  "document.edit",
  "pdf.edit",
]);
export type BinaryWorkItemToolName = z.infer<
  typeof BinaryWorkItemToolNameSchema
>;

export const BinaryWorkItemDirectionSchema = z.enum(["source", "output"]);
export type BinaryWorkItemDirection = z.infer<
  typeof BinaryWorkItemDirectionSchema
>;

/**
 * Client-only binary chunk frame. These frames are encrypted under the
 * session key and are never converted into model-visible tool results.
 */
export const BinaryWorkItemChunkFrameSchema = z.object({
  kind: z.literal("binary_work_item.chunk"),
  direction: BinaryWorkItemDirectionSchema,
  agentTurnId: AgentTurnIdSchema,
  invocationId: InvocationIdSchema,
  toolName: BinaryWorkItemToolNameSchema,
  operationId: z.string().min(1).max(128),
  itemId: z.string().min(1).max(128),
  path: z.string().min(1).max(1024),
  sha256Hex: Sha256HexSchema,
  byteLength: PositiveByteLengthSchema,
  chunkIndex: z.number().int().nonnegative(),
  chunkTotal: z.number().int().min(1).max(10_000),
  chunkB64: z.string().min(1),
});
export type BinaryWorkItemChunkFrame = z.infer<
  typeof BinaryWorkItemChunkFrameSchema
>;

export const BinaryWorkItemWriteRequestFrameSchema = z.object({
  kind: z.literal("binary_work_item.write_request"),
  agentTurnId: AgentTurnIdSchema,
  invocationId: InvocationIdSchema,
  toolName: BinaryWorkItemToolNameSchema,
  operationId: z.string().min(1).max(128),
  outputId: z.string().min(1).max(128),
  outputPath: z.string().min(1).max(1024),
  sha256Hex: Sha256HexSchema,
  byteLength: PositiveByteLengthSchema,
  chunkCount: z.number().int().min(1).max(10_000),
});
export type BinaryWorkItemWriteRequestFrame = z.infer<
  typeof BinaryWorkItemWriteRequestFrameSchema
>;

export const BinaryWorkItemWriteAckFrameSchema = z.object({
  kind: z.literal("binary_work_item.write_ack"),
  agentTurnId: AgentTurnIdSchema,
  invocationId: InvocationIdSchema,
  operationId: z.string().min(1).max(128),
  outputId: z.string().min(1).max(128),
  outputPath: z.string().min(1).max(1024),
  sha256Hex: Sha256HexSchema,
  byteLength: PositiveByteLengthSchema,
  outcome: z.enum(["ok", "denied_by_user", "error"]),
  reason: z.string().max(256).optional(),
});
export type BinaryWorkItemWriteAckFrame = z.infer<
  typeof BinaryWorkItemWriteAckFrameSchema
>;

/**
 * Sentinel toolName recorded when the streaming parser rejects a
 * fence before any real tool was invoked (Tier C/D attempt, unknown
 * tool name, malformed JSON, missing required fields, unclosed fence).
 * The Activity panel renders this as "rejected attempt" rather than
 * pretending a real tool was called.
 *
 * Kept distinct from Tier A/B `ToolName` so static analysis still
 * proves no Tier-C name reaches `ToolInvocationFrameSchema`.
 */
export const PARSER_REJECTION_TOOL_NAME = "<parser-rejection>" as const;
export type ParserRejectionToolName = typeof PARSER_REJECTION_TOOL_NAME;

export const LedgerToolNameSchema = z.union([
  ToolNameSchema,
  z.literal(PARSER_REJECTION_TOOL_NAME),
]);
export type LedgerToolName = z.infer<typeof LedgerToolNameSchema>;

export const ToolCallLedgerEntrySchema = z.object({
  id: z.number().int().nonnegative(),
  invokedAt: z.iso.datetime(),
  toolName: LedgerToolNameSchema,
  scope: z.string().max(256),
  approvedPath: z.string().nullable(),
  outcome: ToolResultOutcomeSchema,
  reason: z.string().nullable(),
  skillPackId: z.string(),
  turnId: z.string(),
});
export type ToolCallLedgerEntry = z.infer<typeof ToolCallLedgerEntrySchema>;
