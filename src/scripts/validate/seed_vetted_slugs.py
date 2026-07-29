#!/usr/bin/env python3
"""seed_vetted_slugs.py — vetted slug auto-seeding (Phase 6, extended Phase 16B).

Seeds the Ashby / Lever / Greenhouse / SmartRecruiters company-slug
arrays in src/config/targets.json from the project-owned vetted lists
(src/config/ashby_vetted_slugs.json, src/config/lever_vetted_slugs.json,
config/greenhouse_vetted_slugs.json, src/config/smartrecruiters_vetted_slugs.json)
so a fresh clone has real board coverage on the first run.

Seeding rules (per slug array, independently):
  - Seed ONLY when the user's array is unset (key missing), empty
    ([]), or placeholder-only (every entry is "REPLACE_ME" —
    case-insensitive, whitespace-trimmed — or blank).
  - NEVER overwrite a non-placeholder value: if even one entry is a
    real slug, the array is treated as a deliberate user choice and
    left untouched.
  - Deterministic and idempotent: seeding writes the vetted list
    verbatim; a second run sees real slugs and does nothing.

The write is a single atomic JSON write of src/config/targets.json
(temp file + os.replace in the same directory) preserving key order —
never a hand-rolled jq mutation. When anything is seeded, a visible
WARNING goes to stderr so the user can review (and `git diff` /
hand-revert) the change.

The vetted lists are trust-bearing, project-owned artifacts: additions
are code changes reviewed in PRs, and nothing is fetched from a remote
source at run time.

Exit codes:
  0  success (seeded, or nothing to do, or vetted list missing — warn)
  1  usage/config error (unreadable targets file, invalid JSON)

Usage:
  python3 src/scripts/validate/seed_vetted_slugs.py
  python3 src/scripts/validate/seed_vetted_slugs.py --targets src/config/targets.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

DEFAULT_TARGETS = "src/config/targets.json"
PLACEHOLDER = "replace_me"

# targets.json key -> vetted list filename (resolved next to targets.json).
SOURCES = {
    "ashby_company_slugs": "ashby_vetted_slugs.json",
    "lever_company_slugs": "lever_vetted_slugs.json",
    "greenhouse_company_slugs": "greenhouse_vetted_slugs.json",
    "smartrecruiters_company_slugs": "smartrecruiters_vetted_slugs.json",
}


def warn(msg: str) -> None:
    print(f"seed_vetted_slugs: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "int":
    print(f"seed_vetted_slugs: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def is_placeholder_state(value) -> bool:
    """True when the slug array is unset, empty, or placeholder-only."""
    if value is None:
        return True
    if not isinstance(value, list):
        return False
    for entry in value:
        text = str(entry).strip()
        if text and text.lower() != PLACEHOLDER:
            return False
    return True


def load_vetted_slugs(path: str) -> list | None:
    """Return the vetted slug list, or None (with a warning) when unusable."""
    if not os.path.exists(path):
        warn(f"vetted list not found: {path} — source left unseeded")
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            vetted = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        warn(f"could not read vetted list {path}: {exc} — source left unseeded")
        return None
    slugs = vetted.get("slugs") if isinstance(vetted, dict) else None
    if not isinstance(slugs, list):
        warn(f"vetted list {path} has no 'slugs' array — source left unseeded")
        return None
    cleaned = [str(s).strip() for s in slugs if str(s).strip()]
    if not cleaned:
        warn(f"vetted list {path} is empty — source left unseeded")
        return None
    return cleaned


def atomic_write_json(path: str, data: dict) -> None:
    """Single atomic JSON write: temp file in the same dir + os.replace."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp_path = tempfile.mkstemp(prefix=".targets.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="seed_vetted_slugs.py",
        description="Seed placeholder Ashby/Lever/Greenhouse/SmartRecruiters slug arrays from vetted lists (Phase 6/16B).",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    args = parser.parse_args(argv)

    if not os.path.exists(args.targets):
        die(f"targets config not found: {args.targets}")
    try:
        with open(args.targets, "r", encoding="utf-8") as f:
            targets = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read targets config {args.targets}: {exc}")
    if not isinstance(targets, dict):
        die("targets config must be a JSON object")

    config_dir = os.path.dirname(os.path.abspath(args.targets))
    seeded = 0
    skipped = 0
    for key, vetted_name in SOURCES.items():
        current = targets.get(key)
        if not is_placeholder_state(current):
            skipped += 1
            continue
        vetted_path = os.path.join(config_dir, vetted_name)
        slugs = load_vetted_slugs(vetted_path)
        if slugs is None:
            skipped += 1
            continue
        targets[key] = slugs
        seeded += 1
        warn(
            f"{key} auto-seeded from vetted list {vetted_name} "
            f"({len(slugs)} slugs) — review the change in {args.targets} "
            f"and edit/revert if unwanted"
        )

    if seeded:
        try:
            atomic_write_json(args.targets, targets)
        except OSError as exc:
            die(f"could not write {args.targets}: {exc}")

    print(
        f"seed_vetted_slugs: complete seeded={seeded} skipped={skipped}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
