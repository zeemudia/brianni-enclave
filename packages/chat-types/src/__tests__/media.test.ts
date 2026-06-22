import { describe, expect, it } from "vitest";
import {
  MediaHandleKindSchema,
  MediaJobStatusSchema,
  MediaArtifactKindSchema,
  MediaOriginSchema,
  MediaProvenanceRecordSchema,
  ProviderVisibleInputConsentSchema,
  VideoCompositionSpecSchema,
  canonicaliseProviderVisibleConsentUnsigned,
  canonicaliseStableJson,
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

  it("pins media enum values used across app, enclave, and renderer boundaries", () => {
    expect(MediaHandleKindSchema.options).toEqual([
      "text",
      "caption",
      "image",
      "audio",
      "video",
      "font",
      "composition",
    ]);
    expect(MediaOriginSchema.options).toEqual([
      "user_private",
      "public",
      "generated",
      "generated_from_private",
      "system_template",
    ]);
    expect(MediaJobStatusSchema.options).toContain("waiting_for_renderer");
    expect(MediaJobStatusSchema.options).toContain("done");
    expect(MediaJobStatusSchema.options).toContain("error");
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

  it("accepts WebAuthn provider-visible consent signatures and canonicalises unsigned payloads", () => {
    const unsigned = {
      consentId: "consent_01JVIDEO0000000000002",
      planId: "plan_1",
      subtaskId: "clip_1",
      providerId: "google",
      modelId: "veo-3.1-generate-preview",
      inputHandleSetHash: "b".repeat(64),
      enclaveNonce: "nonce_1234567890123456",
      expiresAt: "2026-05-19T08:35:00.000Z",
      signerKeyId: "passkey_1",
    };
    const parsed = ProviderVisibleInputConsentSchema.parse({
      ...unsigned,
      signature: {
        type: "webauthn",
        credentialId: "cred_1",
        authenticatorData: "auth_data",
        clientDataJSON: "client_json",
        signature: "sig_b64",
      },
    });

    expect(parsed.signature.type).toBe("webauthn");
    expect(canonicaliseProviderVisibleConsentUnsigned(unsigned)).toBe(
      canonicaliseStableJson({
        consentId: "consent_01JVIDEO0000000000002",
        enclaveNonce: "nonce_1234567890123456",
        expiresAt: "2026-05-19T08:35:00.000Z",
        inputHandleSetHash: "b".repeat(64),
        modelId: "veo-3.1-generate-preview",
        planId: "plan_1",
        providerId: "google",
        signerKeyId: "passkey_1",
        subtaskId: "clip_1",
      }),
    );
  });

  it("sorts nested stable JSON keys without reordering arrays", () => {
    expect(
      canonicaliseStableJson({
        z: 1,
        a: [{ b: 2, a: 1 }],
        m: { y: true, x: null },
      }),
    ).toBe('{"a":[{"a":1,"b":2}],"m":{"x":null,"y":true},"z":1}');
  });

  it("rejects over-broad media provenance and consent tokens", () => {
    expect(() =>
      MediaProvenanceRecordSchema.parse({
        handleId: "mh_01JVIDEO000000000000000001",
        kind: "video",
        origin: "generated_from_private",
        providerVisible: false,
        sourceHandleIds: Array.from({ length: 65 }, (_, i) => `mh_source_${i}`),
        createdBy: "core.video.remotion",
        createdAt: "2026-05-19T08:30:00.000Z",
        ttlSeconds: 86_401,
        byteSize: 0,
        sha256: "a".repeat(64),
        signature: "sig_b64",
      }),
    ).toThrow();
    expect(() =>
      ProviderVisibleInputConsentSchema.parse({
        consentId: "consent_1",
        planId: "plan_1",
        subtaskId: "clip_1",
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        inputHandleSetHash: "not-hex",
        enclaveNonce: "short",
        expiresAt: "not-a-date",
        signerKeyId: "device_key_1",
        signature: { type: "device_key", signature: "" },
      }),
    ).toThrow();
  });

  it("rejects composition specs with scenes beyond duration or unknown asset references", () => {
    const validSpec = {
      version: 1,
      title: "Launch teaser",
      templateId: "promo_cut",
      format: { width: 1920, height: 1080, fps: 24, durationFrames: 240 },
      assets: [{ id: "hero", handleId: "mh_hero", kind: "image" }],
      scenes: [
        {
          id: "scene_1",
          startFrame: 0,
          durationFrames: 240,
          layout: "full_bleed",
          layers: [{ type: "asset", assetId: "hero", fit: "cover" }],
        },
      ],
    };

    expect(() =>
      VideoCompositionSpecSchema.parse({
        ...validSpec,
        scenes: [{ ...validSpec.scenes[0], startFrame: 200, durationFrames: 80 }],
      }),
    ).toThrow(/scene exceeds composition duration/);
    expect(() =>
      VideoCompositionSpecSchema.parse({
        ...validSpec,
        scenes: [
          {
            ...validSpec.scenes[0],
            layers: [{ type: "asset", assetId: "missing", fit: "cover" }],
          },
        ],
      }),
    ).toThrow(/unknown asset id/);
  });
});
