// Plain JSON imports — `resolveJsonModule` in tsconfig.base.json handles
// these. The `with { type: "json" }` syntax requires module:esnext+
// which the mobile tsconfig doesn't enable.
import defaultPack from "./personal-agent.default.json";
import careerPack from "./personal-agent.career.json";
import legalTenantPack from "./personal-agent.legal-tenant.json";
import healthPack from "./personal-agent.health.json";
import claimsPack from "./personal-agent.claims.json";
import {
  BANNED_PACK_IDS,
  SkillPackSchema,
  registerSkillPackId,
  type SkillPack,
  type SkillPackId,
  type ToolName,
} from "../src/skill-pack";

const RAW_PACKS = [defaultPack, careerPack, legalTenantPack, healthPack, claimsPack];

/**
 * Validate every canonical pack at module-load time. A bad commit fails the
 * import and therefore the build. Layer-2 defense: even if the schema's
 * `SkillPackIdSchema` ban refinement is bypassed (e.g. by hand-editing the
 * JSON to a banned id), this explicit check throws before the schema sees it.
 */
const VALIDATED: SkillPack[] = RAW_PACKS.map((p, i) => {
  const id = (p as { id?: unknown }).id;
  if (typeof id === "string" && (BANNED_PACK_IDS as readonly string[]).includes(id)) {
    throw new Error(
      `[chat-types/skills] pack at index ${i} has banned id ${id}; refusing to register`,
    );
  }
  return SkillPackSchema.parse(p);
});

/** Frozen list of every canonical pack at MVP. */
export const ALL_SKILL_PACKS: readonly SkillPack[] = Object.freeze(VALIDATED);

/** Fallback when no preference is set, the stored id is unknown, or the user is signed out. */
export const DEFAULT_PACK_ID: SkillPackId = "personal-agent.default";

// Register live ids into the in-memory set consumed by isRegisteredSkillPackId.
for (const pack of ALL_SKILL_PACKS) {
  registerSkillPackId(pack.id);
}

/** Returns the pack with the given id, or `null` if not in the registry. */
export function getSkillPack(id: string | null | undefined): SkillPack | null {
  if (!id) return null;
  return ALL_SKILL_PACKS.find((p) => p.id === id) ?? null;
}

/** Returns the resolved pack, falling back to {@link DEFAULT_PACK_ID}. Never null. */
export function getActivePackOrDefault(id: string | null | undefined): SkillPack {
  return getSkillPack(id) ?? getSkillPack(DEFAULT_PACK_ID)!;
}

/**
 * Resolves a pack id to its verified system-prompt block. Supplied ONLY by the
 * enclave, after it fetches + Ed25519-verifies the host-served skill-prompts
 * bundle. Clients never pass a resolver, so client-side effective packs carry
 * NO `systemPromptBlock` — the prompt text is in no client bundle.
 */
export type SkillPromptResolver = (packId: string) => string | undefined;

// Metadata composition (toolScopes / capabilities) is prompt-independent and
// cacheable. The prompt is layered on per call from the resolver, so this cache
// never holds prompt text.
const EFFECTIVE_METADATA = new Map<string, SkillPack>();

/**
 * Returns the runtime capability view for the selected pack.
 *
 * Specialist packs are additive over General: selecting Career, Legal, or
 * Health focuses namespace/folder defaults without removing the base General
 * tools. The raw packs remain available via getSkillPack() for settings display
 * and registry validation.
 *
 * The system prompt is composed ONLY when `resolvePrompt` is supplied (the
 * enclave, after verifying the signed skill-prompts bundle). Without it — every
 * client call — the returned pack has NO `systemPromptBlock`; this is what keeps
 * the persona prompts out of the web/mobile bundles. When a resolver IS given, a
 * missing prompt for an active pack THROWS (fail closed): a host that omits a
 * prompt must never yield a silently-unprompted agent.
 */
export function getEffectiveSkillPack(
  id: string | null | undefined,
  resolvePrompt?: SkillPromptResolver,
): SkillPack {
  const active = getActivePackOrDefault(id);
  const base = getSkillPack(DEFAULT_PACK_ID)!;

  let metadata = EFFECTIVE_METADATA.get(active.id);
  if (!metadata) {
    if (active.id === base.id) {
      metadata = base;
    } else {
      // Cross-pack packs are restrictive: they declare exactly the tools they
      // need and must not inherit write tools (e.g. memory.write) from the base
      // pack, since combining cross-namespace reads with writes would widen the
      // exfil surface. All existing packs lack crossPackNamespaces.
      const isRestrictive = Array.isArray(active.crossPackNamespaces);
      metadata = SkillPackSchema.parse({
        ...active,
        systemPromptBlock: undefined,
        toolScopes: isRestrictive
          ? active.toolScopes
          : uniquePreservingOrder(base.toolScopes, active.toolScopes),
        capabilitySuiteIds: uniquePreservingOrder(
          base.capabilitySuiteIds,
          active.capabilitySuiteIds,
        ),
      });
    }
    EFFECTIVE_METADATA.set(active.id, metadata);
  }

  if (!resolvePrompt) return metadata;

  const basePrompt = resolvePrompt(base.id);
  if (!basePrompt) {
    throw new Error(
      `[skills] missing verified system prompt for base pack ${base.id}`,
    );
  }
  let systemPromptBlock: string;
  if (active.id === base.id) {
    systemPromptBlock = basePrompt;
  } else {
    const specialistPrompt = resolvePrompt(active.id);
    if (!specialistPrompt) {
      throw new Error(
        `[skills] missing verified system prompt for pack ${active.id}`,
      );
    }
    systemPromptBlock = [
      basePrompt,
      "",
      `Specialist skill layer (${active.displayName}):`,
      specialistPrompt,
    ].join("\n");
  }
  return { ...metadata, systemPromptBlock };
}

/** Returns true iff `id` matches a pack in the canonical registry. */
export function isKnownSkillPackId(id: string | null | undefined): id is SkillPackId {
  return !!id && ALL_SKILL_PACKS.some((p) => p.id === id);
}

function uniquePreservingOrder<T>(
  baseItems: readonly T[],
  extraItems: readonly T[],
): T[] {
  const out: T[] = [];
  for (const item of [...baseItems, ...extraItems]) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

// --- FREE-tier agent tool policy ---------------------------------------------
//
// Single source of truth, shared by the enclave (authoritative enforcement:
// narrows pack.toolScopes so the model is never offered a paid tool) and the
// clients (UI: show the included tools and present the rest as paid upgrades).
//
// The FREE agent is a deliberate "taste": read and reason over the user's OWN
// files + memory and produce derived artifacts. It EXCLUDES web.fetch (egress
// cost/abuse + the read->egress exfil vector) and the media pipeline
// (image/audio/video/document/pdf — compute not covered by the FREE low-cost
// CHAT-model gate). Those, plus the orchestrator, are the paid upgrades.

/** Tools a FREE-tier agent turn may use. */
export const FREE_AGENT_TOOL_SCOPES: ReadonlySet<ToolName> = new Set<ToolName>([
  "memory.list",
  "memory.read",
  "memory.write",
  "file.read",
  "folder.list",
  "folder.read",
  "folder.write",
  "email.draft",
  "event.draft",
]);

/**
 * Per-turn tool-call cap for FREE single-mode turns (vs the default 10). A
 * single agent turn fans out into multiple tool calls + model round-trips, so
 * the 5/day message cap must be paired with a per-turn fan-out cap.
 */
export const FREE_AGENT_MAX_TOOL_CALLS = 4;

/**
 * Per-read MODEL-VISIBLE byte budget for FREE read tools (memory/file/folder/
 * media) — the serialised tool result the enclave reinjects into the model
 * (contentB64 + extracted text + metadata + records), NOT just raw file bytes.
 * FREE_AGENT_MAX_TOOL_CALLS caps the call COUNT but not the BYTES each read
 * injects, so without this a FREE turn could pull large low-cost-model context
 * (cost blow-through + likely context overflow). 256 KiB keeps the "read &
 * reason over your files" taste for notes/docs while bounding cost; the enclave
 * enforces it authoritatively on every read tool's result.
 */
export const FREE_AGENT_READ_AGGREGATE_BYTES = 256 * 1024;

/** True iff `tool` is available to FREE-tier agent turns. */
export function isFreeAgentTool(tool: ToolName): boolean {
  return FREE_AGENT_TOOL_SCOPES.has(tool);
}

/**
 * Narrow a resolved skill pack to the FREE-tier tool set. Non-FREE plans are
 * returned unchanged. Narrowing the pack is the single authoritative gate: the
 * gateway enforces `pack.toolScopes` on every dispatch and the model's
 * advertised tool list derives from it, so a FREE turn can neither see nor
 * dispatch a paid tool — even from a forged client.
 */
export function scopePackToPlan(
  pack: SkillPack,
  planId: "FREE" | "PRO" | "MAX",
): SkillPack {
  if (planId !== "FREE") return pack;
  const scoped = pack.toolScopes.filter((tool) => FREE_AGENT_TOOL_SCOPES.has(tool));
  // SkillPackSchema requires >=1 scope; the core read tool always exists in any
  // agent pack, but guard so a hypothetical paid-only pack can't crash.
  const toolScopes = scoped.length > 0 ? scoped : (["memory.read"] as ToolName[]);
  return { ...pack, toolScopes };
}
