import { z } from "zod";

// Public-entity slots only. NO free-text identifiers. `.strict()` rejects unknown keys.
export const ResearchQuerySchema = z
  .object({
    insurer: z.string().regex(/^[A-Za-z][A-Za-z .,&'-]{0,63}$/).optional(), // no digits
    planType: z.string().regex(/^[A-Za-z][A-Za-z /-]{0,31}$/).optional(),
    claimCategory: z.string().min(1).max(64).optional(), // codes may include digits (ICD-10, CPT); Layer 2 backstops identifiers
    statute: z.string().min(1).max(64).optional(),        // alphanumeric citations (ACA §2719A); Layer 2 backstops identifiers
    jurisdiction: z.string().regex(/^[A-Za-z][A-Za-z .'-]{0,63}$/).optional(),
    year: z.number().int().gte(1900).lte(2100).optional(),
    // Adaptive phrasing ("context is king"). Subject to Layer 2 (identifier backstop)
    // and Layer 3 (user approval) — NOT trusted on its own.
    question: z.string().min(1).max(280).refine((s) => s.trim().length > 0, {
      message: "question must not be blank",
    }),
  })
  .strict();
export type ResearchQuery = z.infer<typeof ResearchQuerySchema>;

/** Deterministic compile: only allowlisted slots reach the search string. */
export function compileResearchQuery(q: ResearchQuery): string {
  const parts = [
    q.insurer, q.planType, q.claimCategory, q.statute, q.jurisdiction,
    q.year !== undefined ? String(q.year) : undefined,
    q.question,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
