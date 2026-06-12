import type { VideoCompositionSpec } from "@calypso/chat-types";
import type { RendererTrustLevel } from "./custody-gate";

export interface RenderBundle {
  mediaJobId: string;
  jobNonce: string;
  spec: VideoCompositionSpec;
  provenanceSnapshotHash: string;
  encryptedAssetsRef: string;
  sealedAssetKeyRef: string;
}

export interface RenderResult {
  videoBytes: Uint8Array;
  mimeType: "video/mp4" | "video/webm";
  manifest: {
    templateId: string;
    inputHandleIds: string[];
    outputHash: string;
    renderVersion: string;
    durationFrames: number;
    provenanceSnapshotHash: string;
    jobNonce: string;
    signerKeyId: string;
    signature: string;
  };
}

export interface RenderBackend {
  trustLevel: RendererTrustLevel;
  requestAttestation(input: {
    mediaJobId: string;
    nonce: string;
  }): Promise<{
    rawDocument: Uint8Array;
  }>;
  cancel?(input: { mediaJobId: string; jobNonce: string }): Promise<void>;
  render(bundle: RenderBundle, signal?: AbortSignal): Promise<RenderResult>;
}
