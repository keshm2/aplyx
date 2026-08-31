#!/usr/bin/env python3
"""Draft a cover letter for one job, via a direct Anthropic API call: the
hosted review_only pipeline's counterpart to @cover-letter-tailor
(src/agents/bodies/cover-letter-tailor.md).

The system prompt is cover-letter-tailor.md's body verbatim, plus a
prepended override: that file's "Style" section resolves a voice/structure
reference file via resolve_resume.py, which doesn't exist in this hosted,
config-file-free context. The override tells the model there is no
reference file here: cover-letter-tailor.md already documents exactly how
to handle that (write without one; "confidence: none" is not a blocker),
so this only supplies the missing fact, not new behavior.

Same reliability pattern as generate_interest_letter.py: forced tool-use
output, plus a cheap deterministic company-name / word-count grounding
check run on the result before it's handed back.

Usage:
  python3 src/scripts/runtime/tailor_cover_letter_hosted.py '<payload-json>'
  python3 src/scripts/runtime/tailor_cover_letter_hosted.py -   (stdin)

Payload: {"company", "title", "jd_text", "tailored_bullets": [...]}

Exit codes:  0 drafted (JSON result on stdout) · 2 unusable
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

_SUBMIT_COVER_LETTER_TOOL = {
    "name": "submit_cover_letter",
    "description": "Submit the drafted cover letter.",
    "input_schema": {
        "type": "object",
        "properties": {
            "cover_letter": {
                "type": "string",
                "description": "The complete, paste-ready letter: greeting through sign-off, plain text, no markdown.",
            },
            "word_count": {"type": "integer", "description": "Actual word count of cover_letter."},
        },
        "required": ["cover_letter", "word_count"],
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
    path = os.path.join(root, "src", "agents", "bodies", "cover-letter-tailor.md")
    with open(path, "r", encoding="utf-8") as fh:
        body = fh.read()
    override = (
        "HOSTED-WORKER CONTEXT OVERRIDE: you are being invoked directly by "
        "the hosted review_only pipeline (src/worker/), not job-scraper, "
        "with no word_limit/char_limit (target 250-400 words per your own "
        'default). There is no voice/structure reference file in this '
        "context (resolve_resume.py does not exist here); treat this "
        'exactly as your own documented `confidence: "none"` case: write '
        "without a reference rather than blocking on one.\n\n---\n\n"
    )
    return override + body


def call_anthropic(system_prompt: str, payload: dict, api_key: str, model: str, timeout_s: int) -> dict:
    body = json.dumps({
        "model": model,
        "max_tokens": 1536,
        "system": system_prompt,
        "messages": [{
            "role": "user",
            "content": "Draft the cover letter for this application. Input JSON follows.\n" + json.dumps(payload),
        }],
        "tools": [_SUBMIT_COVER_LETTER_TOOL],
        "tool_choice": {"type": "tool", "name": "submit_cover_letter"},
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
        if block.get("type") == "tool_use" and block.get("name") == "submit_cover_letter":
            return block.get("input")
    return None


def _grounding_flags(letter: str, company: str, reported_word_count: int) -> list[str]:
    flags = []
    real_count = len(letter.split())
    if reported_word_count and abs(real_count - reported_word_count) > max(5, real_count * 0.15):
        flags.append(f"self-reported word_count ({reported_word_count}) doesn't match actual ({real_count})")
    if company and company.lower() not in letter.lower():
        flags.append(f"letter never mentions '{company}' by name")
    return flags


def _load_payload_arg(arg: str) -> dict:
    raw = sys.stdin.read() if arg == "-" else arg
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("payload must be a JSON object")
    return obj


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) != 1:
        print(json.dumps({"ok": False, "error": "usage: tailor_cover_letter_hosted.py '<payload-json>' | -"}))
        return 2
    root = os.path.abspath(os.environ.get("APLYX_ROOT", "."))

    try:
        payload_in = _load_payload_arg(argv[0])
    except (json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": f"invalid payload: {exc}"}))
        return 2

    for required in ("company", "title", "jd_text"):
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
        print(json.dumps({"ok": False, "error": f"could not read src/agents/bodies/cover-letter-tailor.md: {exc}"}))
        return 2

    company = payload_in["company"]
    payload = {
        "company": company,
        "title": payload_in["title"],
        "jd_text": payload_in["jd_text"],
        "tailored_bullets": payload_in.get("tailored_bullets") or [],
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
        print(json.dumps({"ok": False, "error": "model did not return the submit_cover_letter tool call"}))
        return 2

    letter = str(obj.get("cover_letter") or "").strip()
    if not letter:
        print(json.dumps({"ok": False, "error": "model returned an empty cover letter"}))
        return 2

    reported_word_count = obj.get("word_count") or 0
    flags = _grounding_flags(letter, company, reported_word_count)

    print(json.dumps({
        "ok": True,
        "cover_letter": letter,
        "words": len(letter.split()),
        "flags": flags,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
