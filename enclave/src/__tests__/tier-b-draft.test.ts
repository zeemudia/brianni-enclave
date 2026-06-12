import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";

import { ToolGateway, type ClientBridge } from "../tools";
import type { DreamDelta, MemoryRecord, SkillPack } from "@calypso/chat-types";

function makeWorkRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    namespace: "work",
    baseVersion: 0,
    tombstoneEpoch: 0,
    dreamSessionId: "turn1",
    kind: "fact",
    text: "I prefer remote work.",
    structured: {},
    tags: [],
    provenance: [
      {
        excerpt: "I prefer remote work.",
        excerptHash: "a".repeat(64),
        sourceRef: { type: "conversation", conversationId: "conv_1" },
        extractedAt: "2026-05-13T00:00:00.000Z",
        dreamSessionId: "turn1",
      },
    ],
    confidence: 0.9,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    supersededBy: null,
    visibleToUser: true,
    ...overrides,
  };
}

function makeAddDelta(record: MemoryRecord = makeWorkRecord()): DreamDelta {
  return {
    action: "ADD",
    targetId: record.id,
    record,
    expectedBaseVersion: -1,
    mutationId: "00000000-0000-0000-0000-000000000000",
  } as DreamDelta;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const careerPack: SkillPack = {
  id: "personal-agent.career",
  version: 1,
  displayName: "Career",
  description: "Career pack.",
  systemPromptBlock: "Career mode.",
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
    "event.draft",
  ],
  capabilitySuiteIds: [
    "text",
    "office-document",
    "pdf",
    "rtf",
    "apple-iwork",
    "google-stub",
    "image",
    "audio",
    "video",
  ],
  defaultNamespace: "work",
  linkedFolderScopes: {},
  uiHints: { icon: "briefcase", accentToken: "accent-blue" },
};

const textOnlyCareerPack: SkillPack = {
  ...careerPack,
  capabilitySuiteIds: ["text"],
};

function makeBridge(resolved: unknown): {
  bridge: ClientBridge;
  mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn().mockResolvedValue(resolved);
  return { bridge: { invokeClient: mock }, mock };
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("Tier B drafts: email.draft / doc.draft / event.draft", () => {
  it.each(["email.draft", "doc.draft", "event.draft"] as const)(
    "%s is pure pass-through — no bridge, no network",
    async (toolName) => {
      const { bridge, mock } = makeBridge({});
      const gw = new ToolGateway({ clientBridge: bridge });
      const r = await gw.dispatch(
        {
          invocationId: "inv1",
          agentTurnId: "t1",
          toolName,
          args: { subject: "Hi", body: "Hello" },
        },
        careerPack,
        "t1",
      );
      expect(r.outcome).toBe("ok");
      // Drafts are formatted directly inside the enclave — no bridge round-trip.
      expect(mock).not.toHaveBeenCalled();
      // Resulting draft envelope is structurally returned to the agent
      expect(
        (r.resultJson as { kind?: string }).kind,
      ).toBe(toolName.split(".")[0]);
      expect(r.ledgerEntry.outcome).toBe("ok");
    },
  );

  it("email.draft never embeds a 'send' or 'recipient.send' field", async () => {
    const gw = new ToolGateway({ clientBridge: makeBridge({}).bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "email.draft",
        args: { to: "x@example.com", subject: "Hi", body: "Hello" },
      },
      careerPack,
      "t1",
    );
    const serialised = JSON.stringify(r.resultJson);
    expect(serialised).not.toContain('"send"');
    expect(serialised).not.toContain('"autoSend"');
  });
});

describe("Tier B memory.write (chunk H end-to-end with signedFinalisationCache)", () => {
  function fakeSessionManager() {
    const stored: Array<{
      sessionId: string;
      dreamSessionId: string;
      entries: Array<[number, unknown]>;
    }> = [];
    const cached: Array<{
      sessionId: string;
      agentTurnId: string;
      invocationId: string;
      entry: unknown;
    }> = [];
    return {
      stored,
      cached,
      storeUnsignedEnvelopes: vi
        .fn()
        .mockImplementation(async (sessionId, dreamSessionId, entries) => {
          stored.push({ sessionId, dreamSessionId, entries });
        }),
      finaliseDreamEnvelopes: vi
        .fn()
        .mockImplementation(async (_sessionId, _dreamSessionId, items) => {
          return items.map((item: { deltaIndex: number; contentHash: string; recordSerialisedHash: string }) => ({
            ok: true,
            deltaIndex: item.deltaIndex,
            envelopeJson: '{"signed":true}',
            signature: "sig_abc",
            signedEnvelope: {
              v: 1,
              userId: "u1",
              namespace: "work",
              blobId: "m1",
              action: "PUT",
              expectedBaseVersion: 0,
              newRecordVersion: 0,
              kind: "fact",
              mutationId: "mut_01",
              dreamSessionId: "turn1",
              teeSessionId: "sess1",
              provenanceConversationIds: [],
              issuedAt: "2026-05-13T00:00:00Z",
              expiresAt: "2026-05-13T00:01:00Z",
              contentHash: item.contentHash,
              recordSerialisedHash: item.recordSerialisedHash,
            },
          }));
        }),
      cacheSignedFinalisation: vi
        .fn()
        .mockImplementation(async (sessionId, agentTurnId, invocationId, entry) => {
          cached.push({ sessionId, agentTurnId, invocationId, entry });
        }),
      lookupSignedFinalisation: vi.fn().mockResolvedValue(null),
    };
  }

  it("happy path: stores unsigned, calls bridge, finalises, caches, returns signed envelope", async () => {
    const sessionManager = fakeSessionManager();
    const record = makeWorkRecord();
    // R11 Finding C: enclave canonicalises createdAt/updatedAt with
    // server clock, so the rsh differs from `sha256Hex(JSON.stringify(record))`.
    // The bridge echoes the enclave's canonical hash back.
    const bridge = {
      bridge: {
        invokeClient: vi.fn().mockImplementation(
          async (frame: { args: Record<string, unknown> }) => ({
            invocationId: "inv1",
            outcome: "ok",
            resultJson: {
              deltaIndex: 0,
              contentHash:
                "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
              recordSerialisedHash: frame.args.recordSerialisedHash,
              signedBlobB64: Buffer.from("body").toString("base64"),
            },
          }),
        ),
      },
      mock: undefined as unknown as ReturnType<typeof vi.fn>,
    };
    bridge.mock = bridge.bridge.invokeClient as ReturnType<typeof vi.fn>;
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: { delta: makeAddDelta(record) },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("ok");
    expect(sessionManager.storeUnsignedEnvelopes).toHaveBeenCalledTimes(1);
    expect(sessionManager.finaliseDreamEnvelopes).toHaveBeenCalledTimes(1);
    expect(sessionManager.cacheSignedFinalisation).toHaveBeenCalledTimes(1);
    const cached = sessionManager.cached[0];
    expect(cached.agentTurnId).toBe("turn1");
    expect(cached.invocationId).toBe("inv1");
    expect(
      (r.resultJson as { signedEnvelope: { contentHash: string } }).signedEnvelope.contentHash,
    ).toBe(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(r.ledgerEntry.scope).toBe("memory/work");
    const bridgeArgs = (bridge.mock.mock.calls[0][0] as { args: Record<string, unknown> }).args;
    expect(bridgeArgs.namespace).toBe("work");
    expect(bridgeArgs.recordSerialisedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bridgeArgs).not.toHaveProperty("unsignedEnvelopeFields");
    const storedEntry = sessionManager.stored[0].entries[0][1] as {
      envelopeFields: { userId: string; teeSessionId: string; mutationId: string };
    };
    expect(storedEntry.envelopeFields.userId).toBe("u1");
    expect(storedEntry.envelopeFields.teeSessionId).toBe("sess1");
    expect(storedEntry.envelopeFields.mutationId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  // --- Ergonomic minimal model-supplied delta. Root-cause fix for the
  // INVALID_DELTA_ACTION agent-proof failure: the model is now told a
  // minimal shape (action + record.kind + record.text) and the enclave
  // synthesises provenance + safe defaults for fields it cannot know.
  // Additive — full-record deltas (above) are unchanged. ---
  function echoSigningBridge() {
    return {
      invokeClient: vi.fn().mockImplementation(
        async (frame: { args: Record<string, unknown> }) => ({
          invocationId: "inv1",
          outcome: "ok",
          resultJson: {
            deltaIndex: 0,
            contentHash:
              "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            recordSerialisedHash: frame.args.recordSerialisedHash,
            signedBlobB64: Buffer.from("body").toString("base64"),
          },
        }),
      ),
    };
  }

  function minimalAddDelta(record: {
    kind: string;
    text: string;
    tags?: string[];
    confidence?: number;
    namespace?: string;
  }): DreamDelta {
    return { action: "ADD", record } as unknown as DreamDelta;
  }

  it("minimal ADD delta (action+kind+text only) succeeds — regression for INVALID_DELTA_ACTION proof failure", async () => {
    const sessionManager = fakeSessionManager();
    const bridge = echoSigningBridge();
    const gw = new ToolGateway({
      clientBridge: bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: {
          delta: minimalAddDelta({
            kind: "preference",
            text: "Your synthetic tea preference is jasmine green tea.",
          }),
        },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("ok");
    expect(r.ledgerEntry.scope).toBe("memory/work");
  });

  it("minimal ADD: enclave synthesises provenance + safe defaults the model cannot know", async () => {
    const sessionManager = fakeSessionManager();
    const bridge = echoSigningBridge();
    const gw = new ToolGateway({
      clientBridge: bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: {
          delta: minimalAddDelta({ kind: "preference", text: "Jasmine green tea." }),
        },
      },
      careerPack,
      "turn1",
    );
    const record = (
      bridge.invokeClient.mock.calls[0][0] as {
        args: { delta: { record: MemoryRecord } };
      }
    ).args.delta.record;
    // namespace pinned to the active pack namespace
    expect(record.namespace).toBe("work");
    // provenance synthesised: >=1 entry, server-stamped session id, excerpt from text
    expect(record.provenance.length).toBeGreaterThanOrEqual(1);
    expect(record.provenance[0].sourceRef).toEqual({
      type: "conversation",
      conversationId: "turn1",
    });
    expect(record.provenance[0].excerpt).toContain("Jasmine green tea");
    expect(record.provenance[0].dreamSessionId).toBe("turn1");
    // scalar defaults
    expect(record.structured).toEqual({});
    expect(record.tags).toEqual([]);
    expect(typeof record.confidence).toBe("number");
    expect(record.confidence).toBeGreaterThan(0);
    expect(record.confidence).toBeLessThanOrEqual(1);
    expect(record.supersededBy).toBeNull();
    expect(record.visibleToUser).toBe(true);
  });

  it("namespace escape guard still fires when model supplies a DIFFERENT namespace on a minimal delta", async () => {
    const sessionManager = fakeSessionManager();
    const bridge = echoSigningBridge();
    const gw = new ToolGateway({
      clientBridge: bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: {
          delta: minimalAddDelta({
            kind: "fact",
            text: "x",
            namespace: "money",
          }),
        },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("NAMESPACE_ESCAPE_REJECTED");
  });

  it("memory.write strips hostile bridge resultJson and maps free-form bridge errors", async () => {
    const sessionManager = fakeSessionManager();
    const record = makeWorkRecord();
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "error",
      reason: "client failure dumped /home/example/.ssh/id_rsa",
      resultJson: {
        secretLeakedKey: "DROP-ME",
        records: [{ id: "smuggled" }],
      },
    });
    const gw = new ToolGateway({
      clientBridge: bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: { delta: makeAddDelta(record) },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("BRIDGE_ERROR");
    expect(r.resultJson).toBeUndefined();
    expect(sessionManager.finaliseDreamEnvelopes).not.toHaveBeenCalled();
  });

  it("namespace escape: delta.record.namespace != pack.defaultNamespace → NAMESPACE_ESCAPE_REJECTED", async () => {
    const sessionManager = fakeSessionManager();
    const bridge = makeBridge({ invocationId: "inv1", outcome: "ok", resultJson: {} });
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const record = makeWorkRecord({ namespace: "health" });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: { delta: makeAddDelta(record) },
      },
      careerPack, // defaultNamespace: "work"
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("NAMESPACE_ESCAPE_REJECTED");
    expect(sessionManager.storeUnsignedEnvelopes).not.toHaveBeenCalled();
    expect(bridge.mock).not.toHaveBeenCalled();
  });

  it("missing auth context → UNAUTHENTICATED_AGENT_CONTEXT", async () => {
    const sessionManager = fakeSessionManager();
    const gw = new ToolGateway({
      clientBridge: makeBridge({}).bridge,
      sessionManager,
      // no userId / sessionId
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: { delta: makeAddDelta() },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("UNAUTHENTICATED_AGENT_CONTEXT");
    expect(sessionManager.storeUnsignedEnvelopes).not.toHaveBeenCalled();
  });

  it("client-returned recordSerialisedHash disagrees with enclave's → RECORD_SERIALISED_MISMATCH", async () => {
    const sessionManager = fakeSessionManager();
    const bridge = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        deltaIndex: 0,
        contentHash: "a".repeat(64),
        recordSerialisedHash: "00".repeat(32), // not equal to enclave's
        signedBlobB64: Buffer.from("body").toString("base64"),
      },
    });
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: { delta: makeAddDelta() },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("RECORD_SERIALISED_MISMATCH");
    // The enclave-side mismatch check fires BEFORE finaliseDreamEnvelopes.
    expect(sessionManager.finaliseDreamEnvelopes).not.toHaveBeenCalled();
    expect(sessionManager.cacheSignedFinalisation).not.toHaveBeenCalled();
  });

  it("unknown_delta_index → INVOCATION_ALREADY_CONSUMED (stale-after-ACK replay)", async () => {
    const sessionManager = fakeSessionManager();
    const record = makeWorkRecord();
    sessionManager.finaliseDreamEnvelopes.mockImplementationOnce(async () => [
      { ok: false, deltaIndex: 0, error: "unknown_delta_index" },
    ]);
    const bridge = {
      bridge: {
        invokeClient: vi.fn().mockImplementation(
          async (frame: { args: Record<string, unknown> }) => ({
            invocationId: "inv1",
            outcome: "ok",
            resultJson: {
              deltaIndex: 0,
              contentHash: "a".repeat(64),
              recordSerialisedHash: frame.args.recordSerialisedHash,
            },
          }),
        ),
      },
    };
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: { delta: makeAddDelta(record) },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVOCATION_ALREADY_CONSUMED");
  });

  it("finaliseDreamEnvelopes returns [] → FINALISE_FAILED, not a crash (regression: signResults[0] was read unguarded)", async () => {
    const sessionManager = fakeSessionManager();
    const record = makeWorkRecord();
    sessionManager.finaliseDreamEnvelopes.mockImplementationOnce(async () => []);
    const bridge = {
      bridge: {
        invokeClient: vi.fn().mockImplementation(
          async (frame: { args: Record<string, unknown> }) => ({
            invocationId: "inv1",
            outcome: "ok",
            resultJson: {
              deltaIndex: 0,
              contentHash: "a".repeat(64),
              recordSerialisedHash: frame.args.recordSerialisedHash,
            },
          }),
        ),
      },
    };
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: { delta: makeAddDelta(record) },
      },
      careerPack,
      "turn1",
    );
    // Pre-fix `const result = signResults[0]; if (!result.ok)` threw a
    // TypeError on the empty array, surfacing as an opaque catch-all instead of
    // a controlled finalise error.
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("FINALISE_FAILED");
    expect(sessionManager.cacheSignedFinalisation).not.toHaveBeenCalled();
  });

  it("SESSION_MANAGER_UNAVAILABLE when gateway constructed without it", async () => {
    const bridge = makeBridge({}).bridge;
    const gw = new ToolGateway({ clientBridge: bridge, userId: "u1", sessionId: "s" });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: { delta: makeAddDelta() },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("SESSION_MANAGER_UNAVAILABLE");
  });

  it("bridge returns non-ok → propagated without finalising or caching", async () => {
    const sessionManager = fakeSessionManager();
    const bridge = makeBridge({
      invocationId: "inv1",
      outcome: "denied_by_user",
      reason: "user cancelled",
    });
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: { delta: makeAddDelta() },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("denied_by_user");
    expect(sessionManager.finaliseDreamEnvelopes).not.toHaveBeenCalled();
    expect(sessionManager.cacheSignedFinalisation).not.toHaveBeenCalled();
  });

  it("rejects when required args are missing — INVALID_ARGS upstream of any signer", async () => {
    const sessionManager = fakeSessionManager();
    const gw = new ToolGateway({
      clientBridge: makeBridge({}).bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: {},
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
  });

  // R6 Finding B (Codex): the model's expectedBaseVersion cannot
  // smuggle action-invalid CAS into the signed envelope.
  // R5 Finding A (Codex): enclave canonicalises record.id and
  // record.dreamSessionId so a hostile model can't smuggle cross-blob
  // or cross-turn attribution into the record body before it's signed.
  // (record.namespace mismatch is caught earlier by the explicit
  // NAMESPACE_ESCAPE_REJECTED check; this test exercises silently-
  // overridden id and dreamSessionId.)
  // R8 Finding A (Codex): canonicalisation covers record.baseVersion
  // (must equal envelope.newRecordVersion) AND every nested
  // provenance[].dreamSessionId (model can't fake provenance
  // attribution).
  it("canonicalises record.baseVersion and provenance[].dreamSessionId — hostile nested fields are stamped", async () => {
    const sessionManager = fakeSessionManager();
    const hostileRecord = makeWorkRecord({
      baseVersion: 999,
      provenance: [
        {
          excerpt: "remote-only",
          excerptHash: "a".repeat(64),
          sourceRef: { type: "conversation", conversationId: "c1" },
          extractedAt: "2026-05-13T00:00:00.000Z",
          dreamSessionId: "MODEL_LIED_ABOUT_PROVENANCE",
        },
        {
          excerpt: "another",
          excerptHash: "b".repeat(64),
          sourceRef: { type: "conversation", conversationId: "c2" },
          extractedAt: "2026-05-13T00:00:00.000Z",
          dreamSessionId: "MODEL_LIED_AGAIN",
        },
      ],
    });
    const bridge = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        deltaIndex: 0,
        contentHash: "a".repeat(64),
        // The handleMemoryWrite mismatch check uses the enclave's
        // recordSerialisedHash; we mirror it via .recordSerialisedHash
        // that the bridge sees in args.
        recordSerialisedHash: "PLACEHOLDER",
        signedBlobB64: Buffer.from("body").toString("base64"),
      },
    });
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    // The bridge mock has to echo whatever the enclave stamped; capture
    // and re-send it on next call.
    bridge.mock.mockImplementationOnce(async (frame: { args: Record<string, unknown> }) => ({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        deltaIndex: 0,
        contentHash: "a".repeat(64),
        recordSerialisedHash: frame.args.recordSerialisedHash,
        signedBlobB64: Buffer.from("body").toString("base64"),
      },
    }));
    await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn_canon",
        toolName: "memory.write",
        args: {
          delta: {
            action: "ADD",
            targetId: "m1",
            record: hostileRecord,
            expectedBaseVersion: -1,
            mutationId: "00000000-0000-0000-0000-000000000000",
          },
        },
      },
      careerPack,
      "turn_canon",
    );
    expect(bridge.mock).toHaveBeenCalledTimes(1);
    const bridgeArgs = (bridge.mock.mock.calls[0][0] as {
      args: {
        delta: {
          record: {
            baseVersion: number;
            provenance: Array<{ dreamSessionId: string }>;
          };
        };
      };
    }).args;
    // ADD → newRecordVersion = 0, record.baseVersion forced to 0.
    expect(bridgeArgs.delta.record.baseVersion).toBe(0);
    // Every provenance entry's dreamSessionId stamped to agentTurnId.
    expect(bridgeArgs.delta.record.provenance).toHaveLength(2);
    for (const p of bridgeArgs.delta.record.provenance) {
      expect(p.dreamSessionId).toBe("turn_canon");
    }
  });

  it("canonicalises record.id and record.dreamSessionId — model-lied values are overwritten", async () => {
    const sessionManager = fakeSessionManager();
    // Hostile model: record.namespace matches pack so we pass the
    // explicit namespace check; record.id and dreamSessionId lie.
    const hostileRecord = makeWorkRecord({
      id: "MODEL_LIED_ABOUT_ID",
      dreamSessionId: "MODEL_LIED_ABOUT_DREAM",
    });
    const expectedCanonicalRecord = {
      ...hostileRecord,
      id: "m1",
      namespace: "work" as const,
      dreamSessionId: "turn_canon",
    };
    const expectedRsh = sha256Hex(JSON.stringify(expectedCanonicalRecord));
    const bridge = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        deltaIndex: 0,
        contentHash: "a".repeat(64),
        recordSerialisedHash: expectedRsh,
        signedBlobB64: Buffer.from("body").toString("base64"),
      },
    });
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn_canon",
        toolName: "memory.write",
        args: {
          delta: {
            action: "ADD",
            targetId: "m1",
            record: hostileRecord,
            expectedBaseVersion: -1,
            mutationId: "00000000-0000-0000-0000-000000000000",
          },
        },
      },
      careerPack,
      "turn_canon",
    );
    // The bridge frame's sanitisedDelta carries the canonicalised record.
    expect(bridge.mock).toHaveBeenCalledTimes(1);
    const bridgeArgs = (bridge.mock.mock.calls[0][0] as {
      args: { delta: { record: Record<string, unknown>; targetId: string } };
    }).args;
    // R13 Finding C: ADD now uses an enclave-minted UUID, not the
    // model's "m1". record.id is canonicalised to that same UUID.
    expect(bridgeArgs.delta.targetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridgeArgs.delta.targetId).not.toBe("m1");
    expect(bridgeArgs.delta.record.id).toBe(bridgeArgs.delta.targetId);
    expect(bridgeArgs.delta.record.namespace).toBe("work");
    expect(bridgeArgs.delta.record.dreamSessionId).toBe("turn_canon");
  });

  // R11 Finding C (Codex): record createdAt / updatedAt / tombstoneEpoch
  // must come from server-controlled context, NOT from the model. A
  // prompt-injected past/future timestamp would otherwise corrupt
  // listByNamespace `since` ordering and sync.
  it("stamps record.createdAt / updatedAt / tombstoneEpoch from server clock — hostile timestamps are overwritten", async () => {
    const sessionManager = fakeSessionManager();
    const hostileRecord = makeWorkRecord({
      createdAt: "1970-01-01T00:00:00.000Z", // ancient
      updatedAt: "2099-12-31T23:59:59.000Z", // future
      tombstoneEpoch: 42,
    });
    const bridge = {
      bridge: {
        invokeClient: vi.fn().mockImplementation(
          async (frame: { args: Record<string, unknown> }) => ({
            invocationId: "inv1",
            outcome: "ok",
            resultJson: {
              deltaIndex: 0,
              contentHash: "a".repeat(64),
              recordSerialisedHash: frame.args.recordSerialisedHash,
              signedBlobB64: Buffer.from("body").toString("base64"),
            },
          }),
        ),
      },
    };
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const before = Date.now();
    await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn_canon",
        toolName: "memory.write",
        args: { delta: makeAddDelta(hostileRecord) },
      },
      careerPack,
      "turn_canon",
    );
    const bridgeArgs = (bridge.bridge.invokeClient.mock.calls[0][0] as {
      args: {
        delta: {
          record: {
            createdAt: string;
            updatedAt: string;
            tombstoneEpoch: number;
          };
        };
      };
    }).args;
    const r = bridgeArgs.delta.record;
    expect(r.tombstoneEpoch).toBe(0);
    expect(Date.parse(r.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(r.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(r.createdAt).not.toBe("1970-01-01T00:00:00.000Z");
    expect(r.updatedAt).not.toBe("2099-12-31T23:59:59.000Z");
  });

  it("ADD: model-supplied expectedBaseVersion=0 is forced to -1", async () => {
    const sessionManager = fakeSessionManager();
    const record = makeWorkRecord();
    const expectedRsh = sha256Hex(JSON.stringify(record));
    const bridge = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        deltaIndex: 0,
        contentHash: "a".repeat(64),
        recordSerialisedHash: expectedRsh,
        signedBlobB64: Buffer.from("body").toString("base64"),
      },
    });
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: {
          delta: {
            action: "ADD",
            targetId: record.id,
            record,
            // Hostile model: ADD requires -1 by schema, model claims 0.
            expectedBaseVersion: 0,
            mutationId: "00000000-0000-0000-0000-000000000000",
          },
        },
      },
      careerPack,
      "turn1",
    );
    const stored = sessionManager.stored[0].entries[0][1] as {
      envelopeFields: { expectedBaseVersion: number; newRecordVersion: number };
    };
    expect(stored.envelopeFields.expectedBaseVersion).toBe(-1);
    expect(stored.envelopeFields.newRecordVersion).toBe(0);
  });

  it("UPDATE: negative expectedBaseVersion → INVALID_DELTA_BASE_VERSION", async () => {
    const sessionManager = fakeSessionManager();
    const record = makeWorkRecord();
    const gw = new ToolGateway({
      clientBridge: makeBridge({}).bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: {
          delta: {
            action: "UPDATE",
            targetId: record.id,
            record,
            // Hostile model: UPDATE requires >= 0 by schema, model claims -1.
            expectedBaseVersion: -1,
            mutationId: "00000000-0000-0000-0000-000000000000",
          },
        },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_DELTA_BASE_VERSION");
    expect(sessionManager.storeUnsignedEnvelopes).not.toHaveBeenCalled();
  });

  it("UPDATE: non-integer expectedBaseVersion → INVALID_DELTA_BASE_VERSION", async () => {
    const sessionManager = fakeSessionManager();
    const record = makeWorkRecord();
    const gw = new ToolGateway({
      clientBridge: makeBridge({}).bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: {
          delta: {
            action: "UPDATE",
            targetId: record.id,
            record,
            expectedBaseVersion: 3.5,
            mutationId: "00000000-0000-0000-0000-000000000000",
          },
        },
      },
      careerPack,
      "turn1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_DELTA_BASE_VERSION");
  });

  // R13 Finding C (Codex): for ADD the enclave mints the blob id so the
  // model can't pick a known id from another namespace to cause a
  // `memory_blob_already_exists` collision at the server.
  it("ADD: enclave mints blob id — model targetId is ignored", async () => {
    const sessionManager = fakeSessionManager();
    const record = makeWorkRecord();
    const bridge = {
      bridge: {
        invokeClient: vi.fn().mockImplementation(
          async (frame: { args: Record<string, unknown> }) => ({
            invocationId: "inv1",
            outcome: "ok",
            resultJson: {
              deltaIndex: 0,
              contentHash: "a".repeat(64),
              recordSerialisedHash: frame.args.recordSerialisedHash,
              signedBlobB64: Buffer.from("body").toString("base64"),
            },
          }),
        ),
      },
    };
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess1",
    });
    await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: {
          delta: {
            action: "ADD",
            targetId: "MODEL_LIED_BLOB_ID", // hostile collision attempt
            record,
            expectedBaseVersion: -1,
            mutationId: "00000000-0000-0000-0000-000000000000",
          },
        },
      },
      careerPack,
      "turn1",
    );
    const bridgeArgs = (bridge.bridge.invokeClient.mock.calls[0][0] as {
      args: { delta: { targetId: string; record: { id: string } } };
    }).args;
    expect(bridgeArgs.delta.targetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridgeArgs.delta.targetId).not.toBe("MODEL_LIED_BLOB_ID");
    // The canonicalised record.id matches the minted targetId.
    expect(bridgeArgs.delta.record.id).toBe(bridgeArgs.delta.targetId);
    // The signed envelope's blobId also matches.
    const storedEnvelope = (sessionManager.stored[0].entries[0][1] as {
      envelopeFields: { blobId: string };
    }).envelopeFields;
    expect(storedEnvelope.blobId).toBe(bridgeArgs.delta.targetId);
  });

  it("model-supplied envelope fields are IGNORED — enclave stamps userId from auth context", async () => {
    const sessionManager = fakeSessionManager();
    const record = makeWorkRecord();
    const expectedRsh = sha256Hex(JSON.stringify(record));
    const bridge = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        deltaIndex: 0,
        contentHash: "a".repeat(64),
        recordSerialisedHash: expectedRsh,
        signedBlobB64: Buffer.from("body").toString("base64"),
      },
    });
    const gw = new ToolGateway({
      clientBridge: bridge.bridge,
      sessionManager,
      userId: "u_authentic",
      sessionId: "sess_authentic",
    });
    await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "turn1",
        toolName: "memory.write",
        args: {
          delta: makeAddDelta(record),
          // Hostile model trying to spoof userId / mutationId / session id.
          unsignedEnvelopeFields: {
            userId: "u_attacker",
            mutationId: "spoof-mutation",
            teeSessionId: "sess_attacker",
          },
          recordSerialisedHash: "spoof_rsh",
          sessionId: "sess_attacker",
        },
      },
      careerPack,
      "turn1",
    );
    const storedEntry = sessionManager.stored[0].entries[0][1] as {
      envelopeFields: { userId: string; teeSessionId: string; mutationId: string };
    };
    expect(storedEntry.envelopeFields.userId).toBe("u_authentic");
    expect(storedEntry.envelopeFields.teeSessionId).toBe("sess_authentic");
    expect(storedEntry.envelopeFields.mutationId).not.toBe("spoof-mutation");
  });
});

describe("Tier B folder.write", () => {
  it("folder.write redirects source/output equality to a new copy path", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "notes copy.md" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          sourcePath: "notes.md",
          path: "notes.md",
          existingPaths: ["notes.md"],
          contentBytesB64: toB64(utf8("# Updated notes\n")),
        },
      },
      careerPack,
      "t1",
    );

    expect(r.outcome).toBe("ok");
    expect(r.resultJson).toEqual({
      writtenPath: "notes copy.md",
      requestedPath: "notes.md",
      pathAdjusted: true,
    });
    expect(r.ledgerEntry.approvedPath).toBe("notes copy.md");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].args.path).toBe("notes copy.md");
  });

  it("folder.write redirects existing output paths to the next available copy path", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "Resume_ATS_Optimized 2.md" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          sourcePath: "Resume.docx",
          path: "Resume_ATS_Optimized.md",
          existingPaths: ["Resume.docx", "Resume_ATS_Optimized.md"],
          contentBytesB64: toB64(utf8("# Optimized resume\n")),
        },
      },
      careerPack,
      "t1",
    );

    expect(r.outcome).toBe("ok");
    expect(r.resultJson).toEqual({
      writtenPath: "Resume_ATS_Optimized 2.md",
      requestedPath: "Resume_ATS_Optimized.md",
      pathAdjusted: true,
    });
    expect(r.ledgerEntry.approvedPath).toBe("Resume_ATS_Optimized 2.md");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].args.path).toBe("Resume_ATS_Optimized 2.md");
  });

  it("folder.write accepts a client-side live collision suffix when existingPaths was omitted", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "notes 2.md" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "notes.md",
          contentBytesB64: toB64(utf8("# Updated notes\n")),
        },
      },
      careerPack,
      "t1",
    );

    expect(r.outcome).toBe("ok");
    expect(r.resultJson).toEqual({
      writtenPath: "notes 2.md",
      requestedPath: "notes.md",
      pathAdjusted: true,
    });
    expect(r.ledgerEntry.approvedPath).toBe("notes 2.md");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].args.path).toBe("notes.md");
  });

  it("folder.write accepts live collision suffixes for filenames that already end in a number", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "notes 5 2.md" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "notes 5.md",
          contentBytesB64: toB64(utf8("# Updated notes\n")),
        },
      },
      careerPack,
      "t1",
    );

    expect(r.outcome).toBe("ok");
    expect(r.resultJson).toEqual({
      writtenPath: "notes 5 2.md",
      requestedPath: "notes 5.md",
      pathAdjusted: true,
    });
    expect(r.ledgerEntry.approvedPath).toBe("notes 5 2.md");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].args.path).toBe("notes 5.md");
  });

  it("folder.write rejects unrelated client-returned written paths", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "unrelated.md" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "notes.md",
          contentBytesB64: toB64(utf8("# Updated notes\n")),
        },
      },
      careerPack,
      "t1",
    );

    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_BRIDGE_RESULT");
  });

  it("folder.write rejects model-supplied source hashes because the enclave cannot verify them", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "notes copy.md" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          sourcePath: "notes.md",
          sourceSha256: "a".repeat(64),
          path: "notes.md",
          contentBytesB64: toB64(utf8("# Updated notes\n")),
        },
      },
      careerPack,
      "t1",
    );

    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
    expect(mock).not.toHaveBeenCalled();
  });

  it("folder.write rejects output families outside the active capability suites", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "photo.png" },
    });
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "photo.png",
          contentBytesB64: toB64(png),
        },
      },
      textOnlyCareerPack,
      "t1",
    );

    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(mock).not.toHaveBeenCalled();
  });

  it("folder.write validates content against the resolved copy path", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "Resume copy.pages" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          sourcePath: "Resume.pages",
          path: "Resume.pages",
          existingPaths: ["Resume.pages"],
          contentBytesB64: toB64(utf8("not a real Pages package")),
        },
      },
      careerPack,
      "t1",
    );

    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
    expect(r.resultJson).toEqual({ resolvedPath: "Resume copy.pages" });
    expect(r.ledgerEntry.approvedPath).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects disallowed extension BEFORE bridge invocation (allowlist applies to writes)", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "Career/payload.exe",
          contentBytesB64: toB64(utf8("anything")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(mock).not.toHaveBeenCalled();
  });

  it("allowed file + bridge returns denied_by_user → outcome denied_by_user, approvedPath null", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "denied_by_user",
      reason: "user clicked Deny",
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "Career/2026-05-12-counter.md",
          contentBytesB64: toB64(utf8("# Counter\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("denied_by_user");
    expect(r.reason).toBe("BRIDGE_DENIED");
    expect(r.resultJson).toBeUndefined();
    expect(r.ledgerEntry.approvedPath).toBeNull();
    expect(r.ledgerEntry.outcome).toBe("denied_by_user");
    expect(r.ledgerEntry.reason).toBe("BRIDGE_DENIED");
    expect(r.ledgerEntry.scope).toBe("folder/Career");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("allowed file + bridge returns ok with writtenPath → approvedPath recorded", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "Career/2026-05-12-counter.md" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "Career/2026-05-12-counter.md",
          contentBytesB64: toB64(utf8("# Counter\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(r.resultJson).toEqual({
      writtenPath: "Career/2026-05-12-counter.md",
    });
    expect(r.ledgerEntry.approvedPath).toBe("Career/2026-05-12-counter.md");
    expect(r.ledgerEntry.outcome).toBe("ok");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("folder.write rejects a bridge writtenPath that differs from the approved request path", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "/etc/passwd" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "Career/safe.md",
          contentBytesB64: toB64(utf8("# Safe\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_BRIDGE_RESULT");
    expect(r.resultJson).toBeUndefined();
    expect(r.ledgerEntry.approvedPath).toBeNull();
  });

  it("folder.write rejects ok bridge results that omit writtenPath", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {},
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "Career/derived.md",
          contentBytesB64: toB64(utf8("# Derived\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_BRIDGE_RESULT");
    expect(r.resultJson).toBeUndefined();
    expect(r.ledgerEntry.approvedPath).toBeNull();
  });

  it("folder.write ok strips hostile bridge fields and keeps only writtenPath", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        writtenPath: "Career/safe.md",
        secretLeakedKey: "DROP-ME",
        records: [{ id: "smuggled" }],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "Career/safe.md",
          contentBytesB64: toB64(utf8("# Safe\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(r.resultJson).toEqual({ writtenPath: "Career/safe.md" });
  });

  it.each([
    "../safe.md",
    "/tmp/safe.md",
    "a/../safe.md",
    "a\\b.md",
    "\\\\server\\share.md",
    "C:/tmp/safe.md",
    " Career/safe.md",
    "Career/safe.md ",
    "Career/bad\nname.md",
    "Career/tab\there.md",
    "Career/del\u007fname.md",
    "Career/c1\u0085name.md",
    "Career/evil\u202eReverse.md",
    "Career/zero\u200bwidth.md",
    "Career/cafe\u0301.md",
    `Career/${"a".repeat(257)}.md`,
  ])(
    "folder.write rejects non-canonical path %s before bridge invocation",
    async (path) => {
      const { bridge, mock } = makeBridge({
        invocationId: "inv1",
        outcome: "ok",
      });
      const gw = new ToolGateway({ clientBridge: bridge });
      const r = await gw.dispatch(
        {
          invocationId: "inv1",
          agentTurnId: "t1",
          toolName: "folder.write",
          args: {
            folderId: "fld_01",
            displayName: "Career",
            path,
            contentBytesB64: toB64(utf8("# Safe\n")),
          },
        },
        careerPack,
        "t1",
      );
      expect(r.outcome).toBe("gateway_rejected");
      expect(r.reason).toBe("INVALID_PATH");
      expect(r.ledgerEntry.outcome).toBe("gateway_rejected");
      expect(r.ledgerEntry.reason).toBe("INVALID_PATH");
      expect(r.ledgerEntry.approvedPath).toBeNull();
      expect(mock).not.toHaveBeenCalled();
    },
  );

  it("folder.write sends canonical relative paths through to the bridge", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "Career/notes/2026.md" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "Career/notes/2026.md",
          contentBytesB64: toB64(utf8("# Safe\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].args.path).toBe("Career/notes/2026.md");
  });

  it("folder.write accepts canonical NFC Unicode path segments", async () => {
    const path = "Career/caf\u00e9.md";
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: path },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path,
          contentBytesB64: toB64(utf8("# Safe\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(r.resultJson).toEqual({ writtenPath: path });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("folder.write non-ok strips hostile bridge resultJson and maps reason", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "error",
      reason: "native exception leaked /tmp/private",
      resultJson: {
        writtenPath: "Career/should-not-surface.md",
        secretLeakedKey: "DROP-ME",
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "Career/safe.md",
          contentBytesB64: toB64(utf8("# Safe\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("BRIDGE_ERROR");
    expect(r.resultJson).toBeUndefined();
    expect(r.ledgerEntry.reason).toBe("BRIDGE_ERROR");
  });

  it("rejects when required args are missing — no bridge round-trip", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: { displayName: "Career", path: "Career/x.md" },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
    expect(mock).not.toHaveBeenCalled();
  });

  it("treats path verbatim past the allowlist — client renders it literally in the modal", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { writtenPath: "Career/weird-but-valid.md" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    // Allowlist-clean extension (.md), but the rest of the path is gnarly.
    // The gateway must forward path verbatim — the client renders it literally
    // and the user (clicking Allow) is the only actor.
    const adversarialPath = "Career/<weird>; & 'safe' name`.md";
    await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: adversarialPath,
          contentBytesB64: toB64(utf8("# Counter\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].args.path).toBe(adversarialPath);
  });

  it("path-traversal-looking paths are rejected before bridge invocation", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "denied_by_user",
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const traversal = "../../sensitive.md";
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: traversal,
          contentBytesB64: toB64(utf8("# x\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(mock).not.toHaveBeenCalled();
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("INVALID_PATH");
    expect(r.ledgerEntry.approvedPath).toBeNull();
  });

  // Defense-in-depth: cross-pack grant binds folder.write to the authorized
  // folder set — unreachable for today's read-only claims pack (which lacks
  // folder.write in toolScopes), but the guard is universal.
  it("folder.write of a non-granted folder → FOLDER_NOT_IN_GRANT, bridge NOT called", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv-grant",
      outcome: "ok",
      resultJson: { writtenPath: "Career/safe.md" },
    });
    const linkedFolders = [
      { folderId: "fld_allowed", displayName: "Allowed", status: "granted" as const },
      { folderId: "fld_01", displayName: "Career", status: "granted" as const },
    ];
    const gw = new ToolGateway({
      clientBridge: bridge,
      linkedFolders,
      crossPackGrant: {
        namespaces: new Set(["work"]) as ReadonlySet<SkillPack["defaultNamespace"]>,
        folderIds: new Set(["fld_allowed"]), // fld_01 is NOT in the grant
        documentIds: new Set<string>(),
      },
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv-grant",
        agentTurnId: "t1",
        toolName: "folder.write",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          path: "Career/safe.md",
          contentBytesB64: toB64(utf8("# Safe\n")),
        },
      },
      careerPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("FOLDER_NOT_IN_GRANT");
    expect(mock).not.toHaveBeenCalled();
  });
});
