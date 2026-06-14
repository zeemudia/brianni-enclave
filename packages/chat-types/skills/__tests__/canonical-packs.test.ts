import { describe, expect, it } from "vitest";

import defaultPack from "../personal-agent.default.json";
import careerPack from "../personal-agent.career.json";
import legalTenantPack from "../personal-agent.legal-tenant.json";
import healthPack from "../personal-agent.health.json";
import {
  ALL_SKILL_PACKS,
  DEFAULT_PACK_ID,
  getEffectiveSkillPack,
  getActivePackOrDefault,
  getSkillPack,
  isKnownSkillPackId,
  scopePackToPlan,
} from "../index";
import {
  BANNED_PACK_IDS,
  TOOL_NAMES,
  SkillPackSchema,
  isRegisteredSkillPackId,
} from "../../src/skill-pack";

describe("canonical packs", () => {
  it("default pack parses", () => {
    expect(() => SkillPackSchema.parse(defaultPack)).not.toThrow();
    expect(defaultPack.id).toBe("personal-agent.default");
  });

  it("General base scopes BOTH research.ask (gated) and web.fetch (quick lookups) so the planner can route between them", () => {
    // research.ask is the gated verbatim-query approval path; web.fetch is the
    // ungated quick-lookup / native-search path. The General base carries both
    // so research-heavy requests route to the gated modal while quick lookups
    // stay on web.fetch. Inherited by the non-restrictive specialist packs.
    expect(defaultPack.toolScopes).toContain("research.ask");
    expect(defaultPack.toolScopes).toContain("web.fetch");
  });

  it("General base scopes video.generate so text→video generation is routable (finding 18)", () => {
    // The video pipeline (PR #99: veo enabled in the signed registry + the Veo
    // adapter + the 8105 checkpoint broker) is wired, but the fail-closed
    // videoGenerateRoutable gate only opens when the ACTIVE pack scopes
    // video.generate. Without it here, veo is filtered out of routing and the
    // planner's deterministic video shaper never fires — video generation is
    // dead regardless of the registry. Mirrors image.generate, which IS scoped.
    expect(defaultPack.toolScopes).toContain("video.generate");
    // video.render stays UNSCOPED on purpose: no render backend is wired, so the
    // fail-closed gate must keep it off (an unrenderable composition subtask).
    expect(defaultPack.toolScopes).not.toContain("video.render");
  });

  it("video.generate is a PAID media tool: kept for PRO/MAX, narrowed away on FREE", () => {
    const pro = scopePackToPlan(getEffectiveSkillPack(DEFAULT_PACK_ID), "PRO");
    expect(pro.toolScopes).toContain("video.generate");
    const free = scopePackToPlan(getEffectiveSkillPack(DEFAULT_PACK_ID), "FREE");
    expect(free.toolScopes).not.toContain("video.generate");
  });

  it("career pack parses", () => {
    expect(() => SkillPackSchema.parse(careerPack)).not.toThrow();
    expect(careerPack.id).toBe("personal-agent.career");
  });

  it("legal-tenant pack parses", () => {
    expect(() => SkillPackSchema.parse(legalTenantPack)).not.toThrow();
    expect(legalTenantPack.id).toBe("personal-agent.legal-tenant");
  });

  it("health pack parses", () => {
    expect(() => SkillPackSchema.parse(healthPack)).not.toThrow();
    expect(healthPack.id).toBe("personal-agent.health");
  });

  it("legal-tenant reuses the default namespace (legal is not Art 9 special-category)", () => {
    expect(legalTenantPack.defaultNamespace).toBe("default");
  });

  it("health pins the health namespace (Art 9 consent-gated on write)", () => {
    expect(healthPack.defaultNamespace).toBe("health");
  });

  // The legal/health not-advice disclaimer guard moved with the prompts into
  // the signed bundle; asserted in
  // enclave/src/__tests__/skill-prompts-bundle.test.ts against the verified
  // bundle. (systemPromptBlock no longer ships in the client-visible pack.)

  it("legal + health packs cannot send email, read mailbox, or use Tier C/D tools", () => {
    const forbidden = [
      "email.send",
      "mailbox.read",
      "calendar.read",
      "event.create",
      "form.submit",
      "web.automation",
      "browser.use",
      "plaid.connect",
    ];
    for (const banned of forbidden) {
      expect(legalTenantPack.toolScopes).not.toContain(banned);
      expect(healthPack.toolScopes).not.toContain(banned);
    }
  });

  it("no canonical pack is in the banned set", () => {
    for (const pack of [defaultPack, careerPack, legalTenantPack, healthPack]) {
      expect((BANNED_PACK_IDS as readonly string[]).includes(pack.id)).toBe(
        false,
      );
    }
  });

  it("career pack omits mailbox.read and calendar.read (deferred to v1.1)", () => {
    expect(careerPack.toolScopes).not.toContain("mailbox.read");
    expect(careerPack.toolScopes).not.toContain("calendar.read");
  });

  it("no canonical pack uses a Tier C/D scope", () => {
    const forbidden = [
      "email.send",
      "event.create",
      "form.submit",
      "web.automation",
      "browser.use",
      "plaid.connect",
    ];
    for (const banned of forbidden) {
      expect(defaultPack.toolScopes).not.toContain(banned);
      expect(careerPack.toolScopes).not.toContain(banned);
    }
  });

  it("career defaultNamespace is 'work'", () => {
    expect(careerPack.defaultNamespace).toBe("work");
  });

  it("default defaultNamespace is 'default'", () => {
    expect(defaultPack.defaultNamespace).toBe("default");
  });

  it("default pack declares general file capability suites", () => {
    expect(defaultPack.capabilitySuiteIds).toEqual([
      "text",
      "office-document",
      "pdf",
      "rtf",
      "apple-iwork",
      "google-stub",
      "image",
      "audio",
      "video",
    ]);
  });

  it("career pack declares resume and document capability suites", () => {
    expect(careerPack.capabilitySuiteIds).toEqual([
      "text",
      "office-document",
      "pdf",
      "rtf",
      "apple-iwork",
      "google-stub",
    ]);
  });
});

describe("personal-agent.claims pack", () => {
  it("is a known pack", () => {
    expect(isKnownSkillPackId("personal-agent.claims")).toBe(true);
  });

  it("declares crossPackNamespaces and is read+draft only (no memory.write)", () => {
    const pack = getEffectiveSkillPack("personal-agent.claims");
    expect(pack.crossPackNamespaces).toEqual(["default", "work", "money", "health"]);
    expect(pack.toolScopes).not.toContain("memory.write");
    expect(pack.defaultNamespace).toBe("default");
  });

  it("research.ask is a known tool name", () => {
    expect(TOOL_NAMES).toContain("research.ask");
  });

  it("claims pack delegates research (research.ask) and does NOT fetch directly", () => {
    const pack = getEffectiveSkillPack("personal-agent.claims");
    expect(pack.toolScopes).toContain("research.ask");
    expect(pack.toolScopes).not.toContain("web.fetch");
  });

  // Audit 4d — the not-legal-advice mandate now lives in the signed,
  // host-served skill-prompts bundle (systemPromptBlock left the
  // client-visible pack to keep the persona-prompt IP out of client bundles).
  // The prompt-CONTENT assertion moved to
  // enclave/src/__tests__/skill-prompts-bundle.test.ts, which reads + verifies
  // the real bundle. Here we assert only the composition CONTRACT: a resolver
  // is required to get a prompt, and it layers base + specialist.
  it("composes systemPromptBlock only with a resolver (enclave path); none for clients", () => {
    const resolver = (id: string) => `PROMPT<${id}>`;
    const composed = getEffectiveSkillPack("personal-agent.claims", resolver);
    expect(composed.systemPromptBlock).toContain("PROMPT<personal-agent.default>");
    expect(composed.systemPromptBlock).toContain("PROMPT<personal-agent.claims>");
    // Client path (no resolver) carries no prompt text — the IP-protection win.
    expect(
      getEffectiveSkillPack("personal-agent.claims").systemPromptBlock,
    ).toBeUndefined();
  });
});

describe("cross-pack packs must not have web.fetch scope (F3 CI guard)", () => {
  it("no pack with a non-empty crossPackNamespaces contains web.fetch in its toolScopes", () => {
    for (const pack of ALL_SKILL_PACKS) {
      if (Array.isArray(pack.crossPackNamespaces) && pack.crossPackNamespaces.length > 0) {
        expect(pack.toolScopes).not.toContain("web.fetch");
      }
    }
  });
});

describe("canonical registry", () => {
  it("ALL_SKILL_PACKS contains exactly the five registered packs", () => {
    expect(ALL_SKILL_PACKS.map((p) => p.id).sort()).toEqual([
      "personal-agent.career",
      "personal-agent.claims",
      "personal-agent.default",
      "personal-agent.health",
      "personal-agent.legal-tenant",
    ]);
  });

  it("DEFAULT_PACK_ID is personal-agent.default", () => {
    expect(DEFAULT_PACK_ID).toBe("personal-agent.default");
  });

  it("getSkillPack resolves known ids", () => {
    expect(getSkillPack("personal-agent.career")?.id).toBe("personal-agent.career");
    expect(getSkillPack("personal-agent.default")?.id).toBe("personal-agent.default");
  });

  it("getSkillPack returns null for unknown / null / empty", () => {
    expect(getSkillPack("personal-agent.does-not-exist")).toBeNull();
    expect(getSkillPack(null)).toBeNull();
    expect(getSkillPack(undefined)).toBeNull();
    expect(getSkillPack("")).toBeNull();
  });

  it("getActivePackOrDefault falls back to DEFAULT_PACK_ID", () => {
    expect(getActivePackOrDefault(null).id).toBe(DEFAULT_PACK_ID);
    expect(getActivePackOrDefault("personal-agent.does-not-exist").id).toBe(
      DEFAULT_PACK_ID,
    );
    expect(getActivePackOrDefault("personal-agent.career").id).toBe(
      "personal-agent.career",
    );
  });

  it("effective specialist packs inherit the General base capabilities", () => {
    // Prompt composition needs a resolver (enclave path); use a synthetic one
    // so this asserts STRUCTURE, not the real (host-served) prompt text.
    const resolver = (id: string) => `PROMPT<${id}>`;
    const career = getEffectiveSkillPack("personal-agent.career", resolver);
    expect(career.id).toBe("personal-agent.career");
    expect(career.defaultNamespace).toBe("work");
    expect(career.systemPromptBlock).toContain("PROMPT<personal-agent.default>");
    expect(career.systemPromptBlock).toContain("PROMPT<personal-agent.career>");
    expect(career.toolScopes).toEqual(
      expect.arrayContaining([
        "web.fetch",
        "event.draft",
        "image.inspect",
        "audio.transform",
        "video.transform",
        "email.draft",
        "doc.draft",
      ]),
    );
    expect(career.capabilitySuiteIds).toEqual(
      expect.arrayContaining(["image", "audio", "video", "office-document"]),
    );
  });

  it("isKnownSkillPackId matches registry", () => {
    expect(isKnownSkillPackId("personal-agent.default")).toBe(true);
    expect(isKnownSkillPackId("personal-agent.career")).toBe(true);
    expect(isKnownSkillPackId("personal-agent.legal-tenant")).toBe(true);
    expect(isKnownSkillPackId("personal-agent.health")).toBe(true);
    expect(isKnownSkillPackId("personal-agent.claims")).toBe(true);
    expect(isKnownSkillPackId("personal-agent.unknown")).toBe(false);
    expect(isKnownSkillPackId(null)).toBe(false);
    expect(isKnownSkillPackId("")).toBe(false);
  });

  it("loading the registry side-effects isRegisteredSkillPackId for all packs", () => {
    // Importing ../index above triggered registerSkillPackId for each pack.
    expect(isRegisteredSkillPackId("personal-agent.default")).toBe(true);
    expect(isRegisteredSkillPackId("personal-agent.career")).toBe(true);
    expect(isRegisteredSkillPackId("personal-agent.legal-tenant")).toBe(true);
    expect(isRegisteredSkillPackId("personal-agent.health")).toBe(true);
    expect(isRegisteredSkillPackId("personal-agent.claims")).toBe(true);
    expect(isRegisteredSkillPackId("personal-agent.does-not-exist")).toBe(false);
  });
});

describe("prompt-IP invariant (Tier-2)", () => {
  it("no canonical pack carries systemPromptBlock — prompts are host-served only", () => {
    // systemPromptBlock lives ONLY in the signed skill-prompts bundle
    // (enclave/src/skills/skill-prompts.json), fetched + verified by the enclave
    // at request time. It must never be in a client-distributed pack, or the
    // prompt IP re-enters the web/mobile bundles. The app-local copies are kept
    // byte-identical to these by canonical-parity.test.ts, so this one assertion
    // protects every client surface.
    for (const pack of ALL_SKILL_PACKS) {
      expect(
        pack.systemPromptBlock,
        `${pack.id} must not carry a prompt block`,
      ).toBeUndefined();
    }
  });
});
