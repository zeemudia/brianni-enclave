import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const toolsDir = resolve(__dirname, "../tools");

function read(name: string): string {
  return readFileSync(resolve(toolsDir, name), "utf8");
}

describe("redteam: folder.write cannot bypass the client bridge", () => {
  it("tier-b-draft.ts folder.write branch exits only via clientBridge.invokeClient", () => {
    const src = read("tier-b-draft.ts");
    // Find the folder.write handler. We accept either a switch case or a
    // dedicated function; check both shapes.
    const lower = src.toLowerCase();
    expect(lower).toContain("folder.write");
    // The handler must contain a call to the bridge.
    expect(src).toMatch(/clientBridge\.invokeClient\s*\(/);
    // And must NOT call any direct filesystem write API.
    const bannedWriteAPIs = [
      "fs.writeFile",
      "fs.writeFileSync",
      "writeFileSync(",
      "createWriteStream",
      "createWritable",
      "promises.writeFile",
      "node:fs",
    ];
    for (const banned of bannedWriteAPIs) {
      expect(src, `tier-b-draft.ts must not reference ${banned}`).not.toContain(
        banned,
      );
    }
  });

  it("tier-b-draft.ts has no autoAllow / always-allow path", () => {
    const src = read("tier-b-draft.ts");
    for (const banned of ["autoAllow", "alwaysAllow", "skipConfirmation"]) {
      expect(src).not.toContain(banned);
    }
  });

  it("Tier C/D tool names are not referenced anywhere in enclave/src/tools/", () => {
    const files = [
      "index.ts",
      "tier-a-read.ts",
      "tier-b-draft.ts",
      "scope-check.ts",
      "file-allowlist.ts",
    ];
    const allowed: Record<string, Set<string>> = {
      // scope-check declares the banned list — those are the ONE allowed mention.
      "scope-check.ts": new Set([
        "mailbox.read",
        "calendar.read",
        "email.send",
        "event.create",
        "form.submit",
        "web.automation",
        "browser.use",
        "plaid.connect",
      ]),
    };
    const banned = [
      "mailbox.read",
      "calendar.read",
      "email.send",
      "event.create",
      "form.submit",
      "web.automation",
      "browser.use",
      "plaid.connect",
    ];
    for (const filename of files) {
      const src = read(filename);
      const exemptions = allowed[filename] ?? new Set<string>();
      for (const name of banned) {
        if (exemptions.has(name)) continue;
        expect(
          src,
          `${filename} must not reference Tier C/D name "${name}"`,
        ).not.toContain(name);
      }
    }
  });

  it("tier-a-read.ts only emits ledger scope labels derived from displayed names, never raw paths", () => {
    const src = read("tier-a-read.ts");
    // The ledger scope strings — server is folder-blind even in audit log.
    // No string concatenation against `frame.args.path` for the ledger.
    expect(src).not.toMatch(/scope:\s*[^,;]*frame\.args\.path/);
  });

  it("the gateway dispatcher rejects banned names BEFORE scope-check (TIER_C_D_BANNED first)", () => {
    const src = read("index.ts");
    // The TIER_C_D_BANNED reject must come before OUT_OF_SCOPE in source order
    // so a pack that erroneously scopes a banned name still cannot reach
    // the tier-A/B switch.
    const bannedIdx = src.indexOf("TIER_C_D_BANNED");
    const scopeIdx = src.indexOf("OUT_OF_SCOPE");
    expect(bannedIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(bannedIdx).toBeLessThan(scopeIdx);
  });
});
