#!/usr/bin/env python3
"""
Calypso media/document sidecar.

The TypeScript gateway owns policy, path checks, copy-on-write, and model
visibility. This Python process only executes fixed operations over bytes
provided by the enclave.
"""

import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import html
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    from PIL import Image
except Exception:  # pragma: no cover - exercised by fail-closed callers
    Image = None

if Image is not None:
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        # HEIF support is optional. If pillow-heif is missing or fails to
        # register, ignore it so standard Pillow formats keep working.
        pass

_WHISPER_MODEL = None


def emit(payload):
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def ok(**payload):
    emit({"status": "ok", **payload})


def fail(code, detail=None):
    message = code if detail is None else f"{code}: {detail}"
    emit({"status": "error", "error": message})


def input_bytes(req):
    try:
        return base64.b64decode(req.get("inputB64", ""), validate=True)
    except Exception as exc:
        raise ValueError(f"INVALID_BASE64: {exc}") from exc


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def ext_for(filename, fallback):
    suffix = Path(filename or "").suffix.lower()
    if suffix and len(suffix) <= 12:
        return suffix
    return fallback


def require_pillow():
    if Image is None:
        raise RuntimeError("IMAGE_ENGINE_UNAVAILABLE")


def image_inspect(req):
    require_pillow()
    data = input_bytes(req)
    with Image.open(io.BytesIO(data)) as im:
        ok(
            contentKind="image",
            extractionStatus="metadata_only",
            metadata={
                "width": im.width,
                "height": im.height,
                "format": im.format or "",
                "mode": im.mode,
            },
        )


def image_ocr(req):
    require_pillow()
    data = input_bytes(req)
    if shutil.which("tesseract") is None:
        raise RuntimeError("OCR_ENGINE_UNAVAILABLE")
    # Feed the rasterised PNG to tesseract over stdin ("-") rather than via a
    # temp-file path. This keeps the OCR input off disk entirely (no plaintext
    # image bytes land in a predictable temp path) and avoids leptonica's
    # filename/path-parsing heuristics, which mis-handle some absolute temp
    # paths and intermittently report a valid image as "image file not found".
    png_buf = io.BytesIO()
    with Image.open(io.BytesIO(data)) as im:
        raster = im.convert("RGB") if im.mode not in ("RGB", "L") else im.copy()
        raster.save(png_buf, format="PNG")
    proc = subprocess.run(
        ["tesseract", "-", "stdout", "--psm", "6", "-l", "eng"],
        check=False,
        input=png_buf.getvalue(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "OCR_ENGINE_FAILED: " + proc.stderr.decode("utf-8", "replace")[:200]
        )
    text = proc.stdout.decode("utf-8", "replace").strip()
    ok(
        contentKind="image",
        extractionStatus="ok" if text else "metadata_only",
        text=text,
        metadata={"engine": "tesseract"},
    )


def image_transform(req):
    require_pillow()
    transform = req.get("transform") or {}
    if transform.get("kind") != "resize":
        raise ValueError("UNSUPPORTED_IMAGE_TRANSFORM")
    data = input_bytes(req)
    fmt = transform.get("format", "png")
    save_format = {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[fmt]
    mime = {"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}[fmt]
    ext = {"png": ".png", "jpeg": ".jpg", "webp": ".webp"}[fmt]
    with Image.open(io.BytesIO(data)) as im:
        im = im.convert("RGB") if fmt == "jpeg" else im.copy()
        im.thumbnail((int(transform["maxWidth"]), int(transform["maxHeight"])))
        out = io.BytesIO()
        im.save(out, format=save_format)
        out_bytes = out.getvalue()
        ok(
            contentKind="image",
            extractionStatus="ok",
            outputB64=base64.b64encode(out_bytes).decode("ascii"),
            outputMimeType=mime,
            outputExtension=ext,
            outputSha256Hex=sha256_hex(out_bytes),
            metadata={"width": im.width, "height": im.height, "format": save_format},
        )


def run_ffprobe(path):
    if shutil.which("ffprobe") is None:
        raise RuntimeError("FFPROBE_UNAVAILABLE")
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "FFPROBE_FAILED: " + proc.stderr.decode("utf-8", "replace")[:200]
        )
    return json.loads(proc.stdout.decode("utf-8"))


def media_inspect(req, kind):
    data = input_bytes(req)
    suffix = ext_for(req.get("filename", ""), ".bin")
    with tempfile.TemporaryDirectory(prefix=f"calypso-{kind}-inspect-") as tmp:
        path = Path(tmp) / f"input{suffix}"
        path.write_bytes(data)
        info = run_ffprobe(path)
    fmt = info.get("format") or {}
    streams = info.get("streams") or []
    ok(
        contentKind=kind,
        extractionStatus="metadata_only",
        metadata={
            "duration": float(fmt.get("duration", 0) or 0),
            "bitRate": int(fmt.get("bit_rate", 0) or 0),
            "formatName": fmt.get("format_name", ""),
            "streams": [
                {
                    "codecType": s.get("codec_type", ""),
                    "codecName": s.get("codec_name", ""),
                    "width": s.get("width"),
                    "height": s.get("height"),
                }
                for s in streams
            ],
        },
    )


def ffmpeg_transform(req, kind):
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("FFMPEG_UNAVAILABLE")
    transform = req.get("transform") or {}
    data = input_bytes(req)
    suffix = ext_for(req.get("filename", ""), ".bin")
    with tempfile.TemporaryDirectory(prefix=f"calypso-{kind}-transform-") as tmp:
        in_path = Path(tmp) / f"input{suffix}"
        in_path.write_bytes(data)
        out_ext, mime, args = build_ffmpeg_args(transform, kind)
        out_path = Path(tmp) / f"output{out_ext}"
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(in_path), *args, str(out_path)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                "FFMPEG_FAILED: " + proc.stderr.decode("utf-8", "replace")[:300]
            )
        out = out_path.read_bytes()
    ok(
        contentKind=kind,
        extractionStatus="ok",
        outputB64=base64.b64encode(out).decode("ascii"),
        outputMimeType=mime,
        outputExtension=out_ext,
        outputSha256Hex=sha256_hex(out),
        metadata={"transform": transform.get("kind", "")},
    )


def build_ffmpeg_args(transform, kind):
    op = transform.get("kind")
    if kind == "audio":
        fmt = transform.get("format", "wav")
        audio_formats = {
            "wav": (".wav", "audio/wav", ["-vn", "-acodec", "pcm_s16le"]),
            "mp3": (".mp3", "audio/mpeg", ["-vn", "-codec:a", "libmp3lame"]),
            "m4a": (".m4a", "audio/mp4", ["-vn", "-codec:a", "aac"]),
            "ogg": (".ogg", "audio/ogg", ["-vn", "-codec:a", "libvorbis"]),
            "flac": (".flac", "audio/flac", ["-vn", "-codec:a", "flac"]),
        }
        if op == "convert" and fmt in audio_formats:
            return audio_formats[fmt]
        if op == "extract_clip" and fmt in audio_formats:
            ext, mime, args = audio_formats[fmt]
            return (
                ext,
                mime,
                [
                    "-ss",
                    str(float(transform.get("startSeconds", 0))),
                    "-t",
                    str(float(transform.get("durationSeconds", 1))),
                    *args,
                ],
            )
    if kind == "video":
        if op == "extract_audio":
            fmt = transform.get("format", "wav")
            return build_ffmpeg_args({"kind": "convert", "format": fmt}, "audio")
        if op == "resize":
            fmt = transform.get("format", "mp4")
            max_w = int(transform.get("maxWidth", 1280))
            max_h = int(transform.get("maxHeight", 720))
            vf = (
                f"scale=w='min({max_w},iw)':h='min({max_h},ih)':"
                "force_original_aspect_ratio=decrease"
            )
            if fmt == "mp4":
                return (".mp4", "video/mp4", ["-vf", vf, "-codec:v", "libx264", "-codec:a", "aac"])
            if fmt == "webm":
                return (".webm", "video/webm", ["-vf", vf, "-codec:v", "libvpx-vp9", "-codec:a", "libopus"])
    raise ValueError("UNSUPPORTED_MEDIA_TRANSFORM")


def whisper_transcribe(req, kind):
    model_path = (
        os.environ.get("CALYPSO_VOSK_MODEL")
        or os.environ.get("VOSK_MODEL_PATH")
        or "/opt/calypso/vosk-model-small-en-us-0.15"
    )
    if os.path.isdir(model_path):
        # vosk_transcribe emits via ok()/fail() and returns None, like the
        # Whisper success path below; keep both transcription paths implicit
        # so this function never returns a procedure's value.
        vosk_transcribe(req, kind, model_path)
        return
    model_path = os.environ.get("CALYPSO_WHISPER_MODEL")
    if not model_path:
        raise RuntimeError("TRANSCRIBE_ENGINE_UNAVAILABLE")
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        raise RuntimeError(f"TRANSCRIBE_ENGINE_UNAVAILABLE: {exc}") from exc
    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        _WHISPER_MODEL = WhisperModel(model_path, device="cpu", compute_type="int8")
    data = input_bytes(req)
    suffix = ext_for(req.get("filename", ""), ".bin")
    with tempfile.TemporaryDirectory(prefix=f"calypso-{kind}-transcribe-") as tmp:
        in_path = Path(tmp) / f"input{suffix}"
        wav_path = Path(tmp) / "audio.wav"
        in_path.write_bytes(data)
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-y",
                "-i",
                str(in_path),
                "-ac",
                "1",
                "-ar",
                "16000",
                str(wav_path),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                "TRANSCRIBE_AUDIO_EXTRACT_FAILED: "
                + proc.stderr.decode("utf-8", "replace")[:300]
            )
        segments, info = _WHISPER_MODEL.transcribe(str(wav_path), beam_size=1)
        text = " ".join(seg.text.strip() for seg in segments).strip()
    ok(
        contentKind=kind,
        extractionStatus="ok" if text else "metadata_only",
        text=text,
        metadata={"language": getattr(info, "language", "") or "", "engine": "faster-whisper"},
    )


def vosk_transcribe(req, kind, model_path):
    try:
        import wave
        from vosk import KaldiRecognizer, Model
    except Exception as exc:
        raise RuntimeError(f"TRANSCRIBE_ENGINE_UNAVAILABLE: {exc}") from exc
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("FFMPEG_UNAVAILABLE")
    data = input_bytes(req)
    suffix = ext_for(req.get("filename", ""), ".bin")
    with tempfile.TemporaryDirectory(prefix=f"calypso-{kind}-vosk-") as tmp:
        in_path = Path(tmp) / f"input{suffix}"
        wav_path = Path(tmp) / "audio.wav"
        in_path.write_bytes(data)
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-y",
                "-i",
                str(in_path),
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "wav",
                str(wav_path),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                "TRANSCRIBE_AUDIO_EXTRACT_FAILED: "
                + proc.stderr.decode("utf-8", "replace")[:300]
            )
        model = Model(model_path)
        with wave.open(str(wav_path), "rb") as wf:
            recognizer = KaldiRecognizer(model, wf.getframerate())
            parts = []
            while True:
                chunk = wf.readframes(4000)
                if not chunk:
                    break
                if recognizer.AcceptWaveform(chunk):
                    partial = json.loads(recognizer.Result()).get("text", "")
                    if partial:
                        parts.append(partial)
            final = json.loads(recognizer.FinalResult()).get("text", "")
            if final:
                parts.append(final)
    text = " ".join(part.strip() for part in parts if part.strip()).strip()
    ok(
        contentKind=kind,
        extractionStatus="ok" if text else "metadata_only",
        text=text,
        metadata={"language": "en", "engine": "vosk"},
    )

DOCX_REQUIRED = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# Zip-bomb / decompression-DoS guards. A small compressed .docx can declare
# huge uncompressed members; inflating them unguarded forces the sidecar into
# excessive RSS / MemoryError (DoS). We reject pathological packages by
# inspecting ZipInfo metadata (uncompressed file_size, compress_size, count)
# BEFORE reading any member. Caps are conservative — well above any legitimate
# editable document the gateway accepts (MAX_FILE_BYTES is 5 MiB).
DOCX_MAX_MEMBER_UNCOMPRESSED = 50 * 1024 * 1024   # 50 MiB per member
DOCX_MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024   # 100 MiB across all members
DOCX_MAX_MEMBER_COUNT = 512
DOCX_MAX_COMPRESSION_RATIO = 200                  # aggregate uncompressed / compressed


def _guard_docx_zipbomb(zin):
    infos = zin.infolist()
    if len(infos) > DOCX_MAX_MEMBER_COUNT:
        raise ValueError("DOCX_TOO_MANY_MEMBERS")
    total_uncompressed = 0
    total_compressed = 0
    for info in infos:
        if info.file_size > DOCX_MAX_MEMBER_UNCOMPRESSED:
            raise ValueError("DOCX_TOO_LARGE")
        total_uncompressed += info.file_size
        total_compressed += info.compress_size
        if total_uncompressed > DOCX_MAX_TOTAL_UNCOMPRESSED:
            raise ValueError("DOCX_TOO_LARGE")
    # Aggregate compression ratio: a tiny archive that inflates enormously is
    # the classic zip-bomb signature. Only flag once there is real volume so a
    # legitimately well-compressed small document is not rejected.
    if (
        total_compressed > 0
        and total_uncompressed > DOCX_MAX_MEMBER_UNCOMPRESSED
        and total_uncompressed > total_compressed * DOCX_MAX_COMPRESSION_RATIO
    ):
        raise ValueError("DOCX_SUSPICIOUS_COMPRESSION")


def docx_transform(req):
    filename = req.get("filename", "")
    if not filename.lower().endswith(".docx"):
        if filename.lower().endswith((".pages", ".numbers", ".key")):
            raise RuntimeError("IWORK_NATIVE_EDIT_UNSUPPORTED")
        raise RuntimeError("UNSUPPORTED_DOCUMENT_FORMAT")
    transform = req.get("transform") or {}
    data = input_bytes(req)
    in_buf = io.BytesIO(data)
    out_buf = io.BytesIO()
    with zipfile.ZipFile(in_buf, "r") as zin:
        names = set(zin.namelist())
        if not DOCX_REQUIRED.issubset(names):
            raise ValueError("DOCX_INVALID_PACKAGE")
        if "word/vbaProject.bin" in names or filename.lower().endswith(".docm"):
            raise ValueError("DOCX_UNSUPPORTED_MACRO_ENABLED")
        # Reject zip-bomb-shaped packages before inflating any member.
        _guard_docx_zipbomb(zin)
        document_xml = zin.read("word/document.xml").decode("utf-8", "replace")
        if transform.get("kind") == "replace_text":
            document_xml, count = replace_docx_text(
                document_xml,
                str(transform.get("search", "")),
                str(transform.get("replacement", "")),
                int(transform.get("maxReplacements", 1)),
            )
            meta = {"replacements": count}
        elif transform.get("kind") == "append_section":
            document_xml = append_docx_section(
                document_xml,
                str(transform.get("heading", "")),
                str(transform.get("body", "")),
            )
            meta = {"appended": True}
        else:
            raise ValueError("UNSUPPORTED_DOCX_TRANSFORM")
        with zipfile.ZipFile(out_buf, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                if info.filename == "word/document.xml":
                    zout.writestr(info.filename, document_xml.encode("utf-8"))
                else:
                    zout.writestr(info, zin.read(info.filename))
    out = out_buf.getvalue()
    ok(
        contentKind="document",
        extractionStatus="ok",
        outputB64=base64.b64encode(out).decode("ascii"),
        outputMimeType="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        outputExtension=".docx",
        outputSha256Hex=sha256_hex(out),
        metadata=meta,
    )


def replace_docx_text(document_xml, search, replacement, max_replacements):
    if not search:
        raise ValueError("INVALID_DOCX_SEARCH")
    root = ET.fromstring(document_xml)
    count = 0
    while count < max_replacements:
        text_nodes = [node for node in root.iter(f"{WORD_NS}t")]
        spans = []
        cursor = 0
        joined_parts = []
        for node in text_nodes:
            text = node.text or ""
            joined_parts.append(text)
            spans.append((node, cursor, cursor + len(text)))
            cursor += len(text)
        joined = "".join(joined_parts)
        start = joined.find(search)
        if start < 0:
            break
        end = start + len(search)
        start_span = next((span for span in spans if span[1] <= start < span[2]), None)
        # Empty text nodes cannot be the start of a non-empty search hit. If the
        # match ends at a node boundary, use the preceding non-empty node.
        end_span = next((span for span in spans if span[1] < end <= span[2]), None)
        if start_span is None or end_span is None:
            break
        start_node, start_node_start, _ = start_span
        end_node, end_node_start, _ = end_span
        start_index = text_nodes.index(start_node)
        end_index = text_nodes.index(end_node)
        before = (start_node.text or "")[: start - start_node_start]
        after = (end_node.text or "")[end - end_node_start :]
        start_node.text = before + replacement + after
        for node in text_nodes[start_index + 1 : end_index + 1]:
            node.text = ""
        count += 1
    return ET.tostring(root, encoding="unicode", xml_declaration=True), count


def docx_paragraph(text):
    return f"<w:p><w:r><w:t>{html.escape(text)}</w:t></w:r></w:p>"


def append_docx_section(document_xml, heading, body):
    insertion = docx_paragraph(heading) + docx_paragraph(body)
    marker = "</w:body>"
    if marker not in document_xml:
        raise ValueError("DOCX_BODY_NOT_FOUND")
    return document_xml.replace(marker, insertion + marker, 1)


def redaction_output_acceptable(before_count, after_count, redacted_count):
    """Decide whether a redact_text output still leaks the target text.

    Pure (no PDF engine) so it is unit-testable without PyMuPDF.
    ``before_count`` / ``after_count`` are occurrences of the search term in the
    *decoded* text of the input / output PDF; ``redacted_count`` is how many
    occurrences the transform intentionally redacted (capped at
    ``maxReplacements``). The output is acceptable iff it retains no MORE than
    the occurrences we deliberately left behind. A failed / no-op
    ``apply_redactions`` leaves ``after_count == before_count`` which exceeds the
    expected remainder and is rejected. ``search_for`` geometry can over-count
    relative to ``str.count`` text matches, so the ``max(0, ...)`` floor keeps a
    genuinely-clean redaction from false-positiving.
    """
    if before_count <= 0:
        return True
    expected_remaining = max(0, before_count - redacted_count)
    return after_count <= expected_remaining


def pdf_transform(req):
    try:
        import fitz
    except Exception as exc:
        raise RuntimeError(f"PDF_ENGINE_UNAVAILABLE: {exc}") from exc
    transform = req.get("transform") or {}
    data = input_bytes(req)
    doc = fitz.open(stream=data, filetype="pdf")
    op = transform.get("kind")
    if op == "annotate":
        if len(doc) == 0:
            raise ValueError("PDF_PAGE_OUT_OF_RANGE")
        # The schema declares `page` 0-indexed (and now .describe()s it so), but
        # an LLM still routinely passes a 1-indexed "page 1". Clamp into range
        # rather than hard-failing the whole task — annotating a valid page is
        # strictly better UX than PDF_PAGE_OUT_OF_RANGE on a 1-page document.
        page_index = max(0, min(int(transform.get("page", 0)), len(doc) - 1))
        page = doc[page_index]
        page.add_text_annot(
            fitz.Point(float(transform.get("x", 72)), float(transform.get("y", 72))),
            str(transform.get("text", "")),
        )
    elif op == "redact_text":
        search = str(transform.get("search", ""))
        max_replacements = int(transform.get("maxReplacements", 1))
        count = 0
        for page in doc:
            page_redactions = 0
            for rect in page.search_for(search):
                if count >= max_replacements:
                    break
                page.add_redact_annot(rect, text="")
                count += 1
                page_redactions += 1
            # Apply only when THIS page gained annotations. The previous
            # `if count:` was cumulative, so once any earlier page had a
            # redaction every later page called apply_redactions() with no new
            # annotations on it.
            if page_redactions:
                page.apply_redactions()
            if count >= max_replacements:
                break
    elif op == "extract_pages":
        pages = list(transform.get("pages") or [])
        new_doc = fitz.open()
        for page_index in pages:
            idx = int(page_index)
            if idx < 0 or idx >= len(doc):
                raise ValueError("PDF_PAGE_OUT_OF_RANGE")
            new_doc.insert_pdf(doc, from_page=idx, to_page=idx)
        doc = new_doc
    elif op == "compress":
        pass
    else:
        raise ValueError("UNSUPPORTED_PDF_TRANSFORM")
    out = doc.tobytes(garbage=4, deflate=True, clean=True)
    if op == "redact_text":
        # Verify the redaction by re-extracting DECODED text from input + output
        # and comparing occurrence counts — NOT by scanning the raw serialized
        # bytes. With deflate=True the text lives in compressed streams, so a
        # raw-byte scan is blind to surviving text (false assurance) and would
        # false-positive when the term appears in uncompressed metadata/xref.
        search = str(transform.get("search", ""))
        if search:

            def _decoded_text(pdf_bytes):
                with fitz.open(stream=pdf_bytes, filetype="pdf") as verify_doc:
                    return "".join(page.get_text() for page in verify_doc)

            before_count = _decoded_text(data).count(search)
            after_count = _decoded_text(out).count(search)
            if not redaction_output_acceptable(before_count, after_count, count):
                raise RuntimeError("PDF_REDACTION_TEXT_REMAINS")
    ok(
        contentKind="pdf",
        extractionStatus="ok",
        outputB64=base64.b64encode(out).decode("ascii"),
        outputMimeType="application/pdf",
        outputExtension=".pdf",
        outputSha256Hex=sha256_hex(out),
        metadata={"transform": op},
    )


def handle(req):
    # Each branch dispatches to a side-effect-only handler that emits its
    # result via ok()/fail() and returns None, so the calls are statements
    # rather than return expressions.
    op = req.get("operation")
    if op == "image.inspect":
        image_inspect(req)
    elif op == "image.ocr":
        image_ocr(req)
    elif op == "image.transform":
        image_transform(req)
    elif op == "audio.inspect":
        media_inspect(req, "audio")
    elif op == "video.inspect":
        media_inspect(req, "video")
    elif op == "audio.transform":
        ffmpeg_transform(req, "audio")
    elif op == "video.transform":
        ffmpeg_transform(req, "video")
    elif op == "audio.transcribe":
        whisper_transcribe(req, "audio")
    elif op == "video.transcribe":
        whisper_transcribe(req, "video")
    elif op == "document.docx_transform":
        docx_transform(req)
    elif op == "document.pdf_transform":
        pdf_transform(req)
    else:
        raise ValueError("UNSUPPORTED_OPERATION")


def main():
    print("MEDIA_TOOLS_READY", flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            handle(json.loads(line))
        except Exception as exc:
            fail("MEDIA_TOOL_ERROR", str(exc))


if __name__ == "__main__":
    main()
