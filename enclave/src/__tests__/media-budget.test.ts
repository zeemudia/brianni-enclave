import { describe, expect, it } from "vitest";
import { estimateVideoQuotaUnits, reserveVideoBudget } from "../media/budget";

describe("video budget", () => {
  it("estimates billable units from megapixel-seconds, audio, and safety margin", () => {
    expect(
      estimateVideoQuotaUnits({
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        durationSeconds: 8,
        width: 1080,
        height: 1920,
        audio: true,
        safetyMarginPercent: 30,
      }),
    ).toEqual({
      providerId: "google",
      modelId: "veo-3.1-generate-preview",
      estimatedBillableQuotaUnits: 435,
      quotaUnits: 566,
      safetyMarginQuotaUnits: 131,
    });
  });

  it("does not charge audio units for silent video renders", () => {
    expect(
      estimateVideoQuotaUnits({
        providerId: "local-render",
        modelId: "remotion",
        durationSeconds: 4,
        width: 1080,
        height: 1080,
        audio: false,
        safetyMarginPercent: 0,
      }),
    ).toMatchObject({
      estimatedBillableQuotaUnits: 117,
      quotaUnits: 117,
      safetyMarginQuotaUnits: 0,
    });
  });

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

  it("passes reservation metadata through with the default generate route", async () => {
    const reserveCalls: unknown[] = [];
    const result = await reserveVideoBudget({
      mediaJobId: "mj_generate",
      estimate: {
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        estimatedBillableQuotaUnits: 435,
        quotaUnits: 566,
        safetyMarginQuotaUnits: 131,
      },
      client: {
        reserve: async (input) => {
          reserveCalls.push(input);
          return { ok: true, holdId: "hold_generate" };
        },
      },
    });

    expect(result).toEqual({ ok: true, holdId: "hold_generate" });
    expect(reserveCalls).toEqual([
      {
        mediaJobId: "mj_generate",
        quotaUnits: 566,
        providerId: "google",
        modelId: "veo-3.1-generate-preview",
        routeKind: "video_generate",
      },
    ]);
  });

  it("uses the video-render route when callers reserve local render budget", async () => {
    const reserveCalls: unknown[] = [];
    await reserveVideoBudget({
      mediaJobId: "mj_render",
      routeKind: "video_render",
      estimate: {
        providerId: "local-render",
        modelId: "remotion",
        estimatedBillableQuotaUnits: 117,
        quotaUnits: 117,
        safetyMarginQuotaUnits: 0,
      },
      client: {
        reserve: async (input) => {
          reserveCalls.push(input);
          return { ok: true, holdId: "hold_render" };
        },
      },
    });

    expect(reserveCalls).toEqual([
      expect.objectContaining({
        mediaJobId: "mj_render",
        quotaUnits: 117,
        providerId: "local-render",
        modelId: "remotion",
        routeKind: "video_render",
      }),
    ]);
  });
});
