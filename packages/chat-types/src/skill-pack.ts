import { z } from "zod";

import { FileCapabilityFamilyIdSchema } from "./file-capabilities";
import { MemoryNamespaceSchema } from "./memory";

export const TOOL_NAMES = [
  "memory.list",
  "memory.read",
  "memory.write",
  "file.read",
  "folder.list",
  "folder.read",
  "folder.write",
  "web.fetch",
  "research.ask",
  "email.draft",
  "doc.draft",
  "event.draft",
  "image.inspect",
  "image.ocr",
  "image.transform",
  "image.generate",
  "image.edit",
  "audio.inspect",
  "audio.transcribe",
  "audio.transform",
  "audio.speech",
  "video.inspect",
  "video.transcribe",
  "video.transform",
  "video.generate",
  "video.render",
  "document.edit",
  "pdf.edit",
  // Generic external-integration capability (spec §5.1). ONE family for ALL
  // connectors — per-connector knowledge lives in the signed connectors.json
  // catalog, never here. The old per-service verbs (calendar/event/mailbox
  // reads & writes, …) stay banned in scope-check.ts.
  "connector.list",
  "connector.read",
  "connector.act",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const ToolNameSchema = z.enum(TOOL_NAMES);

/**
 * Pack ids that must never be activatable, enforced fail-closed by
 * {@link SkillPackIdSchema} (Layer 1), the canonical loader (Layer 2), and the
 * server/enclave admission checks. Empty as of the legal-tenant + health
 * launch — those personas ship with a not-advice disclaimer (system prompt +
 * deterministic enclave append) and, for `health`, the Article 9(2)(a)
 * explicit-consent gate on the `health` memory namespace. The mechanism is
 * retained (do NOT delete it) so a future ban is a one-line change.
 */
export const BANNED_PACK_IDS = [] as const satisfies readonly string[];

export type BannedPackId = (typeof BANNED_PACK_IDS)[number];

const SkillPackIdSchema = z
  .string()
  .regex(/^personal-agent\.[a-z0-9-]+$/, {
    message: "id must match /^personal-agent\\.[a-z0-9-]+$/",
  })
  .refine((id) => !(BANNED_PACK_IDS as readonly string[]).includes(id), {
    message: "pack id is banned at MVP",
  });

const LinkedFolderScopesSchema = z
  .object({
    allowedExtensions: z
      .array(z.string().regex(/^\.[a-z0-9]{1,8}$/))
      .optional(),
    defaultLabel: z.string().max(32).optional(),
  })
  .default({});

const UiHintsSchema = z.object({
  icon: z.enum(["default", "briefcase", "home", "heart", "cash"]),
  accentToken: z.enum(["accent-default", "accent-blue", "accent-amber"]),
});

const CapabilitySuiteIdSchema = FileCapabilityFamilyIdSchema;

export const SkillPackSchema = z.object({
  id: SkillPackIdSchema,
  version: z.literal(1),
  displayName: z.string().min(1).max(64),
  description: z.string().min(1).max(280),
  // systemPromptBlock no longer ships in client-distributed pack metadata (it
  // leaked in the web browser bundle and the mobile binary). It lives ONLY in
  // the signed, host-served skill-prompts bundle (see ./skill-prompts) and is
  // composed onto the pack by the enclave at request time via
  // getEffectiveSkillPack(id, resolvePrompt). Optional so metadata-only packs
  // (clients) and prompt-composed packs (enclave) share one type.
  systemPromptBlock: z.string().min(1).max(4096).optional(),
  toolScopes: z.array(ToolNameSchema).min(1),
  capabilitySuiteIds: z.array(CapabilitySuiteIdSchema).default(["text"]),
  defaultNamespace: MemoryNamespaceSchema,
  // Optional: namespaces this pack may request a cross-pack read union over,
  // gated by a CrossPackGrant. Absent on all existing packs (no behaviour
  // change). See docs/superpowers/specs/2026-06-08-cross-pack-claims-advocate-design.md §4.1.
  crossPackNamespaces: z.array(MemoryNamespaceSchema).min(1).optional(),
  linkedFolderScopes: LinkedFolderScopesSchema,
  uiHints: UiHintsSchema,
});

export type SkillPack = z.infer<typeof SkillPackSchema>;
export type SkillPackId = SkillPack["id"];

/**
 * Registry of known MVP skill-pack ids. Kept as a plain string-set so that
 * server-side validators can call this without importing the JSON registry
 * (which lives in the apps + canonical `skills/` directory). Code that loads
 * the canonical registry installs the live ids via {@link registerSkillPackId}
 * at module-load time; this keeps `@calypso/chat-types` free of `fs` / JSON
 * imports and free of circular deps from `@calypso/chat-types/skills`.
 */
const REGISTERED_PACK_IDS = new Set<string>();

/** Add a pack id to the live registry. Called by `@calypso/chat-types/skills`. */
export function registerSkillPackId(id: string): void {
  REGISTERED_PACK_IDS.add(id);
}

/** True iff the id has been registered by the canonical pack loader. */
export function isRegisteredSkillPackId(id: string): boolean {
  return REGISTERED_PACK_IDS.has(id);
}

/** Test-only — clear the registry. Not exported from package root. */
export function _resetRegisteredSkillPackIdsForTests(): void {
  REGISTERED_PACK_IDS.clear();
}
