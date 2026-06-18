import { describe, it, expect } from "vitest";

import { EGRESS_TAINT_READ_TOOLS } from "../index";

describe("EGRESS_TAINT_READ_TOOLS", () => {
  it("includes the read + media-extraction tools the enclave harvests", () => {
    for (const t of [
      "memory.read",
      "memory.list",
      "file.read",
      "folder.read",
      // folder.list exposes private filenames to the model and must mark the
      // turn as a private read so its answer is omitted from follow-up replay.
      "folder.list",
      "image.ocr",
      "audio.transcribe",
      "video.transcribe",
      // *.transform tools are client-fulfilled via the same private fileRead
      // path and surface private-derived output, so they are private reads too.
      "image.transform",
      "audio.transform",
      "video.transform",
      // connector.read surfaces private external data; it must mark the turn as a
      // private read so cross-subtask + client follow-up consumers treat it so.
      "connector.read",
    ]) {
      expect(EGRESS_TAINT_READ_TOOLS.has(t)).toBe(true);
    }
  });

  it("excludes egress + write tools (incl. connector mutation/list)", () => {
    expect(EGRESS_TAINT_READ_TOOLS.has("web.fetch")).toBe(false);
    expect(EGRESS_TAINT_READ_TOOLS.has("memory.write")).toBe(false);
    // connector.act is a mutation, connector.list is catalog metadata — not reads.
    expect(EGRESS_TAINT_READ_TOOLS.has("connector.act")).toBe(false);
    expect(EGRESS_TAINT_READ_TOOLS.has("connector.list")).toBe(false);
  });
});
