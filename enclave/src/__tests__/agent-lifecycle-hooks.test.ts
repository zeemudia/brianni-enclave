import { describe, it, expect, vi } from "vitest";

import { runAgentLoop, type AgentLoopDeps } from "../agent/loop";
import { ToolGateway, type ClientBridge } from "../tools";
import type { LifecycleHooks, TurnContext } from "../agent/harness/types";
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  SkillPack,
  ToolInvocationFrame,
  ToolResultFrame,
} from "@calypso/chat-types";

function mkPack(scopes: SkillPack["toolScopes"]): SkillPack {
  return {
    id: "personal-agent.default",
    version: 1,
    displayName: "Default",
    description: "test pack",
    systemPromptBlock: "You are Calypso.",
    toolScopes: scopes,
    capabilitySuiteIds: ["text"],
    defaultNamespace: "default",
    linkedFolderScopes: {},
    uiHints: { icon: "default", accentToken: "accent-default" },
  };
}

function mkProvider(scripts: string[][]): ChatProcessor {
  let invocation = 0;
  return {
    async *streamChat(_messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const tokens = scripts[invocation] ?? [];
      invocation += 1;
      for (let i = 0; i < tokens.length; i += 1) {
        const isLast = i === tokens.length - 1;
        yield {
          id: `chunk_${invocation}_${i}`,
          choices: [
            { delta: { content: tokens[i] }, finish_reason: isLast ? "stop" : null },
          ],
        };
      }
    },
  };
}

function mkBridge(
  handler: (frame: ToolInvocationFrame) => ToolResultFrame,
): ClientBridge {
  return { invokeClient: vi.fn().mockImplementation(async (frame) => handler(frame)) };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const TOOL = JSON.stringify({
  invocationId: "inv1",
  toolName: "memory.list",
  args: { namespace: "default" },
});

function depsWith(
  hooks: LifecycleHooks[],
  scripts: string[][],
): { deps: AgentLoopDeps; events: () => Promise<unknown[]> } {
  const bridge = mkBridge((frame) => ({
    invocationId: frame.invocationId,
    outcome: "ok",
    resultJson: { records: [{ id: "m1", text: "Hi" }] },
  }));
  const deps: AgentLoopDeps = {
    gateway: new ToolGateway({ clientBridge: bridge }),
    provider: mkProvider(scripts),
    pack: mkPack(["memory.list", "memory.read"]),
    agentTurnId: "turn1",
    hooks,
  };
  return {
    deps,
    events: () =>
      collect(runAgentLoop(deps, { messages: [{ role: "user", content: "hi" }] })),
  };
}

describe("runAgentLoop — lifecycle hooks", () => {
  it("onTurnStart fires once with pack, turn id, and the assembled messages", async () => {
    let seen: TurnContext | null = null;
    let calls = 0;
    const hook: LifecycleHooks = {
      onTurnStart(ctx) {
        calls += 1;
        seen = ctx;
      },
    };
    await depsWith([hook], [["Hello."]]).events();

    expect(calls).toBe(1);
    expect(seen!.pack.id).toBe("personal-agent.default");
    expect(seen!.agentTurnId).toBe("turn1");
    expect(seen!.messages[0].role).toBe("system");
    expect(seen!.messages.some((m) => m.content === "hi")).toBe(true);
  });

  it("onToolInvoke fires with the dispatched wire frame", async () => {
    const frames: ToolInvocationFrame[] = [];
    const hook: LifecycleHooks = {
      onToolInvoke(frame) {
        frames.push(frame);
      },
    };
    await depsWith([hook], [[`<tool>${TOOL}</tool>`], ["Done."]]).events();

    expect(frames).toHaveLength(1);
    expect(frames[0].toolName).toBe("memory.list");
    // The id is enclave-minted (a UUID), not the model-supplied "inv1".
    expect(frames[0].invocationId).not.toBe("inv1");
  });

  it("onToolInvoke receives the dispatched SANITISED wire frame, not the model's raw frame", async () => {
    // A gateway whose prepareInvocation returns a DISTINCT canonicalised frame
    // (different args identity) than the model's pendingTool — proving the hook
    // (and the reinjection chain) see what was actually dispatched.
    const dispatched: ToolInvocationFrame[] = [];
    const gateway = {
      prepareInvocation: (frame: ToolInvocationFrame) => ({
        ok: true,
        wireFrame: {
          ...frame,
          args: { canonical: true, namespace: "default" },
        },
      }),
      dispatch: async (frame: ToolInvocationFrame) => {
        dispatched.push(frame);
        return {
          invocationId: frame.invocationId,
          outcome: "ok" as const,
          resultJson: { records: [] },
          ledgerEntry: {
            invokedAt: "2026-06-04T00:00:00.000Z",
            toolName: frame.toolName,
            scope: "",
            approvedPath: null,
            outcome: "ok" as const,
            reason: null,
            skillPackId: "personal-agent.default",
            turnId: "turn1",
          },
        };
      },
    } as unknown as ToolGateway;

    let captured: ToolInvocationFrame | null = null;
    const hook: LifecycleHooks = {
      onToolInvoke(frame) {
        captured = frame;
      },
    };
    await collect(
      runAgentLoop(
        {
          gateway,
          provider: mkProvider([[`<tool>${TOOL}</tool>`], ["done"]]),
          pack: mkPack(["memory.list"]),
          agentTurnId: "turn1",
          hooks: [hook],
        },
        { messages: [{ role: "user", content: "go" }] },
      ),
    );

    // The hook saw the canonicalised wire frame (args.canonical), == dispatched.
    expect((captured as unknown as ToolInvocationFrame).args).toMatchObject({
      canonical: true,
    });
    expect(dispatched[0].args).toMatchObject({ canonical: true });

    // And the frame handed to the hook is frozen — a hook cannot mutate the
    // object that gets dispatched.
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("onTurnEnd fires once with 'done' on normal completion", async () => {
    const reasons: string[] = [];
    const hook: LifecycleHooks = {
      onTurnEnd(reason) {
        reasons.push(reason);
      },
    };
    await depsWith([hook], [["All done."]]).events();

    expect(reasons).toEqual(["done"]);
  });

  it("onTurnEnd fires once with 'error' on TOOL_LIMIT_EXCEEDED", async () => {
    const reasons: string[] = [];
    const hook: LifecycleHooks = {
      onTurnEnd(reason) {
        reasons.push(reason);
      },
    };
    const provider: ChatProcessor = {
      async *streamChat() {
        yield {
          id: "loop",
          choices: [{ delta: { content: `<tool>${TOOL}</tool>` }, finish_reason: "stop" }],
        };
      },
    };
    const bridge = mkBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: { records: [] },
    }));
    await collect(
      runAgentLoop(
        {
          gateway: new ToolGateway({ clientBridge: bridge }),
          provider,
          pack: mkPack(["memory.list"]),
          agentTurnId: "turn1",
          maxToolCalls: 2,
          hooks: [hook],
        },
        { messages: [{ role: "user", content: "go" }] },
      ),
    );

    expect(reasons).toEqual(["error"]);
  });

  it("transformOutChunk rewrites streamed text before it reaches the wire", async () => {
    const hook: LifecycleHooks = {
      transformOutChunk: (text) => text.toUpperCase(),
    };
    const events = await depsWith([hook], [["Hello", " world"]]).events();
    const text = events
      .filter((e) => (e as { kind: string }).kind === "chunk")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("HELLO WORLD");
  });

  it("transformOutChunk returning null drops the chunk", async () => {
    const hook: LifecycleHooks = {
      transformOutChunk: (text) => (text.includes("secret") ? null : text),
    };
    const events = await depsWith(
      [hook],
      [["safe ", "secret-bit ", "tail"]],
    ).events();
    const text = events
      .filter((e) => (e as { kind: string }).kind === "chunk")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("safe tail");
  });

  it("chains transformOutChunk across multiple hooks in order", async () => {
    const order: string[] = [];
    const a: LifecycleHooks = {
      transformOutChunk: (t) => {
        order.push("a");
        return t + "[a]";
      },
    };
    const b: LifecycleHooks = {
      transformOutChunk: (t) => {
        order.push("b");
        return t + "[b]";
      },
    };
    const events = await depsWith([a, b], [["x"]]).events();
    const text = events
      .filter((e) => (e as { kind: string }).kind === "chunk")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("x[a][b]");
    expect(order).toEqual(["a", "b"]);
  });

  it("hands hooks a frozen pack snapshot (cannot weaken later scope checks)", async () => {
    let ctxPack: unknown;
    const hook: LifecycleHooks = {
      onTurnStart(ctx) {
        ctxPack = ctx.pack;
      },
    };
    await depsWith([hook], [["hi"]]).events();

    expect(Object.isFrozen(ctxPack)).toBe(true);
    expect(
      Object.isFrozen((ctxPack as { toolScopes: unknown }).toolScopes),
    ).toBe(true);
  });

  it("isolates hook exceptions — a throwing hook does not abort the turn", async () => {
    const reached: string[] = [];
    const thrower: LifecycleHooks = {
      onTurnStart() {
        throw new Error("boom");
      },
    };
    const observer: LifecycleHooks = {
      onTurnEnd(reason) {
        reached.push(reason);
      },
    };
    const events = await depsWith([thrower, observer], [["hi"]]).events();

    expect(events.some((e) => (e as { kind: string }).kind === "done")).toBe(true);
    // The throwing hook did not prevent the later hook from running.
    expect(reached).toEqual(["done"]);
  });

  it("onTurnEnd fires once with 'error' when the turn throws (e.g. provider explodes)", async () => {
    const reasons: string[] = [];
    const hook: LifecycleHooks = {
      onTurnEnd(reason) {
        reasons.push(reason);
      },
    };
    const provider: ChatProcessor = {

      async *streamChat(): AsyncGenerator<ChatChunk> {
        throw new Error("provider exploded");
      },
    };
    const bridge = mkBridge((frame) => ({
      invocationId: frame.invocationId,
      outcome: "ok",
    }));

    await expect(
      collect(
        runAgentLoop(
          {
            gateway: new ToolGateway({ clientBridge: bridge }),
            provider,
            pack: mkPack(["memory.list"]),
            agentTurnId: "turn1",
            hooks: [hook],
          },
          { messages: [{ role: "user", content: "hi" }] },
        ),
      ),
    ).rejects.toThrow("provider exploded");

    // The thrown turn still ends — exactly once, with 'error'.
    expect(reasons).toEqual(["error"]);
  });

  it("a throwing transformOutChunk leaves the chunk unchanged", async () => {
    const hook: LifecycleHooks = {
      transformOutChunk() {
        throw new Error("nope");
      },
    };
    const events = await depsWith([hook], [["Hello", " world"]]).events();
    const text = events
      .filter((e) => (e as { kind: string }).kind === "chunk")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("Hello world");
  });

  it("is a no-op when no hooks are supplied", async () => {
    const bridge = mkBridge((frame) => ({ invocationId: frame.invocationId, outcome: "ok" }));
    const events = await collect(
      runAgentLoop(
        {
          gateway: new ToolGateway({ clientBridge: bridge }),
          provider: mkProvider([["Hello world"]]),
          pack: mkPack(["memory.list"]),
          agentTurnId: "turn1",
        },
        { messages: [{ role: "user", content: "hi" }] },
      ),
    );
    const text = events
      .filter((e) => (e as { kind: string }).kind === "chunk")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("Hello world");
  });
});
