#!/usr/bin/env python3
"""resolve_resume.py: dynamic cover-letter reference file resolution.

Originally resolved both resume categories and the cover-letter reference
file; the resume side retired once tailoring moved to a single generic
resume (data/resumes/resume.json, read directly by resume-tailor.md; see
src/core/src/masterResume.ts for the schema). This helper's only remaining
job is the cover-letter reference file, which still has the exact same
"don't assume a literal filename" problem the resume side used to: the
operator can rename data/resumes/base_cover_letter.md at any time, and
nothing else re-scans data/resumes/ to find it.

Resolution order:
  1. exact conventional stem (base_cover_letter): zero behavior change
     for anyone who hasn't renamed anything.
  2. fuzzy filename match: any stem in data/resumes/ containing one of
     the keyword synonyms below, case-insensitive.
  3. fuzzy description match: same keywords, checked against
     .resume_meta.json's per-stem "description" field (the label the
     Resumes screen lets you set for a non-standard name).
  4. "none" when nothing matches: the caller's job to decide what that
     means (cover-letter-tailor.md treats a missing reference as
     optional, not a hard blocker, unlike a missing resume used to be).

Output contract (single JSON object on stdout):
  {"stem": "base_cover_letter", "md_path": "...", "pdf_path": "...",
   "confidence": "exact"}
  md_path/pdf_path are null when that extension doesn't exist for the
  resolved stem. confidence is one of: exact, fuzzy_filename,
  fuzzy_description, none.

Exit codes:
  0  resolved (including a "none" result: the caller decides what
     "none" means, this helper never treats it as an error)
  1  usage/config error (unreadable data/resumes/)

Usage:
  python3 src/scripts/state/resolve_resume.py --cover-letter
  python3 src/scripts/state/resolve_resume.py --list
"""

from __future__ import annotations

import argparse
import json
import os
import sys

DEFAULT_RESUMES_DIR = "data/resumes"
CONVENTIONAL_STEM = "base_cover_letter"
KEYWORDS = ("cover_letter", "coverletter", "cover")


def die(msg: str, code: int = 1) -> None:
    print(f"resolve_resume: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def _norm(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isalnum())


def list_stems(resumes_dir: str) -> dict:
    """stem -> {"md": bool, "pdf": bool}, for every .md/.pdf file present."""
    stems: dict = {}
    try:
        entries = os.listdir(resumes_dir)
    except OSError:
        entries = []
    for name in entries:
        stem, ext = os.path.splitext(name)
        ext = ext.lower()
        if ext not in (".md", ".pdf"):
            continue
        cur = stems.setdefault(stem, {"md": False, "pdf": False})
        cur["md" if ext == ".md" else "pdf"] = True
    return stems


def load_descriptions(resumes_dir: str) -> dict:
    try:
        with open(os.path.join(resumes_dir, ".resume_meta.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: str(v.get("description", "")) for k, v in data.items() if isinstance(v, dict)}


def _match_by_keyword(stems: dict, descriptions: dict) -> tuple:
    """Returns (stem, "fuzzy_filename"|"fuzzy_description") or (None, None).
    Filename matches are tried before description matches; within each,
    the alphabetically-first stem wins, for a deterministic result."""
    for stem in sorted(stems):
        norm_stem = _norm(stem)
        if any(_norm(kw) in norm_stem for kw in KEYWORDS):
            return stem, "fuzzy_filename"
    for stem in sorted(stems):
        desc = descriptions.get(stem, "")
        if desc and any(kw.lower() in desc.lower() for kw in KEYWORDS):
            return stem, "fuzzy_description"
    return None, None


def resolve(resumes_dir: str) -> dict:
    stems = list_stems(resumes_dir)
    descriptions = load_descriptions(resumes_dir)

    def result(stem: str, confidence: str) -> dict:
        files = stems.get(stem, {"md": False, "pdf": False})
        return {
            "stem": stem,
            "md_path": os.path.join(resumes_dir, stem + ".md") if files["md"] else None,
            "pdf_path": os.path.join(resumes_dir, stem + ".pdf") if files["pdf"] else None,
            "confidence": confidence,
        }

    if CONVENTIONAL_STEM in stems:
        return result(CONVENTIONAL_STEM, "exact")

    stem, how = _match_by_keyword(stems, descriptions)
    if stem is not None:
        return result(stem, how)

    return {"stem": None, "md_path": None, "pdf_path": None, "confidence": "none"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="resolve_resume.py",
        description="Dynamically resolve the cover-letter reference file in data/resumes/.",
    )
    parser.add_argument("--resumes-dir", default=DEFAULT_RESUMES_DIR)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--cover-letter", action="store_true", help="resolve the cover-letter reference file")
    group.add_argument("--list", action="store_true", help="list every discovered resume stem with its files")
    args = parser.parse_args(argv)

    if args.list:
        stems = list_stems(args.resumes_dir)
        descriptions = load_descriptions(args.resumes_dir)
        out = [
            {
                "stem": stem,
                "md_path": os.path.join(args.resumes_dir, stem + ".md") if files["md"] else None,
                "pdf_path": os.path.join(args.resumes_dir, stem + ".pdf") if files["pdf"] else None,
                "description": descriptions.get(stem) or None,
            }
            for stem, files in sorted(stems.items())
        ]
        print(json.dumps(out, ensure_ascii=False))
        return 0

    print(json.dumps(resolve(args.resumes_dir), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
