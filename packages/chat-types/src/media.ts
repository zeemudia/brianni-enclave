import { z } from "zod";

const HandleIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^mh_[A-Za-z0-9_-]{3,96}$/, {
    message: "opaque Calypso media handle required",
  });
const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const MediaHandleKindSchema = z.enum([
  "text",
  "caption",
  "image",
  "audio",
  "video",
  "font",
  "composition",
]);
export type MediaHandleKind = z.infer<typeof MediaHandleKindSchema>;

export const MediaOriginSchema = z.enum([
  "user_private",
  "public",
  "generated",
  "generated_from_private",
  "system_template",
]);
export type MediaOrigin = z.infer<typeof MediaOriginSchema>;

export const MediaArtifactKindSchema = z.enum([
  "video/mp4",
  "video/webm",
  "image/png",
  "image/jpeg",
  "image/webp",
  "audio/mpeg",
  "application/remotion-spec+json",
]);
export type MediaArtifactKind = z.infer<typeof MediaArtifactKindSchema>;

export const MediaProvenanceRecordSchema = z
  .object({
    handleId: HandleIdSchema,
    kind: MediaHandleKindSchema,
    origin: MediaOriginSchema,
    providerVisible: z.boolean(),
    sourceHandleIds: z.array(HandleIdSchema).max(64),
    createdBy: z.string().min(1).max(128),
    createdAt: z.string().datetime(),
    ttlSeconds: z.number().int().positive().max(86_400),
    byteSize: z.number().int().nonnegative().max(2_147_483_647),
    sha256: HexSha256Schema,
    signature: z.string().min(1).max(4096),
  })
  .strict();
export type MediaProvenanceRecord = z.infer<typeof MediaProvenanceRecordSchema>;

export const ProviderVisibleConsentSignatureSchema = z.union([
  z
    .object({
      type: z.literal("device_key"),
      signature: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("webauthn"),
      credentialId: z.string().min(1).max(1024),
      authenticatorData: z.string().min(1).max(4096),
      clientDataJSON: z.string().min(1).max(8192),
      signature: z.string().min(1).max(4096),
    })
    .strict(),
]);

export const ProviderVisibleInputConsentSchema = z
  .object({
    consentId: z.string().min(1).max(128),
    planId: z.string().min(1).max(64),
    subtaskId: z.string().min(1).max(64),
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(128),
    inputHandleSetHash: HexSha256Schema,
    enclaveNonce: z.string().min(16).max(512),
    expiresAt: z.string().datetime(),
    signerKeyId: z.string().min(1).max(128),
    signature: ProviderVisibleConsentSignatureSchema,
  })
  .strict();
export type ProviderVisibleInputConsent = z.infer<
  typeof ProviderVisibleInputConsentSchema
>;

export function canonicaliseProviderVisibleConsentUnsigned(
  value: Omit<ProviderVisibleInputConsent, "signature">,
): string {
  return canonicaliseStableJson(value);
}

export function canonicaliseStableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}

export const VideoTemplateIdSchema = z.enum([
  "captioned_story",
  "promo_cut",
  "slide_explainer",
  "social_clip",
]);
export type VideoTemplateId = z.infer<typeof VideoTemplateIdSchema>;

export const VideoCompositionSpecSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(120),
    templateId: VideoTemplateIdSchema,
    format: z.union([
      z.object({
        width: z.literal(1080),
        height: z.literal(1080),
        fps: z.union([z.literal(24), z.literal(30)]),
        durationFrames: z.number().int().min(1).max(5_400),
      }).strict(),
      z.object({
        width: z.literal(1080),
        height: z.literal(1920),
        fps: z.union([z.literal(24), z.literal(30)]),
        durationFrames: z.number().int().min(1).max(5_400),
      }).strict(),
      z.object({
        width: z.literal(1920),
        height: z.literal(1080),
        fps: z.union([z.literal(24), z.literal(30)]),
        durationFrames: z.number().int().min(1).max(5_400),
      }).strict(),
    ]),
    assets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
            handleId: HandleIdSchema,
            kind: z.enum(["image", "audio", "video", "font"]),
          })
          .strict(),
      )
      .max(64),
    scenes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
            startFrame: z.number().int().nonnegative(),
            durationFrames: z.number().int().min(1).max(5_400),
            layout: z.enum(["full_bleed", "split", "caption_card", "title_card"]),
            layers: z
              .array(
                z.discriminatedUnion("type", [
                  z
                    .object({
                      type: z.literal("text"),
                      textHandleId: HandleIdSchema,
                      styleToken: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
                    })
                    .strict(),
                  z
                    .object({
                      type: z.literal("asset"),
                      assetId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
                      fit: z.enum(["cover", "contain"]),
                    })
                    .strict(),
                  z
                    .object({
                      type: z.literal("caption"),
                      textHandleId: HandleIdSchema,
                      startFrame: z.number().int().nonnegative(),
                      durationFrames: z.number().int().min(1).max(5_400),
                    })
                    .strict(),
                ]),
              )
              .min(1)
              .max(24),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .refine(
    (spec) =>
      spec.scenes.every(
        (scene) => scene.startFrame + scene.durationFrames <= spec.format.durationFrames,
      ),
    { message: "scene exceeds composition duration" },
  )
  .refine(
    (spec) => {
      const assetIds = new Set(spec.assets.map((asset) => asset.id));
      return spec.scenes.every((scene) =>
        scene.layers.every((layer) => layer.type !== "asset" || assetIds.has(layer.assetId)),
      );
    },
    { message: "unknown asset id" },
  );
export type VideoCompositionSpec = z.infer<typeof VideoCompositionSpecSchema>;

export const MediaJobStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_for_consent",
  "waiting_for_renderer",
  "copying_result",
  "cancelling",
  "cancelled",
  "done",
  "blocked",
  "error",
]);
export type MediaJobStatus = z.infer<typeof MediaJobStatusSchema>;
