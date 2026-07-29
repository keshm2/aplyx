#!/usr/bin/env python3
"""build_discovered_companies.py — derive a large company+ATS+slug
directory from SimplifyJobs' public listing feeds.

The hand-vetted lists (src/config/{ashby,lever,greenhouse}_vetted_slugs.json)
are deliberately small — every entry there was individually verified
against its ATS's public API by a human, in a PR. This script covers the
opposite end of the tradeoff: it mines SimplifyJobs' much larger,
community-maintained internship/new-grad listing feeds (the same feeds
scripts/jobs/fetch_simplify_listings.py already fetches at runtime) for
job-posting URLs that reveal a company's Ashby/Lever/Greenhouse slug,
and writes every (company, vendor, slug) tuple it can parse out to
config/discovered_companies.json.

This is NOT hand-verified the way the vetted lists are — it's a
best-effort regex extraction over third-party data, reviewed here only
in aggregate (a real run against ~15k listings resolves ATS+slug for
roughly a third of the distinct companies present; the rest use
Workday, SmartRecruiters, Oracle Cloud, iCIMS, Workable, or a fully
custom careers page, none of which this script attempts to parse).
src/tui/src/data/companyDirectory.ts tags every entry from this file
tier: "discovered" and ranks it below "vetted" entries on a search-score
tie (see autocomplete.ts's filterSuggestions `weightOf` and
companyDirectory.ts's companyWeight).

SimplifyJobs' repos (github.com/SimplifyJobs/Summer2026-Internships,
github.com/SimplifyJobs/New-Grad-Positions) have no LICENSE file as of
this writing — there is no explicit written grant to redistribute a
derived dataset. This project already fetches the same raw JSON at
runtime for job listings (an established, narrower use); caching a
derived company/slug directory is a related but distinct downstream
use worth revisiting if this project's distribution ever broadens.

This is a manual/periodic refresh, not part of any automated run or
schedule — re-run it by hand when you want a bigger/fresher company
pool, review the diff, and commit it like any other vetted-list change.

Usage:
  python3 src/scripts/validate/build_discovered_companies.py
  python3 src/scripts/validate/build_discovered_companies.py --out src/config/discovered_companies.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_OUT = "src/config/discovered_companies.json"
USER_AGENT = "aplyx-job-agent/phase5 (+https://github.com/SimplifyJobs)"

# Same two feeds fetch_simplify_listings.py already pulls at runtime —
# kept as a separate copy here (not imported) since this is a one-off
# maintenance script, not part of the request-time fetch path.
FEED_URLS = [
    "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json",
    "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
]

# (vendor, slug) from a job-posting URL. Ashby/Lever job URLs always
# carry the slug as the first path segment; Greenhouse uses either
# hostname interchangeably (both boards.* and job-boards.* are seen in
# the wild) and is occasionally slug-less (an opaque embed token) —
# that shape just won't match and is silently skipped.
URL_PATTERNS = [
    ("ashby", re.compile(r"^https?://jobs\.ashbyhq\.com/([^/?#]+)", re.IGNORECASE)),
    ("lever", re.compile(r"^https?://jobs\.lever\.co/([^/?#]+)", re.IGNORECASE)),
    ("greenhouse", re.compile(r"^https?://(?:boards|job-boards)\.greenhouse\.io/([^/?#]+)", re.IGNORECASE)),
]


def warn(msg: str) -> None:
    print(f"build_discovered_companies: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "int":
    print(f"build_discovered_companies: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def fetch_feed(url: str, timeout: int) -> list:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    if not isinstance(data, list):
        raise ValueError("feed did not return a JSON array")
    return data


def extract_vendor_slug(url: str) -> tuple[str, str] | None:
    for vendor, pattern in URL_PATTERNS:
        m = pattern.match(url.strip())
        if m:
            return vendor, m.group(1).lower()
    return None


def atomic_write_json(path: str, data: dict) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".discovered.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, sort_keys=False)
            f.write("\n")
        os.replace(tmp_path, path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="build_discovered_companies.py",
        description="Derive a large company/ATS/slug directory from SimplifyJobs' listing feeds.",
    )
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args(argv)

    # company_name -> vendor -> set of slugs. A company can legitimately
    # have more than one board (subsidiaries, regional entities, or a
    # migration between ATSes mid-dataset) — every distinct one found is
    # kept rather than picked-and-discarded.
    companies: dict[str, dict[str, set]] = {}
    total_listings = 0
    failed_feeds = 0

    for url in FEED_URLS:
        try:
            listings = fetch_feed(url, args.timeout)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            warn(f"could not fetch {url}: {exc}")
            failed_feeds += 1
            continue
        total_listings += len(listings)
        for listing in listings:
            if not isinstance(listing, dict):
                continue
            name = str(listing.get("company_name", "")).strip()
            raw_url = str(listing.get("url", "")).strip()
            if not name or not raw_url:
                continue
            hit = extract_vendor_slug(raw_url)
            if hit is None:
                continue
            vendor, slug = hit
            companies.setdefault(name, {}).setdefault(vendor, set()).add(slug)

    if failed_feeds == len(FEED_URLS):
        die("every SimplifyJobs feed failed to fetch — nothing to write")

    entries = []
    for name in sorted(companies):
        for vendor in sorted(companies[name]):
            for slug in sorted(companies[name][vendor]):
                entries.append({"company_name": name, "vendor": vendor, "slug": slug})

    by_vendor = {"ashby": 0, "lever": 0, "greenhouse": 0}
    for e in entries:
        by_vendor[e["vendor"]] += 1

    output = {
        "_provenance": (
            "Auto-generated by src/scripts/validate/build_discovered_companies.py "
            "from SimplifyJobs' public listing feeds "
            "(github.com/SimplifyJobs/Summer2026-Internships, "
            "github.com/SimplifyJobs/New-Grad-Positions) — NOT individually "
            "hand-verified the way src/config/*_vetted_slugs.json entries are. "
            "Re-run the script to refresh; review the diff before committing."
        ),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source_urls": FEED_URLS,
        "source_listings_scanned": total_listings,
        "companies": entries,
    }

    try:
        atomic_write_json(args.out, output)
    except OSError as exc:
        die(f"could not write {args.out}: {exc}")

    print(
        f"build_discovered_companies: complete companies={len(entries)} "
        f"ashby={by_vendor['ashby']} lever={by_vendor['lever']} "
        f"greenhouse={by_vendor['greenhouse']} scanned={total_listings}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
