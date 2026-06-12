import { randomUUID } from 'node:crypto';

import type {
  BinaryWorkItemToolName,
  SkillPack,
  ToolCallLedgerEntry,
  ToolInvocationFrame,
  ToolResultFrame,
} from '@calypso/chat-types';

import type { DispatchResult, ToolGatewayDeps } from './index';
import { BinaryWorkItemManager } from './binary-work-items';
import { validateFileForGateway } from './file-allowlist';
import { MediaToolsClient, type MediaToolRequest, type MediaToolResult } from './media-tools';
import { resolveCopyOutputPath } from './copy-on-write-policy';
import { resolveLinkedFolder, withResolvedFolder } from './folder-resolver';

type BaseLedger = Omit<
  ToolCallLedgerEntry,
  'id' | 'outcome' | 'reason' | 'scope' | 'approvedPath'
>;

let defaultMediaTools: MediaToolsClient | null = null;
let defaultBinaryWorkItems: BinaryWorkItemManager | null = null;

export async function run(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  turnId: string,
): Promise<DispatchResult> {
  const baseLedger: BaseLedger = {
    invokedAt: new Date().toISOString(),
    toolName: frame.toolName,
    skillPackId: pack.id,
    turnId,
  };

  const args = frame.args as Record<string, unknown>;
  const filename = stringArg(args.filename);
  if (!filename) {
    return errorResult(frame, baseLedger, 'INVALID_ARGS');
  }
  // Canonicalise the target folder against the trusted linked-folder context:
  // the model often references a linked folder by its (masked) displayName
  // rather than the opaque folderId. See folder-resolver.ts.
  const resolved = resolveLinkedFolder(args, deps.linkedFolders ?? []);
  if (!resolved) {
    return errorResult(frame, baseLedger, 'INVALID_ARGS');
  }

  // Cross-pack grant binds folder access to the authorized set (defense-in-depth:
  // unreachable for today's read-only claims pack, but keeps the invariant
  // complete for any future grant-bearing pack with this tool). Fail closed.
  const grant = deps.crossPackGrant;
  if (grant && !grant.folderIds.has(resolved.folderId)) {
    return errorResult(frame, baseLedger, 'FOLDER_NOT_IN_GRANT');
  }

  const { folderId, displayName } = resolved;
  const resolvedFrame = withResolvedFolder(frame, resolved);

  if (
    frame.toolName === 'document.edit' &&
    /\.(pages|numbers|key)$/i.test(filename)
  ) {
    return rejectResult(frame, baseLedger, 'IWORK_NATIVE_EDIT_UNSUPPORTED');
  }

  const source = await readSourceBytes(resolvedFrame, deps, pack, baseLedger);
  if (!source.ok) return source.result;

  const mediaReq = buildMediaRequest(frame, filename, source.bytes);
  if (!mediaReq.ok) return errorResult(frame, baseLedger, mediaReq.reason);

  let mediaResult: MediaToolResult;
  try {
    mediaResult = await runMediaTool(deps, mediaReq.request);
  } catch (err) {
    return errorResult(
      frame,
      baseLedger,
      err instanceof Error ? err.message : 'MEDIA_TOOL_FAILED',
    );
  }

  const outputB64 = mediaResult.outputB64;
  if (!outputB64) {
    return okResult(
      frame,
      baseLedger,
      `${mediaResult.contentKind}/${filename}`,
      null,
      stripBinaryFields(mediaResult),
    );
  }

  const outputPath = stringArg(args.outputPath);
  if (!outputPath) {
    return errorResult(frame, baseLedger, 'OUTPUT_PATH_REQUIRED');
  }
  const resolvedPath = resolveCopyOutputPath({
    sourcePath: filename,
    requestedOutputPath: outputPath,
    existingPaths: [filename],
  });
  if (!resolvedPath.ok) {
    return errorResult(frame, baseLedger, resolvedPath.reason);
  }

  const outputBytes = Buffer.from(outputB64, 'base64');
  const manager = deps.binaryWorkItems ?? getDefaultBinaryWorkItems();
  const output = manager.createOutputWriteRequest({
    sessionId: deps.sessionId ?? '',
    agentTurnId: frame.agentTurnId,
    invocationId: frame.invocationId,
    toolName: frame.toolName as BinaryWorkItemToolName,
    operationId: `${frame.toolName}:${frame.invocationId}`,
    outputId: randomUUID(),
    outputPath: resolvedPath.outputPath,
    outputBytes,
  });

  const dispatch = okResult(
    frame,
    baseLedger,
    `${mediaResult.contentKind}/${filename}`,
    resolvedPath.outputPath,
    {
      ...output.modelResult,
      contentKind: mediaResult.contentKind,
      extractionStatus: mediaResult.extractionStatus,
      outputMimeType: mediaResult.outputMimeType,
      outputExtension: mediaResult.outputExtension,
      metadata: mediaResult.metadata,
    },
  );
  return {
    ...dispatch,
    clientOnlyBinaryWrite: {
      folderId,
      displayName,
      request: output.request,
      chunks: output.chunks,
    },
  };
}

function buildMediaRequest(
  frame: ToolInvocationFrame,
  filename: string,
  sourceBytes: Buffer,
): { ok: true; request: MediaToolRequest } | { ok: false; reason: string } {
  const inputB64 = sourceBytes.toString('base64');
  const args = frame.args as Record<string, unknown>;
  switch (frame.toolName) {
    case 'image.inspect':
    case 'image.ocr':
    case 'image.transform':
    case 'audio.inspect':
    case 'audio.transcribe':
    case 'audio.transform':
    case 'video.inspect':
    case 'video.transcribe':
    case 'video.transform':
      return {
        ok: true,
        request: {
          operation: frame.toolName,
          filename,
          inputB64,
          transform: args.transform as never,
        },
      };
    case 'document.edit':
      if (!filename.toLowerCase().endsWith('.docx')) {
        return { ok: false, reason: 'UNSUPPORTED_DOCUMENT_FORMAT' };
      }
      return {
        ok: true,
        request: {
          operation: 'document.docx_transform',
          filename,
          inputB64,
          transform: args.transform as never,
        },
      };
    case 'pdf.edit':
      if (!filename.toLowerCase().endsWith('.pdf')) {
        return { ok: false, reason: 'UNSUPPORTED_DOCUMENT_FORMAT' };
      }
      return {
        ok: true,
        request: {
          operation: 'document.pdf_transform',
          filename,
          inputB64,
          transform: args.transform as never,
        },
      };
    default:
      return { ok: false, reason: 'UNSUPPORTED_MEDIA_TOOL' };
  }
}

async function readSourceBytes(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  baseLedger: BaseLedger,
): Promise<
  | { ok: true; bytes: Buffer; filename: string }
  | { ok: false; result: DispatchResult }
> {
  const result = await deps.clientBridge.invokeClient(frame);
  if (result.outcome !== 'ok') {
    return {
      ok: false,
      result: wrapBridgeResult(result, baseLedger, 'media/source', null),
    };
  }
  const files = (result.resultJson as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files) || files.length !== 1) {
    return {
      ok: false,
      result: errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT'),
    };
  }
  const file = files[0] as Record<string, unknown>;
  const filename = stringArg(file.filename);
  const contentB64 = stringArg(file.contentB64);
  const byteLength = Number(file.byteLength);
  if (!filename || !contentB64 || !Number.isInteger(byteLength)) {
    return {
      ok: false,
      result: errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT'),
    };
  }
  const bytes = Buffer.from(contentB64, 'base64');
  if (bytes.toString('base64') !== contentB64 || bytes.byteLength !== byteLength) {
    return {
      ok: false,
      result: errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT'),
    };
  }
  const verdict = validateFileForGateway({
    filename,
    byteLength: bytes.byteLength,
    firstBytes: bytes.subarray(0, 32),
    fullBytes: bytes,
    capabilitySuiteIds: pack.capabilitySuiteIds,
  });
  if (!verdict.ok) {
    return {
      ok: false,
      result: rejectResult(frame, baseLedger, verdict.reason),
    };
  }
  return { ok: true, bytes, filename };
}

async function runMediaTool(
  deps: ToolGatewayDeps,
  request: MediaToolRequest,
): Promise<MediaToolResult> {
  const tools = deps.mediaTools ?? getDefaultMediaTools();
  if (tools.start && (!tools.isReady || !tools.isReady())) {
    await tools.start();
  }
  return tools.run(request);
}

function getDefaultMediaTools(): MediaToolsClient {
  defaultMediaTools ??= new MediaToolsClient();
  return defaultMediaTools;
}

function getDefaultBinaryWorkItems(): BinaryWorkItemManager {
  defaultBinaryWorkItems ??= new BinaryWorkItemManager();
  return defaultBinaryWorkItems;
}

function stripBinaryFields(result: MediaToolResult): Record<string, unknown> {
  const {
    outputB64: _outputB64,
    outputSha256Hex: _outputSha256Hex,
    ...rest
  } = result;
  return rest;
}

function okResult(
  frame: ToolInvocationFrame,
  baseLedger: BaseLedger,
  scope: string,
  approvedPath: string | null,
  resultJson: Record<string, unknown>,
): DispatchResult {
  return {
    invocationId: frame.invocationId,
    outcome: 'ok',
    resultJson,
    ledgerEntry: {
      ...baseLedger,
      scope,
      approvedPath,
      outcome: 'ok',
      reason: null,
    },
  };
}

function wrapBridgeResult(
  result: ToolResultFrame,
  baseLedger: BaseLedger,
  scope: string,
  approvedPath: string | null,
): DispatchResult {
  return {
    invocationId: result.invocationId,
    outcome: result.outcome,
    resultJson: result.resultJson,
    resultB64: result.resultB64,
    reason: result.reason,
    ledgerEntry: {
      ...baseLedger,
      scope,
      approvedPath,
      outcome: result.outcome,
      reason: result.reason ?? null,
    },
  };
}

function errorResult(
  frame: ToolInvocationFrame,
  baseLedger: BaseLedger,
  reason: string,
): DispatchResult {
  return {
    invocationId: frame.invocationId,
    outcome: 'error',
    reason,
    ledgerEntry: {
      ...baseLedger,
      scope: 'media',
      approvedPath: null,
      outcome: 'error',
      reason,
    },
  };
}

function rejectResult(
  frame: ToolInvocationFrame,
  baseLedger: BaseLedger,
  reason: string,
): DispatchResult {
  return {
    invocationId: frame.invocationId,
    outcome: 'gateway_rejected',
    reason,
    ledgerEntry: {
      ...baseLedger,
      scope: 'media',
      approvedPath: null,
      outcome: 'gateway_rejected',
      reason,
    },
  };
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
