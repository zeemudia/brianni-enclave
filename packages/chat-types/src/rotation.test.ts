import { describe, it, expect } from "vitest";
import { RotationDrainEventSchema } from "./rotation";

describe("RotationDrainEventSchema", () => {
  it("parses a valid chat rotation_drain event", () => {
    const e = { _type: "rotation_drain", retryAfterMs: 30000, kind: "chat" };
    expect(RotationDrainEventSchema.parse(e)).toEqual(e);
  });

  it("parses a valid agent rotation_drain event", () => {
    const e = { _type: "rotation_drain", retryAfterMs: 1000, kind: "agent" };
    expect(RotationDrainEventSchema.parse(e)).toEqual(e);
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      RotationDrainEventSchema.parse({
        _type: "rotation_drain",
        retryAfterMs: 1000,
        kind: "video",
      }),
    ).toThrow();
  });

  it("rejects a wrong _type", () => {
    expect(() =>
      RotationDrainEventSchema.parse({
        _type: "nope",
        retryAfterMs: 1000,
        kind: "chat",
      }),
    ).toThrow();
  });

  it("rejects a negative retryAfterMs", () => {
    expect(() =>
      RotationDrainEventSchema.parse({
        _type: "rotation_drain",
        retryAfterMs: -1,
        kind: "chat",
      }),
    ).toThrow();
  });
});
