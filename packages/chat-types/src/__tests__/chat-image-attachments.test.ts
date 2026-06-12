import { describe, expect, it } from "vitest";
import {
  CHAT_IMAGE_ATTACHMENT_MAX_BYTES,
  validateChatImageAttachments,
  type ChatImageAttachment,
} from "../index";

// Builds a structurally valid attachment whose dataBase64 really encodes
// `byteLength` bytes, with sizeBytes matching unless overridden — the shape an
// honest client produces (web derives sizeBytes from the same File the base64
// came from; mobile from the processed picker asset).
function makeAttachment(
  byteLength: number,
  overrides: Partial<ChatImageAttachment> = {},
): ChatImageAttachment {
  return {
    id: "att-1",
    kind: "image",
    mimeType: "image/png",
    sizeBytes: byteLength,
    dataBase64: Buffer.alloc(byteLength, 7).toString("base64"),
    ...overrides,
  };
}

describe("validateChatImageAttachments — data-size enforcement", () => {
  it("accepts a consistent valid attachment", () => {
    expect(validateChatImageAttachments([makeAttachment(1200)])).toEqual({
      ok: true,
    });
  });

  it("accepts a max-size attachment whose base64 matches exactly", () => {
    expect(
      validateChatImageAttachments([
        makeAttachment(CHAT_IMAGE_ATTACHMENT_MAX_BYTES),
      ]),
    ).toEqual({ ok: true });
  });

  it("accepts unpadded base64 when the implied size still matches", () => {
    const attachment = makeAttachment(1000);
    attachment.dataBase64 = attachment.dataBase64.replace(/=+$/, "");
    expect(validateChatImageAttachments([attachment])).toEqual({ ok: true });
  });

  it("rejects oversized base64 hiding behind a small claimed sizeBytes", () => {
    // The historical bypass: sizeBytes claims 1 KB but the data string
    // actually encodes ~200 KB. The string-length cap must catch it
    // regardless of what the client claims.
    const attachment = makeAttachment(200 * 1024, { sizeBytes: 1024 });
    const result = validateChatImageAttachments([attachment]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        `Image attachment data must decode to ${CHAT_IMAGE_ATTACHMENT_MAX_BYTES} bytes or smaller.`,
      );
    }
  });

  it("rejects sizeBytes that disagrees with the base64 payload (under-claim)", () => {
    // Data is under the cap, but the declared size is a lie.
    const attachment = makeAttachment(100 * 1024, { sizeBytes: 1024 });
    const result = validateChatImageAttachments([attachment]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        "Image attachment size does not match its data.",
      );
    }
  });

  it("rejects sizeBytes that disagrees with the base64 payload (over-claim)", () => {
    const attachment = makeAttachment(1024, { sizeBytes: 100 * 1024 });
    const result = validateChatImageAttachments([attachment]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        "Image attachment size does not match its data.",
      );
    }
  });

  it("still rejects a claimed sizeBytes above the cap before inspecting data", () => {
    const attachment = makeAttachment(1024, {
      sizeBytes: CHAT_IMAGE_ATTACHMENT_MAX_BYTES + 1,
    });
    const result = validateChatImageAttachments([attachment]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        `Image attachments must be ${CHAT_IMAGE_ATTACHMENT_MAX_BYTES} bytes or smaller.`,
      );
    }
  });
});
