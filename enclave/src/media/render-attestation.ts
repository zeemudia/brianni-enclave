import { createHash } from "node:crypto";
import { canonicaliseStableJson } from "@calypso/chat-types";
import type { RenderResult } from "./render-backend";
import { verifyNitroAttestationDocument, type NitroRootBundle } from "./nitro-attestation";

export interface RenderAttestationPolicy {
  nitroRootBundle: NitroRootBundle;
  allowedMeasurements: readonly string[];
  revokedMeasurements: readonly string[];
  allowedSignerKeyIds: readonly string[];
}

export function verifyRenderAttestation(input: {
  document: {
    rawDocument: Uint8Array;
  };
  expectedNonce: string;
  policy: RenderAttestationPolicy;
  now: Date;
}): { ok: true; publicKeyId: string } | { ok: false; reason: string } {
  const verified = verifyNitroAttestationDocument({
    rawDocument: input.document.rawDocument,
    rootBundle: input.policy.nitroRootBundle,
  });
  if (!verified.ok) return verified;
  const document = verified.document;
  if (document.nonce !== input.expectedNonce) {
    return { ok: false, reason: "RENDER_ATTESTATION_NONCE_MISMATCH" };
  }
  if (input.policy.revokedMeasurements.includes(document.pcr0)) {
    return { ok: false, reason: "RENDER_MEASUREMENT_REVOKED" };
  }
  if (!input.policy.allowedMeasurements.includes(document.pcr0)) {
    return { ok: false, reason: "RENDER_MEASUREMENT_UNKNOWN" };
  }
  if (!input.policy.allowedSignerKeyIds.includes(document.publicKeyId)) {
    return { ok: false, reason: "RENDER_SIGNER_KEY_UNKNOWN" };
  }
  const now = input.now.getTime();
  if (
    now < new Date(document.notBefore).getTime() ||
    now > new Date(document.notAfter).getTime()
  ) {
    return { ok: false, reason: "RENDER_ATTESTATION_STALE" };
  }
  return { ok: true, publicKeyId: document.publicKeyId };
}

export function verifySignedRenderManifest(input: {
  manifest: RenderResult["manifest"];
  expectedNonce: string;
  expectedProvenanceSnapshotHash: string;
  expectedSignerKeyId: string;
  outputBytes: Uint8Array;
  verifySignature(payload: Uint8Array, signature: string, signerKeyId: string): boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.manifest.jobNonce !== input.expectedNonce) {
    return { ok: false, reason: "RENDER_MANIFEST_NONCE_MISMATCH" };
  }
  if (input.manifest.provenanceSnapshotHash !== input.expectedProvenanceSnapshotHash) {
    return { ok: false, reason: "RENDER_MANIFEST_SNAPSHOT_MISMATCH" };
  }
  if (input.manifest.signerKeyId !== input.expectedSignerKeyId) {
    return { ok: false, reason: "RENDER_MANIFEST_SIGNER_MISMATCH" };
  }
  const outputHash = createHash("sha256").update(input.outputBytes).digest("hex");
  if (input.manifest.outputHash !== outputHash) {
    return { ok: false, reason: "RENDER_OUTPUT_HASH_MISMATCH" };
  }
  const { signature, signerKeyId: _signerKeyId, ...unsigned } = input.manifest;
  if (
    !input.verifySignature(
      new TextEncoder().encode(canonicaliseStableJson(unsigned)),
      signature,
      input.manifest.signerKeyId,
    )
  ) {
    return { ok: false, reason: "RENDER_MANIFEST_SIGNATURE_INVALID" };
  }
  return { ok: true };
}
