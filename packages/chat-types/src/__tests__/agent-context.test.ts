import { describe, expect, it } from "vitest";

import {
  AGENT_WRITE_PERMISSION_MODES,
  AgentRequestContextSchema,
  AgentWritePermissionModeSchema,
  MAX_AGENT_LINKED_FOLDERS,
  buildAgentLinkedFolderContext,
} from "../agent-context";

describe("agent context contract", () => {
  it("filters linked folders to the active skill binding set", () => {
    const context = buildAgentLinkedFolderContext(
      [
        {
          id: "fld_career",
          displayName: "Career",
          status: "granted",
          handleRefKey: "secret-handle",
        },
        {
          id: "fld_money",
          displayName: "Money",
          status: "granted",
          handleRefKey: "secret-money-handle",
        },
        {
          id: "fld_old",
          displayName: "Old",
          status: "revoked",
          handleRefKey: "secret-old-handle",
        },
      ],
      ["fld_career", "fld_old"],
    );

    expect(context).toEqual([
      {
        folderId: "fld_career",
        displayName: "Career",
        status: "granted",
      },
    ]);
  });

  it("keeps permission modes constrained to the supported UI states", () => {
    expect(AGENT_WRITE_PERMISSION_MODES).toEqual([
      "always_ask",
      "auto_review",
      "full_access",
    ]);
    expect(AgentWritePermissionModeSchema.parse("auto_review")).toBe(
      "auto_review",
    );
    expect(() => AgentWritePermissionModeSchema.parse("silent")).toThrow();
  });

  it("accepts bounded local date/time context for relative scheduling", () => {
    const localTime = {
      nowIso: "2026-06-21T16:48:00.000Z",
      localDate: "2026-06-21",
      localTime: "17:48:00",
      timeZone: "Europe/London",
      utcOffsetMinutes: 60,
    };

    const parsed = AgentRequestContextSchema.parse({ localTime });

    expect(parsed.localTime).toEqual(localTime);
  });

  it("rejects malformed local date/time context at the enclave boundary", () => {
    expect(() =>
      AgentRequestContextSchema.parse({
        localTime: {
          nowIso: "tomorrow afternoon",
          localDate: "21/06/2026",
          localTime: "5pm",
          timeZone: "Europe London",
        },
      }),
    ).toThrow();
  });

  // --- linked folders cap: cross-pack claims advocate (Task 1A.4) ---

  function folders(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      folderId: `f${i}`,
      displayName: `F${i}`,
      status: "granted" as const,
    }));
  }

  it("accepts up to MAX_AGENT_LINKED_FOLDERS linked folders (cross-pack headroom)", () => {
    expect(() =>
      AgentRequestContextSchema.parse({
        linkedFolders: folders(MAX_AGENT_LINKED_FOLDERS),
      }),
    ).not.toThrow();
  });

  it("rejects more than MAX_AGENT_LINKED_FOLDERS (hard error, never silent truncation)", () => {
    expect(() =>
      AgentRequestContextSchema.parse({
        linkedFolders: folders(MAX_AGENT_LINKED_FOLDERS + 1),
      }),
    ).toThrow();
  });

  it("buildAgentLinkedFolderContext returns all MAX_AGENT_LINKED_FOLDERS folders without truncation", () => {
    // Build MAX_AGENT_LINKED_FOLDERS folder metadata objects (all granted, all bound).
    const rawFolders = Array.from(
      { length: MAX_AGENT_LINKED_FOLDERS },
      (_, i) => ({
        id: `fld_${i}`,
        displayName: `Folder ${i}`,
        status: "granted" as const,
      }),
    );
    const boundIds = rawFolders.map((f) => f.id);

    const result = buildAgentLinkedFolderContext(rawFolders, boundIds);

    expect(result).toHaveLength(MAX_AGENT_LINKED_FOLDERS);
    expect(result[MAX_AGENT_LINKED_FOLDERS - 1]).toEqual({
      folderId: `fld_${MAX_AGENT_LINKED_FOLDERS - 1}`,
      displayName: `Folder ${MAX_AGENT_LINKED_FOLDERS - 1}`,
      status: "granted",
    });
  });

  it("buildAgentLinkedFolderContext defensively caps at MAX_AGENT_LINKED_FOLDERS", () => {
    // function defensively caps; the loud no-silent-truncation guarantee is enforced
    // at the enclave (wire-schema reject + grant-folder reject), not here.
    const rawFolders = Array.from(
      { length: MAX_AGENT_LINKED_FOLDERS + 1 },
      (_, i) => ({
        id: `fld_${i}`,
        displayName: `Folder ${i}`,
        status: "granted" as const,
      }),
    );
    const boundIds = rawFolders.map((f) => f.id);

    const result = buildAgentLinkedFolderContext(rawFolders, boundIds);

    expect(result).toHaveLength(MAX_AGENT_LINKED_FOLDERS);
  });
});
