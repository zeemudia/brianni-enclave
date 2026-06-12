import type {
  AgentLinkedFolderContext,
  ToolInvocationFrame,
} from '@calypso/chat-types';

export interface ResolvedFolder {
  /** The real, opaque folder id the client resolves a handle from. */
  folderId: string;
  /**
   * The label to forward + use for the ledger scope. When resolved from the
   * trusted linked-folder context this is that entry's displayName, so the
   * client's defence-in-depth label cross-check passes; otherwise it is the
   * label the model supplied (legacy passthrough).
   */
  displayName: string;
}

function normaliseLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Canonicalise the folder a Tier-A/B/media frame targets to a REAL folderId
 * using the server/client-authoritative linked-folder context the enclave was
 * handed for this turn (`requestContext.linkedFolders`).
 *
 * Why this exists: the model reasons about folders by their human label and
 * frequently supplies the (masked) `displayName` in place of the opaque
 * `folderId` — or stuffs the label into the `folderId` field. The folder tool
 * handlers used to reject those frames with INVALID_ARGS BEFORE they ever
 * reached the client (which is itself capable of a displayName fallback), so a
 * natural request like "summarise the offer letter in my folder" died inside
 * the gateway. The enclave already holds the trusted {folderId, displayName}
 * pairs for exactly the folders bound to this skill, so it can repair the frame
 * here. The injected id is always one of the bound folders, and the client
 * still independently validates that the id is bound to the active skill before
 * any file access — so resolution never widens access.
 *
 * Resolution order (only when linked-folder context is present):
 *   1. the model's folderId matches a real linked folder id — happy path;
 *   2. a UNIQUE displayName match (label may sit in either field);
 *   3. exactly one folder is linked — "the linked folder" is unambiguous.
 *
 * Returns null only when nothing usable can be determined — callers keep their
 * existing INVALID_ARGS behaviour. Crucially, when NO linked-folder context was
 * provided (tests / direct-dispatch / older callers) a non-empty model-supplied
 * folderId passes through unchanged, so this never regresses the legacy path.
 */
export function resolveLinkedFolder(
  args: { folderId?: unknown; displayName?: unknown },
  linkedFolders: readonly AgentLinkedFolderContext[],
): ResolvedFolder | null {
  const rawFolderId =
    typeof args.folderId === 'string' ? args.folderId.trim() : '';
  const rawDisplayName =
    typeof args.displayName === 'string' ? args.displayName.trim() : '';

  if (linkedFolders.length > 0) {
    // 1. The model supplied a real folderId verbatim. Always return the trusted
    //    entry's displayName so an omitted/mismatched label can't trip the
    //    client's label cross-check.
    const byId = linkedFolders.find((entry) => entry.folderId === rawFolderId);
    if (byId) {
      return { folderId: byId.folderId, displayName: byId.displayName };
    }

    // 2. Resolve by displayName. The label may live in the displayName field
    //    or (the observed failure) the folderId field. Require a UNIQUE match
    //    so an ambiguous label never silently selects a folder.
    const candidateLabels = [
      normaliseLabel(rawDisplayName),
      normaliseLabel(rawFolderId),
    ].filter((label) => label.length > 0);
    for (const label of candidateLabels) {
      const matches = linkedFolders.filter(
        (entry) => normaliseLabel(entry.displayName) === label,
      );
      if (matches.length === 1) {
        return {
          folderId: matches[0].folderId,
          displayName: matches[0].displayName,
        };
      }
    }

    // 3. Sole-folder fallback: exactly one folder is linked, so the target is
    //    unambiguous even when the model supplied an unmatched or empty
    //    identifier. Multi-folder turns require a real id or a unique label
    //    match (steps 1-2) and otherwise fall through.
    if (linkedFolders.length === 1) {
      return {
        folderId: linkedFolders[0].folderId,
        displayName: linkedFolders[0].displayName,
      };
    }
  }

  // 4. Legacy passthrough: no linked-folder context was provided (or it holds
  //    multiple folders and the model gave an id we can't vet here). Keep the
  //    model's non-empty folderId — the client still validates the binding
  //    before any access, exactly as before this resolver existed.
  if (rawFolderId.length > 0) {
    return { folderId: rawFolderId, displayName: rawDisplayName };
  }

  return null;
}

/**
 * Produce a copy of `frame` whose args carry the resolved real folderId and
 * trusted displayName, leaving every other arg untouched. The handlers forward
 * THIS frame to the client so it resolves by the vetted id.
 */
export function withResolvedFolder(
  frame: ToolInvocationFrame,
  resolved: ResolvedFolder,
): ToolInvocationFrame {
  return {
    ...frame,
    args: {
      ...(frame.args as Record<string, unknown>),
      folderId: resolved.folderId,
      displayName: resolved.displayName,
    },
  };
}
