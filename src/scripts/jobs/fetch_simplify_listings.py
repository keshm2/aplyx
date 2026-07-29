#!/usr/bin/env python3
"""fetch_simplify_listings.py — SimplifyJobs ingestion (Phase 5).

Fetches the project-owned SimplifyJobs listing feeds (raw GitHub JSON —
no auth, no scraping), filters to active + visible postings, and emits
one raw-job JSON object per line on stdout, shaped for
`src/scripts/state/job_state.py canonicalize`.

Feeds are configured in src/config/targets.json:

  "simplify_feeds": ["summer_internships", "new_grad"]

Skip behavior mirrors the other optional boards: a missing, empty, or
placeholder-only ("REPLACE_ME") simplify_feeds array means the board is
skipped — a single warning goes to stderr, nothing is written to
stdout, and the exit code is 0 so the run continues.

Output contract:
  stdout — raw-job JSONL only (one JSON object per line), sorted by
           (company, title, external_job_id) for deterministic review.
  stderr — warnings and a final machine-parseable summary line:
           fetch_simplify_listings: complete feeds=<n> jobs=<n> failed=<n>

The emitted `sponsorship` field is informational/audit-only — the
phase 4 fit gate remains the only classifier.

Exit codes:
  0  success, or a clean configured skip
  1  usage/config error (unreadable targets file, invalid JSON)
  3  every configured feed failed to fetch (partial failure exits 0)

Usage:
  python3 src/scripts/jobs/fetch_simplify_listings.py
  python3 src/scripts/jobs/fetch_simplify_listings.py --targets src/config/targets.json
  python3 src/scripts/jobs/fetch_simplify_listings.py --feeds summer_internships --limit 50
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_TARGETS = "src/config/targets.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/phase5 (+https://github.com/SimplifyJobs)"

# Project-owned feed map. Adding a feed here is a code change reviewed in
# a PR — feeds are never taken from remote config at run time.
FEEDS = {
    "summer_internships": {
        "url": (
            "https://raw.githubusercontent.com/SimplifyJobs/"
            "Summer2026-Internships/dev/.github/scripts/listings.json"
        ),
        "role_type": "internship",
    },
    "new_grad": {
        "url": (
            "https://raw.githubusercontent.com/SimplifyJobs/"
            "New-Grad-Positions/dev/.github/scripts/listings.json"
        ),
        "role_type": "new_grad",
    },
}


def warn(msg: str) -> None:
    print(f"fetch_simplify_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "int":
    print(f"fetch_simplify_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def load_configured_feeds(targets_path: str) -> list:
    """Return the configured feed names, or [] for a clean skip."""
    if not os.path.exists(targets_path):
        die(f"targets config not found: {targets_path}")
    try:
        with open(targets_path, "r", encoding="utf-8") as f:
            targets = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read targets config {targets_path}: {exc}")
    if not isinstance(targets, dict):
        die(f"targets config must be a JSON object")

    raw = targets.get("simplify_feeds")
    if raw is None:
        warn("simplify_feeds is not configured — SimplifyJobs board skipped this run")
        return []
    if not isinstance(raw, list):
        die("targets config field 'simplify_feeds' must be an array")

    feeds = []
    for entry in raw:
        name = str(entry).strip()
        if not name or name.lower() == PLACEHOLDER:
            continue
        feeds.append(name)
    if not feeds:
        warn(
            "simplify_feeds is empty or placeholder-only — "
            "SimplifyJobs board skipped this run"
        )
        return []
    return feeds


def fetch_feed(url: str, timeout: int) -> list:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    if not isinstance(data, list):
        raise ValueError("feed did not return a JSON array")
    return data


def to_raw_job(listing: dict, role_type: str) -> dict:
    """Map one SimplifyJobs listing to the raw-job shape canonicalize expects."""
    locations = [
        str(loc).strip()
        for loc in (listing.get("locations") or [])
        if str(loc).strip()
    ]
    terms = [
        str(t).strip()
        for t in (listing.get("terms") or [])
        if str(t).strip() and str(t).strip().upper() != "N/A"
    ]
    return {
        "source": "simplify",
        "company": str(listing.get("company_name", "")).strip(),
        "title": str(listing.get("title", "")).strip(),
        "url": str(listing.get("url", "")).strip(),
        "external_job_id": str(listing.get("id", "")).strip(),
        "location": "; ".join(locations),
        "internship_term": terms[0] if terms else "",
        "role_type": role_type,
        # jd_text is intentionally absent: the feed carries no JD body.
        # The orchestrator must fetch the JD from `url` before running
        # the fit gate (see AGENTS.md "Board-specific fetch method").
        "sponsorship": str(listing.get("sponsorship", "")).strip(),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_simplify_listings.py",
        description="Fetch SimplifyJobs feeds and emit raw-job JSONL (Phase 5).",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument(
        "--feeds",
        default="",
        help="comma-separated feed names; overrides config (for testing)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="max jobs to emit per feed (0 = no cap)",
    )
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args(argv)

    if args.feeds:
        feeds = [f.strip() for f in args.feeds.split(",") if f.strip()]
    else:
        feeds = load_configured_feeds(args.targets)
    if not feeds:
        print(
            "fetch_simplify_listings: complete feeds=0 jobs=0 failed=0",
            file=sys.stderr,
        )
        return 0

    fetched_feeds = 0
    failed_feeds = 0
    jobs = []
    for name in feeds:
        spec = FEEDS.get(name)
        if spec is None:
            warn(
                f"unknown feed '{name}' (known: {', '.join(sorted(FEEDS))}) — skipped"
            )
            continue
        try:
            listings = fetch_feed(spec["url"], args.timeout)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            warn(f"feed '{name}' failed to fetch: {exc} — skipped")
            failed_feeds += 1
            continue
        fetched_feeds += 1
        count = 0
        for listing in listings:
            if not isinstance(listing, dict):
                continue
            if not (listing.get("active") is True and listing.get("is_visible") is True):
                continue
            raw = to_raw_job(listing, spec["role_type"])
            if not (raw["company"] and raw["title"] and raw["url"]):
                continue
            jobs.append(raw)
            count += 1
            if args.limit and count >= args.limit:
                break

    jobs.sort(key=lambda j: (j["company"].lower(), j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))

    print(
        f"fetch_simplify_listings: complete feeds={fetched_feeds} "
        f"jobs={len(jobs)} failed={failed_feeds}",
        file=sys.stderr,
    )
    if failed_feeds and not fetched_feeds:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
