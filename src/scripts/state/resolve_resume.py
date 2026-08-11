#!/usr/bin/env python3
"""resolve_resume.py — dynamic resume/cover-letter file resolution.

resume-tailor.md, job-scraper.md's Phase 3 attach step, and cover-letter-
tailor.md all used to assume a literal filename exists —
`base_resume_<category>.{md,pdf}` or `data/resumes/base_cover_letter.md`
— constructed directly rather than discovered. That breaks silently the
moment a file is renamed: nothing re-scans data/resumes/, so the
tailoring/attach step just tries to read a path that no longer exists.

This helper is the single place that turns "I want the swe-category
resume" into an actual, currently-existing file path, by actually
scanning data/resumes/ every time rather than assuming a name. Category
labels and their keyword synonyms are kept in sync with resume-tailor.md
"Step 1 — Select base resume" by hand (there's no single shared source
the Python and prompt sides can both read at runtime) — CATEGORIES below
is the canonical list; update both together.

Resolution order for a requested category:
  1. exact conventional stem (base_resume_<category>, or
     base_cover_letter for category "cover_letter") — zero behavior
     change for anyone who hasn't renamed anything.
  2. fuzzy filename match — any stem in data/resumes/ containing one of
     the category's keyword synonyms, case-insensitive.
  3. fuzzy description match — same keywords, checked against
     .resume_meta.json's per-stem "description" field (the label the
     TUI's Resumes screen lets you set for a non-standard name).
  4. falls back to resolving "balanced" instead (steps 1-3 again) when
     the requested category isn't "balanced" itself — matches resume-
     tailor.md's own documented default ("use balanced ... when nothing
     above clearly fits").
  5. falls back to whichever resume stem exists at all, picked
     deterministically (alphabetically first) — some resume beats none.
  6. "none" when data/resumes/ has no resume file whatsoever — the
     caller's job to treat that as needs_review, not silently skip.

Every step after (1) is reported in the output's "confidence" field, so
a caller (or a human debugging a needs_review reason) can tell "used
exactly what was asked for" from "guessed."

Output contract (single JSON object on stdout):
  {"category": "swe", "stem": "base_resume_swe", "md_path": "...",
   "pdf_path": "...", "confidence": "exact"}
  md_path/pdf_path are null when that extension doesn't exist for the
  resolved stem. confidence is one of: exact, fuzzy_filename,
  fuzzy_description, fallback_balanced, fallback_any, none.

Exit codes:
  0  resolved (including a "none" result — the caller decides what
     "none" means, this helper never treats it as an error)
  1  usage/config error (bad --category, unreadable data/resumes/)

Usage:
  python3 src/scripts/state/resolve_resume.py --category swe
  python3 src/scripts/state/resolve_resume.py --category cover_letter
  python3 src/scripts/state/resolve_resume.py --list
"""

from __future__ import annotations

import argparse
import json
import os
import sys

DEFAULT_RESUMES_DIR = "data/resumes"

# Canonical category list — keep in sync with resume-tailor.md "Step 1"
# by hand. Keywords are substrings checked case-insensitively against a
# stem (with separators stripped) or a .resume_meta.json description;
# order within a category's tuple doesn't matter.
CATEGORIES = {
    "cyber": ("cyber", "security", "soc", "pentest", "appsec"),
    "networking_cyber": ("networking", "network", "noc", "infrastructure"),
    "ai_ml": ("ai_ml", "aiml", "ai", "ml", "machinelearning", "llm", "nlp"),
    "swe": ("swe", "software", "backend", "fullstack", "frontend", "developer"),
    "balanced": ("balanced", "general", "default", "main"),
    "cover_letter": ("cover_letter", "coverletter", "cover"),
}


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


def _match_by_keyword(stems: dict, keywords: tuple, descriptions: dict) -> tuple:
    """Returns (stem, "fuzzy_filename"|"fuzzy_description") or (None, None).
    Filename matches are tried before description matches; within each,
    the alphabetically-first stem wins, for a deterministic result."""
    for stem in sorted(stems):
        norm_stem = _norm(stem)
        if any(_norm(kw) in norm_stem for kw in keywords):
            return stem, "fuzzy_filename"
    for stem in sorted(stems):
        desc = descriptions.get(stem, "")
        if desc and any(kw.lower() in desc.lower() for kw in keywords):
            return stem, "fuzzy_description"
    return None, None


def resolve(category: str, resumes_dir: str) -> dict:
    stems = list_stems(resumes_dir)
    descriptions = load_descriptions(resumes_dir)

    def result(stem: str, confidence: str) -> dict:
        files = stems.get(stem, {"md": False, "pdf": False})
        return {
            "category": category,
            "stem": stem,
            "md_path": os.path.join(resumes_dir, stem + ".md") if files["md"] else None,
            "pdf_path": os.path.join(resumes_dir, stem + ".pdf") if files["pdf"] else None,
            "confidence": confidence,
        }

    conventional_stem = "base_cover_letter" if category == "cover_letter" else f"base_resume_{category}"
    if conventional_stem in stems:
        return result(conventional_stem, "exact")

    keywords = CATEGORIES[category]
    stem, how = _match_by_keyword(stems, keywords, descriptions)
    if stem is not None:
        return result(stem, how)

    if category != "balanced" and category != "cover_letter":
        balanced_conventional = "base_resume_balanced"
        if balanced_conventional in stems:
            return result(balanced_conventional, "fallback_balanced")
        stem, how = _match_by_keyword(stems, CATEGORIES["balanced"], descriptions)
        if stem is not None:
            return {**result(stem, "fallback_balanced")}

    if stems:
        return result(sorted(stems)[0], "fallback_any")

    return {
        "category": category,
        "stem": None,
        "md_path": None,
        "pdf_path": None,
        "confidence": "none",
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="resolve_resume.py",
        description="Dynamically resolve a resume/cover-letter category to an actual file in data/resumes/.",
    )
    parser.add_argument("--resumes-dir", default=DEFAULT_RESUMES_DIR)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--category", choices=sorted(CATEGORIES), help="which category to resolve")
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

    print(json.dumps(resolve(args.category, args.resumes_dir), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
