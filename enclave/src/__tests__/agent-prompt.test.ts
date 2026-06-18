import { describe, it, expect } from "vitest";

import { assembleSystemPrompt } from "../agent/prompt";
import { TOOL_NAMES, type SkillPack, type ToolName } from "@calypso/chat-types";

const SPECIALIST_MEDIA_TOOLS = new Set<ToolName>([
  "image.generate",
  "image.edit",
  "audio.speech",
  "video.generate",
  "video.render",
]);

const careerPack: SkillPack = {
  id: "personal-agent.career",
  version: 1,
  displayName: "Career",
  description: "Career mode pack.",
  systemPromptBlock:
    "You are Calypso in career mode. Help with offers, resumes, and salary research.",
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
  capabilitySuiteIds: ["text"],
  defaultNamespace: "work",
  linkedFolderScopes: {},
  uiHints: { icon: "briefcase", accentToken: "accent-blue" },
};

const defaultPack: SkillPack = {
  id: "personal-agent.default",
  version: 1,
  displayName: "Default",
  description: "Default pack.",
  systemPromptBlock: "You are Calypso, a private personal agent.",
  toolScopes: ["memory.list", "memory.read", "folder.read"],
  capabilitySuiteIds: ["text"],
  defaultNamespace: "default",
  linkedFolderScopes: {},
  uiHints: { icon: "default", accentToken: "accent-default" },
};

const mediaPack: SkillPack = {
  ...defaultPack,
  toolScopes: [
    "memory.list",
    "image.generate",
    "image.edit",
    "audio.transcribe",
    "audio.speech",
  ],
};

describe("assembleSystemPrompt", () => {
  it("includes the pack's systemPromptBlock verbatim", () => {
    const out = assembleSystemPrompt(careerPack);
    expect(out).toContain(careerPack.systemPromptBlock);
  });

  it("lists every tool that IS in pack.toolScopes", () => {
    const out = assembleSystemPrompt(careerPack);
    for (const tool of careerPack.toolScopes) {
      expect(out).toContain(tool);
    }
  });

  it("does NOT mention any Tier A/B tool that is out of scope", () => {
    const out = assembleSystemPrompt(defaultPack);
    // defaultPack has only memory.list/read + folder.read
    for (const oos of [
      "memory.write",
      "folder.write",
      "folder.list",
      "email.draft",
      "doc.draft",
      "event.draft",
      "web.fetch",
      "file.read",
    ]) {
      expect(out).not.toContain(oos);
    }
  });

  it("never mentions Tier C/D tool names", () => {
    const out = assembleSystemPrompt(careerPack);
    for (const banned of [
      "mailbox.read",
      "calendar.read",
      "email.send",
      "event.create",
      "form.submit",
      "web.automation",
      "browser.use",
      "plaid.connect",
    ]) {
      expect(out).not.toContain(banned);
    }
  });

  it("does not advertise specialist media tools until gateway adapters exist", () => {
    const out = assembleSystemPrompt(mediaPack);

    expect(out).toContain("memory.list");
    expect(out).toContain("audio.transcribe");
    expect(out).not.toContain("image.generate");
    expect(out).not.toContain("image.edit");
    expect(out).not.toContain("audio.speech");
  });

  it("connector guidance names ONLY the scoped connector tools (no OUT_OF_SCOPE bait)", () => {
    // All three scoped → full discover → read/act guidance.
    const all = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["connector.list", "connector.read", "connector.act"],
    });
    expect(all).toContain("connector.list");
    expect(all).toContain("connector.read");
    expect(all).toContain("connector.act");

    // Only connector.read scoped (e.g. a narrowed orchestrator worker) → the
    // prompt must NOT name connector.list / connector.act, or the model loops on
    // OUT_OF_SCOPE retries (the gateway rejects unscoped names).
    const readOnly = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["connector.read"],
    });
    expect(readOnly).toContain("connector.read");
    expect(readOnly).not.toContain("connector.list");
    expect(readOnly).not.toContain("connector.act");

    // Only connector.act scoped → never names connector.list / connector.read.
    const actOnly = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["connector.act"],
    });
    expect(actOnly).toContain("connector.act");
    expect(actOnly).not.toContain("connector.list");
    expect(actOnly).not.toContain("connector.read");

    // No connector tools → no connector guidance at all.
    const none = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["memory.read"],
    });
    expect(none).not.toContain("connector.");
  });

  it("advertises every non-specialist scoped tool", () => {
    const liveToolScopes = TOOL_NAMES.filter(
      (tool) => !SPECIALIST_MEDIA_TOOLS.has(tool),
    );
    const out = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: liveToolScopes,
    });

    for (const tool of liveToolScopes) {
      expect(out).toContain(tool);
    }
  });

  it("uses the literal <tool>...</tool> fence the parser expects", () => {
    const out = assembleSystemPrompt(defaultPack);
    // Documents the tool-call format used by parse-tool-call.ts
    expect(out).toContain("<tool>");
    expect(out).toContain("</tool>");
  });

  it("documents the active default namespace from the pack", () => {
    const out = assembleSystemPrompt(careerPack);
    expect(out).toContain("work");
  });

  it("requires folderId for file.read and does not advertise folder.read globs", () => {
    const out = assembleSystemPrompt(careerPack);
    expect(out).toContain(
      'file.read: Read one user-attached file by filename. Text, markdown, code, JSON, YAML, DOCX, searchable PDF, RTF, and iWork QuickLook previews may include extracted plaintext as text.\n    args: { "folderId": string, "displayName": string, "filename": string }',
    );
    expect(out).toContain(
      'folder.read: Read files from a linked folder. Text, markdown, code, JSON, YAML, DOCX, searchable PDF, RTF, and iWork QuickLook previews may include extracted plaintext as text.\n    args: { "folderId": string, "displayName": string }',
    );
    expect(out).not.toContain("globs");
  });

  it("includes encrypted linked-folder context and write permission instructions", () => {
    const out = assembleSystemPrompt(careerPack, {
      linkedFolders: [
        {
          folderId: "fld_career",
          displayName: "Career",
          status: "granted",
        },
      ],
      writePermissionMode: "auto_review",
    });

    expect(out).toContain("Linked folders available to this skill");
    expect(out).toContain('"folderId":"fld_career"');
    expect(out).toContain('"displayName":"Career"');
    expect(out).toContain("Auto-review");
  });

  it("tells the agent to preserve originals by writing adjusted copies", () => {
    const out = assembleSystemPrompt(careerPack);

    expect(out).toContain("Never directly edit or overwrite");
    expect(out).toContain("write the adjusted copy");
    expect(out).toContain("next available copy filename");
  });

  it("documents that mobile linked-folder writes may be root-level filenames only", () => {
    const out = assembleSystemPrompt(careerPack);

    expect(out).toContain("Mobile linked-folder writes may be root-level filenames only");
  });

  it("tells the agent Google stubs require an explicit export", () => {
    const out = assembleSystemPrompt(careerPack);

    expect(out).toContain("Google local stubs are pointers");
    expect(out).toContain("requires the user to connect Google Drive");
  });

  it("keeps media and binary-edit claims bounded and confirmation-aware", () => {
    const out = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: [
        "folder.write",
        "image.ocr",
        "image.transform",
        "audio.transcribe",
        "video.transcribe",
        "document.edit",
        "pdf.edit",
      ],
      capabilitySuiteIds: [
        "image",
        "audio",
        "video",
        "office-document",
        "pdf",
      ],
    });

    expect(out).toContain("current 5 MiB linked-folder file budget");
    expect(out).toContain("short clips or compressed files");
    expect(out).toContain("do not say the file has been saved");
    expect(out).toContain("awaiting user confirmation");
    expect(out).toContain("bounded DOCX/PDF transforms");
  });

  it("treats output-producing transforms as client-mediated folder writes", () => {
    const out = assembleSystemPrompt(
      {
        ...defaultPack,
        toolScopes: [
          "file.read",
          "audio.inspect",
          "audio.transcribe",
          "audio.transform",
        ],
        capabilitySuiteIds: ["audio"],
      },
      { writePermissionMode: "full_access" },
    );

    expect(out).toContain("Full access");
    expect(out).toContain("For transform/edit tools");
    expect(out).toContain("outputPath");
    expect(out).not.toContain("Folder writes are not available");
    expect(out).not.toContain("folder.write");
  });

  it("advertises width-only image resize as a valid tool shape", () => {
    const out = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["image.transform"],
      capabilitySuiteIds: ["image"],
    });

    expect(out).toContain('"maxWidth"?: number');
    expect(out).toContain('"maxHeight"?: number');
    expect(out).toContain("at least one of maxWidth/maxHeight");
  });

  it("keeps the web.search trap line when only web.fetch is scoped", () => {
    const out = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["web.fetch"],
    });
    expect(out).toContain("There is no web.search tool");
    expect(out).toContain("web.fetch");
    expect(out).not.toContain("No web access is available this turn");
  });

  it("does NOT say web access is unavailable when only research.ask is scoped (it IS the gated web path)", () => {
    // Regression: the planner routes a research-heavy subtask to research.ask
    // ONLY (web.fetch stripped). The worker prompt must then describe
    // research.ask as the (gated) web path, not claim the web is unavailable —
    // otherwise the model declines to look anything up and the verbatim-query
    // approval modal never fires.
    const out = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["memory.read", "research.ask"],
    });
    expect(out).not.toContain("No web access is available this turn");
    expect(out).toContain("research.ask");
    expect(out.toLowerCase()).toContain("approve");
  });

  it("explains when to prefer research.ask over web.fetch when both are scoped", () => {
    const out = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["web.fetch", "research.ask"],
    });
    expect(out).toContain("research.ask");
    expect(out).toContain("web.fetch");
    expect(out).not.toContain("web.fetch is the only web tool");
    expect(out).not.toContain("No web access is available this turn");
  });

  it("says the web is unavailable when neither web tool is scoped", () => {
    const out = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["memory.read", "folder.read"],
    });
    expect(out).toContain("No web access is available this turn");
    expect(out).not.toContain("research.ask");
    expect(out).not.toContain("web.fetch");
  });

  it("states that the available tool list is exhaustive for scoped subtasks", () => {
    const out = assembleSystemPrompt({
      ...defaultPack,
      toolScopes: ["audio.transcribe"],
    });

    expect(out).toContain("Available tools list below is authoritative");
    expect(out).toContain("Only those tools are callable");
    expect(out).toContain("Use exact tool names only");
  });

  it("does not call folder writes globally unavailable when a subtask is narrowed", () => {
    const out = assembleSystemPrompt(
      {
        ...careerPack,
        toolScopes: ["web.fetch"],
      },
      {
        fullSkillToolScopes: careerPack.toolScopes,
        writePermissionMode: "full_access",
      },
    );

    expect(out).toContain("Current subtask has no folder-write tool available");
    expect(out).toContain("Later subtasks may receive folder-write tools");
    expect(out).toContain("Full access");
    expect(out).not.toContain("Folder writes are not available to this skill");
  });

  it("never includes the words 'Memory' or 'Context' as user-facing labels (internal arch may; the prompt is shown to the LLM only, but we keep terminology consistent)", () => {
    // Tighten progressive: the prompt may use 'memory' as the tool-name
    // prefix but must not introduce 'Context' / 'Memory' as a distinct label
    // that could leak into model responses to the user.
    const out = assembleSystemPrompt(careerPack);
    expect(out).not.toMatch(/\bContext:\s*work/);
    expect(out).not.toMatch(/\bUse context\b/);
  });

  it("emits a stable string for identical packs (deterministic)", () => {
    const a = assembleSystemPrompt(careerPack);
    const b = assembleSystemPrompt(careerPack);
    expect(a).toBe(b);
  });

  // Provider prompt caching (src/providers/prompt-cache.ts) only earns a hit
  // when the cached prefix — the system block + early messages — is
  // byte-identical turn to turn and request to request. The agent loop only
  // ever APPENDS tool results (it freezes and never mutates the prefix), so the
  // sole way the prefix can silently drift is if assembleSystemPrompt itself
  // bakes in volatile content (a timestamp, a per-request nonce, an unstable
  // collection order). That drift produces no error — it just quietly collapses
  // the cache hit rate and the savings with it. These tests pin the invariant.
  describe("prompt-cache prefix stability", () => {
    const buildCacheContext = () => ({
      linkedFolders: [
        { folderId: "fld_career", displayName: "Career", status: "granted" as const },
      ],
      writePermissionMode: "auto_review" as const,
    });

    it("is byte-identical across separate context objects with equal content", () => {
      // Distinct array + object identity each call: a real per-turn caller
      // rebuilds the context, so equality must hold on value, not reference.
      const first = assembleSystemPrompt(careerPack, buildCacheContext());
      const second = assembleSystemPrompt(careerPack, buildCacheContext());
      expect(first).toBe(second);
    });

    it("embeds no timestamp, date, or nonce that would bust the cached prefix", () => {
      const out = assembleSystemPrompt(careerPack, buildCacheContext());
      // ISO-8601 datetime (e.g. new Date().toISOString()) and bare dates.
      expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      // 13-digit epoch-millisecond stamps (Date.now()).
      expect(out).not.toMatch(/\b1[6-9]\d{11}\b/);
      // A concrete UUID. The fence example intentionally uses the literal
      // "<uuid>" placeholder, so a real UUID here would signal injected state.
      expect(out).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
    });
  });

  it("documents the memory.write delta shape with the action + kind enums (regression: opaque DreamDelta caused INVALID_DELTA_ACTION)", () => {
    const out = assembleSystemPrompt(careerPack);
    expect(out).toContain("memory.write");
    // The action enum the validator accepts must be literal in the prompt,
    // otherwise the model guesses an action and the write fails with
    // INVALID_DELTA_ACTION (the agent-proof failure this fixes).
    for (const action of ["ADD", "UPDATE", "SUPERSEDE", "TOMBSTONE"]) {
      expect(out).toContain(action);
    }
    // The record.kind enum must be literal too.
    for (const kind of ["fact", "preference", "episode", "lesson", "goal"]) {
      expect(out).toContain(kind);
    }
    // Must NOT advertise the opaque bare type name the model cannot expand.
    expect(out).not.toContain('{ "delta": DreamDelta }');
  });

  it("survives a pack with the smallest possible scope set (singleton)", () => {
    const tinyPack: SkillPack = {
      ...defaultPack,
      toolScopes: ["memory.list"],
    };
    const out = assembleSystemPrompt(tinyPack);
    expect(out).toContain("memory.list");
    expect(out).not.toContain("memory.read");
    expect(out).not.toContain("memory.write");
  });

  it("includes the global not-advice disclaimer rule for legal/medical information (mechanism A)", () => {
    // The rule must apply to EVERY pack — including General mode — so a
    // legal/health question asked outside the specialist packs still gets the
    // disclaimer (industry-standard, founder decision 2026-06-03).
    const out = assembleSystemPrompt(defaultPack).toLowerCase();
    expect(out).toContain("not legal advice");
    expect(out).toContain("not medical advice");
  });
});
