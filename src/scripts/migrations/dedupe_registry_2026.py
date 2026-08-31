#!/usr/bin/env python3
"""dedupe_registry_2026.py: one-time repair for split-job_key duplicates.

derive_job_key() (src/scripts/state/job_state.py) prioritizes apply_url
over url: a job scraped once before its apply_url was extracted and
again after (a fetcher improvement, or a source that only sometimes
returns it) gets two different job_keys for one real posting, and
upsert_job's exact job_key match won't catch it. The natural-key fallback
in upsert_job (_find_record_by_natural_key) now prevents *new* duplicates
going forward, but doesn't retroactively repair rows already split before
that fallback existed; this script is that one-time repair.

Deliberately NOT a job_state.py subcommand: job_state.py's CLI is a
frozen, canonical surface with real ongoing callers (job-scraper.md, the
TUI, the Tauri bridge); a one-off historical migration that becomes a
no-op the moment nothing groups together anymore doesn't belong bolted
onto that surface permanently. This script imports job_state.py's own
helpers (load_json_array, save_json_array, merge_job, _natural_key) as a
library instead of reimplementing them, so the merge semantics are
identical to what upsert_job already does for real-time cross-source
merges.

Safe to re-run: a no-op once nothing groups together. Back up
data/job_registry.json first if you want an undo path; this repo's
data/ files aren't tracked by git.

Usage:
  python3 src/scripts/migrations/dedupe_registry_2026.py
  python3 src/scripts/migrations/dedupe_registry_2026.py --registry path/to/job_registry.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "state"))
from job_state import DEFAULT_REGISTRY, _natural_key, load_json_array, merge_job, save_json_array  # noqa: E402


def dedupe_registry(registry_path: str) -> dict:
    """Merge registry rows that are the same real posting under different
    job_keys. Groups by natural_key (company+title+location+role_type),
    falling back to job_id, then a singleton per-record key when neither
    is derivable, so a record with no grouping signal is never silently
    dropped. Within a group, the earliest-first-seen row survives and
    every other row is folded into it via merge_job (same field-adoption
    rules real-time cross-source merges already use: richer jd_text,
    combined sources, earliest first_seen_at, latest last_seen_at,
    non-'new' status preferred); the discarded rows' own job_keys are not
    preserved anywhere, matching merge_job's "job_key is the identity"
    contract: one surviving identity per real posting.
    """
    registry = load_json_array(registry_path)
    groups: dict = {}
    order = []
    for rec in registry:
        key = _natural_key(rec)
        if not key and rec.get("job_id"):
            key = f"jobid:{rec['job_id']}"
        if not key:
            key = f"singleton:{rec.get('job_key') or id(rec)}"
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(rec)

    merged_registry = []
    groups_merged = 0
    rows_merged_away = 0
    for key in order:
        group = groups[key]
        if len(group) == 1:
            merged_registry.append(group[0])
            continue
        group_sorted = sorted(group, key=lambda r: r.get("first_seen_at", ""))
        survivor = group_sorted[0]
        for dup in group_sorted[1:]:
            merge_job(survivor, dup)
            rows_merged_away += 1
        merged_registry.append(survivor)
        groups_merged += 1

    save_json_array(registry_path, merged_registry)
    return {
        "ok": True,
        "before": len(registry),
        "after": len(merged_registry),
        "groups_merged": groups_merged,
        "rows_merged_away": rows_merged_away,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default=DEFAULT_REGISTRY)
    args = parser.parse_args(argv)
    result = dedupe_registry(args.registry)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
