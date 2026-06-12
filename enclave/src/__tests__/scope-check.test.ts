import { describe, it, expect } from "vitest";

import { isToolBanned, isToolInScope } from "../tools/scope-check";

import type { SkillPack } from "@calypso/chat-types";

const defaultPack: Pick<SkillPack, "toolScopes"> & { id: string } = {
  id: "personal-agent.default",
  toolScopes: ["memory.list", "memory.read", "folder.read"],
};

const careerPack: Pick<SkillPack, "toolScopes"> & { id: string } = {
  id: "personal-agent.career",
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
};

describe("isToolInScope", () => {
  it("accepts in-scope tools", () => {
    expect(isToolInScope("memory.read", defaultPack)).toBe(true);
    expect(isToolInScope("folder.read", defaultPack)).toBe(true);
  });

  it("rejects out-of-scope but legal tools", () => {
    expect(isToolInScope("email.draft", defaultPack)).toBe(false);
    expect(isToolInScope("folder.write", defaultPack)).toBe(false);
    expect(isToolInScope("doc.draft", defaultPack)).toBe(false);
  });

  it("accepts career pack's expanded scopes", () => {
    expect(isToolInScope("folder.write", careerPack)).toBe(true);
    expect(isToolInScope("email.draft", careerPack)).toBe(true);
    expect(isToolInScope("memory.write", careerPack)).toBe(true);
  });

  it("rejects unknown tool names", () => {
    expect(isToolInScope("not.a.tool", defaultPack)).toBe(false);
    expect(isToolInScope("", defaultPack)).toBe(false);
  });

  it("rejects banned Tier C/D tools even if pack erroneously lists them", () => {
    const widePack: Pick<SkillPack, "toolScopes"> = {
      toolScopes: [
        "memory.list",
        "mailbox.read",
        "email.send",
      ] as never as SkillPack["toolScopes"],
    };
    expect(isToolInScope("mailbox.read", widePack)).toBe(false);
    expect(isToolInScope("email.send", widePack)).toBe(false);
  });
});

describe("isToolBanned", () => {
  it.each([
    "mailbox.read",
    "calendar.read",
    "email.send",
    "event.create",
    "form.submit",
    "web.automation",
    "browser.use",
    "plaid.connect",
  ])("recognises %s as banned", (name) => {
    expect(isToolBanned(name)).toBe(true);
  });

  it.each([
    "memory.list",
    "memory.read",
    "memory.write",
    "file.read",
    "folder.list",
    "folder.read",
    "folder.write",
    "web.fetch",
    "email.draft",
    "doc.draft",
    "event.draft",
  ])("does not flag MVP tool %s as banned", (name) => {
    expect(isToolBanned(name)).toBe(false);
  });

  it("does not flag unknown names as banned (banned is a positive list)", () => {
    expect(isToolBanned("totally.unknown")).toBe(false);
  });
});
