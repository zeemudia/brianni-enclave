import { describe, it, expect } from "vitest";
import { ClaimsTaskReceiptSchema } from "../claims-receipt";

describe("ClaimsTaskReceiptSchema", () => {
  it("validates a full receipt", () => {
    const r = ClaimsTaskReceiptSchema.parse({
      id: "r1", taskId: "t1", grantId: "g1", createdAt: Date.now(), mode: "jit",
      exercisedNamespaces: ["money", "health"],
      folderIds: ["folder_1", "folder_2"],
      documentIds: ["d1", "d2"],
      approvedQueries: ["Aetna PPO out-of-network ER appeal deadline 2026"],
      fetchedUrls: ["https://www.aetna.com/appeals"],
      artifactHash: "a".repeat(64),
    });
    expect(r.exercisedNamespaces).toContain("money");
    expect(r.folderIds).toEqual(["folder_1", "folder_2"]);
    expect(r.mode).toBe("jit");
  });

  it("defaults the optional array fields to []", () => {
    const r = ClaimsTaskReceiptSchema.parse({
      id: "r1", taskId: "t1", grantId: "g1", createdAt: Date.now(), mode: "durable",
      exercisedNamespaces: [],
    });
    expect(r.folderIds).toEqual([]);
    expect(r.documentIds).toEqual([]);
    expect(r.approvedQueries).toEqual([]);
    expect(r.fetchedUrls).toEqual([]);
    expect(r.artifactHash).toBeUndefined();
  });

  it('defaults status to "completed" so receipts stored before it existed parse', () => {
    const r = ClaimsTaskReceiptSchema.parse({
      id: "r1", taskId: "t1", grantId: "g1", createdAt: Date.now(), mode: "jit",
      exercisedNamespaces: ["money"],
    });
    expect(r.status).toBe("completed");
  });

  it('parses an explicit "errored" status', () => {
    const r = ClaimsTaskReceiptSchema.parse({
      id: "r1", taskId: "t1", grantId: "g1", createdAt: Date.now(), mode: "jit",
      status: "errored",
      exercisedNamespaces: ["money"],
    });
    expect(r.status).toBe("errored");
  });

  it('parses an explicit "cancelled" status (user-aborted run with recordable activity)', () => {
    const r = ClaimsTaskReceiptSchema.parse({
      id: "r1", taskId: "t1", grantId: "g1", createdAt: Date.now(), mode: "jit",
      status: "cancelled",
      exercisedNamespaces: ["money"],
    });
    expect(r.status).toBe("cancelled");
  });

  it("rejects an unknown status", () => {
    expect(() =>
      ClaimsTaskReceiptSchema.parse({
        id: "r1", taskId: "t1", grantId: "g1", createdAt: Date.now(), mode: "jit",
        status: "aborted",
        exercisedNamespaces: ["money"],
      } as never),
    ).toThrow();
  });

  it("parses a receipt stored before folderIds existed (back-compat default)", () => {
    // Simulate a receipt written by an earlier build that had no folderIds
    // field: the schema default must backfill it so old stored receipts
    // still parse on read.
    const r = ClaimsTaskReceiptSchema.parse({
      id: "r1", taskId: "t1", grantId: "g1", createdAt: Date.now(), mode: "jit",
      exercisedNamespaces: ["money"],
      documentIds: ["d1"],
      approvedQueries: [],
      fetchedUrls: [],
    });
    expect(r.folderIds).toEqual([]);
  });

  it("rejects a non-hex artifactHash", () => {
    expect(() =>
      ClaimsTaskReceiptSchema.parse({
        id: "r1", taskId: "t1", grantId: "g1", createdAt: Date.now(), mode: "jit",
        exercisedNamespaces: ["money"], artifactHash: "zz",
      }),
    ).toThrow();
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      ClaimsTaskReceiptSchema.parse({
        id: "r1", taskId: "t1", grantId: "g1", createdAt: Date.now(), mode: "permanent",
        exercisedNamespaces: ["money"],
      } as never),
    ).toThrow();
  });

  it("rejects an empty grantId (receipt must trace to its authorizing grant)", () => {
    expect(() =>
      ClaimsTaskReceiptSchema.parse({
        id: "r1", taskId: "t1", grantId: "", createdAt: Date.now(), mode: "jit",
        exercisedNamespaces: ["money"],
      }),
    ).toThrow();
  });
});
