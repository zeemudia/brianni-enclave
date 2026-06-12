import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MediaToolRequestSchema, MediaToolsClient } from "../tools/media-tools";

// These tests spawn the Python media sidecar, whose start() waits for the
// process to import its deps (Pillow/vosk) and print MEDIA_TOOLS_READY — a
// cold spawn on a loaded CI runner can exceed vitest's default 5s test
// timeout (the client timeoutMs only bounds run(), not start()). Give the
// whole file a generous timeout so the cold-start cost doesn't flake.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const servicePath = resolve(
  import.meta.dirname ?? __dirname,
  "../tools/media_tools_service.py",
);

const onePixelPngB64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const hasTesseract = spawnSync("tesseract", ["--version"], {
  stdio: "ignore",
}).status === 0;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], {
  stdio: "ignore",
}).status === 0;
const hasPillow = spawnSync("python3", ["-c", "import PIL"], {
  stdio: "ignore",
}).status === 0;
const hasPillowHeif = spawnSync("python3", ["-c", "import pillow_heif"], {
  stdio: "ignore",
}).status === 0;
const requireMediaToolDeps =
  process.env.CALYPSO_REQUIRE_MEDIA_TOOL_DEPS === "1";
// Image inspect/transform need Pillow in the sidecar. Bare CI runners
// (ubuntu-latest on PR events) ship no Pillow, so guard like the HEIC/OCR/
// ffmpeg runtime tests; set CALYPSO_REQUIRE_MEDIA_TOOL_DEPS=1 to force them.
const imageRuntimeTest = hasPillow || requireMediaToolDeps ? it : it.skip;
const ocrRuntimeTest =
  (hasTesseract && hasPillow) || requireMediaToolDeps ? it : it.skip;
const heicRuntimeTest = hasPillowHeif || requireMediaToolDeps ? it : it.skip;

const tinyHeicB64 =
  "AAAAHGZ0eXBoZWl4AAAAAG1pZjFoZWl4bWlhZgAAAldtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAANGlsb2MAAAAAREAAAgABAAAAAAJ7AAEAAAAAAAAAVwACAAAAAALSAAEAAAAAAAAAEwAAADhpaW5mAAAAAAACAAAAFWluZmUCAAAAAAEAAGh2YzEAAAAAFWluZmUCAAAAAAIAAGh2YzEAAAABlmlwcnAAAAFvaXBjbwAAAHVodmNDAQQIAAAAAAAAAAAAHvAA/P38/AAADwNgAAEAF0ABDAH//wQIAAADAJm4AAADAAAeugJAYQABACpCAQEECAAAAwCZuAAAAwAAHqAggQRSlurkprm4CGgwIAAAAwMgAAADACFiAAEABkQBwXPAiQAAABRpc3BlAAAAAAAAAEAAAABAAAAAKGNsYXAAAABAAAAAAQAAACAAAAABAAAAAAAAAAL////gAAAAAgAAABBwaXhpAAAAAAMMDAwAAABxaHZjQwEECAAAAAAAAAAAAB7wAPz8/PwAAA8DYAABABdAAQwB//8ECAAAAwCZ+AAAAwAAHroCQGEAAQAmQgEBBAgAAAMAmfgAAAMAAB7AggQRSlurkprmwIAAAAyAAAADAIRiAAEABkQBwXPAiQAAAA5waXhpAAAAAAEMAAAAJ2F1eEMAAAAAdXJuOm1wZWc6aGV2YzoyMDE1OmF1eGlkOjEAAAAAH2lwbWEAAAAAAAAAAgABBIECBIMAAgWFAgaHgwAAABppcmVmAAAAAAAAAA5hdXhsAAIAAQABAAAAcm1kYXQAAABTKAGvE4DcRbwHz+AGfGuVl9oHRSv/bRAyDuOM7U8aNfj+8xjN/0Z23hz42xbDhGm0MSNVXQUjM2ut/scfrHdvJoTwAnGUh7DiZS4y4pP9SleliHgAAAAPKAGuJ+ffNHf/9Mj3nAK+";

function makeOcrFixture(): string {
  return execFileSync("python3", [
    "-c",
    `
import base64, io
from PIL import Image, ImageDraw
im = Image.new("RGB", (260, 90), "white")
d = ImageDraw.Draw(im)
d.text((20, 30), "HELLO OCR", fill="black")
buf = io.BytesIO()
im.save(buf, format="PNG")
print(base64.b64encode(buf.getvalue()).decode("ascii"))
`,
  ])
    .toString("utf8")
    .trim();
}

function makeSilentWavB64(): string {
  return execFileSync("python3", [
    "-c",
    `
import base64, io, wave
buf = io.BytesIO()
with wave.open(buf, "wb") as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(16000)
    wf.writeframes(b"\\x00\\x00" * 1600)
print(base64.b64encode(buf.getvalue()).decode("ascii"))
`,
  ])
    .toString("utf8")
    .trim();
}

function makeSplitRunDocxB64(): string {
  return execFileSync("python3", [
    "-c",
    `
import base64, io, zipfile
content_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
content_types_xml = f'''<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="{content_type}"/></Types>'''
rels_xml = '''<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'''
document_xml = '''<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{CALYPSO_</w:t></w:r><w:r><w:t>PROOF_PLACEHOLDER}}</w:t></w:r></w:p></w:body></w:document>'''
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types_xml)
    z.writestr("_rels/.rels", rels_xml)
    z.writestr("word/document.xml", document_xml)
print(base64.b64encode(buf.getvalue()).decode("ascii"))
`,
  ])
    .toString("utf8")
    .trim();
}

function extractDocxDocumentXmlFromB64(docxB64: string): string {
  return execFileSync(
    "python3",
    [
      "-c",
      `
import base64, io, sys, zipfile
data = base64.b64decode(sys.stdin.read().strip())
with zipfile.ZipFile(io.BytesIO(data), "r") as z:
    print(z.read("word/document.xml").decode("utf-8"))
`,
    ],
    { input: docxB64 },
  ).toString("utf8");
}

describe("MediaToolsClient", () => {
  it("accepts image resize requests that only constrain width", () => {
    const parsed = MediaToolRequestSchema.parse({
      operation: "image.transform",
      filename: "proof-image.png",
      inputB64: onePixelPngB64,
      transform: { kind: "resize", maxWidth: 800, format: "png" },
    });

    expect(parsed.transform).toMatchObject({
      kind: "resize",
      maxWidth: 800,
      maxHeight: 8192,
      format: "png",
    });
  });

  imageRuntimeTest("inspects image metadata through the Python sidecar", async () => {
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
    await client.start();
    const result = await client.run({
      operation: "image.inspect",
      filename: "pixel.png",
      inputB64: onePixelPngB64,
    });
    client.stop();

    expect(result).toMatchObject({
      contentKind: "image",
      metadata: {
        width: 1,
        height: 1,
      },
    });
  });

  imageRuntimeTest("resizes images and returns transformed bytes", async () => {
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
    await client.start();
    const result = await client.run({
      operation: "image.transform",
      filename: "pixel.png",
      inputB64: onePixelPngB64,
      transform: { kind: "resize", maxWidth: 1, maxHeight: 1, format: "png" },
    });
    client.stop();

    expect(result).toMatchObject({
      contentKind: "image",
      outputMimeType: "image/png",
      outputExtension: ".png",
      metadata: {
        width: 1,
        height: 1,
      },
    });
    expect(result.outputB64).toEqual(expect.any(String));
    expect(result.outputSha256Hex).toMatch(/^[a-f0-9]{64}$/);
  });

  ocrRuntimeTest("runs true OCR through tesseract", async () => {
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 10_000 });
    await client.start();
    const result = await client.run({
      operation: "image.ocr",
      filename: "ocr.png",
      inputB64: makeOcrFixture(),
    });
    client.stop();

    expect(result.contentKind).toBe("image");
    expect(result.text?.toUpperCase()).toContain("HELLO");
    expect(result.extractionStatus).toBe("ok");
  });

  heicRuntimeTest("decodes HEIC images through the registered Pillow opener", async () => {
    if (!hasPillowHeif) {
      throw new Error("MEDIA_TOOL_DEP_MISSING:pillow_heif");
    }
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
    await client.start();
    const result = await client.run({
      operation: "image.inspect",
      filename: "fixture.heic",
      inputB64: tinyHeicB64,
    });
    client.stop();

    expect(result.contentKind).toBe("image");
    expect(result.metadata.width).toBe(64);
    expect(result.metadata.height).toBe(32);
  });

  (hasFfmpeg ? it : it.skip)("uses the configured Vosk model path for transcription", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "calypso-vosk-test-"));
    const fakeModel = join(tmp, "model");
    mkdirSync(fakeModel);
    writeFileSync(
      join(tmp, "vosk.py"),
      [
        "import json",
        "class Model:",
        "    def __init__(self, path):",
        "        if not path.endswith('model'):",
        "            raise RuntimeError('unexpected model path: ' + path)",
        "class KaldiRecognizer:",
        "    def __init__(self, model, rate):",
        "        self.model = model",
        "    def AcceptWaveform(self, chunk):",
        "        return False",
        "    def Result(self):",
        "        return json.dumps({'text': ''})",
        "    def FinalResult(self):",
        "        return json.dumps({'text': 'hello from configured vosk model'})",
        "",
      ].join("\n"),
    );
    const oldPythonPath = process.env.PYTHONPATH;
    const oldModelPath = process.env.CALYPSO_VOSK_MODEL;
    process.env.PYTHONPATH = oldPythonPath ? `${tmp}${delimiter}${oldPythonPath}` : tmp;
    process.env.CALYPSO_VOSK_MODEL = fakeModel;
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 10_000 });
    try {
      await client.start();
      const result = await client.run({
        operation: "audio.transcribe",
        filename: "silence.wav",
        inputB64: makeSilentWavB64(),
      });

      expect(result.contentKind).toBe("audio");
      expect(result.extractionStatus).toBe("ok");
      expect(result.text).toContain("configured vosk model");
      expect(result.metadata.engine).toBe("vosk");
    } finally {
      client.stop();
      if (oldPythonPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = oldPythonPath;
      if (oldModelPath === undefined) delete process.env.CALYPSO_VOSK_MODEL;
      else process.env.CALYPSO_VOSK_MODEL = oldModelPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when transcription is not configured with a local model", async () => {
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
    await client.start();
    await expect(
      client.run({
        operation: "audio.transcribe",
        filename: "silence.wav",
        inputB64: Buffer.from("not-a-real-wav").toString("base64"),
      }),
    ).rejects.toThrow(/TRANSCRIBE_ENGINE_UNAVAILABLE|MEDIA_TOOL_ERROR/);
    client.stop();
  });

  it("replaces DOCX placeholders split across adjacent text runs", async () => {
    const client = new MediaToolsClient({ scriptPath: servicePath, timeoutMs: 5_000 });
    await client.start();
    const result = await client.run({
      operation: "document.docx_transform",
      filename: "proof-letter.docx",
      inputB64: makeSplitRunDocxB64(),
      transform: {
        kind: "replace_text",
        search: "{{CALYPSO_PROOF_PLACEHOLDER}}",
        replacement: "Calypso agent document edit proof",
        maxReplacements: 1,
      },
    });
    client.stop();

    expect(result.outputB64).toEqual(expect.any(String));
    expect(result.metadata.replacements).toBe(1);
    const documentXml = extractDocxDocumentXmlFromB64(result.outputB64 ?? "");
    expect(documentXml).toContain("Calypso agent document edit proof");
    expect(documentXml).not.toContain("CALYPSO_");
    expect(documentXml).not.toContain("PROOF_PLACEHOLDER");
  });
});
