import { describe, it, expect } from "vitest";

import { ToolGateway } from "../tools";
import type {
  ToolInvocationFrame,
  SkillPack,
} from "@calypso/chat-types";
import { ToolCallStreamParser } from "../agent/parse-tool-call";

/**
 * §15.5 — Tier C/D absence at runtime, not just at the type system.
 * Every forbidden name must be rejected at three layers:
 *   1. The streaming parser (a model emitting <tool>{name}</tool> →
 *      parse-error with TIER_C_D_BANNED:<name>).
 *   2. The gateway dispatcher (a synthetic frame bypassing the parser).
 *   3. Even when a skill pack erroneously scopes the name, the gateway
 *      banned-check trumps OUT_OF_SCOPE.
 */
const FORBIDDEN_AT_MVP = [
  "mailbox.read",
  "calendar.read",
  "email.send",
  "event.create",
  "form.submit",
  "web.automation",
  "browser.use",
  "plaid.connect",
] as const;

function pack(scopes: SkillPack["toolScopes"] = ["memory.list"]): SkillPack {
  return {
    id: "personal-agent.default",
    version: 1,
    displayName: "Default",
    description: "test",
    systemPromptBlock: "x",
    toolScopes: scopes,
    capabilitySuiteIds: ["text"],
    defaultNamespace: "default",
    linkedFolderScopes: {},
    uiHints: { icon: "default", accentToken: "accent-default" },
  };
}

describe("§15.5 — Tier C/D absence (integration)", () => {
  it.each(FORBIDDEN_AT_MVP)(
    "parser rejects <tool>{toolName:'%s'}</tool> with TIER_C_D_BANNED:<name>",
    (name) => {
      const parser = new ToolCallStreamParser();
      const events = [
        ...parser.push(
          `<tool>${JSON.stringify({
            invocationId: "x",
            toolName: name,
            args: {},
          })}</tool>`,
        ),
      ];
      const errors = events.filter((e) => e.kind === "parse-error");
      expect(errors).toHaveLength(1);
      expect((errors[0] as { reason: string }).reason).toBe(
        `TIER_C_D_BANNED:${name}`,
      );
    },
  );

  it.each(FORBIDDEN_AT_MVP)(
    "gateway rejects synthetic %s frame with TIER_C_D_BANNED (even if pack lists it)",
    async (name) => {
      const gateway = new ToolGateway({
        clientBridge: {
          invokeClient: async () => {
            throw new Error("Bridge should never be reached for banned tools");
          },
        },
      });
      const widePack = pack(["memory.list", name as never]);
      const frame: ToolInvocationFrame = {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: name as never,
        args: {},
      };
      const r = await gateway.dispatch(frame, widePack, "turn1");
      expect(r.outcome).toBe("gateway_rejected");
      expect(r.reason).toBe("TIER_C_D_BANNED");
      expect(r.ledgerEntry.outcome).toBe("gateway_rejected");
      expect(r.ledgerEntry.reason).toBe("TIER_C_D_BANNED");
    },
  );

  it("an 'autonomous folder.write' (no bridge response) cannot complete", async () => {
    // The gateway emits a TOOL_INVOCATION and awaits the bridge. If the
    // client never resolves, the loop must surface this — there is no
    // path where the enclave performs the write on its own.
    const gateway = new ToolGateway({
      clientBridge: {
        invokeClient: () => new Promise(() => undefined), // never resolves
      },
    });
    const frame: ToolInvocationFrame = {
      invocationId: "inv1",
      agentTurnId: "turn1",
      toolName: "folder.write",
      args: {
        folderId: "fld_01",
        displayName: "Career",
        path: "x.md",
        contentBytesB64: Buffer.from("# x").toString("base64"),
      },
    };
    const racing = Promise.race([
      gateway.dispatch(frame, pack(["folder.write"]), "turn1"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    const r = await racing;
    expect(r).toBe("timeout");
  });
});
