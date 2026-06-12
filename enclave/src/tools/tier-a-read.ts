import {
  MemoryRecordSchema,
  MEMORY_NAMESPACES,
  type MemoryNamespace,
  type SkillPack,
  type ToolCallLedgerEntry,
  type ToolInvocationFrame,
  type ToolResultFrame,
} from '@calypso/chat-types';
import { isIP } from 'node:net';

import type { DispatchResult, ToolGatewayDeps } from './index';
import {
  validateFileForGateway,
  MAX_REASSEMBLED_TOOL_RESULT_BYTES,
  MAX_TOOL_AGGREGATE_PLAINTEXT_BYTES,
  MAX_TOOL_RESULT_FILES,
  TEXT_EXTENSIONS,
  isAllowedGatewayExtension,
  type AllowlistResult,
} from './file-allowlist';
import {
  extractFileContent,
  type ContentKind,
  type ExtractionStatus,
} from './content-extractors';
import { sanitiseBridgeResultForDispatch } from './bridge-result-sanitiser';
import { isBoundedFolderPathSegment } from './folder-path-validator';
import { resolveLinkedFolder, withResolvedFolder } from './folder-resolver';

type BaseLedger = Omit<
  ToolCallLedgerEntry,
  'id' | 'outcome' | 'reason' | 'scope' | 'approvedPath'
>;

/**
 * Returns the set of memory namespaces the gateway may access for this
 * request. When a cross-pack grant is present its `namespaces` union is
 * the authority; otherwise only `pack.defaultNamespace` is allowed.
 * This makes the guard fail-closed: absent grant ≡ single-namespace
 * (today's) behaviour, so existing packs are byte-for-byte unaffected.
 */
function authorizedNamespaces(
  pack: Pick<SkillPack, 'defaultNamespace'>,
  deps: Pick<ToolGatewayDeps, 'crossPackGrant'>,
): ReadonlySet<MemoryNamespace> {
  return deps.crossPackGrant?.namespaces ?? new Set([pack.defaultNamespace]);
}

interface ReturnedFile {
  filename: string;
  byteLength: number;
  firstBytesB64?: string;
  contentB64?: string;
  contentKind?: ContentKind;
  extractionStatus?: ExtractionStatus;
  text?: string;
  textTruncated?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

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

  switch (frame.toolName) {
    case 'memory.list':
      return handleMemoryList(frame, deps, pack, baseLedger);
    case 'memory.read':
      return handleMemoryRead(frame, deps, pack, baseLedger);
    case 'folder.list':
      return handleFolderList(frame, deps, pack, baseLedger);
    case 'folder.read':
      return handleFolderRead(frame, deps, pack, baseLedger);
    case 'file.read':
      return handleFileRead(frame, deps, pack, baseLedger);
    case 'web.fetch':
      return handleWebFetch(frame, deps, baseLedger);
    default:
      return errorResult(frame, baseLedger, 'NOT_IMPLEMENTED');
  }
}

async function handleMemoryList(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  baseLedger: BaseLedger,
): Promise<DispatchResult> {
  // R13 Finding B + R14 Finding A (Codex) + 1C.2: the requested namespace must
  // be in the authorized set (the pack's defaultNamespace alone, or the
  // crossPackGrant.namespaces union when a grant is present) BEFORE any bridge
  // call. Post-bridge, every returned record is validated against
  // MemoryRecordSchema and must carry namespace === the requested namespace — a
  // mixed-namespace response is rejected in full (fail-closed), never dropped.
  const requested = (frame.args as { namespace?: unknown }).namespace;
  if (typeof requested !== 'string' || requested.length === 0) {
    return invalidArgs(frame, baseLedger);
  }
  const isNs = (s: string): s is MemoryNamespace =>
    (MEMORY_NAMESPACES as readonly string[]).includes(s);
  const allowed = authorizedNamespaces(pack, deps);
  if (!isNs(requested) || !allowed.has(requested)) {
    return errorResult(frame, baseLedger, 'NAMESPACE_ESCAPE_REJECTED');
  }
  const namespace = requested;
  const sanitisedFrame: ToolInvocationFrame = {
    ...frame,
    args: { namespace },
  };
  const result = await deps.clientBridge.invokeClient(sanitisedFrame);
  if (result.outcome !== 'ok') {
    return wrapBridgeResult(result, baseLedger, `memory/${namespace}`, null);
  }
  const raw = (result.resultJson as { records?: unknown } | undefined)?.records;
  if (!Array.isArray(raw)) {
    return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT');
  }
  const sanitised = [];
  for (const item of raw) {
    const parsed = MemoryRecordSchema.safeParse(item);
    if (!parsed.success) {
      return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RECORD');
    }
    if (parsed.data.namespace !== namespace) {
      // The bridge MUST NOT return records outside the requested
      // namespace. Fail closed rather than silently drop the offender
      // — a mixed list is a sign of bridge bug or compromise.
      return errorResult(frame, baseLedger, 'NAMESPACE_ESCAPE_REJECTED');
    }
    sanitised.push(parsed.data);
  }
  return wrapBridgeResult(
    {
      invocationId: result.invocationId,
      outcome: 'ok',
      resultJson: { records: sanitised },
    },
    baseLedger,
    `memory/${namespace}`,
    null,
  );
}

async function handleMemoryRead(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  baseLedger: BaseLedger,
): Promise<DispatchResult> {
  const id = (frame.args as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) {
    return invalidArgs(frame, baseLedger);
  }
  const result = await deps.clientBridge.invokeClient(frame);
  if (result.outcome !== 'ok') {
    return wrapBridgeResult(result, baseLedger, `memory/${id}`, null);
  }
  // R13 Finding B + R14 Finding A (Codex) + 1C.2: parse the returned record
  // with MemoryRecordSchema and require the record's namespace to be IN the
  // authorized set (pack.defaultNamespace alone, or the crossPackGrant.namespaces
  // union when a grant is present). A namespace-less, malformed, or out-of-grant
  // record is rejected outright (fail-closed), never silently passed through.
  const raw = (result.resultJson as { record?: unknown } | undefined)?.record;
  if (raw === undefined || raw === null) {
    return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RECORD');
  }
  const parsed = MemoryRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RECORD');
  }
  if (!authorizedNamespaces(pack, deps).has(parsed.data.namespace)) {
    return errorResult(frame, baseLedger, 'NAMESPACE_ESCAPE_REJECTED');
  }
  return wrapBridgeResult(
    {
      invocationId: result.invocationId,
      outcome: 'ok',
      resultJson: { record: parsed.data },
    },
    baseLedger,
    `memory/${id}`,
    null,
  );
}

async function handleFolderList(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  baseLedger: BaseLedger,
): Promise<DispatchResult> {
  const resolved = resolveLinkedFolder(
    frame.args as { folderId?: unknown; displayName?: unknown },
    deps.linkedFolders ?? [],
  );
  if (!resolved) {
    return invalidArgs(frame, baseLedger);
  }
  // Cross-pack grant binds reads to the authorized folder set. Absent grant
  // (every non-claims request) → skipped, behaviour unchanged. Fail closed.
  const grant = deps.crossPackGrant;
  if (grant && !grant.folderIds.has(resolved.folderId)) {
    return errorResult(frame, baseLedger, 'FOLDER_NOT_IN_GRANT');
  }
  const displayName = resolved.displayName || 'unknown';
  const result = await deps.clientBridge.invokeClient(
    withResolvedFolder(frame, resolved),
  );
  if (result.outcome !== 'ok') {
    return wrapBridgeResult(result, baseLedger, `folder/${displayName}`, null);
  }
  // R16 Finding B (Codex): folder.list returns ONLY a capped array of
  // { filename, byteLength } entries — any extra bridge fields (files,
  // records, secretLeakedKey) would otherwise reach model context via
  // the agent loop's reinjection.
  const rawEntries = (result.resultJson as { entries?: unknown } | undefined)
    ?.entries;
  if (!Array.isArray(rawEntries)) {
    return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT');
  }
  const entries: Array<{ filename: string; byteLength: number }> = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') {
      return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT');
    }
    const e = raw as Record<string, unknown>;
    const verdict = validateFolderListEntry(e, pack.capabilitySuiteIds);
    if (!verdict.ok) {
      if (verdict.reason === 'FILE_TYPE_OUT_OF_SCOPE') {
        continue;
      }
      return rejectAllowlist(
        frame,
        baseLedger,
        `folder/${displayName}`,
        verdict.reason,
      );
    }
    entries.push({
      filename: e.filename as string,
      byteLength: e.byteLength as number,
    });
    if (entries.length > MAX_TOOL_RESULT_FILES) {
      return rejectAllowlist(
        frame,
        baseLedger,
        `folder/${displayName}`,
        'TOO_MANY_FILES',
      );
    }
    if (
      folderListResultJsonBytes(entries) > MAX_FOLDER_LIST_RESULT_JSON_BYTES
    ) {
      return rejectAllowlist(
        frame,
        baseLedger,
        `folder/${displayName}`,
        'TOOL_RESULT_TOO_LARGE',
      );
    }
  }
  return wrapBridgeResult(
    {
      invocationId: result.invocationId,
      outcome: 'ok',
      resultJson: { entries },
    },
    baseLedger,
    `folder/${displayName}`,
    null,
  );
}

async function handleFolderRead(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  baseLedger: BaseLedger,
): Promise<DispatchResult> {
  const resolved = resolveLinkedFolder(
    frame.args as { folderId?: unknown; displayName?: unknown },
    deps.linkedFolders ?? [],
  );
  if (!resolved) {
    return invalidArgs(frame, baseLedger);
  }
  // Cross-pack grant binds reads to the authorized folder set. Absent grant
  // (every non-claims request) → skipped, behaviour unchanged. Fail closed.
  const grant = deps.crossPackGrant;
  if (grant && !grant.folderIds.has(resolved.folderId)) {
    return errorResult(frame, baseLedger, 'FOLDER_NOT_IN_GRANT');
  }
  const displayName = resolved.displayName || 'unknown';
  return forwardAndAllowlistFiles(
    withResolvedFolder(frame, resolved),
    deps,
    baseLedger,
    `folder/${displayName}`,
    pack,
  );
}

async function handleFileRead(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  pack: SkillPack,
  baseLedger: BaseLedger,
): Promise<DispatchResult> {
  const filename = (frame.args as { filename?: unknown }).filename;
  if (typeof filename !== 'string' || filename.length === 0) {
    return invalidArgs(frame, baseLedger);
  }
  const resolved = resolveLinkedFolder(
    frame.args as { folderId?: unknown; displayName?: unknown },
    deps.linkedFolders ?? [],
  );
  if (!resolved) {
    return invalidArgs(frame, baseLedger);
  }
  // Cross-pack grant binds reads to the authorized folder set. Absent grant
  // (every non-claims request) → skipped, behaviour unchanged. Fail closed.
  const grant = deps.crossPackGrant;
  if (grant && !grant.folderIds.has(resolved.folderId)) {
    return errorResult(frame, baseLedger, 'FOLDER_NOT_IN_GRANT');
  }
  if (!isBoundedFolderPathSegment(filename)) {
    return invalidPath(frame, baseLedger, 'file/<invalid>');
  }
  return forwardAndAllowlistFiles(
    withResolvedFolder(frame, resolved),
    deps,
    baseLedger,
    `file/${filename}`,
    pack,
  );
}

const WEB_FETCH_BODY_TEXT_MAX_BYTES = 64 * 1024;

function isBlockedHttpTarget(parsed: URL): boolean {
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return true;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.startsWith('localhost.')) {
    return true;
  }
  const literal = stripIpv6Brackets(hostname);
  const ipVersion = isIP(literal);
  if (ipVersion === 4) return isBlockedIpv4(literal);
  if (ipVersion === 6) return isBlockedIpv6(literal);
  return false;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isBlockedIpv4(value: string): boolean {
  const parts = value.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIpv6(value: string): boolean {
  // Loopback + unspecified addresses. `::` (the IPv6 unspecified
  // address) routes loopback-equivalent on most stacks; both forms
  // (`::` compressed and `0:0:0:0:0:0:0:0` expanded) must reject.
  // Mirrors `server/src/routes/agent-web-fetch.ts:isBlockedIpv6`.
  if (value === '::1' || value === '::' || value === '0:0:0:0:0:0:0:0')
    {return true;}
  const firstGroup = value.split(':', 1)[0];
  const first = Number.parseInt(firstGroup, 16);
  if (Number.isInteger(first)) {
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
  }
  const mappedIpv4 = ipv4FromMappedIpv6(value);
  return mappedIpv4 !== null && isBlockedIpv4(mappedIpv4);
}

function ipv4FromMappedIpv6(value: string): string | null {
  if (value.startsWith('::ffff:')) {
    const tail = value.slice('::ffff:'.length);
    if (isIP(tail) === 4) return tail;
  }
  const pieces = value.split(':');
  if (pieces.length < 2) return null;
  const last = pieces.at(-1);
  const prev = pieces.at(-2);
  if (last === undefined || prev === undefined) return null;
  const prevNumber = Number.parseInt(prev, 16);
  const lastNumber = Number.parseInt(last, 16);
  if (
    !Number.isInteger(prevNumber) ||
    !Number.isInteger(lastNumber) ||
    prevNumber < 0 ||
    prevNumber > 0xffff ||
    lastNumber < 0 ||
    lastNumber > 0xffff
  ) {
    return null;
  }
  const prefix = pieces.slice(0, -2).join(':');
  if (prefix !== '::ffff' && prefix !== '0:0:0:0:0:ffff') return null;
  return [
    (prevNumber >> 8) & 0xff,
    prevNumber & 0xff,
    (lastNumber >> 8) & 0xff,
    lastNumber & 0xff,
  ].join('.');
}

async function handleWebFetch(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  baseLedger: BaseLedger,
): Promise<DispatchResult> {
  const rawUrl = (frame.args as { url?: unknown }).url;
  const rawQuery = (frame.args as { query?: unknown }).query;
  if (typeof rawUrl !== 'string' || typeof rawQuery !== 'string') {
    return invalidArgs(frame, baseLedger);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return invalidArgs(frame, baseLedger);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalidArgs(frame, baseLedger);
  }
  if (isBlockedHttpTarget(parsed)) {
    return rejectAllowlist(
      frame,
      baseLedger,
      `web/${parsed.hostname}`,
      'SSRF_BLOCKED',
    );
  }
  const result = await deps.clientBridge.invokeClient(frame);
  if (result.outcome !== 'ok') {
    return wrapBridgeResult(result, baseLedger, `web/${parsed.hostname}`, null);
  }
  // R15 Finding B (Codex): strict schema for the web.fetch bridge
  // result — return ONLY `{ status, bodyText? }` so extra fields like
  // `records`, `files`, or `secretLeakedKey` can't smuggle into the
  // model context via the agent loop's reinjection.
  const raw = result.resultJson as
    | { status?: unknown; bodyText?: unknown }
    | undefined;
  if (
    !raw ||
    typeof raw.status !== 'number' ||
    !Number.isFinite(raw.status) ||
    raw.status <= 0
  ) {
    return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT');
  }
  let bodyText: string | undefined;
  if (raw.bodyText !== undefined) {
    if (typeof raw.bodyText !== 'string') {
      return errorResult(frame, baseLedger, 'INVALID_BRIDGE_RESULT');
    }
    if (
      Buffer.byteLength(raw.bodyText, 'utf8') > WEB_FETCH_BODY_TEXT_MAX_BYTES
    ) {
      return errorResult(frame, baseLedger, 'WEB_FETCH_BODY_TOO_LARGE');
    }
    bodyText = raw.bodyText;
  }
  return wrapBridgeResult(
    {
      invocationId: result.invocationId,
      outcome: 'ok',
      resultJson:
        bodyText === undefined
          ? { status: raw.status }
          : { status: raw.status, bodyText },
    },
    baseLedger,
    `web/${parsed.hostname}`,
    null,
  );
}

async function forwardAndAllowlistFiles(
  frame: ToolInvocationFrame,
  deps: ToolGatewayDeps,
  baseLedger: BaseLedger,
  scope: string,
  pack: SkillPack,
): Promise<DispatchResult> {
  const result = await deps.clientBridge.invokeClient(frame);
  if (result.outcome !== 'ok') {
    return wrapBridgeResult(result, baseLedger, scope, null);
  }
  // R14 Finding B (Codex): the previous implementation forwarded
  // result.resultJson verbatim if `files` validated. A malformed
  // bridge result with no `files` but extra payload fields, or with a
  // contentB64 that disagrees with byteLength/firstBytesB64, would
  // bypass both the allowlist and the aggregate cap. Now we require
  // `files` to be an exact array of well-formed `ReturnedFile` shapes,
  // verify contentB64 (if present) matches byteLength + firstBytesB64,
  // and return a SANITISED `{ files }` payload — discarding extra
  // fields and breaking any "smuggle data through unvalidated keys"
  // path.
  const rawFiles = (result.resultJson as { files?: unknown } | undefined)
    ?.files;
  if (!Array.isArray(rawFiles)) {
    return {
      invocationId: frame.invocationId,
      outcome: 'gateway_rejected',
      reason: 'INVALID_BRIDGE_RESULT',
      ledgerEntry: {
        ...baseLedger,
        scope,
        approvedPath: null,
        outcome: 'gateway_rejected',
        reason: 'INVALID_BRIDGE_RESULT',
      },
    };
  }
  if (rawFiles.length > MAX_TOOL_RESULT_FILES) {
    return {
      invocationId: frame.invocationId,
      outcome: 'gateway_rejected',
      reason: 'TOO_MANY_FILES',
      ledgerEntry: {
        ...baseLedger,
        scope,
        approvedPath: null,
        outcome: 'gateway_rejected',
        reason: 'TOO_MANY_FILES',
      },
    };
  }
  const sanitisedFiles: ReturnedFile[] = [];
  let aggregateBytes = 0;
  const HEAD_BYTES = 16;
  for (const raw of rawFiles) {
    if (!raw || typeof raw !== 'object') {
      return rejectAllowlist(frame, baseLedger, scope, 'INVALID_BRIDGE_FILE');
    }
    const file = raw as Record<string, unknown>;
    if (
      typeof file.filename !== 'string' ||
      typeof file.byteLength !== 'number' ||
      !Number.isInteger(file.byteLength) ||
      file.byteLength < 0 ||
      typeof file.contentB64 !== 'string'
    ) {
      return rejectAllowlist(frame, baseLedger, scope, 'INVALID_BRIDGE_FILE');
    }
    if (!isBoundedFolderPathSegment(file.filename)) {
      return rejectAllowlist(
        frame,
        baseLedger,
        scope,
        'INVALID_BRIDGE_FILENAME',
      );
    }
    const decoded = decodeB64ToBytes(file.contentB64);
    if (!decoded || decoded.length !== file.byteLength) {
      return rejectAllowlist(
        frame,
        baseLedger,
        scope,
        'FILE_BYTE_LENGTH_MISMATCH',
      );
    }
    // R16 Finding C (Codex): Buffer.from(b64, 'base64') accepts non-
    // canonical base64 and silently ignores trailing junk. The
    // bridge can stuff readable text after the padding and have it
    // pass the byteLength check while still leaking into the model
    // via `contentB64` in the returned tool result. Re-encode the
    // canonical base64 ourselves from `decoded` bytes — the returned
    // string is now derived, not echoed.
    const canonicalContentB64 = Buffer.from(decoded).toString('base64');
    // Derive the head from decoded bytes — never trust the bridge's
    // firstBytesB64. R15 Finding A.
    const headLen = Math.min(HEAD_BYTES, decoded.length);
    const derivedHead = decoded.slice(0, headLen);
    const derivedHeadB64 = Buffer.from(derivedHead).toString('base64');
    // Per-file allowlist using the trusted, derived head. `.docx`
    // additionally requires the full decoded bytes so the OOXML
    // container check can walk the central directory + verify the
    // content type declaration. All other extensions ignore
    // fullBytes — passing it is a cheap reference, not a copy.
    const verdict: AllowlistResult = validateFileForGateway({
      filename: file.filename,
      byteLength: decoded.length,
      firstBytes: derivedHead,
      fullBytes: decoded,
      capabilitySuiteIds: pack.capabilitySuiteIds,
    });
    if (!verdict.ok) {
      return rejectAllowlist(frame, baseLedger, scope, verdict.reason);
    }
    // R16 Finding D (Codex): for text extensions, validate the ENTIRE
    // decoded payload is valid UTF-8 — not just the first 16 bytes.
    // Otherwise a bridge can prefix 16 valid bytes and stuff binary /
    // invalid-UTF8 garbage past the head into the model context.
    if (isTextExtension(file.filename) && !isValidUtf8(decoded)) {
      return rejectAllowlist(frame, baseLedger, scope, 'FILE_CONTENT_MISMATCH');
    }
    aggregateBytes += decoded.length;
    // Wire framing is bounded per-frame by MAX_TOOL_RESULT_PLAINTEXT_BYTES
    // (200 KiB) and per-invocation by MAX_REASSEMBLED_TOOL_RESULT_BYTES
    // (8 MiB) after chunked-transport reassembly. The gateway-side
    // cap on what we route to the model is tighter — see
    // MAX_TOOL_AGGREGATE_PLAINTEXT_BYTES (5 MiB) — so a folder.read
    // can't exhaust the model's context window with multiple
    // mid-sized files in one call.
    if (aggregateBytes > MAX_TOOL_AGGREGATE_PLAINTEXT_BYTES) {
      return rejectAllowlist(frame, baseLedger, scope, 'TOOL_RESULT_TOO_LARGE');
    }
    const extraction = await extractFileContent({
      filename: file.filename,
      bytes: decoded,
    });
    const sanitisedFile: ReturnedFile = {
      filename: file.filename,
      byteLength: decoded.length,
      firstBytesB64: derivedHeadB64,
      contentB64: canonicalContentB64,
      contentKind: extraction.contentKind,
      extractionStatus: extraction.extractionStatus,
    };
    if (extraction.text !== undefined) {
      sanitisedFile.text = extraction.text;
      sanitisedFile.textTruncated = extraction.textTruncated ?? false;
    }
    if (extraction.metadata !== undefined) {
      sanitisedFile.metadata = extraction.metadata;
    }
    sanitisedFiles.push(sanitisedFile);
    if (
      resultJsonUtf8Bytes({ files: sanitisedFiles }) >
      MAX_REASSEMBLED_TOOL_RESULT_BYTES
    ) {
      return rejectAllowlist(frame, baseLedger, scope, 'TOOL_RESULT_TOO_LARGE');
    }
  }
  return wrapBridgeResult(
    {
      invocationId: result.invocationId,
      outcome: 'ok',
      resultJson: { files: sanitisedFiles },
    },
    baseLedger,
    scope,
    null,
  );
}

function rejectAllowlist(
  frame: ToolInvocationFrame,
  baseLedger: BaseLedger,
  scope: string,
  reason: string,
): DispatchResult {
  return {
    invocationId: frame.invocationId,
    outcome: 'gateway_rejected',
    reason,
    ledgerEntry: {
      ...baseLedger,
      scope,
      approvedPath: null,
      outcome: 'gateway_rejected',
      reason,
    },
  };
}

const MAX_FOLDER_LIST_ENTRY_JSON_BYTES = 512;
const MAX_FOLDER_LIST_RESULT_JSON_BYTES = 4 * 1024;

function validateFolderListEntry(
  entry: Record<string, unknown>,
  capabilitySuiteIds: SkillPack['capabilitySuiteIds'],
):
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'INVALID_BRIDGE_RESULT'
        | 'FILE_TYPE_NOT_ALLOWED'
        | 'FILE_TYPE_OUT_OF_SCOPE'
        | 'TOOL_RESULT_TOO_LARGE';
    } {
  const filename = entry.filename;
  const byteLength = entry.byteLength;
  if (
    typeof filename !== 'string' ||
    typeof byteLength !== 'number' ||
    !Number.isFinite(byteLength) ||
    !Number.isInteger(byteLength) ||
    byteLength < 0
  ) {
    return { ok: false, reason: 'INVALID_BRIDGE_RESULT' };
  }
  if (!isBoundedFolderPathSegment(filename)) {
    return { ok: false, reason: 'INVALID_BRIDGE_RESULT' };
  }
  if (!isAllowedGatewayExtension(filename)) {
    return { ok: false, reason: 'FILE_TYPE_NOT_ALLOWED' };
  }
  if (!isAllowedGatewayExtension(filename, capabilitySuiteIds)) {
    return { ok: false, reason: 'FILE_TYPE_OUT_OF_SCOPE' };
  }
  if (
    Buffer.byteLength(JSON.stringify({ filename, byteLength }), 'utf8') >
    MAX_FOLDER_LIST_ENTRY_JSON_BYTES
  ) {
    return { ok: false, reason: 'TOOL_RESULT_TOO_LARGE' };
  }
  return { ok: true };
}

function folderListResultJsonBytes(
  entries: Array<{ filename: string; byteLength: number }>,
): number {
  return resultJsonUtf8Bytes({ entries });
}

function resultJsonUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isTextExtension(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return false;
  return TEXT_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

/**
 * Strict UTF-8 validation across the entire byte string. Node's
 * TextDecoder with fatal=true throws on invalid sequences — exactly the
 * shape we need for content-type enforcement on text files. R16
 * Finding D (Codex).
 */
function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodeB64ToBytes(value: string | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (value === '') return new Uint8Array(0);
  try {
    return new Uint8Array(Buffer.from(value, 'base64'));
  } catch {
    return undefined;
  }
}

function wrapBridgeResult(
  result: ToolResultFrame,
  baseLedger: BaseLedger,
  scope: string,
  approvedPath: string | null,
): DispatchResult {
  // R16 Finding A (Codex): scrub `resultJson` for non-ok results. A
  // hostile bridge could otherwise set outcome='error' (bypassing the
  // R14/R15 ok-path sanitisers) and stuff secrets/records/files in
  // resultJson, which the agent loop reinjects into the model. For
  // non-ok results, only invocationId + outcome + reason cross the
  // boundary; resultJson is dropped.
  if (result.outcome !== 'ok') {
    return sanitiseBridgeResultForDispatch(
      result,
      baseLedger,
      scope,
      approvedPath,
    );
  }
  return sanitiseBridgeResultForDispatch(
    result,
    baseLedger,
    scope,
    approvedPath,
    result.resultJson,
  );
}

function invalidArgs(
  frame: ToolInvocationFrame,
  baseLedger: BaseLedger,
): DispatchResult {
  return {
    invocationId: frame.invocationId,
    outcome: 'error',
    reason: 'INVALID_ARGS',
    ledgerEntry: {
      ...baseLedger,
      scope: '',
      approvedPath: null,
      outcome: 'error',
      reason: 'INVALID_ARGS',
    },
  };
}

function invalidPath(
  frame: ToolInvocationFrame,
  baseLedger: BaseLedger,
  scope: string,
): DispatchResult {
  return {
    invocationId: frame.invocationId,
    outcome: 'gateway_rejected',
    reason: 'INVALID_PATH',
    ledgerEntry: {
      ...baseLedger,
      scope,
      approvedPath: null,
      outcome: 'gateway_rejected',
      reason: 'INVALID_PATH',
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
      scope: '',
      approvedPath: null,
      outcome: 'error',
      reason,
    },
  };
}
