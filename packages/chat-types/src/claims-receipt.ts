import { z } from "zod";
import { MemoryNamespaceSchema } from "./memory";

/**
 * Per-task audit receipt for a cross-pack claims advocate run (Phase 4, spec §4.7).
 *
 * A receipt records what a single claims-agent task actually did: which memory
 * namespaces it exercised, which documents/queries/URLs it touched, and an
 * optional hash of the produced artifact. `grantId` is REQUIRED so every receipt
 * traces back to the authorizing grant that scoped the run — a receipt with no
 * grant has no provenance and must not validate.
 *
 * The optional array fields default to [] so a receipt that exercised nothing in
 * a given dimension is still well-formed without the writer threading empties.
 */
export const ClaimsTaskReceiptSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  grantId: z.string().min(1),
  createdAt: z.number().int().positive(),
  mode: z.enum(["jit", "durable"]),
  // Whether the run reached a clean terminal success, ended in a terminal
  // error, or was cancelled by the user mid-run. The enclave flushes the
  // CLAIMS_SUMMARY frame on EVERY terminal exit (success, error, abort), so an
  // errored run that read a namespace / fetched a URL still has an audit
  // receipt — it is just marked "errored" so a partial run is visibly
  // distinguished from a completed one. "cancelled" records a user-aborted run
  // that already had recordable activity (an approved research query egressed,
  // a private read happened, or a summary arrived) — the client assembles it
  // from data it already holds, since the abort can kill the stream before the
  // terminal CLAIMS_SUMMARY arrives. Defaults to "completed" so receipts
  // stored before this field existed still parse.
  status: z.enum(["completed", "errored", "cancelled"]).default("completed"),
  exercisedNamespaces: z.array(MemoryNamespaceSchema),
  // folderIds is the v1 consent granularity — the grant authorizes whole
  // folders, so the receipt records which folders were in scope for the run
  // (spec §4.7: "namespaces and documentIds/folderIds actually read").
  // documentIds is [] in practice today (per-document selection is a v1
  // follow-up), so folderIds is what actually records what was read.
  // Defaults to [] so receipts stored before this field existed still parse.
  folderIds: z.array(z.string()).default([]),
  documentIds: z.array(z.string()).default([]),
  approvedQueries: z.array(z.string()).default([]),
  fetchedUrls: z.array(z.string()).default([]),
  // sha256 of the produced artifact, 64-char lowercase hex (mirrors the
  // commit-hash convention in cross-pack-grant.ts). Absent when no artifact
  // was produced.
  artifactHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "artifactHash must be 64-char lowercase hex (sha256)")
    .optional(),
});
export type ClaimsTaskReceipt = z.infer<typeof ClaimsTaskReceiptSchema>;
