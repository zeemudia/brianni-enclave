import { describe, expect, it } from "vitest";
import { loadRemotionCoreSkill } from "../media/remotion-core-skill";
import { validateVideoCompositionAgainstProvenance } from "../media/composition-spec";

describe("Remotion render policy", () => {
  it("loads a non-secret internal Remotion core skill", () => {
    const skill = loadRemotionCoreSkill();
    expect(skill.id).toBe("core.video.remotion");
    expect(skill.visibility).toBe("internal");
    expect(skill.content).toContain("VideoCompositionSpec");
    expect(skill.content).not.toMatch(/api[_-]?key|secret|token|https:\/\/api\./i);
  });

  it("rejects specs that reference unknown handles before reading bytes", async () => {
    const result = await validateVideoCompositionAgainstProvenance({
      spec: {
        version: 1,
        title: "Unknown handle",
        templateId: "captioned_story",
        format: { width: 1080, height: 1080, fps: 30, durationFrames: 90 },
        assets: [{ id: "hero", handleId: "mh_missing", kind: "image" }],
        scenes: [
          {
            id: "s1",
            startFrame: 0,
            durationFrames: 90,
            layout: "full_bleed",
            layers: [{ type: "asset", assetId: "hero", fit: "cover" }],
          },
        ],
      },
      recordsByHandleId: new Map(),
      handleStore: {
        getBytes: async () => {
          throw new Error("should not read bytes for unknown handles");
        },
        getText: async () => null,
      },
      signer: {
        sign: () => "unused",
        verify: () => false,
      },
      now: new Date("2026-05-19T08:00:00.000Z"),
    });

    expect(result).toEqual({ ok: false, reason: "UNKNOWN_MEDIA_HANDLE:mh_missing" });
  });
});
