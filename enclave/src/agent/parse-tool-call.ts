import {
  ToolInvocationFrameSchema,
  TOOL_NAMES,
  type ConnectorDescriptor,
  type ToolInvocationFrame,
} from '@calypso/chat-types';

import {
  getAllConnectors,
  getConnectorOperation,
} from '../connectors/registry';
import { isToolBanned } from '../tools/scope-check';

export type ParserEvent =
  | { kind: 'text'; value: string }
  | {
      kind: 'tool';
      payload: Pick<ToolInvocationFrame, 'invocationId' | 'toolName' | 'args'>;
    }
  | { kind: 'parse-error'; reason: string };

const OPEN = '<tool>';
const CLOSE = '</tool>';

const VALID_TOOL_NAMES = new Set<string>(TOOL_NAMES);

/**
 * Streaming parser for the `<tool>...</tool>` JSON fence the agent emits.
 *
 * Accepts arbitrary chunk boundaries (token deltas from the provider stream).
 * Plain text is yielded as `text` events; the body inside a fence is
 * accumulated, JSON-parsed on `</tool>`, and yielded as a `tool` event.
 *
 * The parser is deliberately permissive about plain text but strict about
 * the tool payload — invalid JSON, missing fields, unknown / banned tool
 * names all surface as `parse-error` events so the agent loop can append a
 * corrective tool-result and let the model retry without crashing the turn.
 */
export class ToolCallStreamParser {
  private buffer = '';
  private inFence = false;

  *push(chunk: string): Generator<ParserEvent> {
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (!this.inFence) {
        const openAt = this.buffer.indexOf(OPEN);
        if (openAt < 0) {
          // No open fence in the buffer. But we might be mid-prefix
          // (e.g. last chars are "<too"). Hold back the tail to avoid
          // splitting an open tag across emissions.
          const safe = safeTextPrefix(this.buffer, OPEN);
          if (safe > 0) {
            yield { kind: 'text', value: this.buffer.slice(0, safe) };
            this.buffer = this.buffer.slice(safe);
          }
          return;
        }
        if (openAt > 0) {
          yield { kind: 'text', value: this.buffer.slice(0, openAt) };
        }
        this.buffer = this.buffer.slice(openAt + OPEN.length);
        this.inFence = true;
        continue;
      }

      const closeAt = this.buffer.indexOf(CLOSE);
      if (closeAt < 0) return; // wait for more
      const body = this.buffer.slice(0, closeAt);
      this.buffer = this.buffer.slice(closeAt + CLOSE.length);
      this.inFence = false;
      yield this.parseBody(body);
    }
  }

  *flush(): Generator<ParserEvent> {
    if (this.inFence) {
      yield { kind: 'parse-error', reason: 'UNCLOSED_FENCE' };
      this.buffer = '';
      this.inFence = false;
      return;
    }
    if (this.buffer.length > 0) {
      yield { kind: 'text', value: this.buffer };
      this.buffer = '';
    }
  }

  private parseBody(raw: string): ParserEvent {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { kind: 'parse-error', reason: 'MALFORMED_JSON' };
    }
    if (typeof json !== 'object' || json === null) {
      return { kind: 'parse-error', reason: 'NOT_AN_OBJECT' };
    }
    const obj = json as Record<string, unknown>;
    const normalised = normaliseConnectorOperationAlias(obj);
    const toolName = normalised.toolName;
    if (typeof toolName === 'string') {
      if (isToolBanned(toolName)) {
        return {
          kind: 'parse-error',
          reason: `TIER_C_D_BANNED:${toolName}`,
        };
      }
      if (!VALID_TOOL_NAMES.has(toolName)) {
        return {
          kind: 'parse-error',
          reason: `UNKNOWN_TOOL_NAME:${toolName}`,
        };
      }
    }
    if (
      typeof normalised.toolName !== 'string' ||
      typeof normalised.args !== 'object' ||
      normalised.args === null
    ) {
      return { kind: 'parse-error', reason: 'MISSING_REQUIRED_FIELDS' };
    }
    // Codex finding #2: invocationId is enclave-minted; we deliberately
    // ignore any model-supplied value. Validate the rest against the
    // schema using a transient placeholder for invocationId + agentTurnId
    // — the loop substitutes both with freshly minted values.
    const parsed = ToolInvocationFrameSchema.safeParse({
      invocationId: 'parse-time-placeholder-invocation',
      agentTurnId: 'parse-time-placeholder-turn',
      toolName: normalised.toolName,
      args: normalised.args,
    });
    if (!parsed.success) {
      return { kind: 'parse-error', reason: 'INVALID_FRAME_SHAPE' };
    }
    return {
      kind: 'tool',
      payload: {
        // Model-supplied invocationId is INTENTIONALLY DROPPED here.
        // The agent loop mints a fresh uuid via randomUUID() before
        // emitting the TOOL_INVOCATION frame.
        invocationId: '',
        toolName: parsed.data.toolName,
        args: parsed.data.args,
      },
    };
  }
}

/**
 * Some providers naturally spell runtime connector operations as a namespaced
 * tool (`<connectorId>.<operation>`) even though the measured interface only
 * exposes the generic connector.read/connector.act tools. Normalise that common
 * shape into the canonical frame and leave every hard safety check to the
 * gateway: pack scope, connector binding, connected status, grant scope, read
 * ceilings, budgets, and write confirmation.
 *
 * C1 (rotation-free) invariant: this measured module names NO connector id and
 * NO operation id. Both the connector id and the operation are resolved against
 * the RUNTIME signed catalog (registry) via generic, identifier-shape alias
 * folding only — so connector #2..N needs no enclave change/PCR0 rotation.
 */
function normaliseConnectorOperationAlias(
  obj: Record<string, unknown>,
): { toolName: unknown; args: unknown } {
  const toolName = obj.toolName;
  if (typeof toolName !== 'string') {
    return { toolName, args: obj.args };
  }
  if (VALID_TOOL_NAMES.has(toolName)) {
    return {
      toolName,
      args: normaliseGenericConnectorArgs(toolName, obj.args),
    };
  }

  const dot = toolName.lastIndexOf('.');
  if (dot <= 0 || dot === toolName.length - 1) {
    return { toolName, args: obj.args };
  }

  const resolved = resolveConnectorOperationAlias(
    toolName.slice(0, dot),
    toolName.slice(dot + 1),
  );
  if (!resolved) {
    return { toolName, args: obj.args };
  }
  const { connectorId, operation, descriptor } = resolved;
  if (!descriptor) {
    return { toolName, args: obj.args };
  }

  const args = obj.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { toolName, args };
  }

  return {
    toolName: descriptor.mutating ? 'connector.act' : 'connector.read',
    args: {
      connectorId,
      operation,
      params: extractConnectorParams(args as Record<string, unknown>),
    },
  };
}

function normaliseGenericConnectorArgs(toolName: string, args: unknown): unknown {
  if (toolName !== 'connector.read' && toolName !== 'connector.act') {
    return args;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return args;
  }
  const raw = args as Record<string, unknown>;
  if (
    typeof raw.connectorId !== 'string' ||
    typeof raw.operation !== 'string'
  ) {
    return args;
  }
  const resolved = resolveConnectorOperationAlias(
    raw.connectorId,
    raw.operation,
  );
  if (!resolved) return args;
  return {
    connectorId: resolved.connectorId,
    operation: resolved.operation,
    params: extractConnectorParams(raw),
  };
}

function extractConnectorParams(args: Record<string, unknown>): Record<string, unknown> {
  if (
    typeof args.params === 'object' &&
    args.params !== null &&
    !Array.isArray(args.params)
  ) {
    const out = { ...(args.params as Record<string, unknown>) };
    for (const [key, value] of Object.entries(args)) {
      if (key !== 'connectorId' && key !== 'operation' && key !== 'params') {
        out[key] = value;
      }
    }
    return out;
  }
  const { connectorId: _connectorId, operation: _operation, ...params } = args;
  return params;
}

function resolveConnectorOperationAlias(
  connectorId: string,
  operation: string,
): {
  connectorId: string;
  operation: string;
  descriptor: NonNullable<ReturnType<typeof getConnectorOperation>>;
} | null {
  const connector = matchCatalogConnector(connectorId);
  if (!connector) return null;
  const canonicalOperation = matchCatalogOperationId(connector, operation);
  if (!canonicalOperation) return null;
  const descriptor = getConnectorOperation(connector.id, canonicalOperation);
  if (!descriptor) return null;
  return {
    connectorId: connector.id,
    operation: canonicalOperation,
    descriptor,
  };
}

/**
 * Loosen an identifier for generic, connector-agnostic comparison: lowercase and
 * drop every separator (so camelCase, snake_case, kebab-case and unseparated
 * spellings all collapse to the same key — e.g. `fooBar`, `foo_bar`, `foo-bar`
 * → `foobar`). Names no specific id (C1).
 */
function loosenIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[-_\s.]+/g, '');
}

/**
 * Resolve a model-supplied connector id to the catalog connector descriptor
 * WITHOUT naming any connector: match against the runtime signed catalog only.
 * First a loosened exact match (`acmecal` ↔ `acme-cal`), then a UNIQUE token
 * match so a single salient word resolves an unambiguous connector (`cal` ↔
 * `acme-cal`). Ambiguity, no catalog, or no match ⇒ no resolution (null). An
 * empty loosened input needs no special guard — it matches no real catalog id, so
 * it falls through to null via the same no-match path.
 */
function matchCatalogConnector(input: string): ConnectorDescriptor | null {
  const connectors = getAllConnectors();
  if (!connectors) return null;
  const want = loosenIdentifier(input);

  const exact = connectors.filter((c) => loosenIdentifier(c.id) === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // ambiguous — never guess

  const byToken = connectors.filter((c) =>
    c.id.split(/[-_]/).some((token) => loosenIdentifier(token) === want),
  );
  return byToken.length === 1 ? byToken[0] : null;
}

/**
 * Resolve a model-supplied operation to an operation id of the given connector
 * descriptor via a loosened exact match against THAT connector's declared
 * operations only — never a hardcoded synonym table. Unknown/undeclared ⇒ null
 * (the call then fails closed as an unknown tool and the model retries).
 */
function matchCatalogOperationId(
  connector: ConnectorDescriptor,
  input: string,
): string | null {
  const want = loosenIdentifier(input);
  const exact = connector.operations.filter((op) => loosenIdentifier(op.id) === want);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  return matchUniqueReadOperationByObject(connector, input);
}

const DISCOVERY_READ_VERBS = new Set(['find', 'lookup', 'query', 'search']);
const CATALOG_READ_VERBS = new Set(['get', 'list', 'read']);

function matchUniqueReadOperationByObject(
  connector: ConnectorDescriptor,
  input: string,
): string | null {
  const inputTokens = identifierTokens(input);
  const [inputVerb, ...inputObject] = inputTokens;
  if (
    !inputVerb ||
    inputObject.length === 0 ||
    !DISCOVERY_READ_VERBS.has(inputVerb)
  ) {
    return null;
  }

  const candidates = connector.operations.filter((operation) => {
    if (operation.mutating) return false;
    const [catalogVerb, ...catalogObject] = identifierTokens(operation.id);
    return (
      catalogVerb !== undefined &&
      CATALOG_READ_VERBS.has(catalogVerb) &&
      sameTokens(catalogObject, inputObject)
    );
  });
  return candidates.length === 1 ? candidates[0].id : null;
}

function identifierTokens(value: string): string[] {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.\s]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, idx) => token === right[idx]);
}

/**
 * How many characters from the start of `s` are safe to flush as text —
 * i.e. cannot possibly be the start of `marker`. Used to avoid splitting
 * `<tool>` across two text emissions when the tag straddles a chunk
 * boundary.
 */
function safeTextPrefix(s: string, marker: string): number {
  // The last (marker.length - 1) chars could be the prefix of marker;
  // hold them back. Anything before that is safe.
  const tail = Math.max(0, s.length - (marker.length - 1));
  // Check whether the tail actually looks like a prefix of marker.
  for (let i = tail; i < s.length; i += 1) {
    const candidate = s.slice(i);
    if (marker.startsWith(candidate)) {
      return i;
    }
  }
  return s.length;
}
