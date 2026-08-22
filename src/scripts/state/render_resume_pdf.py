#!/usr/bin/env python3
"""render_resume_pdf.py — deterministic, one-page-guaranteed resume PDF export.

Renders a MasterResume-shaped JSON (see src/core/src/masterResume.ts,
data/resumes/resume.json) into a clean, ATS-parseable PDF reproducing Jake's
Resume's well-known minimalist layout — implemented in HTML/CSS rather than
LaTeX, printed via a real headless Chrome (Playwright's `channel="chrome"`,
the same approach src/scripts/runtime/replay_fill.py already uses so no new
browser-binary provisioning is needed). This never touches resume.json —
purely a rendering artifact.

Guarantees exactly one page via a deterministic shrink ladder, most- to
least-preferred: (1) tighten section/entry spacing, (2) reduce font size
down to a 10pt floor, (3) trim the lowest-priority bullets one at a time
(never below 2 per entry; projects trimmed before experience, oldest
entries first), (4) as an absolute last resort, drop a whole low-priority
entry (never the last remaining experience entry). Fit is verified by
counting the ACTUAL rendered PDF's pages with pypdf (already a project
dependency) after each attempt — ground truth, not an estimate of print
layout from a screen-rendered height measurement.

Usage:
  python3 src/scripts/state/render_resume_pdf.py <output.pdf>
  (MasterResume JSON piped via stdin)

Exit codes:
  0  success (JSON: {"ok": true, "path", "pages", "notes": [...]})
  1  usage / input / pypdf error (JSON: {"ok": false, "error"})
  2  the "playwright" pip package is not installed
  3  could not launch Chrome (most commonly: real Chrome isn't installed)
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys
from typing import Any, Dict, List, Optional

# Font sizes (pt) tried in order — floor matches common resume-format-guide
# advice to never go below ~10pt body text on a printed/ATS-scanned resume.
FONT_STEPS = [11.0, 10.5, 10.0]
# Multiplier applied to section/entry vertical spacing and line-height —
# tried innermost (all spacing steps exhausted before the font shrinks),
# per the shrink ladder's stated priority (spacing before font).
SPACING_STEPS = [1.0, 0.85, 0.7]
BULLET_FLOOR = 2


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def error(message: str, code: int = 1, **extra: object) -> int:
    payload: Dict[str, Any] = {"ok": False, "error": message}
    payload.update(extra)
    emit(payload)
    return code


def esc(text: object) -> str:
    return html.escape(str(text or ""), quote=False)


def clone_resume(resume: dict) -> dict:
    return json.loads(json.dumps(resume))


# --- HTML/CSS template (Jake's Resume layout, in CSS rather than LaTeX) ---


def render_bullets(bullets: List[dict]) -> str:
    items = "".join(f"<li>{esc(b.get('text', ''))}</li>" for b in bullets if (b.get("text") or "").strip())
    return f"<ul class='bullets'>{items}</ul>" if items else ""


def render_experience(entries: List[dict]) -> str:
    parts = []
    for e in entries:
        parts.append(
            "<div class='entry'>"
            "<div class='entry-row'>"
            f"<span class='entry-title'>{esc(e.get('title'))}</span>"
            f"<span class='entry-dates'>{esc(e.get('dates'))}</span>"
            "</div>"
            "<div class='entry-row entry-row-sub'>"
            f"<span class='entry-sub'>{esc(e.get('company'))}</span>"
            f"<span class='entry-sub'>{esc(e.get('location'))}</span>"
            "</div>"
            f"{render_bullets(e.get('bullets', []))}"
            "</div>"
        )
    return "".join(parts)


def render_projects(entries: List[dict]) -> str:
    parts = []
    for p in entries:
        parts.append(
            "<div class='entry'>"
            "<div class='entry-row'>"
            f"<span class='entry-title'>{esc(p.get('name'))}</span>"
            f"<span class='entry-dates'>{esc(p.get('dates'))}</span>"
            "</div>"
            f"{render_bullets(p.get('bullets', []))}"
            "</div>"
        )
    return "".join(parts)


def render_education(entries: List[dict]) -> str:
    parts = []
    for e in entries:
        details = "".join(f"<div class='edu-detail'>{esc(d)}</div>" for d in (e.get("details") or []) if str(d).strip())
        parts.append(
            "<div class='entry'>"
            "<div class='entry-row'>"
            f"<span class='entry-title'>{esc(e.get('school'))}</span>"
            f"<span class='entry-dates'>{esc(e.get('location'))}</span>"
            "</div>"
            "<div class='entry-row entry-row-sub'>"
            f"<span class='entry-sub'>{esc(e.get('degree'))}</span>"
            f"<span class='entry-sub'>{esc(e.get('dates'))}</span>"
            "</div>"
            f"{details}"
            "</div>"
        )
    return "".join(parts)


def render_skills(groups: List[dict]) -> str:
    rows = "".join(
        f"<div class='skill-row'><span class='skill-cat'>{esc(g.get('category'))}:</span> "
        f"<span class='skill-items'>{esc(', '.join(g.get('items') or []))}</span></div>"
        for g in groups
        if (g.get("category") or "").strip() or (g.get("items") or [])
    )
    return rows


def render_certifications(items: List[str]) -> str:
    lis = "".join(f"<li>{esc(c)}</li>" for c in items if str(c).strip())
    return f"<ul class='bullets'>{lis}</ul>" if lis else ""


def build_html(resume: dict, font_pt: float, spacing_scale: float) -> str:
    contact = resume.get("contact") or {}
    contact_parts = [
        v for v in (contact.get("phone"), contact.get("email"), contact.get("linkedin_url"), contact.get("github_url"))
        if (v or "").strip()
    ]
    contact_line = "&nbsp;&nbsp;|&nbsp;&nbsp;".join(esc(p) for p in contact_parts)

    sections = []
    if resume.get("education"):
        sections.append(f"<div class='section'><h2>Education</h2>{render_education(resume['education'])}</div>")
    if resume.get("experience"):
        sections.append(f"<div class='section'><h2>Experience</h2>{render_experience(resume['experience'])}</div>")
    if resume.get("projects"):
        sections.append(f"<div class='section'><h2>Projects</h2>{render_projects(resume['projects'])}</div>")
    if resume.get("skills"):
        sections.append(f"<div class='section'><h2>Technical Skills</h2>{render_skills(resume['skills'])}</div>")
    if resume.get("certifications"):
        sections.append(
            f"<div class='section'><h2>Certifications &amp; Awards</h2>{render_certifications(resume['certifications'])}</div>"
        )

    entry_gap = 0.5 * spacing_scale
    section_gap = 0.7 * spacing_scale
    line_height = 1.0 + 0.15 * spacing_scale

    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {{ size: Letter; margin: 0; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    padding: 0.55in 0.6in;
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-size: {font_pt}pt;
    line-height: {line_height};
    color: #111;
  }}
  .name {{
    text-align: center;
    font-size: {font_pt * 2.1}pt;
    font-weight: 700;
    letter-spacing: 0.02em;
  }}
  .contact {{
    text-align: center;
    font-size: {font_pt * 0.85}pt;
    margin-top: 0.08in;
    color: #333;
  }}
  .section {{
    margin-top: {section_gap}em;
  }}
  .section h2 {{
    font-size: {font_pt * 1.0}pt;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 0.75pt solid #111;
    padding-bottom: 0.05em;
    margin: 0 0 {0.25 * spacing_scale}em 0;
  }}
  .entry {{
    margin-bottom: {entry_gap}em;
  }}
  .entry-row {{
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5em;
  }}
  .entry-title {{
    font-weight: 700;
  }}
  .entry-dates {{
    font-style: italic;
    white-space: nowrap;
    flex-shrink: 0;
  }}
  .entry-row-sub {{
    font-style: italic;
    font-size: {font_pt * 0.95}pt;
  }}
  .edu-detail {{
    font-size: {font_pt * 0.9}pt;
    color: #333;
  }}
  .bullets {{
    margin: {0.15 * spacing_scale}em 0 0 0;
    padding-left: 1.1em;
  }}
  .bullets li {{
    margin-bottom: {0.1 * spacing_scale}em;
  }}
  .skill-row {{
    font-size: {font_pt * 0.95}pt;
    margin-bottom: {0.1 * spacing_scale}em;
  }}
  .skill-cat {{
    font-weight: 700;
  }}
</style>
</head>
<body>
  <div class="name">{esc(contact.get('name'))}</div>
  <div class="contact">{contact_line}</div>
  {''.join(sections)}
</body>
</html>"""


# --- Render + page-fit loop -------------------------------------------------


def count_pages(pdf_path: str) -> int:
    from pypdf import PdfReader

    return len(PdfReader(pdf_path).pages)


def render_and_count(page: Any, resume: dict, font_pt: float, spacing_scale: float, out_path: str) -> int:
    page.set_content(build_html(resume, font_pt, spacing_scale), wait_until="load")
    page.pdf(path=out_path, print_background=True, margin={"top": "0", "bottom": "0", "left": "0", "right": "0"})
    return count_pages(out_path)


def trim_one_bullet(working: dict) -> Optional[str]:
    """Removes the last bullet of the highest-priority-to-trim entry that's
    still above the floor. Projects before experience (work history detail
    outweighs project detail), oldest entries first within each list (list
    order is already reverse-chronological, so "oldest" = last)."""
    for group_name in ("projects", "experience"):
        for entry in reversed(working.get(group_name) or []):
            bullets = entry.get("bullets") or []
            if len(bullets) > BULLET_FLOOR:
                removed = bullets.pop()
                label = entry.get("title") or entry.get("name") or "an entry"
                return f'Shortened "{label}" — removed bullet: "{str(removed.get("text", ""))[:70]}"'
    return None


def drop_one_entry(working: dict) -> Optional[str]:
    """Absolute last resort. Projects first (from the oldest), then
    experience — but never the last remaining experience entry, so the
    exported resume always shows at least one job."""
    projects = working.get("projects") or []
    if projects:
        dropped = projects.pop()
        return f'Removed project "{dropped.get("name", "")}" entirely — resume still did not fit one page.'
    experience = working.get("experience") or []
    if len(experience) > 1:
        dropped = experience.pop()
        return (
            f'Removed experience entry "{dropped.get("title", "")}" at {dropped.get("company", "")} entirely — '
            "resume still did not fit one page."
        )
    return None


def fit_one_page(page: Any, resume: dict, out_path: str) -> dict:
    working = clone_resume(resume)
    notes: List[str] = []
    pages = 1
    font_pt, spacing = FONT_STEPS[0], SPACING_STEPS[0]

    for font_pt in FONT_STEPS:
        for spacing in SPACING_STEPS:
            pages = render_and_count(page, working, font_pt, spacing, out_path)
            if pages <= 1:
                return {"pages": pages, "notes": notes}

    # Tightest spacing/font still overflows — trim bullets one at a time,
    # re-checking after every single removal rather than guessing how many
    # are needed.
    while True:
        note = trim_one_bullet(working)
        if note is None:
            break
        notes.append(note)
        pages = render_and_count(page, working, font_pt, spacing, out_path)
        if pages <= 1:
            return {"pages": pages, "notes": notes}

    # Every entry is at the bullet floor and it still doesn't fit — drop
    # whole low-priority entries as a last resort.
    while True:
        note = drop_one_entry(working)
        if note is None:
            break
        notes.append(note)
        pages = render_and_count(page, working, font_pt, spacing, out_path)
        if pages <= 1:
            return {"pages": pages, "notes": notes}

    return {"pages": pages, "notes": notes}


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(
        prog="render_resume_pdf.py",
        description="Render a MasterResume JSON (stdin) into a one-page PDF at <output.pdf>.",
    )
    parser.add_argument("output", help="path to write the PDF to")
    args = parser.parse_args(argv)

    try:
        resume = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        return error(f"invalid JSON on stdin: {exc}")
    if not isinstance(resume, dict):
        return error("input must be a JSON object matching MasterResume")

    out_dir = os.path.dirname(os.path.abspath(args.output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return error(
            "the 'playwright' pip package is not installed — run `pip3 install -r requirements.txt` first",
            code=2,
        )

    try:
        with sync_playwright() as p:
            try:
                # Ephemeral headless launch (no persistent user profile needed —
                # this only ever renders HTML this script itself generated, it
                # never visits a real site or needs a logged-in session), so
                # unlike replay_fill.py there's no "Chrome already running
                # against this profile" lock to worry about.
                browser = p.chromium.launch(channel="chrome", headless=True)
            except Exception as exc:
                return error(f"could not launch Chrome: {exc}", code=3)
            try:
                page = browser.new_page()
                result = fit_one_page(page, resume, args.output)
            finally:
                browser.close()
    except Exception as exc:  # pypdf/IO errors surfaced from inside the loop
        return error(f"render failed: {exc}")

    try:
        os.chmod(args.output, 0o600)
    except OSError:
        pass

    emit({"ok": True, "path": args.output, "pages": result["pages"], "notes": result["notes"]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
