export interface VideoQuotaEstimateInput {
  providerId: string;
  modelId: string;
  durationSeconds: number;
  width: 1080 | 1920;
  height: 1080 | 1920;
  audio: boolean;
  safetyMarginPercent: number;
}

export interface VideoQuotaEstimate {
  quotaUnits: number;
  estimatedBillableQuotaUnits: number;
  safetyMarginQuotaUnits: number;
  providerId: string;
  modelId: string;
}

export interface VideoBudgetClient {
  reserve(input: {
    mediaJobId: string;
    quotaUnits: number;
    providerId: string;
    modelId: string;
    // Drives the server-side per-kind quota cap (video reserves must NOT be
    // charged against the image budget). 'video_render' is set by the render
    // path; the generate path passes 'video_generate'.
    routeKind: 'video_generate' | 'video_render';
  }): Promise<{ ok: true; holdId: string } | { ok: false; reason: string }>;
}

export function estimateVideoQuotaUnits(input: VideoQuotaEstimateInput): VideoQuotaEstimate {
  const pixels = input.width * input.height;
  const megapixelSeconds = (pixels / 1_000_000) * input.durationSeconds;
  const audioUnits = input.audio ? 20 : 0;
  const rawUnits = Math.ceil(megapixelSeconds * 25 + audioUnits);
  const quotaUnits = Math.ceil(rawUnits * (1 + input.safetyMarginPercent / 100));
  return {
    quotaUnits,
    estimatedBillableQuotaUnits: rawUnits,
    safetyMarginQuotaUnits: quotaUnits - rawUnits,
    providerId: input.providerId,
    modelId: input.modelId,
  };
}

export async function reserveVideoBudget(input: {
  mediaJobId: string;
  estimate: VideoQuotaEstimate;
  client: VideoBudgetClient;
  // Defaults to 'video_generate'; the render path passes 'video_render'. Either
  // way the server applies the video cap, never the image cap.
  routeKind?: 'video_generate' | 'video_render';
}): Promise<{ ok: true; holdId: string } | { ok: false; reason: string }> {
  return input.client.reserve({
    mediaJobId: input.mediaJobId,
    quotaUnits: input.estimate.quotaUnits,
    providerId: input.estimate.providerId,
    modelId: input.estimate.modelId,
    routeKind: input.routeKind ?? 'video_generate',
  });
}
