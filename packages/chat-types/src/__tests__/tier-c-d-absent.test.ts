import { describe, it, expect } from "vitest";

import { TOOL_NAMES, ToolNameSchema } from "../skill-pack";
import {
  ToolInvocationFrameSchema,
  ToolCallLedgerEntrySchema,
} from "../tool-protocol";

const FORBIDDEN_MVP = [
  "mailbox.read",
  "calendar.read",
  "email.send",
  "event.create",
  "form.submit",
  "web.automation",
  "browser.use",
  "plaid.connect",
] as const;

describe("MVP tier C/D absence (Chunk H + spec §15.5)", () => {
  it.each(FORBIDDEN_MVP)(
    "%s is not in TOOL_NAMES",
    (name) => {
      expect((TOOL_NAMES as readonly string[]).includes(name)).toBe(false);
    },
  );

  it.each(FORBIDDEN_MVP)(
    "ToolNameSchema rejects %s",
    (name) => {
      expect(() => ToolNameSchema.parse(name)).toThrow();
    },
  );

  it.each(FORBIDDEN_MVP)(
    "ToolInvocationFrameSchema rejects %s as toolName",
    (name) => {
      expect(() =>
        ToolInvocationFrameSchema.parse({
          invocationId: "inv_x",
          agentTurnId: "turn_x",
          toolName: name,
          args: {},
        }),
      ).toThrow();
    },
  );

  it.each(FORBIDDEN_MVP)(
    "ToolCallLedgerEntrySchema rejects %s as toolName",
    (name) => {
      expect(() =>
        ToolCallLedgerEntrySchema.parse({
          id: 1,
          invokedAt: "2026-05-11T00:00:00Z",
          toolName: name,
          scope: "x",
          approvedPath: null,
          outcome: "ok",
          reason: null,
          skillPackId: "personal-agent.default",
          turnId: "turn_x",
        }),
      ).toThrow();
    },
  );
});
