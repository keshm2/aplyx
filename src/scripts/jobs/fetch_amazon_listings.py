#!/usr/bin/env python3
"""fetch_amazon_listings.py — Amazon company-specific careers board (Phase 16B).

Amazon exposes a public, auth-free JSON search API used by its own
careers site (no API key, no Playwright needed):

  GET https://www.amazon.jobs/en/search.json?base_query=<query>&result_limit=<n>&offset=<n>

Unlike the ATS-vendor sources (Ashby/Lever/Greenhouse/SmartRecruiters),
Amazon is a single company, not a multi-tenant product — there is no
per-company slug to configure. Enable it by adding "amazon" to
config/targets.json "boards", same as linkedin/indeed/wellfound/handshake
(this helper has no config file of its own to be placeholder/unconfigured;
the orchestrator decides whether to call it based on "boards").

The list response carries FULL JD text (description + basic_qualifications
+ preferred_qualifications, confirmed live) — no separate per-posting
detail fetch needed, unlike Workday/SmartRecruiters.

Output contract:
  stdout — raw-job JSONL, sorted by (title, external_job_id).
  stderr — a machine-parseable summary line:
           fetch_amazon_listings: complete jobs=<n> failed=<true|false>

Exit codes:
  0  success (including zero matches)
  3  the request failed entirely (network error on the first page)

Usage:
  python3 src/scripts/jobs/fetch_amazon_listings.py --search "software engineer intern" --limit 200
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from _jd_text import extract_pay, join_sections

USER_AGENT = "aplyx-job-agent/phase16b"
API_BASE = "https://www.amazon.jobs/en/search.json"
PAGE_SIZE = 100


def warn(msg: str) -> None:
    print(f"fetch_amazon_listings: WARNING: {msg}", file=sys.stderr)


def parse_posted_date(text: str):
    """'May 13, 2026' -> ISO date, or None if unparseable."""
    try:
        dt = datetime.strptime(text.strip(), "%B %d, %Y").replace(tzinfo=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, AttributeError):
        return None


def api_get(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def to_raw_job(job: dict) -> dict:
    title = str(job.get("title", "")).strip()
    job_path = str(job.get("job_path", "")).strip()
    job_id = str(job.get("id_icims") or job.get("id") or "").strip()
    jd_text = join_sections(
        [
            (None, str(job.get("description", ""))),
            ("Basic Qualifications", str(job.get("basic_qualifications", ""))),
            ("Preferred Qualifications", str(job.get("preferred_qualifications", ""))),
        ]
    )
    raw = {
        "source": "amazon",
        "company": str(job.get("company_name") or "Amazon").strip(),
        "title": title,
        "url": f"https://www.amazon.jobs{job_path}" if job_path else str(job.get("url_next_step", "")).strip(),
        "apply_url": str(job.get("url_next_step", "")).strip() or None,
        "external_job_id": job_id,
        "location": str(job.get("normalized_location") or job.get("location") or "").strip(),
        "jd_text": jd_text,
        "pay_text": extract_pay(jd_text),
    }
    posted = parse_posted_date(str(job.get("posted_date", "")))
    if posted:
        raw["posted_at"] = posted
    return raw


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_amazon_listings.py",
        description="Fetch Amazon postings via the public amazon.jobs search API (Phase 16B).",
    )
    parser.add_argument("--search", default="", help="search query, e.g. 'software engineer intern'")
    parser.add_argument("--limit", type=int, default=200, help="max postings total (0 = no cap)")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args(argv)

    jobs = []
    offset = 0
    failed = False
    try:
        while True:
            page_size = min(PAGE_SIZE, args.limit - len(jobs)) if args.limit else PAGE_SIZE
            if args.limit and page_size <= 0:
                break
            params = {"base_query": args.search, "result_limit": page_size, "offset": offset}
            data = api_get(f"{API_BASE}?{urllib.parse.urlencode(params)}", args.timeout)
            raw_jobs = data.get("jobs") or []
            for job in raw_jobs:
                raw = to_raw_job(job)
                if raw["title"] and raw["url"] and raw["external_job_id"]:
                    jobs.append(raw)
            offset += page_size
            total = int(data.get("hits", 0))
            if not raw_jobs or offset >= total or (args.limit and len(jobs) >= args.limit):
                break
    except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
        warn(f"request failed: {exc}")
        failed = True

    jobs.sort(key=lambda j: (j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_amazon_listings: complete jobs={len(jobs)} failed={str(failed).lower()}",
        file=sys.stderr,
    )
    if failed and not jobs:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
