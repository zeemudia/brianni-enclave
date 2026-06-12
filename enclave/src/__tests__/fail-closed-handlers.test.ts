import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "..", "index.ts"), "utf8");

/**
 * Codex LOW F2 (+ claude-adv adversarial review) — the enclave must fail
 * CLOSED on a genuinely-undefined-state fault (uncaughtException → exit), but
 * must NOT exit on unhandledRejection: per-frame errors are caught at the
 * operation boundary, so exiting on a rejection would let attacker-reachable
 * input become a repeatable multi-tenant DoS + attestation churn. Rejections
 * are logged as an operator metric and the enclave keeps serving.
 */
describe("enclave global error handlers (F2)", () => {
  function handlerBody(
    event: "uncaughtException" | "unhandledRejection",
  ): string {
    const start = indexSource.indexOf(`process.on("${event}"`);
    expect(start, `${event} handler not found`).toBeGreaterThan(-1);
    // Capture a generous slice covering the handler body.
    return indexSource.slice(start, start + 500);
  }

  it("exits non-zero on uncaughtException (undefined state — fail closed)", () => {
    expect(handlerBody("uncaughtException")).toMatch(/process\.exit\(1\)/);
  });

  it("does NOT exit on unhandledRejection (avoid multi-tenant DoS)", () => {
    const body = handlerBody("unhandledRejection");
    expect(body).not.toMatch(/process\.exit/);
    // It must still surface the rejection as an operator-actionable metric.
    expect(body).toMatch(/calypso-enclave-unhandled-rejection/);
  });

  // L2 (error-handling audit): stderr is host-visible. The handler used to
  // print the full promise + reason objects — whose messages can embed
  // payload-derived content. It must log only the error class name.
  it("unhandledRejection logging is redacted (no promise/reason objects)", () => {
    const body = handlerBody("unhandledRejection");
    // The handler no longer takes or prints the promise argument.
    expect(body).not.toMatch(/promise/);
    // Only the constructor/class name of the reason is logged.
    expect(body).toMatch(/reason instanceof Error \? reason\.name/);
  });
});
