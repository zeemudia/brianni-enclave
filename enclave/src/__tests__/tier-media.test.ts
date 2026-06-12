import { describe, expect, it, vi } from "vitest";

import { ToolGateway, type ClientBridge } from "../tools";
import { BinaryWorkItemManager } from "../tools/binary-work-items";
import type { MediaToolResult } from "../tools/media-tools";
import type { SkillPack, ToolInvocationFrame } from "@calypso/chat-types";

const pack: SkillPack = {
  id: "personal-agent.default",
  version: 1,
  displayName: "Default",
  description: "Default pack.",
  systemPromptBlock: "You are Calypso.",
  toolScopes: ["image.ocr", "image.transform", "document.edit", "pdf.edit"],
  capabilitySuiteIds: ["image", "office-document", "pdf"],
  defaultNamespace: "default",
  linkedFolderScopes: {},
  uiHints: { icon: "default", accentToken: "accent-default" },
};

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function frame(
  toolName: ToolInvocationFrame["toolName"],
  args: Record<string, unknown>,
): ToolInvocationFrame {
  return {
    invocationId: "inv1",
    agentTurnId: "turn1",
    toolName,
    args,
  };
}

function bridgeWithFile(filename: string, bytes: Buffer): ClientBridge {
  return {
    invokeClient: vi.fn().mockResolvedValue({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename,
            byteLength: bytes.byteLength,
            contentB64: bytes.toString("base64"),
          },
        ],
      },
    }),
  };
}

describe("tier-media gateway tools", () => {
  it("image.ocr reads source bytes from the client and returns only OCR text to the model", async () => {
    const mediaTools = {
      run: vi.fn().mockResolvedValue({
        contentKind: "image",
        extractionStatus: "ok",
        text: "HELLO OCR",
        metadata: { engine: "test" },
      } satisfies MediaToolResult),
    };
    const bridge = bridgeWithFile("ocr.png", validPng);
    const gw = new ToolGateway({ clientBridge: bridge, mediaTools });

    const result = await gw.dispatch(
      frame("image.ocr", {
        folderId: "folder1",
        displayName: "Docs",
        filename: "ocr.png",
      }),
      pack,
      "turn1",
    );

    expect(result.outcome).toBe("ok");
    expect(mediaTools.run).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "image.ocr",
        filename: "ocr.png",
      }),
    );
    expect(JSON.stringify(result.resultJson)).not.toContain("contentB64");
    expect(result.resultJson).toMatchObject({
      text: "HELLO OCR",
      extractionStatus: "ok",
    });
  });

  it("image.transform strips output bytes from model-visible result and prepares a client-only write", async () => {
    const mediaTools = {
      run: vi.fn().mockResolvedValue({
        contentKind: "image",
        extractionStatus: "ok",
        outputB64: Buffer.from("PNGDATA").toString("base64"),
        outputMimeType: "image/png",
        outputExtension: ".png",
        outputSha256Hex: "a".repeat(64),
        metadata: { width: 1, height: 1 },
      } satisfies MediaToolResult),
    };
    const binaryWorkItems = new BinaryWorkItemManager({ sweepIntervalMs: null });
    const gw = new ToolGateway({
      clientBridge: bridgeWithFile("photo.png", validPng),
      mediaTools,
      binaryWorkItems,
      sessionId: "sess1",
    });

    const result = await gw.dispatch(
      frame("image.transform", {
        folderId: "folder1",
        displayName: "Docs",
        filename: "photo.png",
        outputPath: "photo.calypso.png",
        transform: { kind: "resize", maxWidth: 100, maxHeight: 100, format: "png" },
      }),
      pack,
      "turn1",
    );

    expect(result.outcome).toBe("ok");
    expect(JSON.stringify(result.resultJson)).not.toContain("PNGDATA");
    expect(JSON.stringify(result.resultJson)).not.toContain("outputB64");
    expect(result.resultJson).toMatchObject({
      status: "awaiting_client_write",
      outputPath: "photo.calypso.png",
      byteLength: 7,
      writeState: "pending_client_confirmation",
      userConfirmationRequired: true,
      modelInstruction:
        "Do not claim this output has been saved yet; tell the user a copy is prepared and awaiting their confirmation.",
    });
    expect(result.clientOnlyBinaryWrite?.request).toMatchObject({
      kind: "binary_work_item.write_request",
      outputPath: "photo.calypso.png",
      byteLength: 7,
    });
    expect(result.clientOnlyBinaryWrite?.chunks[0]?.chunkB64).toBe(
      Buffer.from("PNGDATA").toString("base64"),
    );
    expect(
      binaryWorkItems.ackOutputWrite({
        kind: "binary_work_item.write_ack",
        sessionId: "sess1",
        agentTurnId: "turn1",
        invocationId: "inv1",
        operationId: "image.transform:inv1",
        outputId: result.clientOnlyBinaryWrite!.request.outputId,
        outputPath: "photo.calypso.png",
        sha256Hex: result.clientOnlyBinaryWrite!.request.sha256Hex,
        byteLength: 7,
        outcome: "ok",
      }),
    ).toEqual({ status: "acknowledged" });
  });

  it("lazy-starts the configured media sidecar before the first operation", async () => {
    let ready = false;
    const start = vi.fn().mockImplementation(async () => {
      ready = true;
    });
    const run = vi.fn().mockResolvedValue({
      contentKind: "image",
      extractionStatus: "ok",
      text: "HELLO OCR",
      metadata: { engine: "test" },
    } satisfies MediaToolResult);
    const gw = new ToolGateway({
      clientBridge: bridgeWithFile("ocr.png", validPng),
      mediaTools: {
        start,
        isReady: () => ready,
        run,
      },
    });

    const result = await gw.dispatch(
      frame("image.ocr", {
        folderId: "folder1",
        displayName: "Docs",
        filename: "ocr.png",
      }),
      pack,
      "turn1",
    );

    expect(result.outcome).toBe("ok");
    expect(start).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(
      run.mock.invocationCallOrder[0],
    );
  });

  it("document.edit fails closed for native iWork files", async () => {
    const gw = new ToolGateway({
      clientBridge: bridgeWithFile("deck.key", Buffer.from("iwork")),
      mediaTools: { run: vi.fn() },
    });

    const result = await gw.dispatch(
      frame("document.edit", {
        folderId: "folder1",
        displayName: "Docs",
        filename: "deck.key",
        outputPath: "deck-copy.key",
        transform: { kind: "append_section", heading: "x", body: "y" },
      }),
      { ...pack, capabilitySuiteIds: ["apple-iwork"] },
      "turn1",
    );

    expect(result.outcome).toBe("gateway_rejected");
    expect(result.reason).toBe("IWORK_NATIVE_EDIT_UNSUPPORTED");
  });
});
