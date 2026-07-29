#!/usr/bin/env python3
"""fetch_gem_listings.py — Gem-powered job boards (Recruiting CRM/ATS).

Gem (jobs.gem.com/<company>) has a real, public, unauthenticated GraphQL
API — confirmed live (2026-07-26) via a real browser session's network
traffic (Playwright), which is how the correct path was actually found:

  POST https://jobs.gem.com/api/public/graphql/batch

An earlier research pass concluded Gem wasn't accessible and got a 403
— that was from guessing the WRONG path (`/api/graphql`, missing both
`/public/` and `/batch`). The real endpoint needs no session, no
cookies, no special headers at all (confirmed live with a bare
`curl -X POST` and nothing else) — its GraphQL schema even names every
type `Public*` (`PublicOatsJobPost`, `PublicOatsLocation`, ...),
confirming this was always meant to be a plain public API; the 403 was
never bot/CAPTCHA protection, just a routing miss on a different,
unrelated internal path.

The body is a JSON ARRAY of GraphQL operations (a "batch" request, not
one operation per call): `[{"operationName", "variables", "query"}, ...]`.
Response is an array of `{"data": {...}}` in the same order.

Like Ashby/Lever/Greenhouse, this is multi-company/multi-tenant with no
free-text search in the schema itself (JobBoardList takes only
`boardId`) — configured in src/config/targets.json as "gem_company_slugs"
(the <company> segment of jobs.gem.com/<company>), same convention as
those three. Filtering by role/level keywords happens downstream, same
as any other unfiltered-board source.

The list query carries no JD text; the detail query
(ExternalJobPostingQuery) does, confirmed live with a real, rich HTML
description — same two-step pattern as Oracle/Workday/SmartRecruiters.

Output contract:
  stdout — raw-job JSONL (list mode) or a single JD JSON (--jd-url),
           list mode sorted by (company, title, external_job_id).
  stderr — warnings and a machine-parseable summary line:
           fetch_gem_listings: complete companies=<n> jobs=<n> failed=<n>

Exit codes:
  0  success, or a clean configured skip
  1  usage/config error
  3  every configured company failed to fetch (partial failure exits 0)

Usage:
  python3 src/scripts/jobs/fetch_gem_listings.py --limit 200
  python3 src/scripts/jobs/fetch_gem_listings.py --jd-url 'https://jobs.gem.com/gem/4965519002'
"""

from __future__ import annotations

import argparse
import html as html_lib
import json
import os
import re
import sys
import urllib.error
import urllib.request

DEFAULT_TARGETS = "src/config/targets.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/ats-expansion"
API_URL = "https://jobs.gem.com/api/public/graphql/batch"

_LIST_QUERY = """
query JobBoardList($boardId: String!) {
  oatsExternalJobPostings(boardId: $boardId) {
    jobPostings {
      id
      extId
      title
      locations { name city isoCountry isRemote }
      job { department { name } locationType employmentType }
    }
  }
}
"""

_DETAIL_QUERY = """
query ExternalJobPostingQuery($boardId: String!, $extId: String!) {
  oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
    title
    descriptionHtml
    extId
    firstPublishedTsSec
    locations { name city isoCountry isRemote }
    job { department { name } locationType employmentType }
    jobPostSectionHtml { introHtml outroHtml }
    compensationHtml
  }
}
"""


def warn(msg: str) -> None:
    print(f"fetch_gem_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    print(f"fetch_gem_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def load_configured_companies(targets_path: str) -> list:
    if not os.path.exists(targets_path):
        die(f"targets config not found: {targets_path}")
    try:
        with open(targets_path, "r", encoding="utf-8") as f:
            targets = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read targets config {targets_path}: {exc}")
    raw = targets.get("gem_company_slugs")
    if raw is None:
        warn("gem_company_slugs is not configured — Gem board skipped this run")
        return []
    if not isinstance(raw, list):
        die("targets config field 'gem_company_slugs' must be an array")
    companies = [str(e).strip() for e in raw if str(e).strip() and str(e).strip().lower() != PLACEHOLDER]
    if not companies:
        warn("gem_company_slugs is empty or placeholder-only — Gem board skipped this run")
    return companies


def graphql_batch(operations: list, timeout: int) -> list:
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(operations).encode("utf-8"),
        method="POST",
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def strip_html(markup) -> str:
    if not isinstance(markup, str):
        return ""
    text = re.sub(r"<[^>]+>", " ", markup)
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def to_raw_job(posting: dict, company: str) -> dict:
    ext_id = str(posting.get("extId", "")).strip()
    locations = posting.get("locations") or []
    location_names = []
    for loc in locations:
        parts = [str(loc.get("name") or loc.get("city") or "").strip(), str(loc.get("isoCountry", "")).strip()]
        location_names.append(", ".join(p for p in parts if p))
    job = posting.get("job") or {}
    raw = {
        "source": "gem",
        "company": company,
        "title": str(posting.get("title", "")).strip(),
        "url": f"https://jobs.gem.com/{company}/{ext_id}",
        "external_job_id": ext_id,
        "location": "; ".join(n for n in location_names if n),
        # jd_text intentionally absent — fetch per candidate with
        # --jd-url after role filtering and BEFORE the fit gate (same
        # rule as the SimplifyJobs/Workday/Oracle/SmartRecruiters feeds).
    }
    department = (job.get("department") or {}).get("name")
    if department:
        raw["department"] = str(department).strip()
    return raw


def fetch_jd(url: str, timeout: int) -> dict:
    m = re.match(r"https?://jobs\.gem\.com/([^/]+)/([^/?]+)", url.strip())
    if m is None:
        die(f"unrecognized Gem posting URL shape: {url}")
    board_id, ext_id = m.group(1), m.group(2)
    try:
        result = graphql_batch([{"operationName": "ExternalJobPostingQuery", "variables": {"boardId": board_id, "extId": ext_id}, "query": _DETAIL_QUERY}], timeout)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
        die(f"JD fetch failed for {url}: {exc}")
    posting = ((result[0] or {}).get("data") or {}).get("oatsExternalJobPosting")
    if not posting:
        die(f"no posting data returned for {url} (removed, or board/id no longer valid)")
    section = posting.get("jobPostSectionHtml") or {}
    jd_parts = [strip_html(section.get("introHtml")), strip_html(posting.get("descriptionHtml")), strip_html(section.get("outroHtml")), strip_html(posting.get("compensationHtml"))]
    locations = posting.get("locations") or []
    location_names = [", ".join(p for p in (str(loc.get("name") or loc.get("city") or "").strip(), str(loc.get("isoCountry", "")).strip()) if p) for loc in locations]
    return {
        "source": "gem",
        "company": board_id,
        "title": str(posting.get("title", "")).strip(),
        "location": "; ".join(n for n in location_names if n),
        "url": url,
        "external_job_id": str(posting.get("extId", ext_id)).strip(),
        "jd_text": " ".join(p for p in jd_parts if p).strip(),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_gem_listings.py",
        description="Fetch postings from Gem-powered job boards via the public GraphQL batch API.",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument("--limit", type=int, default=200, help="max postings per company (0 = no cap)")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--jd-url", default="", help="fetch one posting's JD JSON instead of listing")
    args = parser.parse_args(argv)

    if args.jd_url:
        print(json.dumps(fetch_jd(args.jd_url, args.timeout), ensure_ascii=False))
        return 0

    companies = load_configured_companies(args.targets)
    if not companies:
        print("fetch_gem_listings: complete companies=0 jobs=0 failed=0", file=sys.stderr)
        return 0

    fetched = 0
    failed = 0
    jobs = []
    for company in companies:
        try:
            result = graphql_batch([{"operationName": "JobBoardList", "variables": {"boardId": company}, "query": _LIST_QUERY}], args.timeout)
            postings = (((result[0] or {}).get("data") or {}).get("oatsExternalJobPostings") or {}).get("jobPostings") or []
            count = 0
            for posting in postings:
                raw = to_raw_job(posting, company)
                if raw["title"] and raw["external_job_id"]:
                    jobs.append(raw)
                    count += 1
                if args.limit and count >= args.limit:
                    break
            fetched += 1
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            warn(f"company '{company}' failed to fetch: {exc} — skipped")
            failed += 1

    jobs.sort(key=lambda j: (j["company"], j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_gem_listings: complete companies={fetched} jobs={len(jobs)} failed={failed}",
        file=sys.stderr,
    )
    if failed and not fetched:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
