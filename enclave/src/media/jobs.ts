import { createHash } from "node:crypto";

export function createMediaJobIds(input: {
  agentTurnId: string;
  planId: string;
  subtaskId: string;
}): { mediaJobId: string; providerIdempotencyKey: string } {
  const digest = createHash("sha256")
    .update(`${input.agentTurnId}\0${input.planId}\0${input.subtaskId}`)
    .digest("hex");
  return {
    mediaJobId: `mj_${digest.slice(0, 32)}`,
    providerIdempotencyKey: `calypso_${digest}`,
  };
}

export interface MediaJobCheckpointPayload {
  version: 1;
  mediaJobId: string;
  providerId: string;
  providerJobId: string;
  planId: string;
  subtaskId: string;
  provenanceSnapshotHash: string;
}

export function mediaJobCheckpointPayload(input: {
  mediaJobId: string;
  providerId: string;
  providerJobId: string;
  planId: string;
  subtaskId: string;
  provenanceSnapshotHash: string;
}): MediaJobCheckpointPayload {
  return { version: 1, ...input };
}
