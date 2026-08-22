#!/usr/bin/env python3
"""preview_resume.py — preview a tailored + humanized resume for a JD.

Usage:
  python3 src/scripts/runtime/preview_resume.py --title "Software Engineer Intern" --jd-file jd.txt
  python3 src/scripts/runtime/preview_resume.py --title "..." --company "..." < jd.txt
  python3 src/scripts/runtime/preview_resume.py --title "..." --jd-file jd.txt --out logs/tmp/preview.json
  echo '{"master_resume": {...}, "jd_text": "..."}' | \
    python3 src/scripts/runtime/preview_resume.py --title "..." --payload-stdin

Runs the real `@resume-tailor` agent (src/agents/bodies/resume-tailor.md
Steps 1-3, including the humanizer skill pass —
src/agents/skills/humanizer/SKILL.md) via whatever coding-agent harness
this install is already configured to use (src/config/harness.json /
APLYX_HARNESS — same resolution run_job_agent.py itself uses), invoked
standalone as a one-shot subagent call: no job-scraper run, no board
search, no fit gate, no live application. This is a preview tool — it is
never invoked by run_job_agent.py and has no effect on any real
application.

Deliberately does NOT call a model provider's API directly (an earlier
version of this script did, requiring a separate ANTHROPIC_API_KEY the
operator would have had to configure on top of whatever's already backing
their harness). Routing through the configured harness means Preview
uses the exact same model/credentials the real apply pipeline already
uses for tailoring — no second credential, and the output reflects what
a real run would actually produce.

resume-tailor's own opencode/Claude Code frontmatter marks it
`mode: subagent` — reachable via in-session delegation (the normal
job-scraper -> @resume-tailor path) but NOT via a harness CLI's own
top-level agent-selection flag; confirmed empirically that opencode
silently runs the project's default agent instead when asked for a
subagent-mode one by name. harness_adapter.agent_command()'s
`standalone=True` flag routes around this by inlining resume-tailor's
body into the prompt instead (the same mechanism harnesses without any
subagent registry at all already use) — see harness_adapter.py's own
docstring on `standalone` for the full story.

Never writes to data/resumes/resume.json, data/applied_jobs.json, the job
registry, or any other state file — read-only except for the optional
--out file, which is just a copy of the stdout JSON for your own reference.

Exit codes:
  0  preview generated
  2  unusable (no resume / no JD / no harness available / bad model output)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_adapter  # noqa: E402

# A full tailor+humanize pass is a real multi-step agent task (read the
# master resume content, read the humanizer skill file, think, write the
# JSON) — empirically observed to take 90-200s depending on harness/model,
# not the few-second turnaround a direct API call would have had. Give it
# real room rather than a copy-pasted short default.
HARNESS_TIMEOUT_S = 280

_REQUIRED_KEYS = ("resume_used", "tailored_resume", "tailored_bullets", "ats_score", "missing_keywords")


def emit(obj: dict) -> None:
    # Single line, matching every other helper's stdout convention (see
    # record_fill.py, job_state.py, generate_interest_letter.py) — callers
    # that parse this (masterResume.ts's previewTailoredResume) grab the
    # last stdout line as JSON. Pipe to `python3 -m json.tool` or `jq` for
    # pretty terminal output.
    print(json.dumps(obj, ensure_ascii=False))


def _read_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return default


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def _extract_json_object(text: str, required_keys: tuple) -> dict | None:
    """The harness CLI's stdout is a model transcript, not a guaranteed
    single JSON value — even with an explicit "print ONLY the JSON object"
    instruction, a stray progress line or tool-call echo can end up mixed
    in. Scan for every balanced top-level {...} substring, and return the
    last one (the real answer is normally the last thing printed) that
    both parses as JSON and has every key resume-tailor's own output
    contract requires — a schema-aware pick, not just "the last
    brace-balanced blob", so stray JSON-shaped noise from the harness
    itself doesn't get mistaken for the actual result."""
    candidates = []
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    candidates.append(text[start:i + 1])
    for candidate in reversed(candidates):
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and all(k in obj for k in required_keys):
            return obj
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="preview_resume.py",
        description="Preview a tailored + humanized resume for a job title/JD, without applying anywhere.",
    )
    ap.add_argument("--title", required=True, help="job title, e.g. 'Software Engineer Intern'")
    ap.add_argument("--company", default="", help="employer name, for the preview header only (not required by resume-tailor's own contract)")
    ap.add_argument("--jd-file", default=None, help="path to a file containing the job description text; omit to read from stdin (ignored with --payload-stdin)")
    ap.add_argument(
        "--payload-stdin", action="store_true",
        help="read a single JSON object {\"master_resume\", \"jd_text\"} from stdin instead of "
             "plain JD text, and use master_resume verbatim instead of reading "
             "data/resumes/resume.json from disk — lets a caller (e.g. the desktop app's "
             "Resumes editor) preview the current in-memory resume, including unsaved edits, "
             "the same way exportResumePdf already works.",
    )
    ap.add_argument("--out", default=None, help="also write the full JSON result to this path")
    ap.add_argument("--root", default=os.environ.get("APLYX_ROOT", os.environ.get("FLUX_ROOT", ".")))
    args = ap.parse_args(argv)
    root = os.path.abspath(args.root)

    if args.payload_stdin:
        try:
            envelope = json.loads(sys.stdin.read())
        except json.JSONDecodeError as exc:
            emit({"ok": False, "error": f"--payload-stdin: stdin was not valid JSON: {exc}"})
            return 2
        resume = envelope.get("master_resume")
        jd_text = str(envelope.get("jd_text") or "").strip()
    else:
        resume_path = os.path.join(root, "data", "resumes", "resume.json")
        resume = _read_json(resume_path, None)
        if args.jd_file:
            try:
                jd_text = _read_text(args.jd_file)
            except OSError as exc:
                emit({"ok": False, "error": f"could not read --jd-file: {exc}"})
                return 2
        else:
            jd_text = sys.stdin.read()
        jd_text = jd_text.strip()

    if not isinstance(resume, dict) or (not resume.get("experience") and not resume.get("projects")):
        emit({"ok": False, "error": "no master resume — data/resumes/resume.json is missing or has no "
                                     "experience/projects (same hard-blocker resume-tailor itself uses; "
                                     "fill out the Resumes screen first, nothing to preview yet)"})
        return 2
    if not jd_text:
        emit({"ok": False, "error": "no job description text given"})
        return 2

    harness = harness_adapter.resolve_harness(root)
    if not harness:
        emit({"ok": False, "error": "no coding-agent harness available — set src/config/harness.json, "
                                     "APLYX_HARNESS, or install one of: " + ", ".join(harness_adapter.SUPPORTED)})
        return 2
    exe = shutil.which(harness) or harness

    payload = {"title": args.title, "jd_text": jd_text, "master_resume": resume}
    prompt = (
        "Tailor and humanize the resume for this job. Print ONLY the resulting JSON "
        "object on stdout when done, no prose before or after, no markdown fence. "
        "Input JSON follows.\n" + json.dumps(payload, ensure_ascii=False)
    )
    cmd = harness_adapter.agent_command(exe, harness, "resume-tailor", prompt, standalone=True, role="agent")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=HARNESS_TIMEOUT_S, cwd=root)
    except subprocess.TimeoutExpired:
        emit({"ok": False, "error": f"harness ({harness}) did not finish within {HARNESS_TIMEOUT_S}s"})
        return 2
    except OSError as exc:
        emit({"ok": False, "error": f"failed to launch harness ({harness}): {exc}"})
        return 2

    obj = _extract_json_object(result.stdout, _REQUIRED_KEYS)
    if obj is None:
        stderr_tail = (result.stderr or "")[-1000:]
        emit({"ok": False, "error": f"harness ({harness}) did not return a usable tailored-resume JSON object",
              "exit_code": result.returncode, "stderr_tail": stderr_tail})
        return 2

    final = {
        "ok": True,
        "company": args.company,
        "title": args.title,
        "resume_used": obj.get("resume_used", ""),
        "ats_score": obj.get("ats_score"),
        "missing_keywords": obj.get("missing_keywords", []),
        "tailored_bullets": obj.get("tailored_bullets", []),
        "tailored_resume": obj.get("tailored_resume", {}),
    }

    if args.out:
        try:
            os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as fh:
                json.dump(final, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
        except OSError as exc:
            emit({"ok": False, "error": f"generated the preview but could not write --out: {exc}"})
            return 2

    emit(final)
    return 0


if __name__ == "__main__":
    sys.exit(main())
