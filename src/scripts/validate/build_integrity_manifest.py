#!/usr/bin/env python3
"""build_integrity_manifest.py: (re)generate src/integrity/manifest.json.

The manifest is aplyx's tamper-detection baseline for the local build. It
holds a SHA-256 for every enforcement-critical shipped file, plus a list
of paths that must NOT exist (the agent definitions for features disabled
server-side: cover letters / application essays are hosted Basic+ only).

verify_integrity.py checks a local install against this manifest. The
bundled copy here is the offline fallback; the authoritative copy is
published per-release to the `release_manifests` Supabase table (CI), which
a client cannot forge because that write is service_role-only.

  python3 src/scripts/validate/build_integrity_manifest.py           # write
  python3 src/scripts/validate/build_integrity_manifest.py --check   # CI drift check

Exit codes: 0 ok; 1 drift (--check) or a tracked file is missing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

MANIFEST_PATH = "src/integrity/manifest.json"

# Files whose bytes must match the release. Editing any of these to remove
# a cap, re-enable a disabled agent, or change the apply loop is a
# detected `file_modified` violation.
TRACKED = [
    "src/scripts/runtime/run_job_agent.py",
    "src/scripts/state/job_state.py",
    "src/scripts/state/verify_integrity.py",
    "src/scripts/state/integrity_events.py",
    "src/scripts/validate/generate_agent_definitions.py",
    "src/agents/bodies/job-scraper.md",
    "src/agents/bodies/resume-tailor.md",
    "src/agents/bodies/discord-reporter.md",
    "AGENTS.md",
    ".claude/agents/job-scraper.md",
    ".opencode/agents/job-scraper.md",
    ".codex/agents/job-scraper.toml",
    ".github/agents/job-scraper.md",
    ".claude/agents/resume-tailor.md",
    ".opencode/agents/resume-tailor.md",
    ".codex/agents/resume-tailor.toml",
    ".github/agents/resume-tailor.md",
]

# Paths that must NOT exist in a clean local build. Re-creating any of
# these re-enables a hosted-only feature and is a
# `disabled_feature_reenabled` / `forbidden_file_present` violation.
FORBIDDEN = [
    ".claude/agents/cover-letter-tailor.md",
    ".claude/agents/interest-letter.md",
    ".opencode/agents/cover-letter-tailor.md",
    ".opencode/agents/interest-letter.md",
    ".codex/agents/cover-letter-tailor.toml",
    ".codex/agents/interest-letter.toml",
    ".github/agents/cover-letter-tailor.md",
    ".github/agents/interest-letter.md",
    "src/agents/frontmatter/claude/cover-letter-tailor.yaml",
    "src/agents/frontmatter/claude/interest-letter.yaml",
    "src/agents/frontmatter/codex/cover-letter-tailor.toml",
    "src/agents/frontmatter/codex/interest-letter.toml",
    "src/agents/frontmatter/copilot/cover-letter-tailor.yaml",
    "src/agents/frontmatter/copilot/interest-letter.yaml",
    "src/agents/frontmatter/opencode/cover-letter-tailor.yaml",
    "src/agents/frontmatter/opencode/interest-letter.yaml",
    "src/tui/src/ui/LettersScreen.tsx",
    "src/tui/src/letters.ts",
]


def sha256(root: str, rel: str) -> str:
    with open(os.path.join(root, rel), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def read_version(root: str) -> str:
    try:
        with open(os.path.join(root, "VERSION"), "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return "unknown"


def build(root: str) -> dict:
    files = {}
    missing = []
    for rel in sorted(TRACKED):
        if os.path.exists(os.path.join(root, rel)):
            files[rel] = sha256(root, rel)
        else:
            missing.append(rel)
    if missing:
        print(f"build_integrity_manifest: ERROR: tracked files missing: {missing}", file=sys.stderr)
        raise SystemExit(1)
    return {
        "version": read_version(root),
        "files": files,
        "forbidden": sorted(FORBIDDEN),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="build_integrity_manifest.py")
    parser.add_argument("--root", default=".")
    parser.add_argument("--check", action="store_true", help="exit 1 if the on-disk manifest is stale")
    args = parser.parse_args(argv)

    manifest = build(args.root)
    out_path = os.path.join(args.root, MANIFEST_PATH)
    rendered = json.dumps(manifest, indent=2, sort_keys=True) + "\n"

    if args.check:
        try:
            with open(out_path, "r", encoding="utf-8") as fh:
                current = fh.read()
        except OSError:
            current = ""
        if current != rendered:
            print(f"build_integrity_manifest: STALE ({MANIFEST_PATH}); re-run without --check", file=sys.stderr)
            return 1
        print("build_integrity_manifest: check OK", file=sys.stderr)
        return 0

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(rendered)
    print(f"build_integrity_manifest: wrote {MANIFEST_PATH} ({len(manifest['files'])} files)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
