import { createHash } from "node:crypto";
import { canonicaliseStableJson } from "@calypso/chat-types";
import { describe, expect, it } from "vitest";
import { VALID_NITRO_FIXTURE, fixtureNitroDocument, fixtureNitroRootBundle } from "./fixtures/nitro-attestation";
import { verifyRenderAttestation, verifySignedRenderManifest } from "../media/render-attestation";

describe("render attestation", () => {
  it("rejects stale, revoked, unknown, and nonce-mismatched render attestations", () => {
    const base = {
      document: {
        rawDocument: fixtureNitroDocument("valid"),
      },
      expectedNonce: VALID_NITRO_FIXTURE.nonce,
      policy: {
        nitroRootBundle: fixtureNitroRootBundle(),
        allowedMeasurements: [VALID_NITRO_FIXTURE.pcr0],
        revokedMeasurements: [] as string[],
        allowedSignerKeyIds: [VALID_NITRO_FIXTURE.publicKeyId],
      },
      now: new Date("2026-05-19T08:01:00.000Z"),
    };

    const valid = verifyRenderAttestation(base);
    expect(valid).toMatchObject({ ok: true, publicKeyId: VALID_NITRO_FIXTURE.publicKeyId });

    const nonceResult = verifyRenderAttestation({ ...base, expectedNonce: "other" });
    expect(nonceResult.ok).toBe(false);
    if (!nonceResult.ok) expect(nonceResult.reason).toBe("RENDER_ATTESTATION_NONCE_MISMATCH");

    const revokedResult = verifyRenderAttestation({
      ...base,
      policy: { ...base.policy, revokedMeasurements: [VALID_NITRO_FIXTURE.pcr0] },
    });
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok) expect(revokedResult.reason).toBe("RENDER_MEASUREMENT_REVOKED");

    const unknownResult = verifyRenderAttestation({
      ...base,
      policy: { ...base.policy, allowedMeasurements: [] },
    });
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) expect(unknownResult.reason).toBe("RENDER_MEASUREMENT_UNKNOWN");

    const signerResult = verifyRenderAttestation({
      ...base,
      policy: { ...base.policy, allowedSignerKeyIds: [] },
    });
    expect(signerResult.ok).toBe(false);
    if (!signerResult.ok) expect(signerResult.reason).toBe("RENDER_SIGNER_KEY_UNKNOWN");

    const staleResult = verifyRenderAttestation({
      ...base,
      now: new Date("2026-05-19T08:06:00.000Z"),
    });
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) expect(staleResult.reason).toBe("RENDER_ATTESTATION_STALE");
  });

  it("verifies render manifests over the same payload the renderer signs", () => {
    const unsigned = {
      templateId: "promo_cut" as const,
      inputHandleIds: ["mh_hero"],
      outputHash: createHash("sha256").update("mp4").digest("hex"),
      renderVersion: "test-renderer",
      durationFrames: 240,
      provenanceSnapshotHash: "a".repeat(64),
      jobNonce: "nonce_1",
    };
    const payloads: string[] = [];
    expect(
      verifySignedRenderManifest({
        manifest: { ...unsigned, signerKeyId: "render_key_1", signature: "sig" },
        expectedNonce: "nonce_1",
        expectedProvenanceSnapshotHash: "a".repeat(64),
        expectedSignerKeyId: "render_key_1",
        outputBytes: new TextEncoder().encode("mp4"),
        verifySignature: (payload) => {
          payloads.push(new TextDecoder().decode(payload));
          return true;
        },
      }),
    ).toEqual({ ok: true });
    expect(payloads).toEqual([canonicaliseStableJson(unsigned)]);
  });
});
