import { describe, expect, it } from "vitest";
import { estimateVideoQuotaUnits, reserveVideoBudget } from "../media/budget";

describe("video budget", () => {
  it("blocks dispatch when a ceiling would be exceeded", async () => {
    const result = await reserveVideoBudget({
      mediaJobId: "mj_1",
      estimate: estimateVideoQuotaUnits({
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        durationSeconds: 8,
        width: 1080,
        height: 1920,
        audio: true,
        safetyMarginPercent: 30,
      }),
      client: {
        reserve: async () => ({ ok: false, reason: "USER_BUDGET_EXCEEDED" }),
      },
    });

    expect(result).toEqual({ ok: false, reason: "USER_BUDGET_EXCEEDED" });
  });
});
