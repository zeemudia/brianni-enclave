import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";

import { runAgentLoop, type AgentLoopEvent } from "../agent/loop";
import { ToolGateway, type ClientBridge } from "../tools";
import type {
  ChatChunk,
  ChatMessage,
  ChatProcessor,
  DreamDelta,
  MemoryMutationEnvelope,
  MemoryRecord,
  SkillPack,
  ToolInvocationFrame,
  ToolResultFrame,
} from "@calypso/chat-types";

function workRecord(): MemoryRecord {
  return {
    id: "m1",
    namespace: "work",
    baseVersion: 0,
    tombstoneEpoch: 0,
    dreamSessionId: "turn_e2e",
    kind: "fact",
    text: "remote-only",
    structured: {},
    tags: [],
    provenance: [
      {
        excerpt: "remote-only",
        excerptHash: "a".repeat(64),
        sourceRef: { type: "conversation", conversationId: "c1" },
        extractedAt: "2026-05-13T00:00:00.000Z",
        dreamSessionId: "turn_e2e",
      },
    ],
    confidence: 0.9,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    supersededBy: null,
    visibleToUser: true,
  };
}

function addDelta(record: MemoryRecord = workRecord()): DreamDelta {
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
  description: "test",
  systemPromptBlock: "x",
  toolScopes: [
    "memory.list",
    "memory.read",
    "memory.write",
    "folder.read",
  ],
  capabilitySuiteIds: ["text"],
  defaultNamespace: "work",
  linkedFolderScopes: {},
  uiHints: { icon: "briefcase", accentToken: "accent-blue" },
};

function makeProvider(script: string[]): ChatProcessor {
  let i = 0;
  return {
    async *streamChat(): AsyncGenerator<ChatChunk> {
      const tokens = i === 0 ? script : ["Done."];
      i += 1;
      for (let n = 0; n < tokens.length; n += 1) {
        yield {
          id: `c_${i}_${n}`,
          choices: [
            {
              delta: { content: tokens[n] },
              finish_reason: n === tokens.length - 1 ? "stop" : null,
            },
          ],
        };
      }
    },
  };
}

function fakeSessionManager() {
  const cached: Array<{
    sessionId: string;
    agentTurnId: string;
    invocationId: string;
    entry: unknown;
  }> = [];
  return {
    cached,
    storeUnsignedEnvelopes: vi.fn().mockResolvedValue(undefined),
    finaliseDreamEnvelopes: vi
      .fn()
      .mockImplementation(async (_sessionId, _dreamSessionId, items) => {
        return items.map(
          (item: {
            deltaIndex: number;
            contentHash: string;
            recordSerialisedHash: string;
          }) => ({
            ok: true,
            deltaIndex: item.deltaIndex,
            envelopeJson: '{"signed":true}',
            signature: "sig_abc",
            signedEnvelope: {
              v: 1,
              userId: "u1",
              namespace: "work",
              blobId: "m1",
              action: "ADD",
              expectedBaseVersion: 0,
              newRecordVersion: 0,
              kind: "fact",
              mutationId: "mut_01",
              dreamSessionId: "turn_e2e",
              teeSessionId: "sess_e2e",
              provenanceConversationIds: [],
              issuedAt: "2026-05-13T00:00:00Z",
              expiresAt: "2026-05-13T00:01:00Z",
              contentHash: item.contentHash,
              recordSerialisedHash: item.recordSerialisedHash,
            } as MemoryMutationEnvelope,
          }),
        );
      }),
    cacheSignedFinalisation: vi
      .fn()
      .mockImplementation(async (sessionId, agentTurnId, invocationId, entry) => {
        cached.push({ sessionId, agentTurnId, invocationId, entry });
      }),
    lookupSignedFinalisation: vi.fn().mockResolvedValue(null),
    ackSignedFinalisation: vi.fn().mockResolvedValue({ outcome: "ok" }),
  };
}

describe("memory.write end-to-end (codex finding #1 — second outbound frame to client)", () => {
  it("emits memory-write-signed event with signed envelope after gateway dispatch", async () => {
    const sessionManager = fakeSessionManager();
    const record = workRecord();
    const expectedRsh = sha256Hex(JSON.stringify(record));
    const bridge: ClientBridge = {
      invokeClient: vi.fn().mockImplementation(async (frame: ToolInvocationFrame) => {
        // Bridge frame the enclave passes is now sanitised: it carries
        // server-pinned namespace + enclave-canonicalised
        // recordSerialisedHash. The client echoes the hash back, which
        // both sides verify match for defence-in-depth.
        const args = frame.args as { recordSerialisedHash?: string };
        return {
          invocationId: frame.invocationId,
          outcome: "ok",
          resultJson: {
            deltaIndex: 0,
            contentHash: "a".repeat(64),
            recordSerialisedHash: args.recordSerialisedHash ?? "",
            signedBlobB64: Buffer.from("body").toString("base64"),
          },
        } satisfies ToolResultFrame;
      }),
    };
    const gateway = new ToolGateway({
      clientBridge: bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess_e2e",
    });

    // The model only emits a DreamDelta — the enclave fills in everything
    // else from authenticated context (R4 Finding 1).
    const toolJson = JSON.stringify({
      toolName: "memory.write",
      args: { delta: addDelta(record) },
    });
    void expectedRsh;

    const provider = makeProvider([`<tool>${toolJson}</tool>`]);

    const events: AgentLoopEvent[] = [];
    for await (const ev of runAgentLoop(
      { gateway, provider, pack: careerPack, agentTurnId: "turn_e2e" },
      { messages: [{ role: "user", content: "save it" }] },
    )) {
      events.push(ev);
    }

    // Codex finding #1 acceptance: memory-write-signed event exists
    // and carries the signed envelope back toward the client.
    const signedEvents = events.filter(
      (e) => e.kind === "memory-write-signed",
    );
    expect(signedEvents).toHaveLength(1);
    const sig = signedEvents[0] as Extract<
      AgentLoopEvent,
      { kind: "memory-write-signed" }
    >;
    expect(sig.signedEnvelope.contentHash).toBe("a".repeat(64));
    expect(sig.signature).toBe("sig_abc");
    expect(sig.signedBlobB64.length).toBeGreaterThan(0);
    // The invocationId is the enclave-minted one (Codex finding #2),
    // not anything the model supplied.
    expect(sig.invocationId).toMatch(/^[0-9a-f-]{36}$/);

    // Cache entry persists (Codex finding #3) — keyed by the same
    // (agentTurnId, invocationId) tuple the client will ACK against.
    expect(sessionManager.cached).toHaveLength(1);
    expect(sessionManager.cached[0].agentTurnId).toBe("turn_e2e");
    expect(sessionManager.cached[0].invocationId).toBe(sig.invocationId);
  });

  it("memory.write model reinjection HIDES signed envelope bytes (only audit lives in the ledger)", async () => {
    const sessionManager = fakeSessionManager();
    const bridge: ClientBridge = {
      invokeClient: vi.fn().mockImplementation(async (frame: ToolInvocationFrame) => {
        const args = frame.args as { recordSerialisedHash?: string };
        return {
          invocationId: "x",
          outcome: "ok",
          resultJson: {
            deltaIndex: 0,
            contentHash: "b".repeat(64),
            recordSerialisedHash: args.recordSerialisedHash ?? "",
            signedBlobB64: "",
          },
        } satisfies ToolResultFrame;
      }),
    };
    const gateway = new ToolGateway({
      clientBridge: bridge,
      sessionManager,
      userId: "u1",
      sessionId: "sess_redact",
    });

    // Intercept the provider stream to capture what gets reinjected
    // as a user message on the SECOND call (after memory.write).
    const captured: ChatMessage[][] = [];
    const provider: ChatProcessor = {
      async *streamChat(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
        captured.push(JSON.parse(JSON.stringify(messages)));
        const isFirst = captured.length === 1;
        const text = isFirst
          ? `<tool>${JSON.stringify({
              toolName: "memory.write",
              args: { delta: addDelta() },
            })}</tool>`
          : "Done.";
        yield {
          id: "c1",
          choices: [{ delta: { content: text }, finish_reason: "stop" }],
        };
      },
    };

    const events: AgentLoopEvent[] = [];
    for await (const ev of runAgentLoop(
      { gateway, provider, pack: careerPack, agentTurnId: "turn_redact" },
      { messages: [{ role: "user", content: "save it" }] },
    )) {
      events.push(ev);
    }

    expect(captured).toHaveLength(2);
    const reinjectedToolResult = captured[1][captured[1].length - 1];
    expect(reinjectedToolResult.role).toBe("user");
    // The reinjection must NOT contain signed envelope bytes or
    // signature — these are audit-only and travel to the CLIENT via
    // the memory-write-signed event, not into the model context.
    expect(reinjectedToolResult.content).not.toContain('"signedEnvelope"');
    expect(reinjectedToolResult.content).not.toContain('"signature"');
    expect(reinjectedToolResult.content).not.toContain("sig_abc");
  });
});
