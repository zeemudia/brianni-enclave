import { describe, expect, it } from "vitest";
import { createMediaJobIds, mediaJobCheckpointPayload } from "../media/jobs";

describe("media jobs", () => {
  it("uses stable provider idempotency keys for the same logical subtask", () => {
    const first = createMediaJobIds({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtaskId: "clip_1",
    });
    const second = createMediaJobIds({
      agentTurnId: "turn_1",
      planId: "plan_1",
      subtaskId: "clip_1",
    });

    expect(first.providerIdempotencyKey).toBe(second.providerIdempotencyKey);
    expect(first.mediaJobId).toBe(second.mediaJobId);
  });

  it("stores provider job ids only inside encrypted checkpoint payloads", () => {
    const payload = mediaJobCheckpointPayload({
      mediaJobId: "mj_1",
      providerId: "google",
      providerJobId: "provider-secret-job-id",
      planId: "plan_1",
      subtaskId: "clip_1",
      provenanceSnapshotHash: "f".repeat(64),
    });

    expect(JSON.stringify(payload)).toContain("provider-secret-job-id");
    expect(payload.providerJobId).toBe("provider-secret-job-id");
  });
});
