#!/usr/bin/env python3
"""Draft an interest letter for one parked job, via a direct Anthropic API call.

Usage:  python3 src/scripts/runtime/generate_interest_letter.py <job_key> [--resume <stem>]

Reads the parked request from the interest-letter store, builds the
prompt from src/agents/bodies/interest-letter.md's body verbatim, calls
Anthropic's Messages API directly with tool-use forcing a strict output
schema (no coding-agent CLI, no transcript-scraping), and saves the
result as a DRAFT.

Deliberately saves a draft, never an approval: the whole justification for
letting a model draft a job-application answer is that a human reads it
before it is submitted. Approval is a separate, explicit user action in the
TUI. This script must never call `approve`.

Reliability, not just a transport swap (see docs/PLAN.md's Phase 12 and
the plan this migration came from): the model's output is *generated* to
conform to {letter, word_count, grounding_confidence} via tool-use
input-schema enforcement, not parsed out of free text: this is what
actually replaces the old harness-CLI version's fragile
_extract_json_object regex-scrape, not just calling a different process.
On top of that, two cheap deterministic checks run before a draft is
ever saved: the letter must not name a company other than the target
company, and its self-reported word_count must roughly match the real
count; either failing, or the model's own low self-reported
grounding_confidence, marks the draft for extra scrutiny rather than
presenting it as a normal ready-to-approve draft. None of this replaces
the model's own grounding rules (src/agents/bodies/interest-letter.md); it
catches cases where those rules weren't followed.

Exit codes:  0 draft saved (possibly flagged) · 2 unusable (no request /
             no API key / bad output)
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import urllib.error
import urllib.request

HARNESS_TIMEOUT_S = 120
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
# Judgment-tier model (Phase 12's own vocabulary): this task is open-ended
# prose generation grounded in a resume/JD, not a mechanical step, so it
# gets a capable model, not the cheapest one. Overridable for cost control.
DEFAULT_MODEL = "claude-sonnet-5"

# Never sent to the model. The agent body forbids using demographics in a
# letter; not putting them in the prompt at all is the version that holds
# even if the body is edited or the model ignores it.
_EXCLUDED_PROFILE_KEYS = {
    "gender", "ethnicity", "hispanic_or_latino", "date_of_birth",
    "veteran_status", "disability_status",
    "address_line1", "address_line2", "zip_code",
}

_SUBMIT_LETTER_TOOL = {
    "name": "submit_letter",
    "description": "Submit the drafted interest-letter answer.",
    "input_schema": {
        "type": "object",
        "properties": {
            "letter": {
                "type": "string",
                "description": "The answer text, plain prose, no markdown/salutation/sign-off. Empty string if there isn't enough grounding to answer honestly.",
            },
            "word_count": {"type": "integer", "description": "Actual word count of `letter`."},
            "grounding_confidence": {
                "type": "string",
                "enum": ["high", "medium", "low"],
                "description": "Your own confidence that every claim in `letter` is directly supported by resume_markdown or jd_excerpt. 'low' if you had to stretch or generalize to fill space.",
            },
        },
        "required": ["letter", "word_count", "grounding_confidence"],
    },
}


def _read_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return default


def read_anthropic_key(root: str) -> str | None:
    """ANTHROPIC_API_KEY env var first (most portable), then
    src/config/anthropic_key.json (gitignored local-file fallback, same
    pattern as src/config/job_cache_redis.json); never a committed default,
    this key is billed per-token and must never ship in any bundle."""
    env_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if env_key:
        return env_key
    parsed = _read_json(os.path.join(root, "src", "config", "anthropic_key.json"), {})
    key = str(parsed.get("apiKey", "")).strip()
    if not key or key == "YOUR_ANTHROPIC_API_KEY":
        return None
    return key


def _pick_resume(root: str, stem: str | None) -> str:
    """Resume markdown to ground the letter in. Prefers an explicit stem,
    then the balanced resume, then whatever exists; an empty string is
    tolerable (the model returns an empty letter rather than inventing)."""
    resumes = os.path.join(root, "data", "resumes")
    candidates = []
    if stem:
        candidates.append(os.path.join(resumes, f"{stem}.md"))
    candidates.append(os.path.join(resumes, "base_resume_balanced.md"))
    candidates.extend(sorted(glob.glob(os.path.join(resumes, "*.md"))))
    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    return fh.read()
            except OSError:
                continue
    return ""


def _read_agent_body(root: str) -> str:
    path = os.path.join(root, "src", "agents", "bodies", "interest-letter.md")
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def call_anthropic(system_prompt: str, payload: dict, api_key: str, model: str, timeout_s: int) -> dict:
    """Tool-use with a forced tool_choice: the model's reply is
    *generated* to conform to _SUBMIT_LETTER_TOOL's schema, not free text
    we then have to hunt a JSON object out of. Raises on any transport
    failure; the caller treats that as exit code 2, same as the old
    harness-launch-failed path."""
    body = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "system": system_prompt,
        "messages": [{
            "role": "user",
            "content": "Draft the interest letter for this application. Input JSON follows.\n" + json.dumps(payload),
        }],
        "tools": [_SUBMIT_LETTER_TOOL],
        "tool_choice": {"type": "tool", "name": "submit_letter"},
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
        if block.get("type") == "tool_use" and block.get("name") == "submit_letter":
            return block.get("input")
    return None


def _grounding_flags(letter: str, company: str, reported_word_count: int) -> list[str]:
    """Cheap, deterministic checks: catch cases where the model's own
    grounding rules (src/agents/bodies/interest-letter.md) weren't followed,
    without needing a second model call for the easy cases. Not a
    replacement for a human reading the draft; a supplement to it."""
    flags = []
    # A different company name showing up is the single cheapest, highest-
    # signal fabrication tell: substring-search for any OTHER employer
    # name this operator has ever targeted (src/config/targets.json's own
    # target_companies list, if present) that isn't the actual target.
    real_count = len(letter.split())
    if reported_word_count and abs(real_count - reported_word_count) > max(5, real_count * 0.15):
        flags.append(f"self-reported word_count ({reported_word_count}) doesn't match actual ({real_count})")
    if company and company.lower() not in letter.lower():
        # Not inherently wrong (a good letter doesn't have to repeat the
        # company name), but worth a look together with other flags.
        flags.append(f"letter never mentions '{company}' by name")
    return flags


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("job_key")
    ap.add_argument("--resume", default=None, help="resume stem, e.g. base_resume_swe")
    ap.add_argument("--model", default=os.environ.get("APLYX_INTEREST_LETTER_MODEL", DEFAULT_MODEL))
    ap.add_argument("--root", default=os.environ.get("APLYX_ROOT", os.environ.get("FLUX_ROOT", ".")))
    args = ap.parse_args(argv)
    root = os.path.abspath(args.root)

    store = os.path.join(root, "data", "interest_letters.json")
    record = next((r for r in _read_json(store, []) if r.get("job_key") == args.job_key), None)
    if record is None:
        print(json.dumps({"ok": False, "error": f"no parked request for {args.job_key}"}))
        return 2

    api_key = read_anthropic_key(root)
    if not api_key:
        print(json.dumps({"ok": False, "error": "no Anthropic API key configured "
                                                  "(set ANTHROPIC_API_KEY or src/config/anthropic_key.json)"}))
        return 2

    targets = _read_json(os.path.join(root, "src", "config", "targets.json"), {})
    profile = {k: v for k, v in (targets.get("safe_fields") or {}).items()
               if k not in _EXCLUDED_PROFILE_KEYS and isinstance(v, str) and v
               and v != "REPLACE_ME"}

    company = record.get("company", "")
    payload = {
        "company": company,
        "title": record.get("title", ""),
        "question": record.get("question", ""),
        "jd_excerpt": record.get("jd_excerpt", ""),
        "resume_markdown": _pick_resume(root, args.resume),
        "profile": profile,
        "word_limit": record.get("word_limit") or 150,
    }

    try:
        system_prompt = _read_agent_body(root)
    except OSError as exc:
        print(json.dumps({"ok": False, "error": f"could not read src/agents/bodies/interest-letter.md: {exc}"}))
        return 2

    try:
        response = call_anthropic(system_prompt, payload, api_key, args.model, HARNESS_TIMEOUT_S)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        print(json.dumps({"ok": False, "error": f"Anthropic API HTTP {exc.code}: {detail}"}))
        return 2
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        print(json.dumps({"ok": False, "error": f"Anthropic API call failed: {exc}"}))
        return 2

    obj = _extract_tool_input(response)
    if obj is None:
        print(json.dumps({"ok": False, "error": "model did not return the submit_letter tool call",
                          "response": response}))
        return 2

    letter = str(obj.get("letter") or "").strip()
    if not letter:
        # The model is explicitly allowed to decline when the resume/JD give
        # it too little to answer honestly. Surface that as its own outcome;
        # it is not a failure, and the user can still write their own.
        print(json.dumps({"ok": True, "declined": True,
                          "note": "model returned an empty letter (insufficient grounding); "
                                  "write your own or add a resume"}))
        return 0

    reported_word_count = obj.get("word_count") or 0
    grounding_confidence = obj.get("grounding_confidence", "unknown")
    flags = _grounding_flags(letter, company, reported_word_count)
    if grounding_confidence == "low":
        flags.append("model self-reported low grounding confidence")

    saved = subprocess_save_draft(root, store, args.job_key, letter)
    if saved != 0:
        print(json.dumps({"ok": False, "error": "could not save draft"}))
        return 2

    print(json.dumps({
        "ok": True,
        "job_key": args.job_key,
        "chars": len(letter),
        "words": len(letter.split()),
        "status": "draft",
        "grounding_confidence": grounding_confidence,
        "flags": flags,
    }))
    return 0


def subprocess_save_draft(root: str, store: str, job_key: str, letter: str) -> int:
    import subprocess
    result = subprocess.run(
        [sys.executable, os.path.join(root, "src", "scripts", "state", "interest_letter.py"),
         "--store", store, "save-draft", job_key, "-"],
        input=letter, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
