import { describe, it, expect } from "vitest";

import { ToolCallStreamParser } from "../agent/parse-tool-call";

describe("ToolCallStreamParser", () => {
  it("emits plain assistant text between fences as 'text' events", () => {
    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push("Hello world")) events.push(e);
    for (const e of p.push(" more text")) events.push(e);
    expect(events).toEqual([
      { kind: "text", value: "Hello world" },
      { kind: "text", value: " more text" },
    ]);
  });

  it("buffers and parses a complete <tool>...</tool> JSON block", () => {
    const p = new ToolCallStreamParser();
    const tool = JSON.stringify({
      invocationId: "inv1",
      toolName: "memory.list",
      args: { namespace: "default" },
    });
    const stream = `Sure. <tool>${tool}</tool> done.`;
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(stream)) events.push(e);
    expect(events).toContainEqual({ kind: "text", value: "Sure. " });
    // Codex finding #2: invocationId is enclave-minted by the agent
    // loop, NOT parsed from the model's output. Parser drops it.
    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "memory.list",
        args: { namespace: "default" },
      },
    });
    expect(events).toContainEqual({ kind: "text", value: " done." });
  });

  it("handles a fence split across multiple push() calls", () => {
    const p = new ToolCallStreamParser();
    const tool = JSON.stringify({
      invocationId: "inv2",
      toolName: "memory.read",
      args: { id: "m1" },
    });
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const chunk of ["<too", "l>" + tool.slice(0, 10), tool.slice(10), "</tool>"]) {
      for (const e of p.push(chunk)) events.push(e);
    }
    const tools = events.filter((e: { kind: string }) => e.kind === "tool");
    expect(tools).toHaveLength(1);
    expect((tools[0] as { payload: { toolName: string } }).payload.toolName).toBe(
      "memory.read",
    );
  });

  it("emits a parse-error event on malformed JSON inside the fence", () => {
    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push("<tool>{ this is not json }</tool>")) events.push(e);
    const errs = events.filter(
      (e: { kind: string }) => e.kind === "parse-error",
    );
    expect(errs).toHaveLength(1);
  });

  it("rejects a tool-call missing required fields (toolName / args)", () => {
    // Codex finding #2: invocationId is enclave-minted, so the parser
    // no longer requires it from the model. toolName + args remain
    // required.
    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(
      // toolName present, but args missing
      `<tool>${JSON.stringify({ toolName: "memory.list" })}</tool>`,
    )) {
      events.push(e);
    }
    const errs = events.filter(
      (e: { kind: string }) => e.kind === "parse-error",
    );
    expect(errs).toHaveLength(1);
  });

  it("accepts a tool-call WITHOUT model-supplied invocationId (codex finding #2 — enclave mints it)", () => {
    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(
      `<tool>${JSON.stringify({ toolName: "memory.list", args: { namespace: "default" } })}</tool>`,
    )) {
      events.push(e);
    }
    const tools = events.filter((e: { kind: string }) => e.kind === "tool");
    expect(tools).toHaveLength(1);
    // Parser drops model-supplied invocationId — replaced with empty
    // string and minted by the loop.
    expect(
      (tools[0] as { payload: { invocationId: string } }).payload.invocationId,
    ).toBe("");
  });

  it("rejects a tool-call whose toolName is a banned Tier C/D name", () => {
    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    const tool = JSON.stringify({
      invocationId: "inv3",
      toolName: "email.send",
      args: {},
    });
    for (const e of p.push(`<tool>${tool}</tool>`)) events.push(e);
    const errs = events.filter(
      (e: { kind: string }) => e.kind === "parse-error",
    );
    expect(errs).toHaveLength(1);
    // The error reason must call out the banned name so the agent loop can
    // reinject a corrective message AND record a gateway_rejected ledger entry.
    expect((errs[0] as { reason: string }).reason).toMatch(/UNKNOWN_TOOL_NAME|TIER_C_D/);
  });

  it("yields multiple sequential tool calls in one stream", () => {
    const p = new ToolCallStreamParser();
    // Codex finding #2: model-supplied invocationId is ignored. Both
    // tool calls below render with the same dropped id; the agent loop
    // mints fresh uuids per emission.
    const tool1 = JSON.stringify({
      toolName: "memory.list",
      args: { namespace: "default" },
    });
    const tool2 = JSON.stringify({
      toolName: "memory.read",
      args: { id: "m1" },
    });
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(`<tool>${tool1}</tool> bridging <tool>${tool2}</tool>`)) {
      events.push(e);
    }
    const tools = events.filter((e: { kind: string }) => e.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(
      (tools[1] as { payload: { toolName: string } }).payload.toolName,
    ).toBe("memory.read");
  });

  it("ignores a stray closing </tool> with no open fence", () => {
    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push("plain text </tool> still plain")) events.push(e);
    const errs = events.filter(
      (e: { kind: string }) => e.kind === "parse-error",
    );
    expect(errs).toHaveLength(0);
    const text = events
      .filter((e): e is { kind: "text"; value: string } => e.kind === "text")
      .map((e) => e.value)
      .join("");
    expect(text).toContain("plain text");
    expect(text).toContain("still plain");
  });

  it("flush() reports an open-fence-at-EOF error", () => {
    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push("<tool>{")) events.push(e);
    for (const e of p.flush()) events.push(e);
    const errs = events.filter(
      (e: { kind: string }) => e.kind === "parse-error",
    );
    expect(errs).toHaveLength(1);
    expect((errs[0] as { reason: string }).reason).toMatch(/UNCLOSED_FENCE/);
  });

  it("ignores model-supplied invocationId — codex finding #2 (enclave mints fresh)", () => {
    const p = new ToolCallStreamParser();
    const tool = JSON.stringify({
      // An attacker-controlled or model-supplied id MUST not influence
      // resolver routing. The parser strips this verbatim.
      invocationId: "predicted_by_attacker",
      toolName: "memory.list",
      args: { namespace: "default" },
    });
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(`<tool>${tool}</tool>`)) events.push(e);
    const t = events.find((e: { kind: string }) => e.kind === "tool");
    expect((t as { payload: { invocationId: string } }).payload.invocationId).toBe("");
  });

  it("strips Tier C/D tool name even when surrounded by valid tool calls", () => {
    const p = new ToolCallStreamParser();
    const ok = JSON.stringify({
      invocationId: "ok1",
      toolName: "memory.list",
      args: { namespace: "default" },
    });
    const bad = JSON.stringify({
      invocationId: "bad1",
      toolName: "mailbox.read",
      args: {},
    });
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(`<tool>${ok}</tool><tool>${bad}</tool>`))
      {events.push(e);}
    const tools = events.filter((e: { kind: string }) => e.kind === "tool");
    const errs = events.filter(
      (e: { kind: string }) => e.kind === "parse-error",
    );
    expect(tools).toHaveLength(1);
    expect(errs).toHaveLength(1);
  });
});
