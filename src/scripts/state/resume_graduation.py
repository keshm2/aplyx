#!/usr/bin/env python3
"""resume_graduation.py: derive the candidate's graduation date from their
master resume (data/resumes/resume.json), so the resume PDF is the single
source of truth for eligibility instead of a value hand-typed once during
onboarding and then forgotten.

The fit gate (src/scripts/jobs/evaluate_job_fit.py) already uses
graduation_date to reject class-year-mismatched postings and to decide
internship eligibility; it just read that date from
targets.json safe_fields.graduation_date. This helper lets "upload a new
resume that says December 2027" shift which seasons pass the gate with no
config edit.

Read-only. Never writes targets.json (the TS settings helpers own that
write); it only reports what it parsed and how confident it is.

Confidence:
  high  - a clear month+year, or a clear year with graduation context, on
          the education entry that graduates last. Safe to act on.
  low   - a year was found but the phrasing is ambiguous (a bare range, an
          open-ended "Present"). Surface it, don't act on it silently.
  none  - nothing parseable. Fall back to whatever the config already has.

Usage:
  python3 src/scripts/state/resume_graduation.py
  python3 src/scripts/state/resume_graduation.py --resume path/to/resume.json

Output (stdout, one JSON object):
  {"ok": true, "graduation_date": "December 2027", "confidence": "high",
   "note": "...", "source": "MSc, University of Washington"}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

_MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9, "october": 10,
    "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}
_MONTH_NAMES = {
    1: "January", 2: "February", 3: "March", 4: "April", 5: "May", 6: "June",
    7: "July", 8: "August", 9: "September", 10: "October", 11: "November", 12: "December",
}

_YEAR_RE = re.compile(r"\b(20\d{2})\b")
_GRAD_CONTEXT_RE = re.compile(
    r"\b(graduat\w*|expected|anticipated|class\s+of|completion|conferred|degree\s+expected)\b",
    re.I,
)
_OPEN_ENDED_RE = re.compile(r"\b(present|current|now|ongoing|expected)\b", re.I)
_RANGE_SPLIT_RE = re.compile(r"\s*(?:-{1,2}|–|—|\bto\b|\bthrough\b|\buntil\b|/)\s*", re.I)


def _parse_end_fragment(fragment: str) -> tuple[int, int | None] | None:
    """('Jun 2027') -> (2027, 6); ('2027') -> (2027, None); junk -> None."""
    year_m = _YEAR_RE.search(fragment)
    if not year_m:
        return None
    year = int(year_m.group(1))
    month: int | None = None
    for name, num in _MONTHS.items():
        if re.search(rf"\b{name}\b", fragment, re.I):
            month = num
            break
    return (year, month)


def _candidate_from_text(text: str) -> tuple[tuple[int, int | None], str, bool] | None:
    """Pull a graduation (year, month) out of one date/detail string.

    Returns ((year, month), matched_fragment, has_context) or None. For a
    "Start - End" range only the End side is considered; a bare "Present"
    end yields None (no fixed graduation to read)."""
    if not text or not text.strip():
        return None
    parts = _RANGE_SPLIT_RE.split(text.strip())
    end = parts[-1].strip()
    # An open-ended end ("Sep 2023 - Present") tells us nothing about when
    # the degree finishes, UNLESS the text also literally spells a future
    # year with graduation context ("Expected 2028").
    if _OPEN_ENDED_RE.search(end) and not _YEAR_RE.search(end):
        ctx_year = _YEAR_RE.search(text)
        if ctx_year and _GRAD_CONTEXT_RE.search(text):
            return ((int(ctx_year.group(1)), None), text.strip(), True)
        return None
    parsed = _parse_end_fragment(end)
    if parsed is None:
        # try the whole string, for "Class of 2027" / "Expected May 2028"
        parsed = _parse_end_fragment(text)
        if parsed is None:
            return None
        end = text
    has_context = bool(_GRAD_CONTEXT_RE.search(text))
    return (parsed, end.strip(), has_context)


def derive_graduation_date(education: list) -> dict:
    """education is resume.json's `education` list ({school, degree, dates,
    details:[...]}). Returns {graduation_date, confidence, note, source}."""
    if not isinstance(education, list) or not education:
        return {"graduation_date": "", "confidence": "none",
                "note": "resume has no education section", "source": ""}

    best: tuple | None = None  # ((year, month), has_context, entry_label, single_entry)
    single = len(education) == 1
    for entry in education:
        if not isinstance(entry, dict):
            continue
        label = ", ".join(x for x in (entry.get("degree", ""), entry.get("school", "")) if x).strip(", ")
        texts = [str(entry.get("dates", ""))]
        details = entry.get("details")
        if isinstance(details, list):
            texts.extend(str(d) for d in details)
        for text in texts:
            cand = _candidate_from_text(text)
            if cand is None:
                continue
            (year, month), _frag, has_ctx = cand
            key = (year, month if month is not None else 12)
            if best is None or key > best[0]:
                best = (key, (year, month), has_ctx, label)

    if best is None:
        return {"graduation_date": "", "confidence": "none",
                "note": "no parseable graduation date on any education entry", "source": ""}

    _key, (year, month), has_ctx, label = best
    if month is not None:
        value = f"{_MONTH_NAMES[month]} {year}"
    else:
        value = str(year)

    # high: a real month, or a year we can trust because the entry says
    # "graduating"/"expected"/"class of", or it's the only degree listed.
    if month is not None or has_ctx or single:
        confidence = "high"
        note = f"read from resume education entry ({label or 'unlabeled'})"
    else:
        confidence = "low"
        note = (f"found year {year} on '{label or 'an education entry'}' but no month "
                "and no 'graduating/expected' wording; not acting on it automatically")
    return {"graduation_date": value, "confidence": confidence, "note": note, "source": label}


def _default_resume_path() -> str:
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    return os.path.join(root, "data", "resumes", "resume.json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="resume_graduation.py", description=__doc__)
    parser.add_argument("--resume", default=None, help="path to resume.json (default: data/resumes/resume.json)")
    args = parser.parse_args(argv)

    path = args.resume or _default_resume_path()
    if not os.path.exists(path):
        print(json.dumps({"ok": True, "graduation_date": "", "confidence": "none",
                          "note": f"no resume at {path}", "source": ""}))
        return 0
    try:
        with open(path, "r", encoding="utf-8") as fh:
            resume = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": f"could not read {path}: {exc}"}))
        return 1

    result = derive_graduation_date(resume.get("education", []) if isinstance(resume, dict) else [])
    result["ok"] = True
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
