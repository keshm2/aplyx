#!/usr/bin/env python3
"""fetch_muse_listings.py: The Muse company-specific careers board (Phase 16B).

The Muse exposes a public, auth-free JSON API (no API key required for
read access; registering one raises the rate limit to 3,600 req/hour:
see https://www.themuse.com/developers/api/v2):

  GET https://www.themuse.com/api/public/jobs?category=<cat>&level=<lvl>&page=<n>

Unlike the ATS-vendor sources (Ashby/Lever/Greenhouse/SmartRecruiters),
The Muse is itself an aggregator across many employers and many
underlying ATSes: its own "landing_page" URL is Muse-hosted, not the
employer's real application URL, so a Muse-sourced job's `ats_system`
stays unresolved (same class as "simplify"/"vanshb03"; see
job_state.py's ATS_SOURCE_MAP, which intentionally has no "muse" entry).
The generic Playwright-driven apply flow (AGENTS.md "Fill records") still
works fine against a Muse landing page; it just clicks through to
whatever real application form is on the other end, the same way it
would for any other job's `url`.

Confirmed live 2026-08-10: level=Internship alone is ~398 pages (~7,960
jobs) across ALL of Muse's industry categories, most irrelevant to a
tech-internship search. level=Entry Level is dramatically noisier:
"Software Engineering" + "Entry Level" alone is 1,518 pages (~30,360
jobs), a strong signal this level tag is applied far more loosely than
"actually entry-level" by posting employers. To keep this source
reliable rather than a volume dump, this helper defaults to
level=Internship only, scoped to a fixed, empirically-verified set of
tech-relevant categories (CATEGORIES below) rather than every category
Muse has: "IT" and "Data Science" were tried and don't exist as real
category values on this API (0 results, silently accepted rather than
erroring, which is why the category list here was verified against live
data rather than guessed from docs).

The list response carries FULL JD text (the "contents" field, HTML);
no separate per-posting detail fetch needed, unlike Workday/
SmartRecruiters/Oracle/Eightfold.

Output contract:
  stdout: raw-job JSONL, sorted by (title, external_job_id).
  stderr: a machine-parseable summary line:
           fetch_muse_listings: complete jobs=<n> failed=<true|false>

Exit codes:
  0  success (including zero matches)
  3  every category request failed entirely

Usage:
  python3 src/scripts/jobs/fetch_muse_listings.py --limit 200
  python3 src/scripts/jobs/fetch_muse_listings.py --search "software engineer intern" --limit 50
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from _jd_text import extract_pay, html_to_text

USER_AGENT = "aplyx-job-agent/phase16b (+https://github.com/keshm2/aplyx)"
API_BASE = "https://www.themuse.com/api/public/jobs"
PAGE_LIMIT = 20  # fixed by the API, not a param, just documenting the page size.

# Verified live 2026-08-10 against level=Internship (see module docstring):
# the only category values on this API that returned non-zero results
# for a tech/eng/PM search. "IT" and "Data Science" are not real category
# values on this API (0 results each) despite showing up in some
# third-party docs.
CATEGORIES = [
    "Software Engineering",
    "Data and Analytics",
    "Science and Engineering",
    "Product Management",
]


def warn(msg: str) -> None:
    print(f"fetch_muse_listings: WARNING: {msg}", file=sys.stderr)


def api_get(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def to_raw_job(job: dict) -> dict:
    locations = sorted(
        str(loc.get("name", "")).strip()
        for loc in (job.get("locations") or [])
        if str(loc.get("name", "")).strip()
    )
    company = job.get("company") or {}
    jd_text = html_to_text(str(job.get("contents", "")))
    return {
        "source": "muse",
        "company": str(company.get("name", "")).strip(),
        "title": str(job.get("name", "")).strip(),
        "url": str((job.get("refs") or {}).get("landing_page", "")).strip(),
        "external_job_id": str(job.get("id", "")).strip(),
        "location": "; ".join(locations),
        "role_type": "internship",
        "jd_text": jd_text,
        "pay_text": extract_pay(jd_text),
        "posted_at": str(job.get("publication_date", "")).strip() or None,
    }


def fetch_category(category: str, timeout: int, limit: int) -> tuple[list[dict], bool]:
    jobs: list[dict] = []
    page = 0
    failed = False
    while True:
        params = {"category": category, "level": "Internship", "page": page}
        try:
            data = api_get(f"{API_BASE}?{urllib.parse.urlencode(params)}", timeout)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            warn(f"category '{category}' page {page} failed: {exc}")
            failed = True
            break
        results = data.get("results") or []
        for job in results:
            raw = to_raw_job(job)
            if raw["company"] and raw["title"] and raw["url"] and raw["external_job_id"]:
                jobs.append(raw)
            if limit and len(jobs) >= limit:
                return jobs, failed
        page += 1
        page_count = int(data.get("page_count", 0))
        if not results or page >= page_count:
            break
    return jobs, failed


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_muse_listings.py",
        description="Fetch The Muse's internship postings via its public jobs API (Phase 16B).",
    )
    parser.add_argument(
        "--search", default="",
        help="case-insensitive substring filter on title (client-side: the API has no free-text search)",
    )
    parser.add_argument("--limit", type=int, default=200, help="max postings total (0 = no cap)")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args(argv)

    jobs: list[dict] = []
    any_ok = False
    for category in CATEGORIES:
        remaining = (args.limit - len(jobs)) if args.limit else 0
        if args.limit and remaining <= 0:
            break
        cat_jobs, failed = fetch_category(category, args.timeout, remaining if args.limit else 0)
        if not failed:
            any_ok = True
        jobs.extend(cat_jobs)

    if args.search:
        needle = args.search.strip().lower()
        terms = [t for t in needle.split() if t]
        jobs = [j for j in jobs if all(t in j["title"].lower() for t in terms)]

    failed = not any_ok and not jobs

    jobs.sort(key=lambda j: (j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_muse_listings: complete jobs={len(jobs)} failed={str(failed).lower()}",
        file=sys.stderr,
    )
    if failed:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
