import { z } from "zod";

/**
 * Hard upper bound on linked folders attached to ONE agent request. Raised from
 * 16 to 32 so a cross-pack claims union can reference folders spanning several
 * packs. This is the SINGLE source of truth for the bound — the enclave's
 * cross-pack grant folder limit (resolveCrossPackGrant, a later task) imports and
 * reuses this constant so the transport cap, the wire-schema reject, and the
 * grant-folder reject can never drift apart. See spec §7.
 */
export const MAX_AGENT_LINKED_FOLDERS = 32;

export const AGENT_WRITE_PERMISSION_MODES = [
  "always_ask",
  "auto_review",
  "full_access",
] as const;

export type AgentWritePermissionMode =
  (typeof AGENT_WRITE_PERMISSION_MODES)[number];

export const AgentWritePermissionModeSchema = z.enum(
  AGENT_WRITE_PERMISSION_MODES,
);

export const AgentLinkedFolderContextSchema = z.object({
  folderId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(128),
  status: z.enum(["granted", "needs_regrant"]),
});

export type AgentLinkedFolderContext = z.infer<
  typeof AgentLinkedFolderContextSchema
>;

export const AgentRequestContextSchema = z.object({
  // Authoritative WIRE bound: the enclave hard-REJECTS an inbound request
  // context carrying more than MAX_AGENT_LINKED_FOLDERS folders (no silent
  // truncation at the trust boundary). The client-side
  // buildAgentLinkedFolderContext defensively caps at the SAME bound below. For
  // the cross-pack claims path the authoritative read allowlist is the grant's
  // folderIds, separately bounded + hard-rejected in the enclave (later task).
  linkedFolders: z
    .array(AgentLinkedFolderContextSchema)
    .max(MAX_AGENT_LINKED_FOLDERS)
    .default([]),
  writePermissionMode: AgentWritePermissionModeSchema.default("always_ask"),
});

export type AgentRequestContext = z.infer<typeof AgentRequestContextSchema>;

interface FolderMetadataLike {
  id: string;
  displayName: string;
  status: "granted" | "needs_regrant" | "revoked";
  handleRefKey?: unknown;
}

export function buildAgentLinkedFolderContext(
  folders: readonly FolderMetadataLike[],
  boundFolderIds: readonly string[],
): AgentLinkedFolderContext[] {
  const bound = new Set(boundFolderIds);
  return folders
    .filter(
      (
        folder,
      ): folder is FolderMetadataLike & {
        status: "granted" | "needs_regrant";
      } => bound.has(folder.id) && folder.status !== "revoked",
    )
    // Defensive client cap at the same bound as the wire schema. Oversize sets
    // fail loudly at the trust boundary (enclave schema reject); this slice just
    // bounds an honest client's context. See MAX_AGENT_LINKED_FOLDERS.
    .slice(0, MAX_AGENT_LINKED_FOLDERS)
    .map((folder) => ({
      folderId: folder.id,
      displayName: folder.displayName,
      status: folder.status,
    }));
}
