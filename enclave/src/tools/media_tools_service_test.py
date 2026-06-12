#!/usr/bin/env python3
"""
Regression tests for the media/document sidecar's DOCX zip-bomb guard.

No project-wide pytest harness exists for the enclave Python sidecar
(`enclave/src/tools/media_tools_service.py`). These tests use the stdlib
`unittest` runner so they execute with no extra dependencies:

    python3 -m unittest enclave.src.tools.media_tools_service_test
    # or, from this directory:
    python3 -m unittest media_tools_service_test

Security regression: a small compressed .docx with a huge uncompressed
member (or too many members) must be rejected BEFORE inflation, so the
sidecar cannot be forced to inflate it into excessive RSS / MemoryError.
Valid normal .docx files must still transform.
"""

import importlib.util
import io
import json
import os
import unittest
import zipfile
from contextlib import redirect_stdout


_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE_PATH = os.path.join(_HERE, "media_tools_service.py")
_spec = importlib.util.spec_from_file_location("media_tools_service", _SERVICE_PATH)
mts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mts)


MINIMAL_DOCUMENT_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    "<w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body>"
    "</w:document>"
)
CONTENT_TYPES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    "</Relationships>"
)


def build_docx(extra_members=None, document_xml=MINIMAL_DOCUMENT_XML):
    """Build a valid in-memory .docx with the required OOXML members."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES_XML)
        zf.writestr("_rels/.rels", RELS_XML)
        zf.writestr("word/document.xml", document_xml)
        for name, data in (extra_members or {}).items():
            zf.writestr(name, data)
    return buf.getvalue()


def run_transform(docx_bytes, transform):
    """Invoke docx_transform; capture the emitted JSON payload from stdout."""
    req = {
        "filename": "report.docx",
        "inputB64": __import__("base64").b64encode(docx_bytes).decode("ascii"),
        "transform": transform,
    }
    out = io.StringIO()
    with redirect_stdout(out):
        mts.docx_transform(req)
    return json.loads(out.getvalue().strip())


class DocxZipBombGuardTest(unittest.TestCase):
    def test_huge_uncompressed_member_is_rejected(self):
        # A highly compressible 128 MiB member: small on disk, huge inflated.
        bomb = b"\0" * (128 * 1024 * 1024)
        docx = build_docx(extra_members={"word/media/bomb.bin": bomb})
        # Sanity: the compressed package must stay small (true zip-bomb shape).
        self.assertLess(len(docx), 5 * 1024 * 1024)
        with self.assertRaises(ValueError) as ctx:
            run_transform(docx, {"kind": "append_section", "heading": "H", "body": "B"})
        self.assertIn(
            str(ctx.exception).split(":")[0],
            {"DOCX_TOO_LARGE", "DOCX_SUSPICIOUS_COMPRESSION"},
        )

    def test_huge_document_xml_is_rejected_before_decode(self):
        big_xml = (
            '<?xml version="1.0"?><w:document '
            'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body>" + ("<w:p><w:r><w:t>x</w:t></w:r></w:p>" * 1) + "<!--"
            + ("A" * (80 * 1024 * 1024)) + "--></w:body></w:document>"
        )
        docx = build_docx(document_xml=big_xml)
        self.assertLess(len(docx), 5 * 1024 * 1024)
        with self.assertRaises(ValueError) as ctx:
            run_transform(docx, {"kind": "append_section", "heading": "H", "body": "B"})
        self.assertIn(
            str(ctx.exception).split(":")[0],
            {"DOCX_TOO_LARGE", "DOCX_SUSPICIOUS_COMPRESSION"},
        )

    def test_too_many_members_is_rejected(self):
        extra = {f"word/media/m{i}.bin": b"x" for i in range(1024)}
        docx = build_docx(extra_members=extra)
        with self.assertRaises(ValueError) as ctx:
            run_transform(docx, {"kind": "append_section", "heading": "H", "body": "B"})
        self.assertEqual(str(ctx.exception).split(":")[0], "DOCX_TOO_MANY_MEMBERS")

    def test_normal_docx_still_transforms_append(self):
        docx = build_docx()
        result = run_transform(docx, {"kind": "append_section", "heading": "Title", "body": "Body"})
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["contentKind"], "document")
        self.assertTrue(result["metadata"]["appended"])

    def test_normal_docx_still_transforms_replace(self):
        docx = build_docx()
        result = run_transform(
            docx,
            {"kind": "replace_text", "search": "Hello world", "replacement": "Goodbye", "maxReplacements": 1},
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["metadata"]["replacements"], 1)


class RedactionVerificationPolicyTest(unittest.TestCase):
    """GitHub AI finding: the redact_text post-check previously scanned the raw
    *compressed* output bytes for the search string. With `deflate=True` the
    redacted (and any surviving) text is compressed away, so the check almost
    never fired (false assurance of a failed redaction) and could false-positive
    when the term survived in uncompressed metadata/xref. The replacement
    extracts decoded text and applies a pure, PDF-engine-free policy:
    `redaction_output_acceptable(before, after, redacted)`. These tests pin that
    policy's truth table without needing PyMuPDF."""

    def test_nothing_to_redact_is_acceptable(self):
        self.assertTrue(mts.redaction_output_acceptable(0, 0, 0))

    def test_full_removal_is_acceptable(self):
        self.assertTrue(mts.redaction_output_acceptable(1, 0, 1))

    def test_partial_by_max_replacements_is_acceptable(self):
        # Term appears twice, maxReplacements=1 → one left behind on purpose.
        self.assertTrue(mts.redaction_output_acceptable(2, 1, 1))

    def test_noop_redaction_is_rejected(self):
        # Claimed to redact 1, but the occurrence still survives in output text.
        # This is the silent-failure mode the raw-byte scan could not catch.
        self.assertFalse(mts.redaction_output_acceptable(1, 1, 1))

    def test_underredaction_is_rejected(self):
        # Two occurrences, one redacted, but BOTH still present in output.
        self.assertFalse(mts.redaction_output_acceptable(2, 2, 1))

    def test_geometry_overcount_does_not_false_positive(self):
        # search_for (geometry) can find more rects than text.count sees; the
        # max(0, ...) floor must absorb that so a clean redaction is accepted.
        self.assertTrue(mts.redaction_output_acceptable(1, 0, 2))


def _one_page_pdf():
    import fitz

    doc = fitz.open()
    doc.new_page()  # exactly one page (index 0)
    data = doc.tobytes()
    doc.close()
    return data


def _run_pdf(pdf_bytes, transform):
    import base64 as _b64

    req = {
        "filename": "brief.pdf",
        "inputB64": _b64.b64encode(pdf_bytes).decode("ascii"),
        "transform": transform,
    }
    out = io.StringIO()
    with redirect_stdout(out):
        mts.pdf_transform(req)
    return json.loads(out.getvalue().strip())


class PdfAnnotatePageIndexTests(unittest.TestCase):
    """Defect D4: the model routinely passes a 1-indexed 'page 1' even though the
    `page` field is 0-indexed. On a 1-page PDF that previously raised
    PDF_PAGE_OUT_OF_RANGE and failed the whole task; it must now clamp into range
    and annotate a valid page instead."""

    def test_one_indexed_page_on_single_page_pdf_clamps_and_succeeds(self):
        pdf = _one_page_pdf()
        result = _run_pdf(
            pdf,
            {"kind": "annotate", "page": 1, "text": "Reviewed by Calypso", "x": 72, "y": 72},
        )
        self.assertEqual(result.get("extractionStatus"), "ok")
        self.assertTrue(result.get("outputB64"))
        self.assertEqual(result.get("outputMimeType"), "application/pdf")

    def test_zero_indexed_first_page_still_works(self):
        pdf = _one_page_pdf()
        result = _run_pdf(
            pdf,
            {"kind": "annotate", "page": 0, "text": "Reviewed by Calypso", "x": 72, "y": 72},
        )
        self.assertEqual(result.get("extractionStatus"), "ok")
        self.assertTrue(result.get("outputB64"))

    def test_wildly_out_of_range_page_clamps_to_last_page(self):
        # A nonsense large page also clamps rather than failing the task.
        pdf = _one_page_pdf()
        result = _run_pdf(
            pdf,
            {"kind": "annotate", "page": 99, "text": "Reviewed by Calypso", "x": 72, "y": 72},
        )
        self.assertEqual(result.get("extractionStatus"), "ok")


if __name__ == "__main__":
    unittest.main()
