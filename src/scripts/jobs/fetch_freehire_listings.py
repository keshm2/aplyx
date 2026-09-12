#!/usr/bin/env python3
"""fetch_freehire_listings.py: freehire aggregator board (github.com/strelov1/freehire).

freehire exposes a public, keyless JSON API (no API key required for the
plain jobs-search surface):

  GET https://freehire.me/api/v1/agent/jobs/search?<filters>

Unlike The Muse (see fetch_muse_listings.py), freehire is an aggregator
whose OWN response tags each posting with the real underlying board/ATS
in its `source` field (confirmed live 2026-09-12: values seen include
"lever", "eightfold", "recruitee", "amazon", "successfactors",
"paylocity", "zohorecruit", "whatjobs") and whose `url` is the real
employer-hosted ATS URL (freehire appends only a `?utm_source=freehire.me`
tracking param, which job_state.py's normalize_url() already strips as a
generic "utm_*" tracking param). Two consequences, both load-bearing:

1. `source` on every raw job below is freehire's own field value, NEVER
   the literal string "freehire" — freehire is a fetch mechanism, not a
   job board, and reporting it as the source would misattribute every
   posting to a "board" that doesn't actually host any of them (operator
   instruction, 2026-09-12).
2. Dedup against a board also reachable through a direct-API fetcher
   above (e.g. this same posting also being visible via Ashby/Lever/
   Greenhouse) is automatic, not new logic: once the utm_source param is
   stripped, the normalized URL matches exactly, so job_state.py's
   existing job_key derivation (URL first) finds the SAME job_key either
   fetcher produces. The natural-key fallback
   (_find_record_by_natural_key, already built for aggregators whose URL
   is their own landing page rather than the employer's) is a second
   safety net, not the primary path, for a source shaped like this one.

`--search` is sent server-side as freehire's own full-text `q` param
(confirmed live against a real query returns well-targeted, correctly
enrichment-tagged results, e.g. "software engineer intern" surfacing
Ibotta/L3Harris/Motorola/EA internships with enrichment.seniority=intern
already set) — same convention as fetch_amazon_listings.py's
`base_query`/fetch_oracle_listings.py's `--search`: job-scraper.md passes
the same role/level query used for prefiltering (step 0/8), one call,
rather than looping per role_keyword. Two documented filter params that
looked promising were tried live and dropped: `seniority=intern` is
accepted but silently has no effect (`ignored_params` on `/jobs`, zero
results when combined with `q` on `/jobs/search` and `/agent/jobs/search`
alike — 2026-09-12), and `is_tech=true` per the docs' stated boolean type
also zeroes every result; `is_tech=tech` (the enrichment field's own
string value) does work, but was left out here rather than risk
narrowing away non-"tech"-tagged security/network roles aplyx also
targets, unverified against those categories. If freehire fixes
`seniority` or `is_tech`'s documented behavior later, revisit adding it
back as a second server-side narrowing pass.

`description_format=markdown` avoids the HTML-strip pass other sources
need for their raw `content`/`description` field; salary is read from
freehire's own structured salary_min/max/currency/period fields when
present (more precise than mining a pay line out of free text), falling
back to extract_pay(jd_text) only when they're absent.

Output contract:
  stdout: raw-job JSONL, sorted by (title, external_job_id).
  stderr: a machine-parseable summary line:
           fetch_freehire_listings: complete jobs=<n> failed=<true|false>

Exit codes:
  0  success (including zero matches)
  3  every page request failed entirely

Usage:
  python3 src/scripts/jobs/fetch_freehire_listings.py --limit 200
  python3 src/scripts/jobs/fetch_freehire_listings.py --search "software engineer" --limit 50
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from _jd_text import extract_pay

USER_AGENT = "aplyx-job-agent (+https://github.com/keshm2/aplyx)"
API_BASE = "https://freehire.me/api/v1/agent/jobs/search"
PAGE_SIZE = 100  # API max per freehire.me/docs/api.
MAX_OFFSET = 10000  # API-enforced: offset + limit <= 10000.


def warn(msg: str) -> None:
    print(f"fetch_freehire_listings: WARNING: {msg}", file=sys.stderr)


def api_get(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _pay_text(job: dict) -> str | None:
    lo, hi, cur = job.get("salary_min"), job.get("salary_max"), job.get("salary_currency") or "USD"
    period = job.get("salary_period") or "yr"
    if lo and hi:
        return f"{cur} {lo:,.0f}–{hi:,.0f}/{period}"
    return extract_pay(str(job.get("description", "")))


def to_raw_job(job: dict) -> dict:
    jd_text = str(job.get("description", "")).strip()
    return {
        # NOT "freehire": freehire's own field already names the real
        # board a posting lives on. Falling back to "freehire" only
        # covers a malformed response missing the field entirely.
        "source": str(job.get("source", "") or "freehire").strip().lower(),
        "company": str(job.get("company", "")).strip(),
        "title": str(job.get("title", "")).strip(),
        "url": str(job.get("url", "")).strip(),
        "external_job_id": str(job.get("external_id", "") or job.get("public_slug", "")).strip(),
        "location": str(job.get("location", "")).strip(),
        "role_type": "internship",
        "jd_text": jd_text,
        "pay_text": _pay_text(job),
        "posted_at": str(job.get("posted_at", "")).strip() or None,
    }


def fetch_all(query: str, timeout: int, limit: int) -> tuple[list[dict], bool]:
    jobs: list[dict] = []
    offset = 0
    failed = False
    while offset < MAX_OFFSET:
        page_size = min(PAGE_SIZE, MAX_OFFSET - offset)
        if limit:
            page_size = min(page_size, limit - len(jobs))
            if page_size <= 0:
                break
        params = {
            "q": query,
            "description_format": "markdown",
            "limit": page_size,
            "offset": offset,
        }
        try:
            data = api_get(f"{API_BASE}?{urllib.parse.urlencode(params)}", timeout)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            warn(f"offset {offset} failed: {exc}")
            failed = True
            break
        results = data.get("data") or []
        for job in results:
            raw = to_raw_job(job)
            if raw["company"] and raw["title"] and raw["url"] and raw["external_job_id"]:
                jobs.append(raw)
        if len(results) < page_size:
            break  # last page
        offset += page_size
    return jobs, failed


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_freehire_listings.py",
        description="Fetch postings via freehire's public aggregator API, source-attributed to the real underlying board.",
    )
    parser.add_argument(
        "--search", required=True,
        help="full-text query sent server-side as freehire's own 'q' param, e.g. 'software engineer intern'",
    )
    parser.add_argument("--limit", type=int, default=200, help="max postings total (0 = no cap, bounded by MAX_OFFSET regardless)")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args(argv)

    jobs, failed = fetch_all(args.search, args.timeout, args.limit)
    failed = failed and not jobs

    jobs.sort(key=lambda j: (j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_freehire_listings: complete jobs={len(jobs)} failed={str(failed).lower()}",
        file=sys.stderr,
    )
    if failed:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
