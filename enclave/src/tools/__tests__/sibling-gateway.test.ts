import { describe, it, expect, vi } from "vitest";
import type {
  AgentLinkedFolderContext,
  ToolInvocationFrame,
  ToolResultFrame,
} from "@calypso/chat-types";
import { ToolGateway, type ClientBridge, type ToolGatewayDeps } from "../index";

// Minimal ClientBridge stub — the sibling-gateway tests never dispatch a real
// tool call, so a never-resolving stub is fine.
function makeClientBridge(): ClientBridge {
  return {
    invokeClient: () => Promise.resolve({ invocationId: "x", outcome: "ok", resultJson: {} }),
  };
}

function makeDeps(overrides: Partial<ToolGatewayDeps> = {}): ToolGatewayDeps {
  return {
    clientBridge: makeClientBridge(),
    userId: "user-test-001",
    sessionId: "session-test-001",
    ...overrides,
  };
}

describe("createSiblingGateway", () => {
  it("sibling has an INDEPENDENT, empty egress-taint ledger (parent harvest does not leak in)", () => {
    const parent = new ToolGateway(makeDeps());

    // Access the private egressTaint field via cast.
    const pej = (parent as unknown as {
      egressTaint: {
        addText(s: string): void;
        markPrivateReadObserved(): void;
        hasHarvestedAnyPrivateContent(): boolean;
      };
    }).egressTaint;

    // Simulate what happens when the parent gateway reads private data:
    // a 21-char gram produces an entry in the ledger, proving harvest occurred.
    pej.addText("supersecretmembername AB-99812-Z");
    pej.markPrivateReadObserved();
    expect(pej.hasHarvestedAnyPrivateContent()).toBe(true); // parent did harvest

    const sibling = parent.createSiblingGateway({ linkedFolders: [] });

    const sej = (sibling as unknown as {
      egressTaint: { hasHarvestedAnyPrivateContent(): boolean };
    }).egressTaint;

    // The sibling must have a DIFFERENT ledger instance…
    expect(sej).not.toBe(pej);
    // …and that ledger must be empty (parent harvest must not have leaked in).
    expect(sej.hasHarvestedAnyPrivateContent()).toBe(false);
  });

  it("sibling has no private access (linkedFolders empty, crossPackGrant undefined, strictEgressLock false)", () => {
    const grantedFolder: AgentLinkedFolderContext = {
      folderId: "f1",
      displayName: "Bills",
      status: "granted",
    };

    const parent = new ToolGateway(makeDeps({
      linkedFolders: [grantedFolder],
      strictEgressLock: true,
      crossPackGrant: {
        namespaces: new Set(["money"]),
        folderIds: new Set(["f1"]),
        documentIds: new Set(),
      },
    }));

    const sibling = parent.createSiblingGateway({ linkedFolders: [] });

    const sdeps = (sibling as unknown as {
      deps: {
        linkedFolders?: unknown[];
        strictEgressLock?: boolean;
        crossPackGrant?: unknown;
      };
    }).deps;

    // Air-gapped research subagent must have no folder/namespace/grant access.
    expect(sdeps.linkedFolders).toEqual([]);
    expect(sdeps.strictEgressLock).toBe(false);
    expect(sdeps.crossPackGrant).toBeUndefined();
  });

  it("F2: sibling has researchProviderFactory undefined and clientBridge.approveQuery undefined", () => {
    // A parent gateway with a researchProviderFactory and an approveQuery channel.
    const parentApproveQuery = async (_req: { turnId: string; query: string }) => true;
    const parentResearchFactory = (_modelId: string) => {
      throw new Error("should not be called");
    };

    const bridge: ClientBridge = {
      invokeClient: makeClientBridge().invokeClient,
      approveQuery: parentApproveQuery,
    };

    const parent = new ToolGateway(makeDeps({
      clientBridge: bridge,
      researchProviderFactory: parentResearchFactory,
    }));

    const sibling = parent.createSiblingGateway({ linkedFolders: [] });

    const sdeps = (sibling as unknown as {
      deps: {
        researchProviderFactory?: unknown;
        clientBridge: { invokeClient: unknown; approveQuery?: unknown };
      };
    }).deps;

    // F2: no transitive delegation — research.ask on a sibling fails RESEARCH_UNAVAILABLE.
    expect(sdeps.researchProviderFactory).toBeUndefined();

    // F2: no user-approval channel — sibling clientBridge must not have approveQuery.
    expect(sdeps.clientBridge.approveQuery).toBeUndefined();

    // invokeClient must still be callable (web.fetch needs it).
    expect(typeof sdeps.clientBridge.invokeClient).toBe("function");
  });

  // ── Grounding fix (research.ask "no web access") ────────────────────────────
  //
  // Root cause: the sibling's clientBridge.invokeClient was the PLAIN parent
  // variant, which only awaits the resolver — it never EMITS the
  // TOOL_INVOCATION wire frame. The main orchestrator pump emits the frame for
  // the parent's tool calls, but the air-gapped sibling's events are consumed
  // privately by runResearchSubagent and never reach the pump (which is parked
  // inside gateway.dispatch(research.ask) awaiting approveQuery). So the
  // sibling's web.fetch resolver was created but never resolved → 30s timeout →
  // zero sources → "no web access".
  //
  // Fix: createSiblingGateway prefers the parent's `invokeClientFromSibling`
  // (a SELF-EMITTING variant, mirroring approveQuery) when present, falling
  // back to the plain `invokeClient` for back-compat.
  describe("grounding: sibling prefers the self-emitting invokeClientFromSibling", () => {
    const okResult = (frame: ToolInvocationFrame): ToolResultFrame => ({
      invocationId: frame.invocationId,
      outcome: "ok",
      resultJson: {},
    });
    const sampleFrame = (): ToolInvocationFrame => ({
      invocationId: "inv-sib-1",
      agentTurnId: "turn-sib-1",
      toolName: "web.fetch",
      args: { url: "https://example.com", query: "q" },
    });

    it("routes the sibling's invokeClient to the SELF-EMITTING variant when the parent provides it", async () => {
      const fromSibling = vi.fn(async (f: ToolInvocationFrame) => okResult(f));
      const plain = vi.fn(async (f: ToolInvocationFrame) => okResult(f));

      const bridge: ClientBridge = {
        invokeClient: plain,
        invokeClientFromSibling: fromSibling,
      };
      const parent = new ToolGateway(makeDeps({ clientBridge: bridge }));
      const sibling = parent.createSiblingGateway({ linkedFolders: [] });

      const sdeps = (sibling as unknown as {
        deps: { clientBridge: { invokeClient: ClientBridge["invokeClient"] } };
      }).deps;

      // Invoking the sibling's invokeClient must reach the self-emitting
      // variant, NOT the plain (non-emitting) one — otherwise web.fetch hangs.
      await sdeps.clientBridge.invokeClient(sampleFrame());
      expect(fromSibling).toHaveBeenCalledTimes(1);
      expect(plain).not.toHaveBeenCalled();
    });

    it("falls back to plain invokeClient when the parent has no invokeClientFromSibling (back-compat)", async () => {
      const plain = vi.fn(async (f: ToolInvocationFrame) => okResult(f));
      const bridge: ClientBridge = { invokeClient: plain };
      const parent = new ToolGateway(makeDeps({ clientBridge: bridge }));

      // Must not throw when the optional self-emitting variant is absent.
      const sibling = parent.createSiblingGateway({ linkedFolders: [] });

      const sdeps = (sibling as unknown as {
        deps: { clientBridge: { invokeClient: ClientBridge["invokeClient"] } };
      }).deps;

      await sdeps.clientBridge.invokeClient(sampleFrame());
      expect(plain).toHaveBeenCalledTimes(1);
    });
  });
});
