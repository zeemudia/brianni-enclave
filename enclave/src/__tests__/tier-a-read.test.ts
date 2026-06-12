import { describe, it, expect, vi } from "vitest";
import { deflateRawSync } from "node:zlib";

import { ToolGateway, type ClientBridge } from "../tools";
import type {
  MemoryNamespace,
  MemoryRecord,
  SkillPack,
} from "@calypso/chat-types";

function validRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    namespace: "default" as MemoryNamespace,
    baseVersion: 0,
    tombstoneEpoch: 0,
    dreamSessionId: "turn_x",
    kind: "fact",
    text: "hi",
    structured: {},
    tags: [],
    provenance: [
      {
        excerpt: "hi",
        excerptHash: "a".repeat(64),
        sourceRef: { type: "conversation", conversationId: "c1" },
        extractedAt: "2026-05-13T00:00:00.000Z",
        dreamSessionId: "turn_x",
      },
    ],
    confidence: 0.9,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    supersededBy: null,
    visibleToUser: true,
    ...overrides,
  };
}
import {
  MAX_FILE_BYTES,
  MAX_TOOL_RESULT_FILES,
  MAX_TOOL_RESULT_PLAINTEXT_BYTES,
} from "../tools/file-allowlist";

const pack: SkillPack = {
  id: "personal-agent.default",
  version: 1,
  displayName: "Default",
  description: "Default pack.",
  systemPromptBlock: "You are Calypso.",
  toolScopes: [
    "memory.list",
    "memory.read",
    "file.read",
    "folder.list",
    "folder.read",
    "web.fetch",
  ],
  capabilitySuiteIds: [
    "text",
    "office-document",
    "pdf",
    "rtf",
    "apple-iwork",
    "google-stub",
    "image",
    "audio",
    "video",
  ],
  defaultNamespace: "default",
  linkedFolderScopes: {},
  uiHints: { icon: "default", accentToken: "accent-default" },
};

const textOnlyPack: SkillPack = {
  ...pack,
  capabilitySuiteIds: ["text"],
};

const pdfOnlyPack: SkillPack = {
  ...pack,
  capabilitySuiteIds: ["pdf"],
};

function makeBridge(
  resolved: Awaited<ReturnType<ClientBridge["invokeClient"]>>,
): { bridge: ClientBridge; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn().mockResolvedValue(resolved);
  return { bridge: { invokeClient: mock }, mock };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function bridgeFile(filename: string, content = "# ok") {
  const bytes = utf8(content);
  return {
    filename,
    byteLength: bytes.length,
    firstBytesB64: toB64(bytes),
    contentB64: toB64(bytes),
  };
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function makeZip(
  entries: Array<{ name: string; body: Uint8Array; compressed: boolean }>,
): Uint8Array {
  const locals: Uint8Array[] = [];
  const cdEntries: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.compressed
      ? new Uint8Array(deflateRawSync(entry.body))
      : entry.body;
    const crc = crc32(entry.body);
    const nameBuf = utf8(entry.name);
    const localHeader = new Uint8Array(30 + nameBuf.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, entry.compressed ? 8 : 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, entry.body.length, true);
    localView.setUint16(26, nameBuf.length, true);
    localHeader.set(nameBuf, 30);
    const local = new Uint8Array(localHeader.length + data.length);
    local.set(localHeader, 0);
    local.set(data, localHeader.length);
    locals.push(local);

    const centralDirectory = new Uint8Array(46 + nameBuf.length);
    const centralView = new DataView(centralDirectory.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, entry.compressed ? 8 : 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, entry.body.length, true);
    centralView.setUint16(28, nameBuf.length, true);
    centralView.setUint32(42, offset, true);
    centralDirectory.set(nameBuf, 46);
    cdEntries.push(centralDirectory);
    offset += local.length;
  }
  const cdStart = offset;
  const cdLength = cdEntries.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, cdLength, true);
  eocdView.setUint32(16, cdStart, true);
  const out = new Uint8Array(cdStart + cdLength + eocd.length);
  let p = 0;
  for (const local of locals) {
    out.set(local, p);
    p += local.length;
  }
  for (const centralDirectory of cdEntries) {
    out.set(centralDirectory, p);
    p += centralDirectory.length;
  }
  out.set(eocd, p);
  return out;
}

function makeDocxWithText(text: string): Uint8Array {
  const contentType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  const contentTypesXml = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${contentType}"/></Types>`;
  const relsXml = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body></w:document>`;
  return makeZip([
    {
      name: "[Content_Types].xml",
      body: utf8(contentTypesXml),
      compressed: true,
    },
    { name: "_rels/.rels", body: utf8(relsXml), compressed: true },
    { name: "word/document.xml", body: utf8(documentXml), compressed: true },
  ]);
}

function pdfEscape(value: string): string {
  return value.replace(/([\\()])/g, "\\$1");
}

function makeMinimalPdfWithText(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${pdfEscape(text)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return utf8(pdf);
}

function makeIWorkZipWithQuickLookPdf(text: string): Uint8Array {
  return makeZip([
    {
      name: "Index.zip",
      body: utf8("PK\u0003\u0004"),
      compressed: true,
    },
    {
      name: "QuickLook/Preview.pdf",
      body: makeMinimalPdfWithText(text),
      compressed: true,
    },
  ]);
}

function makeIWorkZipWithoutPreview(): Uint8Array {
  return makeZip([
    {
      name: "Index.zip",
      body: utf8("PK\u0003\u0004"),
      compressed: true,
    },
    {
      name: "Metadata/Properties.plist",
      body: utf8("<?xml version=\"1.0\"?><plist><dict /></plist>"),
      compressed: true,
    },
  ]);
}

async function dispatchReadFile(filename: string, bytes: Uint8Array) {
  const { bridge } = makeBridge({
    invocationId: "inv1",
    outcome: "ok",
    resultJson: {
      files: [
        {
          filename,
          byteLength: bytes.length,
          firstBytesB64: toB64(bytes.slice(0, 64)),
          contentB64: toB64(bytes),
        },
      ],
    },
  });
  const gw = new ToolGateway({ clientBridge: bridge });
  return gw.dispatch(
    {
      invocationId: "inv1",
      agentTurnId: "t1",
      toolName: "file.read",
      args: {
        folderId: "fld_01",
        displayName: "Career",
        filename,
      },
    },
    pack,
    "t1",
  );
}

// R13 Finding B (Codex): memory.list and memory.read must be pinned
// to pack.defaultNamespace. A work-scoped pack cannot list or read
// health-namespace records.
describe("Tier A namespace pinning (R13 Finding B)", () => {
  const workPack: SkillPack = {
    ...pack,
    id: "personal-agent.work",
    defaultNamespace: "work",
  };

  it("memory.list with namespace different from pack.defaultNamespace → NAMESPACE_ESCAPE_REJECTED", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { records: [] },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.list",
        args: { namespace: "health" },
      },
      workPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("NAMESPACE_ESCAPE_REJECTED");
    expect(mock).not.toHaveBeenCalled();
  });

  it("memory.list with namespace === pack.defaultNamespace passes through", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { records: [] },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.list",
        args: { namespace: "work" },
      },
      workPack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(mock).toHaveBeenCalledTimes(1);
    // The bridge frame's args.namespace is server-pinned.
    expect(mock.mock.calls[0][0].args).toEqual({ namespace: "work" });
  });

  // Capability-proof A03 regression: after the A02 write-ACK loop the
  // active namespace held ~10 duplicate agent-written "jasmine green tea"
  // preference records. A03's list+read BOTH surfaced an ERROR (not an
  // empty result) to the model. This proves the enclave read/list gateway
  // is NOT the source of that error: a list of ten well-formed records
  // (the shape `canonicaliseMemoryRecord` produces for an agent write,
  // including synthesised provenance) passes through `ok`, unchanged, with
  // no aggregate/size cap and no per-record schema rejection. The A03
  // error therefore originates CLIENT-side (storage-core sync/decrypt/parse
  // throw, reinjected verbatim by the loop), not in the enclave.
  it("memory.list passes a list of ~10 valid agent-written records through unchanged", async () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      validRecord({
        id: `blob_jasmine_${i}`,
        kind: "preference",
        text: "jasmine green tea",
        // Synthesised-provenance shape an agent ADD produces: a bare-hex
        // excerptHash (no `sha256:` prefix) satisfied by the schema's
        // `.or(z.string().min(8))` branch, sourceRef pinned to the turn.
        provenance: [
          {
            excerpt: "jasmine green tea",
            excerptHash: "b".repeat(64),
            sourceRef: { type: "conversation", conversationId: "turn_x" },
            extractedAt: "2026-05-13T00:00:00.000Z",
            dreamSessionId: "turn_x",
          },
        ],
      }),
    );
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { records },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.list",
        args: { namespace: "default" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect((r.resultJson as { records: unknown[] }).records).toHaveLength(10);
  });

  it("memory.read on a record whose namespace != pack.defaultNamespace → NAMESPACE_ESCAPE_REJECTED", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      // Client returns a full valid health record even though the pack is work.
      resultJson: { record: validRecord({ namespace: "health" }) },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.read",
        args: { id: "m1" },
      },
      workPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("NAMESPACE_ESCAPE_REJECTED");
  });
});

// Task 1C.2: namespace guard honors crossPackGrant.namespaces union;
// absent grant falls back to {defaultNamespace} (existing behaviour).
describe("Tier A cross-pack grant (1C.2)", () => {
  // Claims-style pack: id carries the claims suffix but defaultNamespace
  // is "default" (the guard reads deps.crossPackGrant.namespaces, not
  // pack.crossPackNamespaces, so the fixture only needs the id + default).
  const claimsPack: SkillPack = {
    ...pack,
    id: "personal-agent.claims",
    defaultNamespace: "default" as SkillPack["defaultNamespace"],
  };

  const claimsGrant = {
    namespaces: new Set(["money", "health"]) as ReadonlySet<
      SkillPack["defaultNamespace"]
    >,
    folderIds: new Set<string>(),
    documentIds: new Set<string>(),
  };

  const moneyGrant = {
    namespaces: new Set(["money"]) as ReadonlySet<SkillPack["defaultNamespace"]>,
    folderIds: new Set<string>(),
    documentIds: new Set<string>(),
  };

  it("memory.list of an authorized namespace passes the REQUESTED ns to the bridge (not pinned to default)", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { records: [] },
    });
    const gw = new ToolGateway({
      clientBridge: bridge,
      crossPackGrant: claimsGrant,
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.list",
        args: { namespace: "money" },
      },
      claimsPack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    // The bridge MUST be called with the REQUESTED namespace, NOT pinned to
    // "default" — this is the line-96 fix.
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].args).toEqual({ namespace: "money" });
  });

  it("memory.list of an unauthorized namespace → NAMESPACE_ESCAPE_REJECTED, bridge NOT called", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { records: [] },
    });
    const gw = new ToolGateway({
      clientBridge: bridge,
      crossPackGrant: claimsGrant,
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.list",
        args: { namespace: "relationships" },
      },
      claimsPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("NAMESPACE_ESCAPE_REJECTED");
    expect(mock).not.toHaveBeenCalled();
  });

  it("memory.read of a record in an authorized namespace → ok", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        record: validRecord({
          namespace: "money" as SkillPack["defaultNamespace"],
        }),
      },
    });
    const gw = new ToolGateway({
      clientBridge: bridge,
      crossPackGrant: moneyGrant,
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.read",
        args: { id: "m1" },
      },
      claimsPack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
  });

  it("memory.read of a record OUTSIDE the authorized set → NAMESPACE_ESCAPE_REJECTED", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        // Bridge returns a record in "health" which is NOT in the grant
        record: validRecord({
          namespace: "health" as SkillPack["defaultNamespace"],
        }),
      },
    });
    const gw = new ToolGateway({
      clientBridge: bridge,
      crossPackGrant: moneyGrant,
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.read",
        args: { id: "m1" },
      },
      claimsPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("NAMESPACE_ESCAPE_REJECTED");
  });

  it("no grant → only defaultNamespace allowed (regression): record in non-default ns → NAMESPACE_ESCAPE_REJECTED", async () => {
    // No crossPackGrant → authorized set is {"default"} only.
    const { bridge: bridgeA } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        record: validRecord({
          namespace: "money" as SkillPack["defaultNamespace"],
        }),
      },
    });
    const gwA = new ToolGateway({ clientBridge: bridgeA });
    const rA = await gwA.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.read",
        args: { id: "m1" },
      },
      pack, // defaultNamespace: "default"
      "t1",
    );
    expect(rA.outcome).toBe("error");
    expect(rA.reason).toBe("NAMESPACE_ESCAPE_REJECTED");

    // A record in "default" must still pass.
    const { bridge: bridgeB } = makeBridge({
      invocationId: "inv2",
      outcome: "ok",
      resultJson: { record: validRecord({ namespace: "default" as SkillPack["defaultNamespace"] }) },
    });
    const gwB = new ToolGateway({ clientBridge: bridgeB });
    const rB = await gwB.dispatch(
      {
        invocationId: "inv2",
        agentTurnId: "t1",
        toolName: "memory.read",
        args: { id: "m2" },
      },
      pack,
      "t1",
    );
    expect(rB.outcome).toBe("ok");
  });

  // Adversarial: post-bridge per-record check uses STRICT equality against the
  // REQUESTED namespace, not mere set membership. A bridge that returns a record
  // in a granted-but-not-requested namespace must be rejected — proving that a
  // future loosening of the check (e.g. `allowed.has(ns)` instead of
  // `ns !== namespace`) would cause this test to fail.
  it("memory.list grant {money,health}: bridge returns a health record when money was requested → NAMESPACE_ESCAPE_REJECTED", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      // Bridge returns a record in "health" — which IS in the grant, but
      // the requested namespace was "money". The strict !== check must
      // reject the whole list, never silently drop the offender.
      resultJson: {
        records: [validRecord({ namespace: "health" as SkillPack["defaultNamespace"] })],
      },
    });
    const gw = new ToolGateway({
      clientBridge: bridge,
      crossPackGrant: claimsGrant, // grant covers both "money" and "health"
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.list",
        args: { namespace: "money" },
      },
      claimsPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("NAMESPACE_ESCAPE_REJECTED");
  });
});

// R14 Finding A (Codex): bridge results must be schema-validated and
// every record must carry namespace === pack.defaultNamespace. A
// namespace-less or schema-malformed record fails closed.
describe("Tier A bridge-result validation (R14 Finding A)", () => {
  const workPack: SkillPack = {
    ...pack,
    id: "personal-agent.work",
    defaultNamespace: "work",
  };

  it("memory.list rejects a mixed-namespace list with NAMESPACE_ESCAPE_REJECTED", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        records: [
          validRecord({ id: "m1", namespace: "work" }),
          validRecord({ id: "m2", namespace: "health" }), // hostile
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.list",
        args: { namespace: "work" },
      },
      workPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("NAMESPACE_ESCAPE_REJECTED");
  });

  it("memory.list rejects a schema-invalid record with INVALID_BRIDGE_RECORD", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        records: [{ id: "m1", text: "hi" }], // missing required fields
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.list",
        args: { namespace: "work" },
      },
      workPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_BRIDGE_RECORD");
  });

  it("memory.read rejects a namespace-less record with INVALID_BRIDGE_RECORD (fail-closed)", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { record: { id: "m1", text: "hi" } }, // no namespace
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.read",
        args: { id: "m1" },
      },
      workPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_BRIDGE_RECORD");
  });

  it("folder.read rejects a file with contentB64 byteLength mismatch", async () => {
    const head = utf8("# x");
    const wrongContent = utf8("# x but actually 9 bytes");
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "note.md",
            byteLength: head.length, // claims 3 bytes
            firstBytesB64: toB64(head),
            contentB64: toB64(wrongContent), // actually more
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_BYTE_LENGTH_MISMATCH");
  });

  // R15 Finding A (Codex): the firstBytesB64 the gateway returns is
  // DERIVED from decoded contentB64, not echoed from the bridge — so
  // a hostile bridge cannot smuggle data through firstBytesB64. The
  // .pdf-extension-but-actually-zeros scenario instead trips
  // FILE_CONTENT_MISMATCH inside validateFileForGateway (since the
  // derived head is all zeros, not %PDF-).
  it("folder.read derives firstBytesB64 from contentB64 — hostile firstBytesB64 cannot smuggle past allowlist", async () => {
    const head = utf8("%PDF-");
    const fakeBody = new Uint8Array(20); // all zeros — not actually a PDF
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "doc.pdf",
            byteLength: fakeBody.length,
            firstBytesB64: toB64(head), // bridge lies; gateway ignores
            contentB64: toB64(fakeBody),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    // The derived head is all-zero, doesn't match a real PDF signature
    // — caught by validateFileForGateway as a content/extension
    // mismatch.
    expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  // R15 Finding A (Codex): contentB64 is REQUIRED — a bridge that
  // returns metadata-only entries (with a bloated firstBytesB64) was
  // the previous smuggle vector. Now rejected before the model sees
  // anything.
  // R16 Finding A (Codex): non-ok bridge results must NOT carry
  // resultJson through to the model. The agent loop reinjects
  // result.resultJson; a hostile bridge could set outcome='error' and
  // stuff secrets in resultJson to bypass the ok-path sanitisers.
  it("non-ok bridge result drops resultJson entirely", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "error",
      reason: "bridge_error: /home/example/.ssh/id_rsa should not leak",
      resultJson: {
        secretLeakedKey: "DROP-ME",
        records: [{ id: "smuggled", text: "no" }],
        files: [{ filename: "leak.txt", byteLength: 99 }],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("BRIDGE_ERROR");
    expect(r.reason ?? "").toHaveLength("BRIDGE_ERROR".length);
    expect(r.resultJson).toBeUndefined();
  });

  // R16 Finding B (Codex): folder.list returns ONLY { entries: [{
  // filename, byteLength }] } — extra bridge fields (files, records,
  // secretLeakedKey) are stripped.
  it("folder.list sanitises bridge result to { entries }", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        entries: [{ filename: "note.md", byteLength: 12 }],
        // Hostile fields that must NOT survive.
        files: [
          { filename: "smuggled.bin", byteLength: 1, contentB64: "AA==" },
        ],
        records: [{ id: "x" }],
        secretLeakedKey: "DROP",
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(Object.keys(r.resultJson ?? {})).toEqual(["entries"]);
    const entries = (r.resultJson as { entries: unknown[] }).entries;
    expect(entries).toEqual([{ filename: "note.md", byteLength: 12 }]);
  });

  it("folder.list rejects filenames containing slash, backslash, or controls", async () => {
    for (const filename of [
      "nested/note.md",
      "nested\\note.md",
      "bad\u0000name.md",
    ]) {
      const { bridge } = makeBridge({
        invocationId: "inv1",
        outcome: "ok",
        resultJson: { entries: [{ filename, byteLength: 12 }] },
      });
      const gw = new ToolGateway({ clientBridge: bridge });
      const r = await gw.dispatch(
        {
          invocationId: "inv1",
          agentTurnId: "t1",
          toolName: "folder.list",
          args: { folderId: "fld_01", displayName: "Career" },
        },
        pack,
        "t1",
      );
      expect(r.outcome).toBe("gateway_rejected");
      expect(r.reason).toBe("INVALID_BRIDGE_RESULT");
    }
  });

  it.each([
    "bad\nname.md",
    "tab\there.md",
    "del\u007fname.md",
    "c1\u0085name.md",
    "evil\u202eReverse.md",
    "zero\u200bwidth.md",
    "cafe\u0301.md",
    `${"a".repeat(257)}.md`,
  ])("folder.list rejects unlistable filename %s", async (filename) => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { entries: [{ filename, byteLength: 12 }] },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("INVALID_BRIDGE_RESULT");
  });

  it("folder.list rejects disallowed extensions", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { entries: [{ filename: "payload.exe", byteLength: 12 }] },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
  });

  it("folder.list enforces aggregate JSON byte cap", async () => {
    const longBase = "a".repeat(240);
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        entries: Array.from({ length: 20 }, (_, i) => ({
          filename: `${longBase}${i}.md`,
          byteLength: 12,
        })),
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("TOOL_RESULT_TOO_LARGE");
  });

  // R16 Finding C (Codex): Buffer.from(b64, 'base64') accepts garbage
  // characters after padding. The gateway must re-encode contentB64
  // from decoded bytes so no smuggled text rides the original string.
  it("folder.read re-encodes contentB64 to canonical base64 — bridge cannot smuggle non-canonical bytes", async () => {
    const body = utf8("# hi");
    const canonical = Buffer.from(body).toString("base64");
    const smuggled = canonical + "SMUGGLED_PLAINTEXT_DROP_ME";
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "note.md",
            byteLength: body.length,
            firstBytesB64: toB64(body),
            contentB64: smuggled,
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    const sanitisedFiles = (
      r.resultJson as { files: Array<{ contentB64: string }> }
    ).files;
    expect(sanitisedFiles[0].contentB64).toBe(canonical);
    expect(sanitisedFiles[0].contentB64).not.toContain("SMUGGLED");
  });

  // R16 Finding D (Codex): text-file allowlist must validate the FULL
  // decoded payload as UTF-8, not just the first 16 bytes — otherwise
  // a bridge can prefix valid UTF-8 and stuff binary garbage after.
  it("folder.read rejects a text file with invalid UTF-8 past the first 16 bytes", async () => {
    const head = utf8("# valid prefix.."); // 16 valid bytes
    const tail = new Uint8Array([0xff, 0xfe, 0x80, 0x81]); // invalid UTF-8
    const body = new Uint8Array(head.length + tail.length);
    body.set(head, 0);
    body.set(tail, head.length);
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "note.md",
            byteLength: body.length,
            firstBytesB64: toB64(head),
            contentB64: toB64(body),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("folder.read rejects when contentB64 is omitted (INVALID_BRIDGE_FILE)", async () => {
    const head = utf8("# x");
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "note.md",
            byteLength: head.length,
            firstBytesB64: toB64(head),
            // contentB64 deliberately missing — used to slip through.
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("INVALID_BRIDGE_FILE");
  });

  it("folder.read accepts a zero-byte text file", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "empty.txt",
            byteLength: 0,
            firstBytesB64: "",
            contentB64: "",
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    const files = (
      r.resultJson as {
        files: Array<{ byteLength: number; contentB64: string }>;
      }
    ).files;
    expect(files).toEqual([
      expect.objectContaining({ byteLength: 0, contentB64: "" }),
    ]);
  });

  it.each([
    ["newline", "bad\nname.md"],
    ["tab", "tab\there.md"],
    ["RLO bidi", "evil\u202eReverse.md"],
    ["NFD form", "cafe\u0301.md"],
    [">256-byte segment", `${"a".repeat(257)}.md`],
  ])("folder.read rejects unlistable %s filename", async (_label, filename) => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { files: [bridgeFile(filename)] },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("INVALID_BRIDGE_FILENAME");
  });

  it("folder.read rejects an unlistable filename before content processing", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "bad\nname.md",
            byteLength: 10,
            firstBytesB64: "DROP",
            contentB64: "AA==",
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("INVALID_BRIDGE_FILENAME");
  });

  it.each([
    ["newline", "bad\nname.md"],
    ["RLO bidi", "evil\u202eReverse.md"],
    ["NFD form", "cafe\u0301.md"],
    [">256-byte segment", `${"a".repeat(257)}.md`],
  ])(
    "file.read rejects invalid requested %s filename before bridge",
    async (_label, filename) => {
      const { bridge, mock } = makeBridge({
        invocationId: "inv1",
        outcome: "ok",
        resultJson: { files: [bridgeFile(filename)] },
      });
      const gw = new ToolGateway({ clientBridge: bridge });
      const r = await gw.dispatch(
        {
          invocationId: "inv1",
          agentTurnId: "t1",
          toolName: "file.read",
          args: { folderId: "fld_01", displayName: "Career", filename },
        },
        pack,
        "t1",
      );
      expect(r.outcome).toBe("gateway_rejected");
      expect(r.reason).toBe("INVALID_PATH");
      expect(r.ledgerEntry.scope).toBe("file/<invalid>");
      expect(mock).not.toHaveBeenCalled();
    },
  );

  it("folder.read accepts NFC filenames", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { files: [bridgeFile("café.md")] },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(
      (r.resultJson as { files: Array<{ filename: string }> }).files,
    ).toEqual([expect.objectContaining({ filename: "café.md" })]);
  });

  // R15 Finding B (Codex): web.fetch must return ONLY { status, bodyText? }
  // — extra bridge fields cannot smuggle into the model context.
  it("web.fetch sanitises bridge result to { status, bodyText } — extra fields stripped", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        status: 200,
        bodyText: "ok",
        // Hostile fields the gateway must drop.
        records: [{ id: "smuggled", text: "do not leak" }],
        files: [{ filename: "leak.txt" }],
        secretLeakedKey: "DROP-ME",
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "web.fetch",
        args: { url: "https://example.com/", query: "hi" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(Object.keys(r.resultJson ?? {}).sort()).toEqual([
      "bodyText",
      "status",
    ]);
    expect((r.resultJson as { status: number }).status).toBe(200);
  });

  it("web.fetch rejects a non-numeric status with INVALID_BRIDGE_RESULT", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { status: "200" as never, bodyText: "x" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "web.fetch",
        args: { url: "https://example.com/", query: "hi" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_BRIDGE_RESULT");
  });

  it("web.fetch rejects status 0 so server-side blocks cannot look like HTTP success", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { status: 0 },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "web.fetch",
        args: { url: "https://example.com/", query: "hi" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_BRIDGE_RESULT");
  });

  it("web.fetch rejects a bodyText exceeding the cap with WEB_FETCH_BODY_TOO_LARGE", async () => {
    const oversized = "a".repeat(64 * 1024 + 1);
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { status: 200, bodyText: oversized },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "web.fetch",
        args: { url: "https://example.com/", query: "hi" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("WEB_FETCH_BODY_TOO_LARGE");
  });

  it("folder.read returns a SANITISED { files } payload (extra bridge fields stripped)", async () => {
    const head = utf8("# x");
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "note.md",
            byteLength: head.length,
            firstBytesB64: toB64(head),
            contentB64: toB64(head),
          },
        ],
        // Hostile/malformed extra fields the bridge must NOT smuggle.
        secretLeakedKey: "DROP-ME",
        records: [{ id: "smuggled", text: "do not reach the model" }],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(Object.keys(r.resultJson ?? {})).toEqual(["files"]);
    expect((r.resultJson as { files: unknown[] }).files).toHaveLength(1);
  });
});

describe("Tier A: memory.read", () => {
  it("forwards to client bridge with id arg and ledger scope memory/<id>", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      // R14 Finding A: bridge must return a fully-shaped MemoryRecord.
      resultJson: { record: validRecord() },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.read",
        args: { id: "m1" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].args).toEqual({ id: "m1" });
    expect(r.ledgerEntry.scope).toBe("memory/m1");
  });

  it("rejects with INVALID_ARGS when id is missing — no bridge round-trip", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "memory.read",
        args: {},
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("Tier A: folder.list / folder.read / file.read", () => {
  it("folder.list forwards to bridge and records folder display name as scope", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { entries: [{ filename: "offer.pdf", byteLength: 1024 }] },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(r.ledgerEntry.scope).toBe("folder/Career");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("folder.list filters readable file families outside the active capability suites", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        entries: [
          { filename: "notes.md", byteLength: 12 },
          { filename: "photo.png", byteLength: 1024 },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      textOnlyPack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(r.resultJson).toEqual({
      entries: [{ filename: "notes.md", byteLength: 12 }],
    });
  });

  it("folder.list applies the file-count cap after filtering out-of-scope entries", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        entries: [
          ...Array.from({ length: MAX_TOOL_RESULT_FILES + 1 }, (_, i) => ({
            filename: `photo-${i}.png`,
            byteLength: 1024,
          })),
          { filename: "resume.pdf", byteLength: 2048 },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pdfOnlyPack,
      "t1",
    );

    expect(r.outcome).toBe("ok");
    expect(r.resultJson).toEqual({
      entries: [{ filename: "resume.pdf", byteLength: 2048 }],
    });
  });

  it("file.read rejects file contents outside the active capability suites", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "photo.png",
            byteLength: png.length,
            firstBytesB64: toB64(png),
            contentB64: toB64(png),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "file.read",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          filename: "photo.png",
        },
      },
      textOnlyPack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
  });

  it("folder.list includes oversized file metadata while folder.read still rejects its contents", async () => {
    // MAX_FILE_BYTES is now 5 MiB (spec §7.1) — chunked tool-result
    // transport stitches multi-frame reads back together inside the
    // enclave. Oversize for the FOLDER.READ path requires > 5 MiB.
    const oversizedByteLength = 5 * 1024 * 1024 + 1;
    const { bridge: listBridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        entries: [{ filename: "large.pdf", byteLength: oversizedByteLength }],
      },
    });
    const listGateway = new ToolGateway({ clientBridge: listBridge });
    const listResult = await listGateway.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(listResult.outcome).toBe("ok");
    expect(listResult.resultJson).toEqual({
      entries: [{ filename: "large.pdf", byteLength: oversizedByteLength }],
    });

    const largePdf = new Uint8Array(oversizedByteLength);
    largePdf.set(utf8("%PDF-1.7"), 0);
    const { bridge: readBridge } = makeBridge({
      invocationId: "inv2",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "large.pdf",
            byteLength: largePdf.length,
            firstBytesB64: toB64(largePdf.slice(0, 16)),
            contentB64: toB64(largePdf),
          },
        ],
      },
    });
    const readGateway = new ToolGateway({ clientBridge: readBridge });
    const readResult = await readGateway.dispatch(
      {
        invocationId: "inv2",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(readResult.outcome).toBe("gateway_rejected");
    expect(readResult.reason).toBe("FILE_TOO_LARGE");
  });

  it("folder.list rejects when folderId missing", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: {},
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
  });

  it("folder.read rejects whole frame when ANY returned file fails allowlist", async () => {
    const head = utf8("# safe note");
    const evilBody = new Uint8Array(100); // valid bytes for byteLength match
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "safe.md",
            byteLength: head.length,
            firstBytesB64: toB64(head),
            contentB64: toB64(head),
          },
          {
            filename: "evil.exe",
            byteLength: evilBody.length,
            firstBytesB64: toB64(evilBody.slice(0, 16)),
            contentB64: toB64(evilBody),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_TYPE_NOT_ALLOWED");
  });

  it("folder.read rejects when a returned file is over the size cap", async () => {
    const head = utf8("%PDF-1.7");
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set(head, 0);
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "big.pdf",
            byteLength: big.length,
            firstBytesB64: toB64(head),
            contentB64: toB64(big),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_TOO_LARGE");
  });

  it("folder.read rejects extension-spoofed binary (FILE_CONTENT_MISMATCH)", async () => {
    // PDF extension but actual bytes are PE/EXE magic.
    const evil = new Uint8Array(100);
    evil.set([0x4d, 0x5a, 0x90, 0x00], 0);
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "malware.pdf",
            byteLength: evil.length,
            firstBytesB64: toB64(evil.slice(0, 16)),
            contentB64: toB64(evil),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });

  it("folder.read forwards valid .md content unchanged on ok path", async () => {
    const body = utf8("# Counter\n\nThanks!");
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "note.md",
            byteLength: body.length,
            firstBytesB64: toB64(body),
            contentB64: toB64(body),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(r.ledgerEntry.scope).toBe("folder/Career");
  });

  it("file.read derives model-visible text from valid .docx bytes", async () => {
    const docx = makeDocxWithText("Jane Developer ATS resume");
    const r = await dispatchReadFile("resume.docx", docx);

    expect(r.outcome).toBe("ok");
    expect(
      (
        r.resultJson as {
          files: Array<{
            contentKind?: string;
            extractionStatus?: string;
            text?: string;
            textTruncated?: boolean;
          }>;
        }
      ).files[0],
    ).toEqual(
      expect.objectContaining({
        contentKind: "document",
        extractionStatus: "ok",
        text: "Jane Developer ATS resume",
        textTruncated: false,
      }),
    );
  });

  it("file.read returns extracted text for searchable PDFs", async () => {
    const r = await dispatchReadFile(
      "resume.pdf",
      makeMinimalPdfWithText("Hello from PDF"),
    );

    expect(r.outcome).toBe("ok");
    const file = (
      r.resultJson as {
        files: Array<{
          contentKind?: string;
          extractionStatus?: string;
          text?: string;
        }>;
      }
    ).files[0];
    expect(file.contentKind).toBe("document");
    expect(file.extractionStatus).toBe("ok");
    expect(file.text).toContain("Hello from PDF");
  });

  it("file.read returns extracted text for RTF files", async () => {
    const r = await dispatchReadFile(
      "notes.rtf",
      utf8("{\\rtf1\\ansi Hello\\par World}"),
    );

    expect(r.outcome).toBe("ok");
    expect(
      (
        r.resultJson as {
          files: Array<{
            contentKind?: string;
            extractionStatus?: string;
            text?: string;
            textTruncated?: boolean;
          }>;
        }
      ).files[0],
    ).toEqual(
      expect.objectContaining({
        contentKind: "document",
        extractionStatus: "ok",
        text: "Hello\nWorld",
        textTruncated: false,
      }),
    );
  });

  it("file.read extracts iWork QuickLook PDF text when present", async () => {
    const r = await dispatchReadFile(
      "draft.pages",
      makeIWorkZipWithQuickLookPdf("Hello from Pages preview"),
    );

    expect(r.outcome).toBe("ok");
    const file = (
      r.resultJson as {
        files: Array<{
          contentKind?: string;
          extractionStatus?: string;
          text?: string;
        }>;
      }
    ).files[0];
    expect(file.contentKind).toBe("apple-iwork");
    expect(file.extractionStatus).toBe("ok");
    expect(file.text).toContain("Hello from Pages preview");
  });

  it("file.read reports iWork files without preview as metadata-only", async () => {
    const r = await dispatchReadFile(
      "draft.pages",
      makeIWorkZipWithoutPreview(),
    );

    expect(r.outcome).toBe("ok");
    expect(
      (
        r.resultJson as {
          files: Array<{ contentKind?: string; extractionStatus?: string }>;
        }
      ).files[0],
    ).toEqual(
      expect.objectContaining({
        contentKind: "apple-iwork",
        extractionStatus: "metadata_only",
      }),
    );
  });

  it("file.read parses Google document stubs without pretending body text exists", async () => {
    const stub = utf8(
      JSON.stringify({
        url: "https://docs.google.com/document/d/abc123/edit",
        doc_id: "abc123",
      }),
    );
    const r = await dispatchReadFile("plan.gdoc", stub);

    expect(r.outcome).toBe("ok");
    const file = (
      r.resultJson as {
        files: Array<{
          contentKind?: string;
          extractionStatus?: string;
          text?: string;
          metadata?: Record<string, unknown>;
        }>;
      }
    ).files[0];
    expect(file).toEqual(
      expect.objectContaining({
        filename: "plan.gdoc",
        contentKind: "google-stub",
        extractionStatus: "requires_google_export",
        metadata: {
          googleFileKind: "document",
          resourceId: "abc123",
          url: "https://docs.google.com/document/d/abc123/edit",
        },
      }),
    );
    expect(file).not.toHaveProperty("text");
  });

  it("file.read accepts a single valid file", async () => {
    const body = utf8("plain text");
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "note.txt",
            byteLength: body.length,
            firstBytesB64: toB64(body),
            contentB64: toB64(body),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "file.read",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          filename: "note.txt",
        },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(r.ledgerEntry.scope).toBe("file/note.txt");
  });

  it("file.read rejects missing folderId before bridge round-trip", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { files: [bridgeFile("note.txt", "plain text")] },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "file.read",
        args: { filename: "note.txt" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
    expect(mock).not.toHaveBeenCalled();
  });

  it("file.read accepts a zero-byte text file", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "empty.txt",
            byteLength: 0,
            firstBytesB64: "",
            contentB64: "",
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "file.read",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          filename: "empty.txt",
        },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    const files = (
      r.resultJson as {
        files: Array<{ byteLength: number; contentB64: string }>;
      }
    ).files;
    expect(files).toEqual([
      expect.objectContaining({ byteLength: 0, contentB64: "" }),
    ]);
  });

  it("file.read rejects extension-spoofed binary even though client returned data", async () => {
    const evil = new Uint8Array(100);
    evil.set([0x4d, 0x5a], 0);
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "malware.pdf",
            byteLength: evil.length,
            firstBytesB64: toB64(evil.slice(0, 16)),
            contentB64: toB64(evil),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "file.read",
        args: {
          folderId: "fld_01",
          displayName: "Career",
          filename: "malware.pdf",
        },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("FILE_CONTENT_MISMATCH");
  });
});

describe("Tier A: linked-folder resolution (displayName -> folderId)", () => {
  const linkedFolders = [
    { folderId: "fld_work_01", displayName: "Work folder", status: "granted" },
    { folderId: "fld_personal_02", displayName: "Personal", status: "granted" },
  ] as const;

  it("folder.list resolves a displayName-only frame to the real folderId before dispatch", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { entries: [{ filename: "offer.pdf", byteLength: 1024 }] },
    });
    const gw = new ToolGateway({ clientBridge: bridge, linkedFolders });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        // No folderId — only the human label the model reasons about.
        args: { displayName: "Work folder" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(r.ledgerEntry.scope).toBe("folder/Work folder");
    // The frame the CLIENT receives carries the resolved real folderId.
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].args).toEqual({
      folderId: "fld_work_01",
      displayName: "Work folder",
    });
  });

  it("file.read resolves a label the model put in the folderId field", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { files: [bridgeFile("offer.md", "# offer")] },
    });
    const gw = new ToolGateway({ clientBridge: bridge, linkedFolders });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "file.read",
        // The observed failure: label where the opaque id belongs.
        args: { folderId: "Work folder", filename: "offer.md" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(mock.mock.calls[0][0].args).toEqual({
      folderId: "fld_work_01",
      displayName: "Work folder",
      filename: "offer.md",
    });
  });

  it("folder.read falls back to the sole linked folder when the id is empty", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { files: [bridgeFile("notes.md", "# notes")] },
    });
    const gw = new ToolGateway({
      clientBridge: bridge,
      linkedFolders: [linkedFolders[0]],
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "", displayName: "" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(mock.mock.calls[0][0].args).toEqual({
      folderId: "fld_work_01",
      displayName: "Work folder",
    });
  });

  it("folder.list still rejects an empty id with no linked-folder context (legacy)", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { entries: [] },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { displayName: "Work folder" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
    expect(mock).not.toHaveBeenCalled();
  });

  it("folder.list rejects an unresolvable label among multiple folders", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { entries: [] },
    });
    const gw = new ToolGateway({ clientBridge: bridge, linkedFolders });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "", displayName: "" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
    expect(mock).not.toHaveBeenCalled();
  });

  it("a real folderId is preferred and stamped with the trusted displayName", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { entries: [{ filename: "x.md", byteLength: 4 }] },
    });
    const gw = new ToolGateway({ clientBridge: bridge, linkedFolders });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.list",
        // Real id, but a stale/wrong label — the trusted label wins.
        args: { folderId: "fld_personal_02", displayName: "Old name" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(mock.mock.calls[0][0].args).toEqual({
      folderId: "fld_personal_02",
      displayName: "Personal",
    });
  });
});

describe("Tier A: web.fetch", () => {
  it("forwards a fetch request with URL host in ledger scope", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { status: 200, bodyB64: "" },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "web.fetch",
        args: { url: "https://example.com/article", query: "salary trends" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(r.ledgerEntry.scope).toBe("web/example.com");
  });

  it.each([
    "http://127.0.0.1/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://192.0.2.1/",
    "http://198.51.100.1/",
    "http://203.0.113.1/",
    "http://0.1.2.3/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://user:pass@example.com/",
  ])(
    "rejects non-public HTTP target %s before bridge round-trip",
    async (url) => {
      const { bridge, mock } = makeBridge({
        invocationId: "inv1",
        outcome: "ok",
        resultJson: { status: 200 },
      });
      const gw = new ToolGateway({ clientBridge: bridge });
      const r = await gw.dispatch(
        {
          invocationId: "inv1",
          agentTurnId: "t1",
          toolName: "web.fetch",
          args: { url, query: "x" },
        },
        pack,
        "t1",
      );
      expect(r.outcome).toBe("gateway_rejected");
      expect(r.reason).toBe("SSRF_BLOCKED");
      expect(mock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed url with INVALID_ARGS without bridge round-trip", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "web.fetch",
        args: { url: "not a url", query: "x" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) schemes (no file://, no data:)", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    for (const url of [
      "file:///etc/passwd",
      "data:text/plain,abc",
      "ftp://example.com/x",
    ]) {
      const r = await gw.dispatch(
        {
          invocationId: "inv1",
          agentTurnId: "t1",
          toolName: "web.fetch",
          args: { url, query: "x" },
        },
        pack,
        "t1",
      );
      expect(r.outcome).toBe("error");
      expect(r.reason).toBe("INVALID_ARGS");
    }
  });

  it("requires query arg (PII-stripped client side)", async () => {
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "web.fetch",
        args: { url: "https://example.com" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("INVALID_ARGS");
  });
});

describe("Tier A aggregate caps (codex finding #4 — wire-budget enforcement)", () => {
  it("folder.read rejects with TOO_MANY_FILES when files exceed MAX_TOOL_RESULT_FILES", async () => {
    const head = utf8("# x");
    const files = Array.from({ length: MAX_TOOL_RESULT_FILES + 1 }, (_, i) => ({
      filename: `note${i}.md`,
      byteLength: head.length,
      firstBytesB64: toB64(head),
      contentB64: toB64(head),
    }));
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { files },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("TOO_MANY_FILES");
  });

  it("folder.read rejects with TOOL_RESULT_TOO_LARGE when aggregate bytes exceed cap", async () => {
    // 12 files * 800 KB each = 9.6 MiB total — exceeds
    // MAX_TOOL_AGGREGATE_PLAINTEXT_BYTES (5 MiB = MAX_FILE_BYTES) by
    // a healthy margin. Each file is well under MAX_FILE_BYTES so the
    // per-file validation passes; the gateway-side aggregate cap
    // (which bounds the model-context budget separately from the
    // wire reassembly cap) is what fires here.
    const head = utf8("%PDF-");
    const fileSize = 800 * 1024;
    // R14 Finding B: contentB64 must start with firstBytesB64 (else the
    // sanitiser rejects with FILE_CONTENT_PREFIX_MISMATCH); pre-fill the
    // first 5 bytes with %PDF-.
    const fullBody = new Uint8Array(fileSize);
    fullBody.set(head, 0);
    const files = Array.from({ length: 12 }, (_, i) => ({
      filename: `doc${i}.pdf`,
      byteLength: fileSize,
      firstBytesB64: toB64(head),
      contentB64: toB64(fullBody),
    }));
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { files },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("TOOL_RESULT_TOO_LARGE");
  });

  it("folder.read rejects when extracted text pushes the final tool result over the reassembled frame cap", async () => {
    const fileSize = 230 * 1024;
    const files = Array.from({ length: MAX_TOOL_RESULT_FILES }, (_, i) => {
      const body = utf8("x".repeat(fileSize));
      return {
        filename: `note${i}.txt`,
        byteLength: body.length,
        firstBytesB64: toB64(body.slice(0, 16)),
        contentB64: toB64(body),
      };
    });
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { files },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );

    expect(r.outcome).toBe("gateway_rejected");
    expect(r.reason).toBe("TOOL_RESULT_TOO_LARGE");
  });

  it("folder.read accepts a folder with files totalling under the wire budget", async () => {
    const head = utf8("# x");
    const files = Array.from({ length: 5 }, (_, i) => ({
      filename: `n${i}.md`,
      byteLength: head.length,
      firstBytesB64: toB64(head),
      contentB64: toB64(head),
    }));
    const { bridge } = makeBridge({
      invocationId: "inv1",
      outcome: "ok",
      resultJson: { files },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
  });

  it("MAX_TOOL_RESULT_PLAINTEXT_BYTES fits within MAX_VSOCK_PAYLOAD after the FULL pipeline (codex R4 finding #3)", () => {
    // R2's 320 KB cap was still wrong — codex R4 caught that base64
    // expansion happens TWICE (once inside resultJson, once when
    // wrapping encrypted bytes as a JSON string field in the vsock
    // envelope). The correct ceiling walk:
    //
    //   plaintext P
    //     → contentB64 inside resultJson: P × 4/3
    //     → resultJson plaintext: ~5 KB (per-file envelope × MAX_FILES)
    //       + 12 B outer + P × 4/3
    //     → AES-GCM encrypt: +28 B
    //     → base64 the encrypted bytes: × 4/3
    //     → vsock JSON envelope `{session_id, agent_turn_id,
    //         ciphertext}`: +~250 B
    //     → must be ≤ MAX_VSOCK_PAYLOAD (512 KB = 524,288 B)
    //
    //   Solving for P:
    //     vsockEnvelopeOverhead + (resultJsonOverhead + P × 4/3 + 28) × 4/3 ≤ 524,288
    const VSOCK_LIMIT = 512 * 1024;
    const vsockJsonOverhead = 250; // session_id + agent_turn_id + JSON syntax
    const resultJsonPerFileOverhead = 250; // filename + byteLength + firstBytesB64 + syntax
    const resultJsonOuterOverhead = 12; // {"files":[...]}
    const MAX_FILES = 20; // matches MAX_TOOL_RESULT_FILES
    const filesOverhead = resultJsonPerFileOverhead * MAX_FILES;
    const aesGcmOverhead = 28;

    // After base64-wrapping the encrypted body, the result must fit
    // in the vsock envelope. Solve backwards:
    const b64EncryptedBudget = VSOCK_LIMIT - vsockJsonOverhead; // bytes available for b64 string
    const encryptedBodyBudget = Math.floor((b64EncryptedBudget * 3) / 4);
    const resultJsonPlaintextBudget = encryptedBodyBudget - aesGcmOverhead;
    const contentB64Budget =
      resultJsonPlaintextBudget - filesOverhead - resultJsonOuterOverhead;
    const plaintextCeiling = Math.floor((contentB64Budget * 3) / 4);

    expect(MAX_TOOL_RESULT_PLAINTEXT_BYTES).toBeLessThanOrEqual(
      plaintextCeiling,
    );
    // Margin ≥ 30 KB for filename length variance, base64 padding
    // rounding, future small frame-format additions.
    expect(
      plaintextCeiling - MAX_TOOL_RESULT_PLAINTEXT_BYTES,
    ).toBeGreaterThanOrEqual(30 * 1024);
  });

  it("folder.read accepts a single file at MAX_FILE_BYTES — gateway aggregate cap does not falsely reject the spec §7.1 promise", async () => {
    // Spec §7.1 promises 5 MiB per file. The gateway-side aggregate
    // cap (MAX_TOOL_AGGREGATE_PLAINTEXT_BYTES = MAX_FILE_BYTES) is
    // designed so a single max-sized file still passes while a
    // folder of mid-sized files (totalling > 5 MiB) is rejected.
    const fileSize = MAX_FILE_BYTES; // exactly 5 MiB
    const head = utf8("%PDF-1.7");
    const fullBody = new Uint8Array(fileSize);
    fullBody.set(head, 0);
    const { bridge } = makeBridge({
      invocationId: "inv-max",
      outcome: "ok",
      resultJson: {
        files: [
          {
            filename: "big.pdf",
            byteLength: fullBody.length,
            firstBytesB64: toB64(head),
            contentB64: toB64(fullBody),
          },
        ],
      },
    });
    const gw = new ToolGateway({ clientBridge: bridge });
    const r = await gw.dispatch(
      {
        invocationId: "inv-max",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "fld_01", displayName: "Career" },
      },
      pack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
    expect(
      (r.resultJson as { files: Array<{ byteLength: number }> }).files[0]
        .byteLength,
    ).toBe(fileSize);
  });

  it("FREE readAggregateByteCap rejects an over-budget read that the default (paid) cap allows", async () => {
    const { FREE_AGENT_READ_AGGREGATE_BYTES } = await import(
      "../agent/free-tier-tools"
    );
    // ~4 KiB over the FREE budget — far below the default ~5 MiB cap.
    const overBudget = FREE_AGENT_READ_AGGREGATE_BYTES + 4096;
    const head = utf8("%PDF-1.7");
    const body = new Uint8Array(overBudget);
    body.set(head, 0);
    const resultJson = {
      files: [
        {
          filename: "big.pdf",
          byteLength: body.length,
          firstBytesB64: toB64(head),
          contentB64: toB64(body),
        },
      ],
    };
    const frame = {
      invocationId: "inv-free",
      agentTurnId: "t1",
      toolName: "folder.read" as const,
      args: { folderId: "fld_01", displayName: "Career" },
    };

    // FREE budget: the over-budget read is rejected.
    const freeGw = new ToolGateway({
      clientBridge: makeBridge({ invocationId: "inv-free", outcome: "ok", resultJson }).bridge,
      readAggregateByteCap: FREE_AGENT_READ_AGGREGATE_BYTES,
    });
    const freeR = await freeGw.dispatch(frame, pack, "t1");
    expect(freeR.outcome).toBe("gateway_rejected");
    expect(freeR.reason).toBe("TOOL_RESULT_TOO_LARGE");

    // Default (paid) cap: the SAME read is allowed — proving the FREE cap is
    // what blocked it, not the file itself.
    const paidGw = new ToolGateway({
      clientBridge: makeBridge({ invocationId: "inv-free", outcome: "ok", resultJson }).bridge,
    });
    const paidR = await paidGw.dispatch(frame, pack, "t1");
    expect(paidR.outcome).toBe("ok");
  });

  it("FREE budget enforces MODEL-VISIBLE bytes: a raw-under-cap file whose base64 exceeds it is rejected", async () => {
    const { FREE_AGENT_READ_AGGREGATE_BYTES } = await import(
      "../agent/free-tier-tools"
    );
    // 200 KiB raw -> contentB64 ~= 267 KiB (×4/3) > 256 KiB. The RAW size is
    // UNDER budget, so a decoded-bytes cap would wrongly allow it; the
    // model-visible (serialised resultJson) cap correctly rejects it.
    const rawSize = 200 * 1024;
    expect(rawSize).toBeLessThan(FREE_AGENT_READ_AGGREGATE_BYTES);
    const head = utf8("%PDF-1.7");
    const body = new Uint8Array(rawSize);
    body.set(head, 0);
    const resultJson = {
      files: [
        {
          filename: "doc.pdf",
          byteLength: body.length,
          firstBytesB64: toB64(head),
          contentB64: toB64(body),
        },
      ],
    };
    const frame = {
      invocationId: "inv-b64",
      agentTurnId: "t1",
      toolName: "folder.read" as const,
      args: { folderId: "fld_01", displayName: "Career" },
    };
    const freeGw = new ToolGateway({
      clientBridge: makeBridge({ invocationId: "inv-b64", outcome: "ok", resultJson }).bridge,
      readAggregateByteCap: FREE_AGENT_READ_AGGREGATE_BYTES,
    });
    const freeR = await freeGw.dispatch(frame, pack, "t1");
    expect(freeR.outcome).toBe("gateway_rejected");
    expect(freeR.reason).toBe("TOOL_RESULT_TOO_LARGE");
    const paidR = await new ToolGateway({
      clientBridge: makeBridge({ invocationId: "inv-b64", outcome: "ok", resultJson }).bridge,
    }).dispatch(frame, pack, "t1");
    expect(paidR.outcome).toBe("ok");
  });

  it("FREE budget is CUMULATIVE per turn: two individually-under-cap reads sum past it", async () => {
    const { FREE_AGENT_READ_AGGREGATE_BYTES } = await import(
      "../agent/free-tier-tools"
    );
    // 150 KiB raw -> contentB64 ~200 KiB -> each read is UNDER 256 KiB, but two
    // in one turn sum to ~400 KiB > 256 KiB. The second must be rejected.
    const head = utf8("%PDF-1.7");
    const body = new Uint8Array(150 * 1024);
    body.set(head, 0);
    const resultJson = {
      files: [
        {
          filename: "doc.pdf",
          byteLength: body.length,
          firstBytesB64: toB64(head),
          contentB64: toB64(body),
        },
      ],
    };
    // Per-frame bridge so successive reads (distinct invocationIds) both resolve
    // against the SAME gateway instance / turn.
    const bridge: ClientBridge = {
      async invokeClient(frame) {
        return { invocationId: frame.invocationId, outcome: "ok", resultJson };
      },
    };
    const gw = new ToolGateway({
      clientBridge: bridge,
      readAggregateByteCap: FREE_AGENT_READ_AGGREGATE_BYTES,
    });
    const readFrame = (i: number) => ({
      invocationId: `inv-cum-${i}`,
      agentTurnId: "t1",
      toolName: "folder.read" as const,
      args: { folderId: "fld_01", displayName: "Career" },
    });

    const first = await gw.dispatch(readFrame(1), pack, "t1");
    expect(first.outcome).toBe("ok"); // under cap on its own

    const second = await gw.dispatch(readFrame(2), pack, "t1");
    expect(second.outcome).toBe("gateway_rejected"); // cumulative over cap
    expect(second.reason).toBe("TOOL_RESULT_TOO_LARGE");
  });

  it("FREE budget covers memory.list (the file-path cap missed memory)", async () => {
    const { FREE_AGENT_READ_AGGREGATE_BYTES } = await import(
      "../agent/free-tier-tools"
    );
    // 40 records × ~8 KB text ≈ 330 KiB serialised > 256 KiB.
    const records = Array.from({ length: 40 }, (_, i) =>
      validRecord({ id: `m_${i}`, text: "x".repeat(8000) }),
    );
    const resultJson = { records };
    const frame = {
      invocationId: "inv-mem",
      agentTurnId: "t1",
      toolName: "memory.list" as const,
      args: { namespace: "default" },
    };
    const freeGw = new ToolGateway({
      clientBridge: makeBridge({ invocationId: "inv-mem", outcome: "ok", resultJson }).bridge,
      readAggregateByteCap: FREE_AGENT_READ_AGGREGATE_BYTES,
    });
    const freeR = await freeGw.dispatch(frame, pack, "t1");
    expect(freeR.outcome).toBe("gateway_rejected");
    expect(freeR.reason).toBe("TOOL_RESULT_TOO_LARGE");
    const paidR = await new ToolGateway({
      clientBridge: makeBridge({ invocationId: "inv-mem", outcome: "ok", resultJson }).bridge,
    }).dispatch(frame, pack, "t1");
    expect(paidR.outcome).toBe("ok");
  });

  it("a MAX_FILE_BYTES file fits the chunked-transport pipeline AFTER base64 expansion", async () => {
    const { MAX_REASSEMBLED_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_CHUNKS } =
      await import("../tools/file-allowlist");

    // The reassembled bytes are the raw single-frame inner JSON, which
    // carries contentB64 = base64(file bytes). Base64 expands by 4/3.
    // The pipeline self-check that matters is the EXPANDED size, not
    // the raw file size — the round-2 reviewer caught that
    // `MAX_FILE_BYTES ≤ MAX_REASSEMBLED` was apples-to-oranges.
    const filesCount = 1; // worst case: single MAX_FILE_BYTES file
    const perFileEnvelope = 256; // filename + byteLength + firstBytesB64 + JSON syntax
    const outerEnvelope = 64; // {agentTurnId,invocationId,outcome,resultJson:{files:[...]}}
    const contentB64Bytes = Math.ceil((MAX_FILE_BYTES / 3) * 4);
    const expandedInnerJsonBytes =
      outerEnvelope + filesCount * perFileEnvelope + contentB64Bytes;

    expect(expandedInnerJsonBytes).toBeLessThanOrEqual(
      MAX_REASSEMBLED_TOOL_RESULT_BYTES,
    );

    // Same self-check on the wire-chunk count: client must be able to
    // split the expanded plaintext into ≤ MAX_TOOL_RESULT_CHUNKS frames.
    const CHUNK_SLICE_BYTES = 200 * 1024;
    const requiredChunks = Math.ceil(
      expandedInnerJsonBytes / CHUNK_SLICE_BYTES,
    );
    expect(requiredChunks).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHUNKS);
  });

  it("simulated vsock envelope at MAX_TOOL_RESULT_PLAINTEXT_BYTES fits under MAX_VSOCK_PAYLOAD (codex R4 finding #3 end-to-end self-check)", () => {
    // Walk a concrete worst-case payload through the full pipeline
    // (without crypto, since we only care about byte sizes) and assert
    // the result fits in the wire frame.
    const P = MAX_TOOL_RESULT_PLAINTEXT_BYTES;
    const filesCount = 20;
    const perFileEnvelope =
      '{"filename":"some-long-filename.pdf","byteLength":XXXXXX,"firstBytesB64":"' +
      "A".repeat(88) +
      '","contentB64":""}';
    const filesArrayJson =
      '{"files":[' +
      Array.from({ length: filesCount }, () => perFileEnvelope).join(",") +
      "]}";
    const filesArrayJsonOverhead = filesArrayJson.length; // no contentB64 yet
    const contentB64ForP = Math.ceil(P / 3) * 4; // exact b64 expansion incl padding
    const resultJsonPlaintextBytes = filesArrayJsonOverhead + contentB64ForP;
    const aesGcmOverhead = 28;
    const encryptedBodyBytes = resultJsonPlaintextBytes + aesGcmOverhead;
    const ciphertextFieldBytes = Math.ceil(encryptedBodyBytes / 3) * 4;
    const vsockEnvelopeJson = JSON.stringify({
      session_id: "x".repeat(64),
      agent_turn_id: "00000000-0000-0000-0000-000000000000",
      ciphertext: "Y".repeat(ciphertextFieldBytes),
    });
    expect(vsockEnvelopeJson.length).toBeLessThanOrEqual(512 * 1024);
  });
});

// 1C.3: folder/file reads bound to crossPackGrant.folderIds when a grant is present.
// Absent grant → unchanged behaviour (regression safety).
// The identical grant guard also protects handleFolderWrite (tier-b-draft.ts,
// covered by its own test) and the media handler (tier-media.ts). The
// tier-media guard is positioned before readSourceBytes()'s bridge call so it
// cannot be bypassed; it has no dedicated test because exercising the media
// happy path needs heavy readSourceBytes mocking, and the guard is mechanically
// identical to the cases proven here and in tier-b-draft.
describe("Tier A folder grant-binding (1C.3)", () => {
  const claimsPack: SkillPack = { ...pack, id: "personal-agent.claims", defaultNamespace: "default" };

  // Linked-folder entries for the grant tests.
  const linkedFolders = [
    { folderId: "f1", displayName: "Bill", status: "granted" as const },
    { folderId: "f9", displayName: "Other", status: "granted" as const },
  ];

  // A valid .md file payload — reuses the known-good bridge shape from the
  // existing folder.read happy-path tests above.
  function mdBridgeResult(invocationId: string) {
    const body = utf8("# ok");
    return {
      invocationId,
      outcome: "ok" as const,
      resultJson: {
        files: [
          {
            filename: "note.md",
            byteLength: body.length,
            firstBytesB64: toB64(body),
            contentB64: toB64(body),
          },
        ],
      },
    };
  }

  it("folder.read of a grant-listed folder → ok", async () => {
    const { bridge } = makeBridge(mdBridgeResult("inv1"));
    const gw = new ToolGateway({
      clientBridge: bridge,
      linkedFolders,
      crossPackGrant: {
        namespaces: new Set(["default"]) as ReadonlySet<SkillPack["defaultNamespace"]>,
        folderIds: new Set(["f1"]),
        documentIds: new Set<string>(),
      },
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv1",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "f1", displayName: "Bill" },
      },
      claimsPack,
      "t1",
    );
    expect(r.outcome).toBe("ok");
  });

  it("folder.list of a folder NOT in the grant → FOLDER_NOT_IN_GRANT, bridge NOT called", async () => {
    const { bridge, mock } = makeBridge({
      invocationId: "inv-fl",
      outcome: "ok",
      resultJson: { entries: [{ filename: "claim.pdf", byteLength: 512 }] },
    });
    const gw = new ToolGateway({
      clientBridge: bridge,
      linkedFolders,
      crossPackGrant: {
        namespaces: new Set(["default"]) as ReadonlySet<SkillPack["defaultNamespace"]>,
        folderIds: new Set(["f1"]), // f9 is NOT in the grant
        documentIds: new Set<string>(),
      },
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv-fl",
        agentTurnId: "t1",
        toolName: "folder.list",
        args: { folderId: "f9", displayName: "Other" },
      },
      claimsPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("FOLDER_NOT_IN_GRANT");
    expect(mock).not.toHaveBeenCalled();
  });

  it("folder.read of a folder NOT in the grant → FOLDER_NOT_IN_GRANT, bridge NOT called", async () => {
    const { bridge, mock } = makeBridge(mdBridgeResult("inv2"));
    const gw = new ToolGateway({
      clientBridge: bridge,
      linkedFolders,
      crossPackGrant: {
        namespaces: new Set(["default"]) as ReadonlySet<SkillPack["defaultNamespace"]>,
        folderIds: new Set(["f1"]), // f9 is NOT in the grant
        documentIds: new Set<string>(),
      },
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv2",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "f9", displayName: "Other" },
      },
      claimsPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("FOLDER_NOT_IN_GRANT");
    expect(mock).not.toHaveBeenCalled();
  });

  it("file.read of a file in a non-granted folder → FOLDER_NOT_IN_GRANT, bridge NOT called", async () => {
    const { bridge, mock } = makeBridge(mdBridgeResult("inv3"));
    const gw = new ToolGateway({
      clientBridge: bridge,
      linkedFolders,
      crossPackGrant: {
        namespaces: new Set(["default"]) as ReadonlySet<SkillPack["defaultNamespace"]>,
        folderIds: new Set(["f1"]), // f9 is NOT in the grant
        documentIds: new Set<string>(),
      },
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv3",
        agentTurnId: "t1",
        toolName: "file.read",
        args: { folderId: "f9", displayName: "Other", filename: "x.pdf" },
      },
      claimsPack,
      "t1",
    );
    expect(r.outcome).toBe("error");
    expect(r.reason).toBe("FOLDER_NOT_IN_GRANT");
    expect(mock).not.toHaveBeenCalled();
  });

  it("no grant → folder.read proceeds without FOLDER_NOT_IN_GRANT rejection (regression)", async () => {
    // Construct gateway WITHOUT crossPackGrant — only clientBridge + linkedFolders.
    // A folder.read for "f9" must NOT be rejected with FOLDER_NOT_IN_GRANT;
    // it should proceed normally (ok, or whatever the bridge returns).
    const { bridge } = makeBridge(mdBridgeResult("inv4"));
    const gw = new ToolGateway({
      clientBridge: bridge,
      linkedFolders,
      // crossPackGrant deliberately absent
    });
    const r = await gw.dispatch(
      {
        invocationId: "inv4",
        agentTurnId: "t1",
        toolName: "folder.read",
        args: { folderId: "f9", displayName: "Other" },
      },
      pack, // non-claims pack, no grant
      "t1",
    );
    expect(r.reason).not.toBe("FOLDER_NOT_IN_GRANT");
    // It should not be blocked by the grant check — ok is the expected result here.
    expect(r.outcome).toBe("ok");
  });
});
