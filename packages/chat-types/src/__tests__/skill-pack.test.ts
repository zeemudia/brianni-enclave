import { describe, it, expect, beforeEach } from "vitest";

import {
  BANNED_PACK_IDS,
  SkillPackSchema,
  TOOL_NAMES,
  ToolNameSchema,
  _resetRegisteredSkillPackIdsForTests,
  isRegisteredSkillPackId,
  registerSkillPackId,
  type SkillPack,
  type ToolName,
} from "../skill-pack";
import { BinaryWorkItemToolNameSchema } from "../tool-protocol";

const validPack = {
  id: "personal-agent.default",
  version: 1,
  displayName: "Default",
  description: "General-purpose Calypso skill pack.",
  systemPromptBlock: "You are Calypso, a private personal agent.",
  toolScopes: [
    "memory.list",
    "memory.read",
    "memory.write",
    "folder.read",
  ] satisfies ToolName[],
  defaultNamespace: "default",
  linkedFolderScopes: {},
  uiHints: {
    icon: "default",
    accentToken: "accent-default",
  },
};

describe("SkillPackSchema", () => {
  it("accepts a well-formed default pack", () => {
    const parsed = SkillPackSchema.parse(validPack);
    expect(parsed.id).toBe("personal-agent.default");
    expect(parsed.toolScopes).toContain("memory.write");
  });

  it("accepts a well-formed career pack", () => {
    const parsed = SkillPackSchema.parse({
      ...validPack,
      id: "personal-agent.career",
      displayName: "Career",
      description: "Job-search workflow.",
      defaultNamespace: "work",
      toolScopes: [
        "memory.list",
        "memory.read",
        "memory.write",
        "file.read",
        "folder.list",
        "folder.read",
        "folder.write",
        "email.draft",
        "doc.draft",
      ],
      uiHints: { icon: "briefcase", accentToken: "accent-blue" },
    });
    expect(parsed.id).toBe("personal-agent.career");
  });

  it("rejects an unknown tool name", () => {
    expect(() =>
      SkillPackSchema.parse({ ...validPack, toolScopes: ["mailbox.read"] }),
    ).toThrow();
  });

  it("rejects an id outside the personal-agent.* namespace", () => {
    expect(() =>
      SkillPackSchema.parse({ ...validPack, id: "random.pack" }),
    ).toThrow();
    expect(() =>
      SkillPackSchema.parse({ ...validPack, id: "personal-agent." }),
    ).toThrow();
    expect(() =>
      SkillPackSchema.parse({
        ...validPack,
        id: "personal-agent.UPPERCASE",
      }),
    ).toThrow();
  });

  it("rejects empty toolScopes", () => {
    expect(() =>
      SkillPackSchema.parse({ ...validPack, toolScopes: [] }),
    ).toThrow();
  });

  it("rejects ghost namespace at defaultNamespace", () => {
    expect(() =>
      SkillPackSchema.parse({ ...validPack, defaultNamespace: "ghost" }),
    ).toThrow();
  });

  it("rejects version != 1", () => {
    expect(() =>
      SkillPackSchema.parse({ ...validPack, version: 2 }),
    ).toThrow();
  });

  it("rejects systemPromptBlock over 4096 chars", () => {
    expect(() =>
      SkillPackSchema.parse({
        ...validPack,
        systemPromptBlock: "x".repeat(4097),
      }),
    ).toThrow();
  });

  it("rejects unknown uiHints.icon enum values", () => {
    expect(() =>
      SkillPackSchema.parse({
        ...validPack,
        uiHints: { icon: "rocket", accentToken: "accent-default" },
      }),
    ).toThrow();
  });

  it("linkedFolderScopes.allowedExtensions enforces leading dot + lowercase", () => {
    expect(() =>
      SkillPackSchema.parse({
        ...validPack,
        linkedFolderScopes: { allowedExtensions: ["pdf"] },
      }),
    ).toThrow();
    expect(() =>
      SkillPackSchema.parse({
        ...validPack,
        linkedFolderScopes: { allowedExtensions: [".PDF"] },
      }),
    ).toThrow();
    const ok = SkillPackSchema.parse({
      ...validPack,
      linkedFolderScopes: { allowedExtensions: [".pdf", ".docx"] },
    });
    expect(ok.linkedFolderScopes.allowedExtensions).toEqual([".pdf", ".docx"]);
  });

  it("TOOL_NAMES does not contain Tier C/D names", () => {
    const forbidden = [
      "mailbox.read",
      "calendar.read",
      "email.send",
      "event.create",
      "form.submit",
      "web.automation",
      "browser.use",
      "plaid.connect",
    ];
    for (const banned of forbidden) {
      expect((TOOL_NAMES as readonly string[]).includes(banned)).toBe(false);
    }
  });

  it("TOOL_NAMES is exactly the MVP tier-A+B plus specialist media set", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
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
        "connector.list",
        "connector.read",
        "connector.act",
      ].sort(),
    );
  });

  it("includes video tool names", () => {
    expect(ToolNameSchema.parse("video.generate")).toBe("video.generate");
    expect(ToolNameSchema.parse("video.render")).toBe("video.render");
  });

  it("type SkillPack derives from schema", () => {
    const pack: SkillPack = SkillPackSchema.parse(validPack);
    expect(pack.uiHints.icon).toBe("default");
  });

  it("defaults capability suites to text for legacy packs", () => {
    const parsed = SkillPackSchema.parse(validPack);
    expect(parsed.capabilitySuiteIds).toEqual(["text"]);
  });

  it("accepts known capability suites", () => {
    const parsed = SkillPackSchema.parse({
      ...validPack,
      capabilitySuiteIds: ["text", "office-document", "pdf", "image"],
    });
    expect(parsed.capabilitySuiteIds).toEqual([
      "text",
      "office-document",
      "pdf",
      "image",
    ]);
  });

  it("rejects unknown capability suites", () => {
    expect(() =>
      SkillPackSchema.parse({
        ...validPack,
        capabilitySuiteIds: ["text", "browser-automation"],
      }),
    ).toThrow();
  });

  it("accepts the (formerly banned) legal-tenant id", () => {
    const parsed = SkillPackSchema.parse({
      ...validPack,
      id: "personal-agent.legal-tenant",
      defaultNamespace: "default",
      uiHints: { icon: "home", accentToken: "accent-amber" },
    });
    expect(parsed.id).toBe("personal-agent.legal-tenant");
  });

  it("accepts the (formerly banned) health id", () => {
    const parsed = SkillPackSchema.parse({
      ...validPack,
      id: "personal-agent.health",
      defaultNamespace: "health",
      uiHints: { icon: "heart", accentToken: "accent-default" },
    });
    expect(parsed.id).toBe("personal-agent.health");
  });

  it("BANNED_PACK_IDS no longer bans legal-tenant or health", () => {
    expect(BANNED_PACK_IDS).not.toContain("personal-agent.legal-tenant");
    expect(BANNED_PACK_IDS).not.toContain("personal-agent.health");
  });

  it("still enforces the ban mechanism for any id in BANNED_PACK_IDS", () => {
    // The list is empty at this milestone, but the refinement must remain wired
    // so a future ban is a one-line change. Guard the invariant structurally.
    for (const banned of BANNED_PACK_IDS) {
      expect(() =>
        SkillPackSchema.parse({ ...validPack, id: banned }),
      ).toThrow();
    }
  });
});

describe("crossPackNamespaces", () => {
  const base = {
    id: "personal-agent.default",
    version: 1 as const,
    displayName: "x",
    description: "x",
    systemPromptBlock: "x",
    toolScopes: ["memory.read"],
    defaultNamespace: "default",
    linkedFolderScopes: {},
    uiHints: { icon: "default", accentToken: "accent-default" },
  };

  it("is optional (existing packs parse unchanged)", () => {
    const parsed = SkillPackSchema.parse(base);
    expect(parsed.crossPackNamespaces).toBeUndefined();
  });

  it("accepts a subset of MEMORY_NAMESPACES", () => {
    const parsed = SkillPackSchema.parse({
      ...base,
      crossPackNamespaces: ["default", "money", "health"],
    });
    expect(parsed.crossPackNamespaces).toEqual(["default", "money", "health"]);
  });

  it("rejects a value outside MEMORY_NAMESPACES", () => {
    expect(() =>
      SkillPackSchema.parse({ ...base, crossPackNamespaces: ["nope"] }),
    ).toThrow();
  });

  it("rejects an empty array (min 1)", () => {
    expect(() =>
      SkillPackSchema.parse({ ...base, crossPackNamespaces: [] }),
    ).toThrow();
  });
});

describe("skill-pack id registry", () => {
  beforeEach(() => _resetRegisteredSkillPackIdsForTests());

  it("isRegisteredSkillPackId returns false for unregistered ids", () => {
    expect(isRegisteredSkillPackId("personal-agent.career")).toBe(false);
  });

  it("returns true after registerSkillPackId", () => {
    registerSkillPackId("personal-agent.career");
    expect(isRegisteredSkillPackId("personal-agent.career")).toBe(true);
  });

  it("does not collide between different ids", () => {
    registerSkillPackId("personal-agent.default");
    expect(isRegisteredSkillPackId("personal-agent.career")).toBe(false);
  });
});

describe("connector.* tool family", () => {
  it("registers the three generic connector tool names", () => {
    expect(TOOL_NAMES).toContain("connector.list");
    expect(TOOL_NAMES).toContain("connector.read");
    expect(TOOL_NAMES).toContain("connector.act");
  });

  it("ToolNameSchema accepts connector.* names", () => {
    expect(ToolNameSchema.parse("connector.list")).toBe("connector.list");
    expect(ToolNameSchema.parse("connector.read")).toBe("connector.read");
    expect(ToolNameSchema.parse("connector.act")).toBe("connector.act");
  });

  it("connector.* are text/JSON tools — NOT in the binary-work-item set", () => {
    for (const name of ["connector.list", "connector.read", "connector.act"]) {
      expect(() => BinaryWorkItemToolNameSchema.parse(name)).toThrow();
    }
  });

  it("the old per-service names stay BANNED — never in TOOL_NAMES (spec §7.1)", () => {
    for (const banned of [
      "calendar.read",
      "calendar.write",
      "event.create",
      "event.update",
      "event.delete",
      "event.respond",
    ]) {
      expect(TOOL_NAMES).not.toContain(banned);
      expect(() => ToolNameSchema.parse(banned)).toThrow();
    }
  });
});
