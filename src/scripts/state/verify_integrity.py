#!/usr/bin/env python3
"""verify_integrity.py: check a local aplyx install against its manifest.

What this catches: a modified enforcement file (the daily cap removed from
run_job_agent.py, the apply loop rewritten in job-scraper.md), or a
re-created agent definition for a hosted-only feature (cover letters /
application essays are Basic+ only). What it cannot catch: a user who also
patches this script, or who just prompts their own coding agent directly.
That is an accepted limit of shipping plain-text enforcement — the point
is that tampering is detected, recorded (integrity_events.py), and
reported to the account, not that it is impossible.

Manifest source, in order:
  1. --manifest <path|->   a caller-supplied manifest (the desktop app
     passes the canonical one it fetched from the `release_manifests`
     Supabase table; a client cannot forge that service_role-only write).
  2. src/integrity/manifest.json   the bundled offline fallback.

  python3 src/scripts/state/verify_integrity.py [--root .] [--manifest -]

Prints one JSON object: {ok, violations: [{kind, path, detail}], version}.
Exit code is always 0 — this is diagnostic; run_job_agent.py decides what
to do with a non-empty `violations`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

BUNDLED_MANIFEST = "src/integrity/manifest.json"
# A tracked file whose text must still contain these markers, checked
# explicitly so a stripped cap produces a clear `cap_logic_missing` event
# rather than only a generic hash mismatch.
CAP_MARKERS = ("applied-today", "daily_remaining", "25 - applied_today")


def _sha256(path: str) -> str | None:
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


def load_manifest(root: str, manifest_arg: str | None) -> dict | None:
    if manifest_arg == "-":
        try:
            return json.loads(sys.stdin.read())
        except (json.JSONDecodeError, ValueError):
            return None
    path = manifest_arg or os.path.join(root, BUNDLED_MANIFEST)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def verify(root: str, manifest: dict) -> list:
    violations = []

    for rel, expected in (manifest.get("files") or {}).items():
        actual = _sha256(os.path.join(root, rel))
        if actual is None:
            violations.append({"kind": "file_missing", "path": rel, "detail": {}})
        elif actual != expected:
            violations.append({
                "kind": "file_modified", "path": rel,
                "detail": {"expected": expected, "actual": actual},
            })

    for rel in (manifest.get("forbidden") or []):
        if os.path.exists(os.path.join(root, rel)):
            is_agent_def = "/agents/" in rel or "frontmatter/" in rel or "Letters" in rel or "letters." in rel
            violations.append({
                "kind": "disabled_feature_reenabled" if is_agent_def else "forbidden_file_present",
                "path": rel, "detail": {},
            })

    runner = os.path.join(root, "src/scripts/runtime/run_job_agent.py")
    try:
        with open(runner, "r", encoding="utf-8") as fh:
            runner_text = fh.read()
        if not all(m in runner_text for m in CAP_MARKERS):
            violations.append({
                "kind": "cap_logic_missing", "path": "src/scripts/runtime/run_job_agent.py",
                "detail": {"missing_markers": [m for m in CAP_MARKERS if m not in runner_text]},
            })
    except OSError:
        violations.append({"kind": "file_missing", "path": "src/scripts/runtime/run_job_agent.py", "detail": {}})

    return violations


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="verify_integrity.py")
    parser.add_argument("--root", default=".")
    parser.add_argument("--manifest", default=None, help="path, or '-' for stdin (canonical from release_manifests)")
    args = parser.parse_args(argv)

    manifest = load_manifest(args.root, args.manifest)
    if manifest is None:
        print(json.dumps({
            "ok": False,
            "violations": [{"kind": "manifest_unavailable", "path": BUNDLED_MANIFEST, "detail": {}}],
            "version": None,
        }))
        return 0

    violations = verify(args.root, manifest)
    print(json.dumps({
        "ok": len(violations) == 0,
        "violations": violations,
        "version": manifest.get("version"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
