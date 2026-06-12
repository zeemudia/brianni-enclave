import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BinaryWorkItemManager,
  DEFAULT_BINARY_WORK_ITEM_TOTAL_CAP,
  FRAME_SAFE_OUTPUT_CHUNK_BYTES,
  buildBinaryWriteWireFrames,
  type BinaryWorkItemChunkInput,
} from "../tools/binary-work-items";
import { MAX_PADDED_PAYLOAD } from "@calypso/chat-types";

const SESSION = "sess-1";
const TURN = "turn-1";
const INV = "inv-1";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceChunk(
  bytes: Buffer,
  overrides: Partial<BinaryWorkItemChunkInput> = {},
): BinaryWorkItemChunkInput {
  return {
    sessionId: SESSION,
    agentTurnId: TURN,
    invocationId: INV,
    toolName: "image.transform",
    operationId: "op-1",
    itemId: "item-1",
    path: "photos/sign.png",
    sha256Hex: sha256Hex(Buffer.from("ABCDEF")),
    byteLength: 6,
    chunkIndex: 0,
    chunkTotal: 2,
    chunkB64: bytes.toString("base64"),
    direction: "source",
    ...overrides,
  };
}

describe("BinaryWorkItemManager", () => {
  it("keeps the default output cap aligned with the linked-folder write budget", () => {
    expect(DEFAULT_BINARY_WORK_ITEM_TOTAL_CAP).toBe(5 * 1024 * 1024);
    const manager = new BinaryWorkItemManager({ sweepIntervalMs: null });

    expect(() =>
      manager.createOutputWriteRequest({
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: INV,
        toolName: "image.transform",
        operationId: "op-oversized",
        outputId: "out-oversized",
        outputPath: "photos/oversized.calypso.png",
        outputBytes: Buffer.alloc(DEFAULT_BINARY_WORK_ITEM_TOTAL_CAP + 1),
      }),
    ).toThrow(`BINARY_WORK_ITEM_TOO_LARGE:${DEFAULT_BINARY_WORK_ITEM_TOTAL_CAP + 1}`);
  });

  it("streams source bytes without producing model-visible binary", () => {
    const manager = new BinaryWorkItemManager({
      sweepIntervalMs: null,
      perChunkByteCap: 8,
      totalByteCap: 16,
    });

    const first = manager.addChunk(sourceChunk(Buffer.from("ABC")));
    expect(first).toMatchObject({ status: "pending" });

    const second = manager.addChunk(
      sourceChunk(Buffer.from("DEF"), { chunkIndex: 1 }),
    );
    expect(second).toMatchObject({
      status: "complete",
      workItemId: "item-1",
      byteLength: 6,
      sha256Hex: sha256Hex(Buffer.from("ABCDEF")),
    });

    const status = manager.toModelVisibleSourceStatus("item-1");
    expect(status).toEqual({
      status: "ready",
      itemId: "item-1",
      path: "photos/sign.png",
      byteLength: 6,
      sha256Hex: sha256Hex(Buffer.from("ABCDEF")),
    });
    expect(JSON.stringify(status)).not.toContain("QUJD");
    expect(JSON.stringify(status)).not.toContain("ABCDEF");
  });

  it("rejects over-cap chunks and sha mismatches", () => {
    const manager = new BinaryWorkItemManager({
      sweepIntervalMs: null,
      perChunkByteCap: 2,
      totalByteCap: 16,
    });

    expect(manager.addChunk(sourceChunk(Buffer.from("ABC")))).toMatchObject({
      status: "rejected",
      errorCode: "BINARY_WORK_ITEM_CHUNK_TOO_LARGE",
    });

    const wrongShaManager = new BinaryWorkItemManager({
      sweepIntervalMs: null,
      perChunkByteCap: 8,
      totalByteCap: 16,
    });
    wrongShaManager.addChunk(
      sourceChunk(Buffer.from("ABC"), {
        sha256Hex: "f".repeat(64),
      }),
    );
    expect(
      wrongShaManager.addChunk(
        sourceChunk(Buffer.from("DEF"), {
          chunkIndex: 1,
          sha256Hex: "f".repeat(64),
        }),
      ),
    ).toMatchObject({
      status: "rejected",
      errorCode: "BINARY_WORK_ITEM_SHA_MISMATCH",
    });
  });

  it("rejects duplicate byte mismatches and treats identical replays as no-ops", () => {
    const manager = new BinaryWorkItemManager({
      sweepIntervalMs: null,
      perChunkByteCap: 8,
      totalByteCap: 16,
    });

    expect(manager.addChunk(sourceChunk(Buffer.from("ABC")))).toMatchObject({
      status: "pending",
    });
    expect(manager.addChunk(sourceChunk(Buffer.from("ABC")))).toMatchObject({
      status: "pending",
      accepted: false,
    });
    expect(manager.addChunk(sourceChunk(Buffer.from("XYZ")))).toMatchObject({
      status: "rejected",
      errorCode: "BINARY_WORK_ITEM_REPLAY_MISMATCH",
    });
  });

  it("requires output write acknowledgement before reporting committed status", () => {
    const manager = new BinaryWorkItemManager({
      sweepIntervalMs: null,
      perChunkByteCap: 8,
      totalByteCap: 64,
    });
    const output = manager.createOutputWriteRequest({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      toolName: "image.transform",
      operationId: "op-1",
      outputId: "out-1",
      outputPath: "photos/sign.calypso.png",
      outputBytes: Buffer.from("PNGDATA"),
      outputChunkSize: 4,
    });

    expect(output.request).toMatchObject({
      kind: "binary_work_item.write_request",
      outputId: "out-1",
      byteLength: 7,
      chunkCount: 2,
    });
    expect(output.modelResult).toMatchObject({
      status: "awaiting_client_write",
      outputPath: "photos/sign.calypso.png",
    });
    expect(JSON.stringify(output.request)).not.toContain("UE5HREFUQQ");
    expect(JSON.stringify(output.modelResult)).not.toContain("PNGDATA");

    const beforeAck = manager.toModelVisibleOutputStatus("out-1");
    expect(beforeAck).toMatchObject({ status: "awaiting_client_write" });
    const pendingBytes = manager.__peekOutputBytesForTest("out-1");
    expect(pendingBytes?.toString("utf8")).toBe("PNGDATA");

    const ack = manager.ackOutputWrite({
      kind: "binary_work_item.write_ack",
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      operationId: "op-1",
      outputId: "out-1",
      outputPath: "photos/sign.calypso.png",
      sha256Hex: output.request.sha256Hex,
      byteLength: 7,
      outcome: "ok",
    });
    expect(ack).toEqual({ status: "acknowledged" });
    expect(manager.toModelVisibleOutputStatus("out-1")).toMatchObject({
      status: "committed",
      outputPath: "photos/sign.calypso.png",
      byteLength: 7,
      sha256Hex: output.request.sha256Hex,
    });
    expect([...pendingBytes!]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(manager.__peekOutputBytesForTest("out-1")?.byteLength).toBe(0);
  });

  // Regression (live Defect D3, A13): a large OUTPUT artifact (a 10s WAV clip
  // ≈ 860 KB) must be split into frame-safe chunks. With the default chunk size,
  // each serialized chunk frame — base64(chunk) + the JSON envelope — must fit
  // inside a single padded SSE response frame (MAX_PADDED_PAYLOAD = 262140), or
  // the wire encoder throws "padded response chunk exceeds maximum frame". The
  // old 256 KB raw default produced ~349 KB frames that overflowed.
  it("splits a large output artifact into frame-safe chunks (D3)", () => {
    const manager = new BinaryWorkItemManager({
      sweepIntervalMs: null,
      // default per-chunk cap (256 KB) → default output chunk size is the
      // FRAME_SAFE_OUTPUT_CHUNK_BYTES (128 KB), not the cap.
    });
    const big = Buffer.alloc(860 * 1024, 0xab); // ~10s WAV-sized artifact
    const output = manager.createOutputWriteRequest({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      toolName: "audio.transform",
      operationId: "op-clip",
      outputId: "out-clip",
      outputPath: "proof-audio-calypso-clip.wav",
      outputBytes: big,
      // no explicit outputChunkSize → uses the frame-safe default
    });

    expect(output.request.chunkCount).toBeGreaterThan(1);
    expect(output.chunks).toHaveLength(output.request.chunkCount);
    for (const chunk of output.chunks) {
      // raw chunk within the frame-safe cap
      const raw = Buffer.from(chunk.chunkB64, "base64");
      expect(raw.byteLength).toBeLessThanOrEqual(FRAME_SAFE_OUTPUT_CHUNK_BYTES);
      // the SERIALIZED frame (what gets encrypted + padded) fits the SSE cap
      expect(Buffer.byteLength(JSON.stringify(chunk), "utf8")).toBeLessThan(
        MAX_PADDED_PAYLOAD,
      );
    }
    // chunks reassemble to the original byte length
    const total = output.chunks.reduce(
      (n, c) => n + Buffer.from(c.chunkB64, "base64").byteLength,
      0,
    );
    expect(total).toBe(big.byteLength);
  });

  // Regression (live Defect D3, A13 — the REAL fix): the wire emitter must send
  // a write_request frame (metadata, NO embedded chunks) followed by ONE frame
  // per chunk. The previous emitter serialized the whole payload (incl. every
  // chunk) into a SINGLE frame, so an 860 KB WAV (~1.2 MB framed) overflowed the
  // 262140-byte padded SSE cap no matter the per-chunk size. Every emitted frame
  // must independently fit MAX_PADDED_PAYLOAD.
  it("emits a write_request + separate per-chunk frames, each frame-safe (D3 wire)", () => {
    const manager = new BinaryWorkItemManager({ sweepIntervalMs: null });
    const big = Buffer.alloc(860 * 1024, 0xcd);
    const output = manager.createOutputWriteRequest({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      toolName: "audio.transform",
      operationId: "op-clip",
      outputId: "out-clip",
      outputPath: "proof-audio-calypso-clip.wav",
      outputBytes: big,
    });
    const payload = {
      folderId: "fld_1",
      displayName: "Docs",
      request: output.request,
      chunks: output.chunks,
    };
    const frames = buildBinaryWriteWireFrames(payload, undefined) as Array<
      Record<string, unknown>
    >;

    // frame 0 = write_request: carries chunkCount, NOT the chunk bytes
    expect(frames[0]._type).toBe("binary_work_item.write_request");
    expect(frames[0].chunks).toBeUndefined();
    expect((frames[0].request as { chunkCount: number }).chunkCount).toBe(
      output.request.chunkCount,
    );
    // one chunk frame per chunk, all tagged binary_work_item.chunk
    const chunkFrames = frames.slice(1);
    expect(chunkFrames).toHaveLength(output.request.chunkCount);
    expect(
      chunkFrames.every((f) => f._type === "binary_work_item.chunk"),
    ).toBe(true);
    // EVERY emitted frame independently fits a padded SSE response frame
    for (const f of frames) {
      expect(Buffer.byteLength(JSON.stringify(f), "utf8")).toBeLessThan(
        MAX_PADDED_PAYLOAD,
      );
    }
  });

  it("zeros and drops output bytes when the client denies a write", () => {
    const manager = new BinaryWorkItemManager({
      sweepIntervalMs: null,
      perChunkByteCap: 8,
      totalByteCap: 64,
    });
    const output = manager.createOutputWriteRequest({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      toolName: "image.transform",
      operationId: "op-1",
      outputId: "out-denied",
      outputPath: "photos/sign.calypso.png",
      outputBytes: Buffer.from("PNGDATA"),
      outputChunkSize: 4,
    });
    const pendingBytes = manager.__peekOutputBytesForTest("out-denied");

    expect(
      manager.ackOutputWrite({
        kind: "binary_work_item.write_ack",
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: INV,
        operationId: "op-1",
        outputId: "out-denied",
        outputPath: "photos/sign.calypso.png",
        sha256Hex: output.request.sha256Hex,
        byteLength: 7,
        outcome: "denied_by_user",
        reason: "cancelled",
      }),
    ).toMatchObject({
      status: "rejected",
      errorCode: "BINARY_WORK_ITEM_ACK_DENIED",
    });
    expect([...pendingBytes!]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(manager.toModelVisibleOutputStatus("out-denied")).toEqual({
      status: "missing",
      outputId: "out-denied",
    });
  });

  it("rejects cross-invocation output acknowledgements", () => {
    const manager = new BinaryWorkItemManager({
      sweepIntervalMs: null,
      perChunkByteCap: 8,
      totalByteCap: 64,
    });
    const output = manager.createOutputWriteRequest({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      toolName: "image.transform",
      operationId: "op-1",
      outputId: "out-1",
      outputPath: "photos/sign.calypso.png",
      outputBytes: Buffer.from("PNGDATA"),
      outputChunkSize: 4,
    });

    expect(
      manager.ackOutputWrite({
        kind: "binary_work_item.write_ack",
        sessionId: SESSION,
        agentTurnId: TURN,
        invocationId: "other-invocation",
        operationId: "op-1",
        outputId: "out-1",
        outputPath: "photos/sign.calypso.png",
        sha256Hex: output.request.sha256Hex,
        byteLength: 7,
        outcome: "ok",
      }),
    ).toMatchObject({
      status: "rejected",
      errorCode: "BINARY_WORK_ITEM_ACK_MISMATCH",
    });
  });

  it("zeros source and output bytes on session cleanup", () => {
    const manager = new BinaryWorkItemManager({
      sweepIntervalMs: null,
      perChunkByteCap: 8,
      totalByteCap: 64,
    });
    manager.addChunk(sourceChunk(Buffer.from("ABC")));
    manager.addChunk(sourceChunk(Buffer.from("DEF"), { chunkIndex: 1 }));
    const sourceBuffer = manager.__peekSourceBytesForTest("item-1");
    expect(sourceBuffer?.toString("utf8")).toBe("ABCDEF");

    manager.createOutputWriteRequest({
      sessionId: SESSION,
      agentTurnId: TURN,
      invocationId: INV,
      toolName: "image.transform",
      operationId: "op-1",
      outputId: "out-1",
      outputPath: "photos/sign.calypso.png",
      outputBytes: Buffer.from("PNGDATA"),
      outputChunkSize: 4,
    });
    const outputBuffer = manager.__peekOutputBytesForTest("out-1");
    expect(outputBuffer?.toString("utf8")).toBe("PNGDATA");

    manager.clearForSession(SESSION);
    expect([...sourceBuffer!]).toEqual([0, 0, 0, 0, 0, 0]);
    expect([...outputBuffer!]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(manager.toModelVisibleSourceStatus("item-1")).toEqual({
      status: "missing",
      itemId: "item-1",
    });
  });
});
