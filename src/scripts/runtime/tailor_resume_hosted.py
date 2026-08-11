#!/usr/bin/env python3
"""Tailor a resume for one job, via a direct Anthropic API call — the hosted
review_only pipeline's counterpart to @resume-tailor (src/agents/bodies/
resume-tailor.md).

Unlike the local subagent, this script never resolves a resume file from
data/resumes/ itself: the hosted worker (src/worker/) already downloaded the
signed-in user's one uploaded resume from Supabase Storage and converted it
to markdown (convert_resume.py) before calling this script, so there is no
category system to run — one hosted account, one resume. The system prompt
is resume-tailor.md's body verbatim, PLUS a prepended override telling the
model to skip its own "Step 1 — Select base resume" (which assumes
resolve_resume.py exists) and go straight to "Step 2 — Tailor" using the
resume_markdown given in the payload.

Same reliability pattern as generate_interest_letter.py: tool-use forces the
output schema so nothing is parsed out of free text, and a cheap
deterministic check flags a draft for extra scrutiny rather than blocking it
outright.

Usage:
  python3 src/scripts/runtime/tailor_resume_hosted.py '<payload-json>'
  python3 src/scripts/runtime/tailor_resume_hosted.py -   (read JSON from stdin)

Payload: {"title", "jd_text", "resume_markdown"}

Exit codes:  0 tailored (JSON result on stdout) · 2 unusable (bad input /
             no API key / bad model output)
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

HARNESS_TIMEOUT_S = 120
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-sonnet-5"

_SUBMIT_TAILORED_RESUME_TOOL = {
    "name": "submit_tailored_resume",
    "description": "Submit the tailored resume bullets and fit assessment for this job.",
    "input_schema": {
        "type": "object",
        "properties": {
            "tailored_bullets": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Reordered/rewritten resume bullets, front-loading what's most relevant to this JD. Never fabricated — only rephrased from resume_markdown.",
            },
            "ats_score": {
                "type": "integer",
                "description": "0-100 fit score. Below 40 if the JD has a hard requirement the resume clearly cannot meet.",
            },
            "missing_keywords": {
                "type": "array",
                "items": {"type": "string"},
                "description": "ATS keywords from the JD the tailored resume doesn't cover.",
            },
        },
        "required": ["tailored_bullets", "ats_score", "missing_keywords"],
    },
}


def _read_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return default


def read_anthropic_key(root: str) -> str | None:
    env_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if env_key:
        return env_key
    parsed = _read_json(os.path.join(root, "src", "config", "anthropic_key.json"), {})
    key = str(parsed.get("apiKey", "")).strip()
    if not key or key == "YOUR_ANTHROPIC_API_KEY":
        return None
    return key


def _build_system_prompt(root: str) -> str:
    path = os.path.join(root, "src", "agents", "bodies", "resume-tailor.md")
    with open(path, "r", encoding="utf-8") as fh:
        body = fh.read()
    override = (
        "HOSTED-WORKER CONTEXT OVERRIDE: you are being invoked directly by "
        "the hosted review_only pipeline (src/worker/), not job-scraper. "
        "This account has exactly one resume, already selected and given to "
        "you below as `resume_markdown` in the user message — skip "
        '"Step 1 — Select base resume" entirely (resolve_resume.py does not '
        "exist in this context; do not attempt to run any command). Go "
        'straight to "Step 2 — Tailor" using the given resume_markdown as '
        "the base resume.\n\n---\n\n"
    )
    return override + body


def call_anthropic(system_prompt: str, payload: dict, api_key: str, model: str, timeout_s: int) -> dict:
    body = json.dumps({
        "model": model,
        "max_tokens": 2048,
        "system": system_prompt,
        "messages": [{
            "role": "user",
            "content": "Tailor the resume for this job. Input JSON follows.\n" + json.dumps(payload),
        }],
        "tools": [_SUBMIT_TAILORED_RESUME_TOOL],
        "tool_choice": {"type": "tool", "name": "submit_tailored_resume"},
    }).encode("utf-8")
    req = urllib.request.Request(
        ANTHROPIC_API_URL,
        data=body,
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.load(resp)


def _extract_tool_input(response: dict) -> dict | None:
    for block in response.get("content", []):
        if block.get("type") == "tool_use" and block.get("name") == "submit_tailored_resume":
            return block.get("input")
    return None


def _load_payload_arg(arg: str) -> dict:
    raw = sys.stdin.read() if arg == "-" else arg
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("payload must be a JSON object")
    return obj


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) != 1:
        print(json.dumps({"ok": False, "error": "usage: tailor_resume_hosted.py '<payload-json>' | -"}))
        return 2
    root = os.path.abspath(os.environ.get("APLYX_ROOT", "."))

    try:
        payload_in = _load_payload_arg(argv[0])
    except (json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": f"invalid payload: {exc}"}))
        return 2

    for required in ("title", "jd_text", "resume_markdown"):
        if not str(payload_in.get(required, "")).strip():
            print(json.dumps({"ok": False, "error": f"payload missing required field '{required}'"}))
            return 2

    api_key = read_anthropic_key(root)
    if not api_key:
        print(json.dumps({"ok": False, "error": "no Anthropic API key configured (set ANTHROPIC_API_KEY)"}))
        return 2

    try:
        system_prompt = _build_system_prompt(root)
    except OSError as exc:
        print(json.dumps({"ok": False, "error": f"could not read src/agents/bodies/resume-tailor.md: {exc}"}))
        return 2

    payload = {
        "title": payload_in["title"],
        "jd_text": payload_in["jd_text"],
        "resume_markdown": payload_in["resume_markdown"],
    }

    try:
        response = call_anthropic(system_prompt, payload, api_key, os.environ.get("APLYX_TAILOR_MODEL", DEFAULT_MODEL), HARNESS_TIMEOUT_S)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        print(json.dumps({"ok": False, "error": f"Anthropic API HTTP {exc.code}: {detail}"}))
        return 2
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        print(json.dumps({"ok": False, "error": f"Anthropic API call failed: {exc}"}))
        return 2

    obj = _extract_tool_input(response)
    if obj is None:
        print(json.dumps({"ok": False, "error": "model did not return the submit_tailored_resume tool call"}))
        return 2

    tailored_bullets = [str(b) for b in (obj.get("tailored_bullets") or []) if str(b).strip()]
    if not tailored_bullets:
        print(json.dumps({"ok": False, "error": "model returned no tailored_bullets"}))
        return 2

    ats_score = obj.get("ats_score")
    if not isinstance(ats_score, int):
        print(json.dumps({"ok": False, "error": "model returned a non-integer ats_score"}))
        return 2

    print(json.dumps({
        "ok": True,
        "resume_used": "hosted",
        "tailored_bullets": tailored_bullets,
        "ats_score": ats_score,
        "missing_keywords": [str(k) for k in (obj.get("missing_keywords") or [])],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
