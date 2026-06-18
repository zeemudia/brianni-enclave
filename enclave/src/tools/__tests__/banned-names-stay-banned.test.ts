import { describe, expect, it } from "vitest";
import { TOOL_NAMES, type ToolName } from "@calypso/chat-types";
import { isToolBanned, isToolInScope } from "../scope-check";

const BANNED_CALENDAR_NAMES = ["calendar.read", "event.create"];
const NEVER_VALID = [
  ...BANNED_CALENDAR_NAMES,
  "calendar.write", "event.update", "event.delete", "event.respond",
];

describe("banned per-service names stay banned (spec §7.1, Finding R1-3)", () => {
  it("the canonical banned calendar names report isToolBanned", () => {
    for (const b of BANNED_CALENDAR_NAMES) expect(isToolBanned(b)).toBe(true);
  });

  it("none of the per-service names are valid TOOL_NAMES", () => {
    for (const n of NEVER_VALID) expect([...TOOL_NAMES]).not.toContain(n);
  });

  it("a banned name is not in scope even if a pack erroneously lists it", () => {
    for (const b of BANNED_CALENDAR_NAMES) {
      expect(isToolInScope(b, { toolScopes: [b as ToolName] })).toBe(false);
    }
  });
});
