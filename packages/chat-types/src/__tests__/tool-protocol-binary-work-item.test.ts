import { describe, expect, it } from "vitest";

import {
  BINARY_OUTPUT_CHUNK_BYTES,
  BinaryWorkItemChunkFrameSchema,
  BinaryWorkItemWriteAckFrameSchema,
  BinaryWorkItemWriteRequestFrameSchema,
} from "../tool-protocol";

describe("binary work item chunk size (single source of truth)", () => {
  it("is the 128 KiB frame-safe size the enclave emits and the clients must accept", () => {
    // The enclave chunks every binary output at this size; the client MAX_CHUNKS
    // budget is derived from it. Exported here so the enclave and BOTH clients
    // import the SAME number — a 256 KB/128 KB drift previously halved the
    // effective image/video size cap (BINARY_WRITE_TOO_LARGE). Keep them coupled.
    expect(BINARY_OUTPUT_CHUNK_BYTES).toBe(128 * 1024);
  });
});

describe("binary work item protocol", () => {
  it("validates client-only binary source chunks with invocation binding", () => {
    const frame = BinaryWorkItemChunkFrameSchema.parse({
      kind: "binary_work_item.chunk",
      direction: "source",
      agentTurnId: "turn-1",
      invocationId: "inv-1",
      toolName: "image.transform",
      operationId: "op-1",
      itemId: "item-1",
      path: "photos/sign.png",
      sha256Hex: "a".repeat(64),
      byteLength: 3,
      chunkIndex: 0,
      chunkTotal: 1,
      chunkB64: "QUJD",
    });

    expect(frame).toMatchObject({
      kind: "binary_work_item.chunk",
      direction: "source",
      invocationId: "inv-1",
      toolName: "image.transform",
    });
  });

  it("validates output write request and ack frames without carrying model-visible bytes", () => {
    const request = BinaryWorkItemWriteRequestFrameSchema.parse({
      kind: "binary_work_item.write_request",
      agentTurnId: "turn-1",
      invocationId: "inv-1",
      toolName: "image.transform",
      operationId: "op-1",
      outputId: "out-1",
      outputPath: "photos/sign.calypso.png",
      sha256Hex: "b".repeat(64),
      byteLength: 12,
      chunkCount: 2,
    });
    expect(JSON.stringify(request)).not.toContain("chunkB64");

    const ack = BinaryWorkItemWriteAckFrameSchema.parse({
      kind: "binary_work_item.write_ack",
      agentTurnId: "turn-1",
      invocationId: "inv-1",
      operationId: "op-1",
      outputId: "out-1",
      outputPath: "photos/sign.calypso.png",
      sha256Hex: "b".repeat(64),
      byteLength: 12,
      outcome: "ok",
    });
    expect(ack.outcome).toBe("ok");
  });

  it("accepts image.generate and image.edit as binary output tool names", () => {
    for (const toolName of ["image.generate", "image.edit"] as const) {
      const request = BinaryWorkItemWriteRequestFrameSchema.parse({
        kind: "binary_work_item.write_request",
        agentTurnId: "turn-1",
        invocationId: "inv-1",
        toolName,
        operationId: "op-1",
        outputId: "out-1",
        outputPath: "generated/image.calypso.png",
        sha256Hex: "c".repeat(64),
        byteLength: 12,
        chunkCount: 1,
      });
      expect(request.toolName).toBe(toolName);
    }
  });

  it("rejects malformed hashes and unsupported binary tool names", () => {
    expect(() =>
      BinaryWorkItemChunkFrameSchema.parse({
        kind: "binary_work_item.chunk",
        direction: "source",
        agentTurnId: "turn-1",
        invocationId: "inv-1",
        toolName: "web.fetch",
        operationId: "op-1",
        itemId: "item-1",
        path: "x",
        sha256Hex: "not-a-hash",
        byteLength: 1,
        chunkIndex: 0,
        chunkTotal: 1,
        chunkB64: "WA==",
      }),
    ).toThrow();
  });

  // AI finding: PositiveByteLengthSchema is named "Positive" but permits 0.
  // A zero-byte binary work item is semantically meaningless, so byteLength
  // must reject 0 on every frame that carries it.
  it("rejects a zero byteLength on chunk, write-request, and write-ack frames", () => {
    expect(() =>
      BinaryWorkItemChunkFrameSchema.parse({
        kind: "binary_work_item.chunk",
        direction: "source",
        agentTurnId: "turn-1",
        invocationId: "inv-1",
        toolName: "image.transform",
        operationId: "op-1",
        itemId: "item-1",
        path: "photos/sign.png",
        sha256Hex: "a".repeat(64),
        byteLength: 0,
        chunkIndex: 0,
        chunkTotal: 1,
        chunkB64: "QUJD",
      }),
    ).toThrow();

    expect(() =>
      BinaryWorkItemWriteRequestFrameSchema.parse({
        kind: "binary_work_item.write_request",
        agentTurnId: "turn-1",
        invocationId: "inv-1",
        toolName: "image.transform",
        operationId: "op-1",
        outputId: "out-1",
        outputPath: "photos/sign.calypso.png",
        sha256Hex: "b".repeat(64),
        byteLength: 0,
        chunkCount: 1,
      }),
    ).toThrow();

    expect(() =>
      BinaryWorkItemWriteAckFrameSchema.parse({
        kind: "binary_work_item.write_ack",
        agentTurnId: "turn-1",
        invocationId: "inv-1",
        operationId: "op-1",
        outputId: "out-1",
        outputPath: "photos/sign.calypso.png",
        sha256Hex: "b".repeat(64),
        byteLength: 0,
        outcome: "ok",
      }),
    ).toThrow();
  });
});
