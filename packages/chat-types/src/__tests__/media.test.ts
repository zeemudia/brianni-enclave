import { describe, expect, it } from "vitest";
import {
  MediaArtifactKindSchema,
  MediaProvenanceRecordSchema,
  ProviderVisibleInputConsentSchema,
  VideoCompositionSpecSchema,
} from "../media";

describe("media contracts", () => {
  it("accepts signed media provenance records", () => {
    const parsed = MediaProvenanceRecordSchema.parse({
      handleId: "mh_01JVIDEO000000000000000001",
      kind: "video",
      origin: "generated_from_private",
      providerVisible: false,
      sourceHandleIds: ["mh_source"],
      createdBy: "core.video.remotion",
      createdAt: "2026-05-19T08:30:00.000Z",
      ttlSeconds: 900,
      byteSize: 1048576,
      sha256: "a".repeat(64),
      signature: "sig_b64",
    });

    expect(parsed.origin).toBe("generated_from_private");
  });

  it("accepts first-pass artifact kinds", () => {
    expect(MediaArtifactKindSchema.parse("video/mp4")).toBe("video/mp4");
    expect(MediaArtifactKindSchema.parse("application/remotion-spec+json")).toBe(
      "application/remotion-spec+json",
    );
  });

  it("accepts a constrained video composition spec", () => {
    const parsed = VideoCompositionSpecSchema.parse({
      version: 1,
      title: "Launch teaser",
      templateId: "promo_cut",
      format: {
        width: 1080,
        height: 1920,
        fps: 30,
        durationFrames: 240,
      },
      assets: [
        { id: "hero", handleId: "mh_hero", kind: "image" },
        { id: "bed", handleId: "mh_music", kind: "audio" },
      ],
      scenes: [
        {
          id: "scene-1",
          startFrame: 0,
          durationFrames: 240,
          layout: "full_bleed",
          layers: [
            { type: "asset", assetId: "hero", fit: "cover" },
            { type: "caption", textHandleId: "mh_caption", startFrame: 30, durationFrames: 120 },
          ],
        },
      ],
    });

    expect(parsed.scenes[0]?.layers[1]).toMatchObject({
      type: "caption",
      textHandleId: "mh_caption",
    });
  });

  it("rejects inline rendered text and raw URLs in composition specs", () => {
    expect(() =>
      VideoCompositionSpecSchema.parse({
        version: 1,
        title: "Bad spec",
        templateId: "captioned_story",
        format: { width: 1080, height: 1080, fps: 30, durationFrames: 90 },
        assets: [{ id: "a1", handleId: "https://example.com/a.png", kind: "image" }],
        scenes: [
          {
            id: "s1",
            startFrame: 0,
            durationFrames: 90,
            layout: "title_card",
            layers: [{ type: "text", text: "inline copy", styleToken: "headline" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects disguised raw locations and unsupported frame sizes", () => {
    for (const badHandle of [
      "HTTPS://example.com/a.png",
      "javascript:alert(1)",
      "[fd00:ec2::254]/latest/meta-data",
      "::ffff:169.254.169.254",
      "mh",
    ]) {
      expect(() =>
        VideoCompositionSpecSchema.parse({
          version: 1,
          title: "Bad handle",
          templateId: "captioned_story",
          format: { width: 1080, height: 1080, fps: 30, durationFrames: 90 },
          assets: [{ id: "a1", handleId: badHandle, kind: "image" }],
          scenes: [
            {
              id: "s1",
              startFrame: 0,
              durationFrames: 90,
              layout: "title_card",
              layers: [{ type: "asset", assetId: "a1", fit: "cover" }],
            },
          ],
        }),
      ).toThrow();
    }

    expect(() =>
      VideoCompositionSpecSchema.parse({
        version: 1,
        title: "Bad dimensions",
        templateId: "captioned_story",
        format: { width: 1920, height: 1920, fps: 30, durationFrames: 90 },
        assets: [],
        scenes: [
          {
            id: "s1",
            startFrame: 0,
            durationFrames: 90,
            layout: "title_card",
            layers: [{ type: "text", textHandleId: "mh_caption", styleToken: "headline" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts provider-visible consent tokens bound to exact dispatch inputs", () => {
    const parsed = ProviderVisibleInputConsentSchema.parse({
      consentId: "consent_01JVIDEO0000000000001",
      planId: "plan_1",
      subtaskId: "clip_1",
      providerId: "google",
      modelId: "veo-3.1-generate-preview",
      inputHandleSetHash: "b".repeat(64),
      enclaveNonce: "nonce_1234567890123456",
      expiresAt: "2026-05-19T08:35:00.000Z",
      signerKeyId: "device_key_1",
      signature: { type: "device_key", signature: "sig_b64" },
    });

    expect(parsed.providerId).toBe("google");
  });
});
