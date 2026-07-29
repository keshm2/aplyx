#!/usr/bin/env python3
"""convert_resume.py — extract a resume/cover-letter PDF's text into markdown.

resume-tailor.md picks a base resume from data/resumes/ by filename
(e.g. base_resume_swe.md) — it reads markdown, not PDFs. This helper
converts a PDF already sitting in that folder into the matching .md so
the tailoring agent can use it. Text extraction only (pypdf); it does
not attempt OCR, so a scanned/image-only PDF with no text layer fails
with a clear error rather than producing an empty file.

Usage:
  python3 src/scripts/state/convert_resume.py <stem>
  python3 src/scripts/state/convert_resume.py <stem> --force
  python3 src/scripts/state/convert_resume.py <stem> --resumes-dir data/resumes

  <stem> is the filename without extension, e.g. "base_resume_swe" for
  data/resumes/base_resume_swe.pdf -> data/resumes/base_resume_swe.md.

Exit codes:
  0  converted (JSON: {"ok": true, "stem", "pdf_path", "md_path", "chars"})
  1  usage / missing file / extraction / dependency error
     (JSON: {"ok": false, "error"})
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

DEFAULT_RESUMES_DIR = os.path.join("data", "resumes")


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def error(message: str, **extra: object) -> "int":
    payload = {"ok": False, "error": message}
    payload.update(extra)
    emit(payload)
    return 1


def extract_pdf_text(pdf_path: str) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError(
            "pypdf is not installed — run: pip3 install pypdf "
            "(or pip3 install -r requirements.txt)"
        ) from exc

    try:
        reader = PdfReader(pdf_path)
    except Exception as exc:  # pypdf raises several distinct error types
        raise RuntimeError(f"could not open PDF: {exc}") from exc

    if reader.is_encrypted:
        raise RuntimeError("PDF is password-protected — remove the password and retry")

    pages = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception as exc:
            raise RuntimeError(f"could not extract text from page: {exc}") from exc

    text = "\n\n".join(p.strip() for p in pages if p.strip())
    return text


def clean_markdown(raw_text: str, title: str, description: str = "") -> str:
    # Collapse 3+ blank lines to 1, strip trailing whitespace per line.
    lines = [line.rstrip() for line in raw_text.splitlines()]
    collapsed: list = []
    blank_run = 0
    for line in lines:
        if line == "":
            blank_run += 1
            if blank_run > 1:
                continue
        else:
            blank_run = 0
        collapsed.append(line)
    body = "\n".join(collapsed).strip()
    header = (
        f"<!-- Auto-converted from {title}.pdf by convert_resume.py — "
        "text extraction only, formatting is not preserved. Review and "
        "clean up for best tailoring results. -->\n"
    )
    if description:
        header += f"<!-- Description: {description} -->\n"
    header += "\n"
    return header + body + "\n"


def load_meta(meta_path: str) -> dict:
    if not os.path.exists(meta_path):
        return {}
    try:
        with open(meta_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def write_meta_entry(resumes_dir: str, stem: str, description: str) -> None:
    """Read-modify-write data/resumes/.resume_meta.json for one stem, atomically."""
    meta_path = os.path.join(resumes_dir, ".resume_meta.json")
    meta = load_meta(meta_path)
    meta[stem] = {
        "description": description,
        "converted_at": datetime.now(timezone.utc).isoformat(),
    }
    tmp_path = f"{meta_path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp_path, meta_path)


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(
        prog="convert_resume.py",
        description="Convert a resume/cover-letter PDF in data/resumes/ to markdown.",
    )
    parser.add_argument("stem", help="filename without extension, e.g. base_resume_swe")
    parser.add_argument(
        "--resumes-dir", default=DEFAULT_RESUMES_DIR, help="directory holding the PDF/markdown pair"
    )
    parser.add_argument(
        "--force", action="store_true", help="overwrite an existing .md file"
    )
    parser.add_argument(
        "--description", default="", help="short human label for this resume, e.g. \"SWE internships\""
    )
    args = parser.parse_args(argv)

    stem = args.stem.strip()
    description = args.description.strip()
    if not stem or not re.fullmatch(r"[A-Za-z0-9_-]+", stem):
        return error(f"invalid stem {stem!r} — expected a plain filename with no path separators")

    pdf_path = os.path.join(args.resumes_dir, f"{stem}.pdf")
    md_path = os.path.join(args.resumes_dir, f"{stem}.md")

    if not os.path.isfile(pdf_path):
        return error(f"PDF not found: {pdf_path}")
    if os.path.exists(md_path) and not args.force:
        return error(f"{md_path} already exists — pass --force to overwrite")

    try:
        raw_text = extract_pdf_text(pdf_path)
    except RuntimeError as exc:
        return error(str(exc), pdf_path=pdf_path)

    if not raw_text.strip():
        return error(
            "no extractable text found — the PDF may be a scanned image with no "
            "text layer; OCR is not supported, create the .md by hand instead",
            pdf_path=pdf_path,
        )

    markdown = clean_markdown(raw_text, stem, description)
    tmp_path = f"{md_path}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            fh.write(markdown)
        os.replace(tmp_path, md_path)
    except OSError as exc:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return error(f"could not write {md_path}: {exc}")

    if description:
        try:
            write_meta_entry(args.resumes_dir, stem, description)
        except OSError as exc:
            return error(f"could not write resume metadata: {exc}")

    emit(
        {
            "ok": True,
            "stem": stem,
            "pdf_path": pdf_path,
            "md_path": md_path,
            "chars": len(markdown),
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
