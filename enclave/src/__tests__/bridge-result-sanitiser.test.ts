import { describe, expect, it } from "vitest";

import { sanitiseBridgeResultForDispatch } from "../tools/bridge-result-sanitiser";
import type { ToolCallLedgerEntry, ToolResultFrame } from "@calypso/chat-types";

const baseLedger: Omit<
  ToolCallLedgerEntry,
  "id" | "outcome" | "reason" | "scope" | "approvedPath"
> = {
  invokedAt: "2026-05-13T00:00:00.000Z",
  toolName: "folder.write",
  skillPackId: "personal-agent.career",
  turnId: "turn1",
};

describe("bridge result sanitiser", () => {
  it("normalises an unknown TOOL_RESULT outcome to a controlled bridge error", () => {
    const r = sanitiseBridgeResultForDispatch(
      {
        invocationId: "inv1",
        outcome: "WEIRD",
        reason: "hostile detail",
      } as unknown as ToolResultFrame,
      baseLedger,
      "folder/Career",
      null,
    );

    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("BRIDGE_ERROR");
    expect(r.ledgerEntry.outcome).toBe("error");
    expect(r.ledgerEntry.reason).toBe("BRIDGE_ERROR");
  });

  it("normalises a missing TOOL_RESULT outcome to a controlled bridge error", () => {
    const r = sanitiseBridgeResultForDispatch(
      {
        invocationId: "inv1",
        reason: "missing outcome",
      } as unknown as ToolResultFrame,
      baseLedger,
      "folder/Career",
      null,
    );

    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("BRIDGE_ERROR");
    expect(r.ledgerEntry.outcome).toBe("error");
    expect(r.ledgerEntry.reason).toBe("BRIDGE_ERROR");
  });
});
