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

  it("legal + health system prompts each carry a not-advice disclaimer instruction", () => {
    expect(legalTenantPack.systemPromptBlock.toLowerCase()).toContain(
      "not legal advice",
    );
    expect(healthPack.systemPromptBlock.toLowerCase()).toContain(
      "not medical advice",
    );
  });

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

  // Audit 4d — the legal-tenant precedent: the claims prompt must MANDATE a
  // visible not-legal-advice closing line (exact copy, pinned here), and must
  // scope it to the assistant's accompanying note so the disclaimer never
  // lands inside the letter the user mails to a third party.
  it("claims prompt mandates the exact not-legal-advice closing line, outside the letter body", () => {
    const pack = getEffectiveSkillPack("personal-agent.claims");
    expect(pack.systemPromptBlock).toContain(
      "'This draft is general assistance, not legal advice. For advice on your situation, consult a qualified solicitor or legal professional.'",
    );
    expect(pack.systemPromptBlock).toContain("never the letter text itself");
    expect(pack.systemPromptBlock.toLowerCase()).toContain("not legal advice");
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
    const career = getEffectiveSkillPack("personal-agent.career");
    expect(career.id).toBe("personal-agent.career");
    expect(career.defaultNamespace).toBe("work");
    expect(career.systemPromptBlock).toContain(defaultPack.systemPromptBlock);
    expect(career.systemPromptBlock).toContain(careerPack.systemPromptBlock);
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
