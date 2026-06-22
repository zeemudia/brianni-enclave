import { generateKeyPairSync, sign as edSign } from "node:crypto";

import { canonicalConnectorsSigningInput } from "@calypso/chat-types";
import { describe, it, expect } from "vitest";

import { ToolCallStreamParser } from "../agent/parse-tool-call";
import {
  __resetConnectorRegistryForTest,
  initConnectorRegistry,
} from "../connectors/registry";

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

  it("normalizes a runtime connector operation alias into connector.read", () => {
    __resetConnectorRegistryForTest();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const connectors = [
      {
        id: "google-calendar",
        displayName: "Google Calendar",
        provider: "google",
        platforms: ["web"],
        oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        operations: [
          {
            id: "list_calendars",
            mutating: false,
            requiredScope: "calendar.readonly",
            paramsSchema: {},
          },
        ],
        mcp: null,
      },
    ];
    const version = 1;
    initConnectorRegistry(
      {
        version,
        connectors,
        signature: edSign(
          null,
          canonicalConnectorsSigningInput(version, connectors),
          privateKey,
        ).toString("base64"),
      },
      pem,
    );

    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(
      `<tool>${JSON.stringify({ toolName: "google-calendar.list_calendars", args: {} })}</tool>`,
    )) {
      events.push(e);
    }
    __resetConnectorRegistryForTest();

    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.read",
        args: {
          connectorId: "google-calendar",
          operation: "list_calendars",
          params: {},
        },
      },
    });
  });

  it("normalizes common calendar/listEvents aliases only when the signed registry declares the operation", () => {
    __resetConnectorRegistryForTest();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const connectors = [
      {
        id: "google-calendar",
        displayName: "Google Calendar",
        provider: "google",
        platforms: ["web"],
        oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        operations: [
          {
            id: "list_events",
            mutating: false,
            requiredScope: "calendar.readonly",
            paramsSchema: {},
          },
        ],
        mcp: null,
      },
    ];
    const version = 1;
    initConnectorRegistry(
      {
        version,
        connectors,
        signature: edSign(
          null,
          canonicalConnectorsSigningInput(version, connectors),
          privateKey,
        ).toString("base64"),
      },
      pem,
    );

    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(
      `<tool>${JSON.stringify({
        toolName: "calendar.listEvents",
        args: {
          timeMin: "2026-06-22T00:00:00+01:00",
          timeMax: "2026-06-23T00:00:00+01:00",
          maxResults: 50,
        },
      })}</tool>`,
    )) {
      events.push(e);
    }
    __resetConnectorRegistryForTest();

    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.read",
        args: {
          connectorId: "google-calendar",
          operation: "list_events",
          params: {
            timeMin: "2026-06-22T00:00:00+01:00",
            timeMax: "2026-06-23T00:00:00+01:00",
            maxResults: 50,
          },
        },
      },
    });
  });

  it("normalizes generic connector.read calendar/listEvents args", () => {
    __resetConnectorRegistryForTest();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const connectors = [
      {
        id: "google-calendar",
        displayName: "Google Calendar",
        provider: "google",
        platforms: ["web"],
        oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        operations: [
          {
            id: "list_events",
            mutating: false,
            requiredScope: "calendar.readonly",
            paramsSchema: {},
          },
        ],
        mcp: null,
      },
    ];
    const version = 1;
    initConnectorRegistry(
      {
        version,
        connectors,
        signature: edSign(
          null,
          canonicalConnectorsSigningInput(version, connectors),
          privateKey,
        ).toString("base64"),
      },
      pem,
    );

    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(
      `<tool>${JSON.stringify({
        toolName: "connector.read",
        args: {
          connectorId: "calendar",
          operation: "listEvents",
          params: { maxResults: 50 },
        },
      })}</tool>`,
    )) {
      events.push(e);
    }
    __resetConnectorRegistryForTest();

    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.read",
        args: {
          connectorId: "google-calendar",
          operation: "list_events",
          params: { maxResults: 50 },
        },
      },
    });
  });

  it("does NOT resolve an operation the signed registry does not declare (fails closed, no hardcoded synonyms)", () => {
    // The alias folding is catalog-driven (C1): an operation the catalog never
    // declares must NOT be silently mapped to a different declared op. The
    // registry below declares only list_events; "add_event" (an old hardcoded
    // synonym for create_event) must therefore fall through as an unknown tool.
    __resetConnectorRegistryForTest();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const connectors = [
      {
        id: "google-calendar",
        displayName: "Google Calendar",
        provider: "google",
        platforms: ["web"],
        oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        operations: [
          {
            id: "list_events",
            mutating: false,
            requiredScope: "calendar.readonly",
            paramsSchema: {},
          },
        ],
        mcp: null,
      },
    ];
    const version = 1;
    initConnectorRegistry(
      {
        version,
        connectors,
        signature: edSign(
          null,
          canonicalConnectorsSigningInput(version, connectors),
          privateKey,
        ).toString("base64"),
      },
      pem,
    );

    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(
      `<tool>${JSON.stringify({ toolName: "google-calendar.add_event", args: {} })}</tool>`,
    )) {
      events.push(e);
    }
    __resetConnectorRegistryForTest();

    // No connector.* frame was synthesized; the unknown namespaced tool surfaces
    // as a parse-error so the model retries with a real operation id.
    expect(events.some((e) => e.kind === "tool")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "parse-error" }),
    );
  });

  // ── Catalog-driven alias resolution: multi-connector discrimination ──────────
  // These pin the exact-match, unique-token-match, and AMBIGUITY branches of the
  // catalog-driven resolver with TWO connectors, so a mutant that keeps-all /
  // drops the ambiguity guard / flips a length check is caught (single-connector
  // catalogs can't distinguish those).

  function initRegistryWithConnectorIds(ids: string[]): void {
    __resetConnectorRegistryForTest();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const connectors = ids.map((id) => ({
      id,
      displayName: id,
      provider: "google",
      platforms: ["web"],
      oauthScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      operations: [
        {
          id: "list_events",
          mutating: false,
          requiredScope: "calendar.readonly",
          paramsSchema: {},
        },
      ],
      mcp: null,
    }));
    const version = 1;
    initConnectorRegistry(
      {
        version,
        connectors,
        signature: edSign(
          null,
          canonicalConnectorsSigningInput(version, connectors),
          privateKey,
        ).toString("base64"),
      },
      pem,
    );
  }

  function aliasEvents(
    toolName: string,
  ): import("../agent/parse-tool-call").ParserEvent[] {
    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(
      `<tool>${JSON.stringify({ toolName, args: {} })}</tool>`,
    )) {
      events.push(e);
    }
    return events;
  }

  // Init a registry from explicit (id, operations[{id, mutating}]) specs so the
  // alias-normalisation branches (mutating→connector.act vs read, param
  // extraction, arg-shape guards) can be discriminated.
  function initRegistryWithOps(
    specs: Array<{ id: string; operations: Array<{ id: string; mutating: boolean }> }>,
  ): void {
    __resetConnectorRegistryForTest();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const connectors = specs.map((s) => ({
      id: s.id,
      displayName: s.id,
      provider: "google",
      platforms: ["web"],
      oauthScopes: ["https://www.googleapis.com/auth/calendar.events"],
      operations: s.operations.map((op) => ({
        id: op.id,
        mutating: op.mutating,
        requiredScope: op.mutating ? "calendar.events" : "calendar.readonly",
        paramsSchema: {},
      })),
      mcp: null,
    }));
    const version = 1;
    initConnectorRegistry(
      {
        version,
        connectors,
        signature: edSign(
          null,
          canonicalConnectorsSigningInput(version, connectors),
          privateKey,
        ).toString("base64"),
      },
      pem,
    );
  }

  function aliasEventsWithArgs(
    toolName: string,
    args: unknown,
  ): import("../agent/parse-tool-call").ParserEvent[] {
    const p = new ToolCallStreamParser();
    const events: import("../agent/parse-tool-call").ParserEvent[] = [];
    for (const e of p.push(`<tool>${JSON.stringify({ toolName, args })}</tool>`)) {
      events.push(e);
    }
    return events;
  }

  const ALIAS_CATALOG = [
    {
      id: "acme-cal",
      operations: [
        { id: "list_events", mutating: false },
        { id: "create_event", mutating: true },
      ],
    },
  ];

  it("namespaced MUTATING op → connector.act with extracted params", () => {
    initRegistryWithOps(ALIAS_CATALOG);
    const events = aliasEventsWithArgs("acme-cal.create_event", {
      summary: "Lunch",
    });
    __resetConnectorRegistryForTest();
    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.act",
        args: {
          connectorId: "acme-cal",
          operation: "create_event",
          params: { summary: "Lunch" },
        },
      },
    });
  });

  it("namespaced READ op → connector.read (mutating=false branch)", () => {
    initRegistryWithOps(ALIAS_CATALOG);
    const events = aliasEventsWithArgs("acme-cal.list_events", {
      maxResults: 5,
    });
    __resetConnectorRegistryForTest();
    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.read",
        args: {
          connectorId: "acme-cal",
          operation: "list_events",
          params: { maxResults: 5 },
        },
      },
    });
  });

  it("namespaced op with NON-OBJECT args is left unchanged (arg-shape guard) → parse-error", () => {
    initRegistryWithOps(ALIAS_CATALOG);
    // A string args cannot carry connector params; the alias must NOT synthesize a
    // connector.act/read frame from it — it returns the (unknown) namespaced tool.
    const events = aliasEventsWithArgs("acme-cal.create_event", "not-an-object");
    __resetConnectorRegistryForTest();
    expect(events.some((e) => e.kind === "tool")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "parse-error" }),
    );
  });

  it("a namespaced op whose connector/operation does not resolve stays an unknown tool", () => {
    initRegistryWithOps(ALIAS_CATALOG);
    const events = aliasEventsWithArgs("acme-cal.no_such_op", { x: 1 });
    __resetConnectorRegistryForTest();
    expect(events.some((e) => e.kind === "tool")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "parse-error" }),
    );
  });

  it("generic connector.act with alias connector/operation normalises + extracts params", () => {
    initRegistryWithOps(ALIAS_CATALOG);
    const events = aliasEventsWithArgs("connector.act", {
      connectorId: "cal", // unique token → acme-cal
      operation: "createEvent", // camelCase → create_event
      summary: "X",
    });
    __resetConnectorRegistryForTest();
    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.act",
        args: {
          connectorId: "acme-cal",
          operation: "create_event",
          params: { summary: "X" },
        },
      },
    });
  });

  it("generic connector.read merges a nested params object with sibling keys", () => {
    initRegistryWithOps(ALIAS_CATALOG);
    const events = aliasEventsWithArgs("connector.read", {
      connectorId: "acme-cal",
      operation: "list_events",
      params: { maxResults: 10 },
      timeMin: "2026-07-01T00:00:00Z", // sibling key → merged into params
    });
    __resetConnectorRegistryForTest();
    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.read",
        args: {
          connectorId: "acme-cal",
          operation: "list_events",
          params: { maxResults: 10, timeMin: "2026-07-01T00:00:00Z" },
        },
      },
    });
  });

  it("generic connector.read with a NON-STRING connectorId/operation is left unchanged", () => {
    initRegistryWithOps(ALIAS_CATALOG);
    const events = aliasEventsWithArgs("connector.read", {
      connectorId: 123, // not a string → no normalisation
      operation: "list_events",
    });
    __resetConnectorRegistryForTest();
    // connector.read is a valid tool name, so it still emits a tool frame, but the
    // args are passed THROUGH unchanged (connectorId stays the number 123) — the
    // downstream schema/gateway rejects it; the alias layer must not invent one.
    const tool = events.find((e) => e.kind === "tool");
    if (tool && tool.kind === "tool") {
      expect((tool.payload.args as { connectorId: unknown }).connectorId).toBe(123);
    } else {
      // Or it fails schema validation → parse-error; either way NOT normalised.
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "parse-error" }),
      );
    }
  });

  it("loosenIdentifier folds whitespace, case, and repeated separators when matching", () => {
    initRegistryWithOps(ALIAS_CATALOG);
    // "  ACME__CAL " → loosen "acmecal" → exact match acme-cal; "List.Events" →
    // loosen "listevents" → list_events. Exercises trim + toLowerCase + the
    // global multi-separator regex inside loosenIdentifier.
    const events = aliasEventsWithArgs("connector.read", {
      connectorId: "  ACME__CAL ",
      operation: "List.Events",
    });
    __resetConnectorRegistryForTest();
    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.read",
        args: { connectorId: "acme-cal", operation: "list_events", params: {} },
      },
    });
  });

  it("exact loosened match resolves the RIGHT one of two connectors (not keep-all)", () => {
    initRegistryWithConnectorIds(["alpha-cal", "beta-cal"]);
    const events = aliasEvents("alpha-cal.list_events");
    __resetConnectorRegistryForTest();
    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.read",
        args: { connectorId: "alpha-cal", operation: "list_events", params: {} },
      },
    });
  });

  it("two connectors with the SAME loosened id are AMBIGUOUS → no resolution (never guess)", () => {
    // "acme-cal" and "acmecal" both loosen to "acmecal".
    initRegistryWithConnectorIds(["acme-cal", "acmecal"]);
    const events = aliasEvents("acme-cal.list_events");
    __resetConnectorRegistryForTest();
    expect(events.some((e) => e.kind === "tool")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "parse-error" }),
    );
  });

  it("a UNIQUE salient token resolves the matching connector", () => {
    initRegistryWithConnectorIds(["acme-mail", "work-cal"]);
    const events = aliasEvents("mail.list_events");
    __resetConnectorRegistryForTest();
    expect(events).toContainEqual({
      kind: "tool",
      payload: {
        invocationId: "",
        toolName: "connector.read",
        args: { connectorId: "acme-mail", operation: "list_events", params: {} },
      },
    });
  });

  it("a token shared by TWO connectors is AMBIGUOUS → no resolution", () => {
    // Both "acme-cal" and "work-cal" carry the token "cal".
    initRegistryWithConnectorIds(["acme-cal", "work-cal"]);
    const events = aliasEvents("cal.list_events");
    __resetConnectorRegistryForTest();
    expect(events.some((e) => e.kind === "tool")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "parse-error" }),
    );
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
