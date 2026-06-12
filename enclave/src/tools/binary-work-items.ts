import { createHash } from 'node:crypto';

import type {
  BinaryWorkItemToolName,
  BinaryWorkItemWriteAckFrame,
  BinaryWorkItemWriteRequestFrame,
} from '@calypso/chat-types';

import { zeroBuffer } from '../crypto';

export const DEFAULT_BINARY_WORK_ITEM_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_BINARY_WORK_ITEM_SWEEP_INTERVAL_MS = 30_000;
export const DEFAULT_BINARY_WORK_ITEM_PER_CHUNK_CAP = 256 * 1024;
export const DEFAULT_BINARY_WORK_ITEM_TOTAL_CAP = 5 * 1024 * 1024;

// Default size of an OUTPUT chunk (enclave→client artifact, e.g. an audio clip
// or resized image the client writes to a linked folder). It must be small
// enough that ONE chunk, once base64-encoded (chunkB64, ×4/3) and wrapped in the
// ~2 KB JSON chunk-frame envelope, fits inside a single encrypted, padded SSE
// response frame — capped at MAX_PADDED_PAYLOAD = 262140 bytes
// (packages/chat-types/src/padding.ts). The previous 256 KB raw default produced
// a ~349 KB framed chunk that overflowed the cap with
// "padded response chunk exceeds maximum frame (262140 bytes)" — live Defect D3
// (A13 10s WAV ≈ 860 KB failed; it surfaced as ORCHESTRATOR_WORKER_ERROR_RETRY
// because the worker loop caught the deterministic frame error and retried).
// 128 KB raw → ~175 KB framed, ~85 KB under the cap. The RECEIVER caps
// (DEFAULT_BINARY_WORK_ITEM_PER_CHUNK_CAP here, BINARY_WORK_ITEM_MAX_CHUNK_BYTES
// in the web/mobile fulfillers) stay at 256 KB, so this only shrinks what the
// enclave EMITS — large source uploads (client→enclave) are unaffected.
export const FRAME_SAFE_OUTPUT_CHUNK_BYTES = 128 * 1024;

// Split a binary-write payload into ordered WIRE FRAMES: one write_request
// (metadata only — folderId/displayName/request, NO chunks) followed by one
// frame per output chunk. Each chunk is already sized (FRAME_SAFE_OUTPUT_CHUNK_BYTES)
// so its serialized frame fits a single padded SSE response frame
// (MAX_PADDED_PAYLOAD). Emitting them as SEPARATE frames is the real D3 fix:
// the old emitter JSON.stringify'd the WHOLE payload (incl. every chunk) into
// ONE frame, so a >~256 KB artifact (e.g. an 860 KB WAV) always overflowed the
// cap regardless of per-chunk size. Clients reassemble the chunk frames by
// request.outputId until request.chunkCount is reached.
export function buildBinaryWriteWireFrames(
  payload: { chunks?: readonly unknown[] } & Record<string, unknown>,
  orchestrator?: unknown,
): Record<string, unknown>[] {
  const { chunks, ...writeMeta } = payload;
  const orch = orchestrator !== undefined ? { orchestrator } : {};
  const frames: Record<string, unknown>[] = [
    { _type: 'binary_work_item.write_request', ...writeMeta, ...orch },
  ];
  for (const chunk of chunks ?? []) {
    frames.push({
      _type: 'binary_work_item.chunk',
      ...(chunk as Record<string, unknown>),
      ...orch,
    });
  }
  return frames;
}

export interface BinaryWorkItemChunkInput {
  sessionId: string;
  agentTurnId: string;
  invocationId: string;
  toolName: BinaryWorkItemToolName;
  operationId: string;
  itemId: string;
  path: string;
  sha256Hex: string;
  byteLength: number;
  chunkIndex: number;
  chunkTotal: number;
  chunkB64: string;
  direction: 'source' | 'output';
}

export type BinaryWorkItemAddChunkResult =
  | { status: 'pending'; accepted?: boolean }
  | {
      status: 'complete';
      workItemId: string;
      path: string;
      byteLength: number;
      sha256Hex: string;
    }
  | {
      status: 'rejected';
      errorCode:
        | 'BINARY_WORK_ITEM_INVALID'
        | 'BINARY_WORK_ITEM_CHUNK_TOO_LARGE'
        | 'BINARY_WORK_ITEM_TOO_LARGE'
        | 'BINARY_WORK_ITEM_REPLAY_MISMATCH'
        | 'BINARY_WORK_ITEM_SHA_MISMATCH';
      message: string;
    };

export interface BinaryOutputWriteRequestInput {
  sessionId: string;
  agentTurnId: string;
  invocationId: string;
  toolName: BinaryWorkItemToolName;
  operationId: string;
  outputId: string;
  outputPath: string;
  outputBytes: Buffer | Uint8Array;
  outputChunkSize?: number;
}

export interface BinaryOutputChunk {
  kind: 'binary_work_item.chunk';
  direction: 'output';
  agentTurnId: string;
  invocationId: string;
  toolName: BinaryWorkItemToolName;
  operationId: string;
  itemId: string;
  path: string;
  sha256Hex: string;
  byteLength: number;
  chunkIndex: number;
  chunkTotal: number;
  chunkB64: string;
}

export interface BinaryOutputAwaitingStatus {
  status: 'awaiting_client_write';
  writeState: 'pending_client_confirmation';
  userConfirmationRequired: true;
  modelInstruction: string;
  outputId: string;
  outputPath: string;
  byteLength: number;
  sha256Hex: string;
}

export interface BinaryOutputCommittedStatus {
  status: 'committed';
  outputId: string;
  outputPath: string;
  byteLength: number;
  sha256Hex: string;
}

export type BinaryOutputStatus =
  | BinaryOutputAwaitingStatus
  | BinaryOutputCommittedStatus
  | { status: 'missing'; outputId: string };

export type BinarySourceStatus =
  | {
      status: 'ready';
      itemId: string;
      path: string;
      byteLength: number;
      sha256Hex: string;
    }
  | { status: 'missing'; itemId: string };

export type BinaryOutputAckResult =
  | { status: 'acknowledged' }
  | {
      status: 'rejected';
      errorCode:
        | 'BINARY_WORK_ITEM_OUTPUT_MISSING'
        | 'BINARY_WORK_ITEM_ACK_DENIED'
        | 'BINARY_WORK_ITEM_ACK_MISMATCH';
      message: string;
    };

interface ChunkEntry {
  sessionId: string;
  agentTurnId: string;
  invocationId: string;
  toolName: BinaryWorkItemToolName;
  operationId: string;
  itemId: string;
  path: string;
  sha256Hex: string;
  byteLength: number;
  chunkTotal: number;
  chunks: Map<number, Buffer>;
  receivedBytes: number;
  lastTouched: number;
}

interface CompletedSource {
  sessionId: string;
  agentTurnId: string;
  invocationId: string;
  toolName: BinaryWorkItemToolName;
  operationId: string;
  itemId: string;
  path: string;
  sha256Hex: string;
  byteLength: number;
  bytes: Buffer;
  lastTouched: number;
}

interface PendingOutput {
  sessionId: string;
  agentTurnId: string;
  invocationId: string;
  toolName: BinaryWorkItemToolName;
  operationId: string;
  outputId: string;
  outputPath: string;
  sha256Hex: string;
  byteLength: number;
  bytes: Buffer;
  committed: boolean;
  lastTouched: number;
}

export class BinaryWorkItemManager {
  private readonly perChunkByteCap: number;
  private readonly totalByteCap: number;
  private readonly ttlMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;
  private readonly chunkEntries = new Map<string, ChunkEntry>();
  private readonly sources = new Map<string, CompletedSource>();
  private readonly outputs = new Map<string, PendingOutput>();

  constructor(opts: {
    perChunkByteCap?: number;
    totalByteCap?: number;
    ttlMs?: number;
    sweepIntervalMs?: number | null;
  } = {}) {
    this.perChunkByteCap =
      opts.perChunkByteCap ?? DEFAULT_BINARY_WORK_ITEM_PER_CHUNK_CAP;
    this.totalByteCap = opts.totalByteCap ?? DEFAULT_BINARY_WORK_ITEM_TOTAL_CAP;
    this.ttlMs = opts.ttlMs ?? DEFAULT_BINARY_WORK_ITEM_TTL_MS;
    const sweepInterval =
      opts.sweepIntervalMs === undefined
        ? DEFAULT_BINARY_WORK_ITEM_SWEEP_INTERVAL_MS
        : opts.sweepIntervalMs;
    this.sweepTimer =
      sweepInterval === null
        ? null
        : setInterval(() => this.sweep(), sweepInterval);
    this.sweepTimer?.unref();
  }

  addChunk(input: BinaryWorkItemChunkInput): BinaryWorkItemAddChunkResult {
    const validation = validateChunkInput(input);
    if (validation) return validation;
    const bytes = Buffer.from(input.chunkB64, 'base64');
    if (bytes.byteLength > this.perChunkByteCap) {
      zeroBuffer(bytes);
      return rejected(
        'BINARY_WORK_ITEM_CHUNK_TOO_LARGE',
        `chunk exceeds ${this.perChunkByteCap} bytes`,
      );
    }
    if (input.byteLength > this.totalByteCap) {
      zeroBuffer(bytes);
      return rejected(
        'BINARY_WORK_ITEM_TOO_LARGE',
        `work item exceeds ${this.totalByteCap} bytes`,
      );
    }

    const key = chunkKey(input);
    let entry = this.chunkEntries.get(key);
    if (!entry) {
      entry = {
        sessionId: input.sessionId,
        agentTurnId: input.agentTurnId,
        invocationId: input.invocationId,
        toolName: input.toolName,
        operationId: input.operationId,
        itemId: input.itemId,
        path: input.path,
        sha256Hex: input.sha256Hex,
        byteLength: input.byteLength,
        chunkTotal: input.chunkTotal,
        chunks: new Map(),
        receivedBytes: 0,
        lastTouched: Date.now(),
      };
      this.chunkEntries.set(key, entry);
    }

    const mismatch =
      entry.agentTurnId !== input.agentTurnId ||
      entry.invocationId !== input.invocationId ||
      entry.toolName !== input.toolName ||
      entry.operationId !== input.operationId ||
      entry.path !== input.path ||
      entry.sha256Hex !== input.sha256Hex ||
      entry.byteLength !== input.byteLength ||
      entry.chunkTotal !== input.chunkTotal;
    if (mismatch) {
      zeroBuffer(bytes);
      zeroEntry(entry);
      this.chunkEntries.delete(key);
      return rejected(
        'BINARY_WORK_ITEM_INVALID',
        'chunk metadata changed within work item',
      );
    }

    const existing = entry.chunks.get(input.chunkIndex);
    if (existing) {
      zeroBuffer(bytes);
      if (existing.equals(Buffer.from(input.chunkB64, 'base64'))) {
        return { status: 'pending', accepted: false };
      }
      zeroEntry(entry);
      this.chunkEntries.delete(key);
      return rejected(
        'BINARY_WORK_ITEM_REPLAY_MISMATCH',
        'replayed chunk bytes differ',
      );
    }

    const projected = entry.receivedBytes + bytes.byteLength;
    if (projected > this.totalByteCap || projected > input.byteLength) {
      zeroBuffer(bytes);
      zeroEntry(entry);
      this.chunkEntries.delete(key);
      return rejected(
        'BINARY_WORK_ITEM_TOO_LARGE',
        'received bytes exceed declared or configured length',
      );
    }

    entry.chunks.set(input.chunkIndex, bytes);
    entry.receivedBytes = projected;
    entry.lastTouched = Date.now();

    if (entry.chunks.size !== entry.chunkTotal) {
      return { status: 'pending' };
    }

    const ordered: Buffer[] = [];
    for (let i = 0; i < entry.chunkTotal; i += 1) {
      const chunk = entry.chunks.get(i);
      if (!chunk) {
        zeroEntry(entry);
        this.chunkEntries.delete(key);
        return rejected('BINARY_WORK_ITEM_INVALID', `missing chunk ${i}`);
      }
      ordered.push(chunk);
    }
    const assembled = Buffer.concat(ordered);
    zeroEntry(entry);
    this.chunkEntries.delete(key);

    const actualSha = sha256Hex(assembled);
    if (assembled.byteLength !== entry.byteLength || actualSha !== entry.sha256Hex) {
      zeroBuffer(assembled);
      return rejected(
        'BINARY_WORK_ITEM_SHA_MISMATCH',
        'assembled bytes do not match declared length or sha256',
      );
    }

    const source: CompletedSource = {
      sessionId: entry.sessionId,
      agentTurnId: entry.agentTurnId,
      invocationId: entry.invocationId,
      toolName: entry.toolName,
      operationId: entry.operationId,
      itemId: entry.itemId,
      path: entry.path,
      sha256Hex: actualSha,
      byteLength: assembled.byteLength,
      bytes: assembled,
      lastTouched: Date.now(),
    };
    this.sources.set(entry.itemId, source);
    return {
      status: 'complete',
      workItemId: entry.itemId,
      path: entry.path,
      byteLength: assembled.byteLength,
      sha256Hex: actualSha,
    };
  }

  createOutputWriteRequest(input: BinaryOutputWriteRequestInput): {
    request: BinaryWorkItemWriteRequestFrame;
    chunks: BinaryOutputChunk[];
    modelResult: BinaryOutputAwaitingStatus;
  } {
    const bytes = Buffer.from(input.outputBytes);
    if (bytes.byteLength > this.totalByteCap) {
      zeroBuffer(bytes);
      throw new Error(`BINARY_WORK_ITEM_TOO_LARGE:${bytes.byteLength}`);
    }
    const sha = sha256Hex(bytes);
    const outputChunkSize =
      input.outputChunkSize ??
      Math.min(this.perChunkByteCap, FRAME_SAFE_OUTPUT_CHUNK_BYTES);
    if (outputChunkSize <= 0 || outputChunkSize > this.perChunkByteCap) {
      zeroBuffer(bytes);
      throw new Error(
        'BINARY_WORK_ITEM_INVALID_OUTPUT_CHUNK_SIZE: must be positive and <= perChunkByteCap',
      );
    }
    const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / outputChunkSize));
    const request: BinaryWorkItemWriteRequestFrame = {
      kind: 'binary_work_item.write_request',
      agentTurnId: input.agentTurnId,
      invocationId: input.invocationId,
      toolName: input.toolName,
      operationId: input.operationId,
      outputId: input.outputId,
      outputPath: input.outputPath,
      sha256Hex: sha,
      byteLength: bytes.byteLength,
      chunkCount,
    };
    const chunks: BinaryOutputChunk[] = [];
    for (let i = 0; i < chunkCount; i += 1) {
      const start = i * outputChunkSize;
      const chunk = bytes.subarray(start, Math.min(start + outputChunkSize, bytes.length));
      chunks.push({
        kind: 'binary_work_item.chunk',
        direction: 'output',
        agentTurnId: input.agentTurnId,
        invocationId: input.invocationId,
        toolName: input.toolName,
        operationId: input.operationId,
        itemId: input.outputId,
        path: input.outputPath,
        sha256Hex: sha,
        byteLength: bytes.byteLength,
        chunkIndex: i,
        chunkTotal: chunkCount,
        chunkB64: chunk.toString('base64'),
      });
    }
    this.outputs.set(input.outputId, {
      sessionId: input.sessionId,
      agentTurnId: input.agentTurnId,
      invocationId: input.invocationId,
      toolName: input.toolName,
      operationId: input.operationId,
      outputId: input.outputId,
      outputPath: input.outputPath,
      sha256Hex: sha,
      byteLength: bytes.byteLength,
      bytes,
      committed: false,
      lastTouched: Date.now(),
    });
    return {
      request,
      chunks,
      modelResult: {
        status: 'awaiting_client_write',
        writeState: 'pending_client_confirmation',
        userConfirmationRequired: true,
        modelInstruction:
          'Do not claim this output has been saved yet; tell the user a copy is prepared and awaiting their confirmation.',
        outputId: input.outputId,
        outputPath: input.outputPath,
        byteLength: bytes.byteLength,
        sha256Hex: sha,
      },
    };
  }

  ackOutputWrite(
    ack: BinaryWorkItemWriteAckFrame & { sessionId?: string },
  ): BinaryOutputAckResult {
    const output = this.outputs.get(ack.outputId);
    if (!output) {
      return {
        status: 'rejected',
        errorCode: 'BINARY_WORK_ITEM_OUTPUT_MISSING',
        message: 'output work item not found',
      };
    }
    if (ack.outcome !== 'ok') {
      zeroBuffer(output.bytes);
      this.outputs.delete(ack.outputId);
      return {
        status: 'rejected',
        errorCode: 'BINARY_WORK_ITEM_ACK_DENIED',
        message: ack.reason ?? 'client did not write output',
      };
    }
    const mismatch =
      (ack.sessionId !== undefined && ack.sessionId !== output.sessionId) ||
      ack.agentTurnId !== output.agentTurnId ||
      ack.invocationId !== output.invocationId ||
      ack.operationId !== output.operationId ||
      ack.outputPath !== output.outputPath ||
      ack.sha256Hex !== output.sha256Hex ||
      ack.byteLength !== output.byteLength;
    if (mismatch) {
      return {
        status: 'rejected',
        errorCode: 'BINARY_WORK_ITEM_ACK_MISMATCH',
        message: 'ack does not match pending output',
      };
    }
    zeroBuffer(output.bytes);
    output.bytes = Buffer.alloc(0);
    output.committed = true;
    output.lastTouched = Date.now();
    return { status: 'acknowledged' };
  }

  toModelVisibleSourceStatus(itemId: string): BinarySourceStatus {
    const source = this.sources.get(itemId);
    if (!source) return { status: 'missing', itemId };
    return {
      status: 'ready',
      itemId,
      path: source.path,
      byteLength: source.byteLength,
      sha256Hex: source.sha256Hex,
    };
  }

  toModelVisibleOutputStatus(outputId: string): BinaryOutputStatus {
    const output = this.outputs.get(outputId);
    if (!output) return { status: 'missing', outputId };
    if (output.committed) {
      return {
        status: 'committed',
        outputId,
        outputPath: output.outputPath,
        byteLength: output.byteLength,
        sha256Hex: output.sha256Hex,
      };
    }
    return {
      status: 'awaiting_client_write',
      writeState: 'pending_client_confirmation',
      userConfirmationRequired: true,
      modelInstruction:
        'Do not claim this output has been saved yet; tell the user a copy is prepared and awaiting their confirmation.',
      outputId,
      outputPath: output.outputPath,
      byteLength: output.byteLength,
      sha256Hex: output.sha256Hex,
    };
  }

  clearForSession(sessionId: string): void {
    for (const [key, entry] of [...this.chunkEntries]) {
      if (entry.sessionId === sessionId) {
        zeroEntry(entry);
        this.chunkEntries.delete(key);
      }
    }
    for (const [key, source] of [...this.sources]) {
      if (source.sessionId === sessionId) {
        zeroBuffer(source.bytes);
        this.sources.delete(key);
      }
    }
    for (const [key, output] of [...this.outputs]) {
      if (output.sessionId === sessionId) {
        zeroBuffer(output.bytes);
        this.outputs.delete(key);
      }
    }
  }

  clearForTurn(sessionId: string, agentTurnId: string): void {
    for (const [key, entry] of [...this.chunkEntries]) {
      if (entry.sessionId === sessionId && entry.agentTurnId === agentTurnId) {
        zeroEntry(entry);
        this.chunkEntries.delete(key);
      }
    }
    for (const [key, source] of [...this.sources]) {
      if (source.sessionId === sessionId && source.agentTurnId === agentTurnId) {
        zeroBuffer(source.bytes);
        this.sources.delete(key);
      }
    }
    for (const [key, output] of [...this.outputs]) {
      if (output.sessionId === sessionId && output.agentTurnId === agentTurnId) {
        zeroBuffer(output.bytes);
        this.outputs.delete(key);
      }
    }
  }

  sweep(now = Date.now()): void {
    for (const [key, entry] of [...this.chunkEntries]) {
      if (now - entry.lastTouched > this.ttlMs) {
        zeroEntry(entry);
        this.chunkEntries.delete(key);
      }
    }
    for (const [key, source] of [...this.sources]) {
      if (now - source.lastTouched > this.ttlMs) {
        zeroBuffer(source.bytes);
        this.sources.delete(key);
      }
    }
    for (const [key, output] of [...this.outputs]) {
      if (now - output.lastTouched > this.ttlMs) {
        zeroBuffer(output.bytes);
        this.outputs.delete(key);
      }
    }
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const entry of this.chunkEntries.values()) zeroEntry(entry);
    this.chunkEntries.clear();
    for (const source of this.sources.values()) zeroBuffer(source.bytes);
    this.sources.clear();
    for (const output of this.outputs.values()) zeroBuffer(output.bytes);
    this.outputs.clear();
  }

  __peekSourceBytesForTest(itemId: string): Buffer | null {
    return this.sources.get(itemId)?.bytes ?? null;
  }

  __peekOutputBytesForTest(outputId: string): Buffer | null {
    return this.outputs.get(outputId)?.bytes ?? null;
  }
}

function validateChunkInput(
  input: BinaryWorkItemChunkInput,
): BinaryWorkItemAddChunkResult | null {
  if (!input.sessionId) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'sessionId is required');
  }
  if (!input.agentTurnId) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'agentTurnId is required');
  }
  if (!input.invocationId) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'invocationId is required');
  }
  if (!input.operationId) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'operationId is required');
  }
  if (!input.itemId) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'itemId is required');
  }
  if (!input.path) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'path is required');
  }
  if (!/^[a-f0-9]{64}$/.test(input.sha256Hex)) {
    return rejected(
      'BINARY_WORK_ITEM_INVALID',
      'sha256Hex must be 64 lowercase hex chars',
    );
  }
  if (!Number.isInteger(input.byteLength) || input.byteLength < 0) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'byteLength must be a non-negative integer');
  }
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'chunkIndex must be a non-negative integer');
  }
  if (!Number.isInteger(input.chunkTotal) || input.chunkTotal < 1) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'chunkTotal must be an integer >= 1');
  }
  if (input.chunkIndex >= input.chunkTotal) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'chunkIndex must be less than chunkTotal');
  }
  if (!input.chunkB64) {
    return rejected('BINARY_WORK_ITEM_INVALID', 'chunkB64 is required');
  }
  if (input.direction !== 'source' && input.direction !== 'output') {
    return rejected('BINARY_WORK_ITEM_INVALID', 'invalid binary work item direction');
  }
  return null;
}

function chunkKey(input: BinaryWorkItemChunkInput): string {
  return [
    input.sessionId,
    input.agentTurnId,
    input.invocationId,
    input.operationId,
    input.direction,
    input.itemId,
  ].join('::');
}

function zeroEntry(entry: ChunkEntry): void {
  for (const bytes of entry.chunks.values()) zeroBuffer(bytes);
  entry.chunks.clear();
  entry.receivedBytes = 0;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rejected(
  errorCode: Extract<BinaryWorkItemAddChunkResult, { status: 'rejected' }>['errorCode'],
  message: string,
): Extract<BinaryWorkItemAddChunkResult, { status: 'rejected' }> {
  return { status: 'rejected', errorCode, message };
}
