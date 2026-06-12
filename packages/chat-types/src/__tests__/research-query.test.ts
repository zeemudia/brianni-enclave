import { describe, expect, it } from "vitest";
import { ResearchQuerySchema, compileResearchQuery } from "../research-query";

describe("ResearchQuerySchema", () => {
  it("accepts allowlisted public-entity slots + a bounded question", () => {
    const q = ResearchQuerySchema.parse({
      insurer: "Aetna", planType: "PPO", claimCategory: "out-of-network ER",
      jurisdiction: "California", year: 2026, question: "appeal deadline?",
    });
    expect(q.year).toBe(2026);
    expect(q.insurer).toBe("Aetna");
    expect(q.planType).toBe("PPO");
  });
  it("rejects an unknown key", () => {
    expect(() =>
      ResearchQuerySchema.parse({ question: "x", memberId: "12345" } as never),
    ).toThrow();
  });
  it("rejects a malformed year and a digit-bearing insurer", () => {
    expect(() => ResearchQuerySchema.parse({ question: "x", year: 99 })).toThrow();
    expect(() => ResearchQuerySchema.parse({ question: "x", insurer: "Aetna 48213" })).toThrow();
  });
  it("rejects a whitespace-only question", () => {
    expect(() => ResearchQuerySchema.parse({ question: "   " })).toThrow();
  });
});

describe("compileResearchQuery", () => {
  it("is deterministic and only includes allowlisted slots", () => {
    const s = compileResearchQuery({ insurer: "Aetna", planType: "PPO", year: 2026, question: "appeal deadline" });
    expect(s).toContain("Aetna");
    expect(s).toContain("PPO");
    expect(s).toContain("2026");
    expect(s).toContain("appeal deadline");
  });
  it("produces a stable, exact-ordered output string", () => {
    const s = compileResearchQuery({
      insurer: "Aetna", planType: "PPO", year: 2026, question: "appeal deadline",
    });
    expect(s).toBe("Aetna PPO 2026 appeal deadline");
  });
});
