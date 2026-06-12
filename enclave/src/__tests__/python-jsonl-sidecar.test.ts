import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PythonJsonlSidecar } from "../tools/python-jsonl-sidecar";

const tempDirs: string[] = [];

function writeScript(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "calypso-sidecar-test-"));
  tempDirs.push(dir);
  const path = join(dir, "service.py");
  writeFileSync(path, source);
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PythonJsonlSidecar", () => {
  it("starts once and returns JSONL responses", async () => {
    const scriptPath = writeScript(`
import json, sys
print("READY", flush=True)
for line in sys.stdin:
    req = json.loads(line)
    print(json.dumps({"status": "ok", "echo": req["value"]}), flush=True)
`);
    const sidecar = new PythonJsonlSidecar<{ value: string }, { echo: string }>({
      scriptPath,
      readyLine: "READY",
      timeoutMs: 1_000,
    });

    await sidecar.start();
    expect(sidecar.isReady()).toBe(true);
    await expect(sidecar.request({ value: "hello" })).resolves.toEqual({
      echo: "hello",
    });
    sidecar.stop();
    expect(sidecar.isReady()).toBe(false);
  });

  it("serialises concurrent requests so stdout responses cannot cross wires", async () => {
    const scriptPath = writeScript(`
import json, sys
print("READY", flush=True)
for line in sys.stdin:
    req = json.loads(line)
    print(json.dumps({"status": "ok", "index": req["index"]}), flush=True)
`);
    const sidecar = new PythonJsonlSidecar<{ index: number }, { index: number }>({
      scriptPath,
      readyLine: "READY",
      timeoutMs: 1_000,
    });
    await sidecar.start();

    await expect(
      Promise.all([
        sidecar.request({ index: 1 }),
        sidecar.request({ index: 2 }),
        sidecar.request({ index: 3 }),
      ]),
    ).resolves.toEqual([{ index: 1 }, { index: 2 }, { index: 3 }]);
    sidecar.stop();
  });

  it("rejects on timeout and clears readiness", async () => {
    const scriptPath = writeScript(`
import sys, time
print("READY", flush=True)
for _line in sys.stdin:
    time.sleep(2)
`);
    const sidecar = new PythonJsonlSidecar<{ value: string }, { ok: true }>({
      scriptPath,
      readyLine: "READY",
      timeoutMs: 50,
    });
    await sidecar.start();

    await expect(sidecar.request({ value: "slow" })).rejects.toThrow(
      "PYTHON_SIDECAR_TIMEOUT",
    );
    expect(sidecar.isReady()).toBe(false);
  });

  it("turns sidecar error responses into typed errors", async () => {
    const scriptPath = writeScript(`
import json, sys
print("READY", flush=True)
for line in sys.stdin:
    print(json.dumps({"status": "error", "error": "OCR_UNAVAILABLE"}), flush=True)
`);
    const sidecar = new PythonJsonlSidecar<{ value: string }, { ok: true }>({
      scriptPath,
      readyLine: "READY",
      timeoutMs: 1_000,
    });
    await sidecar.start();

    await expect(sidecar.request({ value: "x" })).rejects.toThrow(
      "PYTHON_SIDECAR_ERROR: OCR_UNAVAILABLE",
    );
    sidecar.stop();
  });
});
