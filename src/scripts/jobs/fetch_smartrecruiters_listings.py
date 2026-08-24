#!/usr/bin/env python3
"""fetch_smartrecruiters_listings.py — SmartRecruiters ingestion (Phase 16B).

Fetches job postings from configured SmartRecruiters companies via the
public, auth-free Postings API (no scraping, no Playwright needed) and
emits one raw-job JSON object per line on stdout, shaped for
`src/scripts/state/job_state.py canonicalize`.

Companies are configured in src/config/targets.json as company identifiers
(the slug in a SmartRecruiters careers URL, e.g.
https://jobs.smartrecruiters.com/<CompanyIdentifier>/...):

  "smartrecruiters_company_slugs": ["Equinox"]

Skip behavior mirrors the other optional boards: a missing, empty, or
placeholder-only ("REPLACE_ME") smartrecruiters_company_slugs array means
the board is skipped — a warning goes to stderr, nothing on stdout, exit 0.

The list feed carries NO JD body (confirmed against the live API — the
list endpoint returns title/location/date only). After role filtering and
before the fit gate, the orchestrator fetches the JD per surviving
candidate, same rule as SimplifyJobs/Workday:

  python3 src/scripts/jobs/fetch_smartrecruiters_listings.py --jd-url '<posting-url>'

which prints one JSON object with jd_text (HTML stripped), title,
location, and url.

Output contract:
  stdout — raw-job JSONL (list mode) or a single JD JSON (--jd-url),
           list mode sorted by (company, title, external_job_id).
  stderr — warnings and a machine-parseable summary line:
           fetch_smartrecruiters_listings: complete companies=<n> jobs=<n> failed=<n>

Exit codes:
  0  success, or a clean configured skip
  1  usage/config error
  3  every configured company failed to fetch (partial failure exits 0)

Usage:
  python3 src/scripts/jobs/fetch_smartrecruiters_listings.py
  python3 src/scripts/jobs/fetch_smartrecruiters_listings.py --limit 200
  python3 src/scripts/jobs/fetch_smartrecruiters_listings.py --jd-url 'https://jobs.smartrecruiters.com/Equinox/744000138949777'
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

from _jd_text import extract_pay, join_sections

DEFAULT_TARGETS = "src/config/targets.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/phase16b"
API_BASE = "https://api.smartrecruiters.com/v1/companies"
PAGE_SIZE = 100  # API maximum per request


def warn(msg: str) -> None:
    print(f"fetch_smartrecruiters_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "int":
    print(f"fetch_smartrecruiters_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def load_configured_companies(targets_path: str) -> list:
    if not os.path.exists(targets_path):
        die(f"targets config not found: {targets_path}")
    try:
        with open(targets_path, "r", encoding="utf-8") as f:
            targets = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read targets config {targets_path}: {exc}")
    raw = targets.get("smartrecruiters_company_slugs")
    if raw is None:
        warn("smartrecruiters_company_slugs is not configured — SmartRecruiters board skipped this run")
        return []
    if not isinstance(raw, list):
        die("targets config field 'smartrecruiters_company_slugs' must be an array")
    companies = []
    for entry in raw:
        text = str(entry).strip()
        if not text or text.lower() == PLACEHOLDER:
            continue
        companies.append(text)
    if not companies:
        warn("smartrecruiters_company_slugs is empty or placeholder-only — SmartRecruiters board skipped this run")
    return companies


def api_get(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


_CAMEL_BOUNDARY_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _section_label(key: str) -> str:
    """SmartRecruiters' jobAd.sections keys are camelCase ("jobDescription",
    "qualifications", "companyDescription") — there's no separate
    human-readable title field per section, so the key itself, split on
    camelCase boundaries and title-cased, is the best heading available."""
    words = _CAMEL_BOUNDARY_RE.sub(" ", key).split()
    return " ".join(w.capitalize() for w in words) if words else key


def to_raw_job(posting: dict, company: str) -> dict:
    posting_id = str(posting.get("id", "")).strip()
    location = posting.get("location") or {}
    job = {
        "source": "smartrecruiters",
        "company": company,
        "title": str(posting.get("name", "")).strip(),
        # Confirmed live: the ID-only URL resolves directly (no redirect
        # needed) to the same posting the slugified postingUrl points at,
        # so list mode never needs a per-posting detail fetch just to
        # produce a working URL.
        "url": f"https://jobs.smartrecruiters.com/{company}/{posting_id}",
        "external_job_id": posting_id,
        "location": str(location.get("fullLocation", "")).strip(),
        # jd_text intentionally absent — fetch per candidate with
        # --jd-url after role filtering and BEFORE the fit gate (same
        # rule as the SimplifyJobs/Workday feeds).
    }
    released = str(posting.get("releasedDate", "")).strip()
    if released:
        job["posted_at"] = released
    return job


def fetch_jd(url: str, timeout: int) -> dict:
    """Posting URL -> JD JSON via the detail endpoint."""
    m = re.match(r"https?://jobs\.smartrecruiters\.com/([^/]+)/(\d+)", url.strip())
    if m is None:
        die(f"unrecognized SmartRecruiters posting URL shape: {url}")
    company, posting_id = m.group(1), m.group(2)
    info = api_get(f"{API_BASE}/{company}/postings/{posting_id}", timeout)
    sections = (info.get("jobAd") or {}).get("sections") or {}
    jd_text = join_sections(
        [(_section_label(key), str(section.get("text", ""))) for key, section in sections.items() if section.get("text")]
    )
    location = info.get("location") or {}
    return {
        "source": "smartrecruiters",
        "company": company,
        "title": str(info.get("name", "")).strip(),
        "location": str(location.get("fullLocation", "")).strip(),
        "url": str(info.get("postingUrl") or url).strip(),
        "apply_url": str(info.get("applyUrl") or "").strip() or None,
        "external_job_id": str(info.get("id", "")).strip(),
        "jd_text": jd_text,
        "pay_text": extract_pay(jd_text),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_smartrecruiters_listings.py",
        description="Fetch SmartRecruiters company postings via the public Postings API (Phase 16B).",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument(
        "--search", default="", help="keyword to narrow the feed server-side (e.g. 'intern')"
    )
    parser.add_argument(
        "--limit", type=int, default=200, help="max postings per company (0 = no cap)"
    )
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument(
        "--jd-url", default="", help="fetch one posting's JD JSON instead of listing"
    )
    args = parser.parse_args(argv)

    if args.jd_url:
        try:
            result = fetch_jd(args.jd_url, args.timeout)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            die(f"JD fetch failed for {args.jd_url}: {exc}")
        else:
            print(json.dumps(result, ensure_ascii=False))
        return 0

    companies = load_configured_companies(args.targets)
    if not companies:
        print(
            "fetch_smartrecruiters_listings: complete companies=0 jobs=0 failed=0",
            file=sys.stderr,
        )
        return 0

    # Server-side keyword filtering (confirmed live) — without this, a
    # large board (some SmartRecruiters companies list 10,000+ postings)
    # means paginating all the way to --limit on every single run instead
    # of the handful of pages a narrowed search actually needs.
    query_part = f"&q={urllib.parse.quote(args.search)}" if args.search else ""

    fetched = 0
    failed = 0
    jobs = []

    # Cache check — browse-all only (args.search is always "" in the
    # automatic job-scraper's actual invocation, per src/agents/bodies/
    # job-scraper.md's SmartRecruiters step; a manually-run --search
    # skips this and goes straight to a live fetch, since the job_cache
    # RPC's filtering semantics don't match SmartRecruiters' own
    # server-side `q=` keyword param). Deliberately narrower than
    # jobs.ts's maybeCached(): only intersects the operator's own
    # configured companies with the shared cache list, never adds
    # companies the operator didn't configure — this script feeds an
    # auto-apply agent, not a read-only search UI, so silently
    # expanding which companies get evaluated (and possibly applied to)
    # beyond what the operator explicitly targeted would be a real
    # behavior change, not just a speedup.
    cache_covered = set()
    if not args.search:
        try:
            import job_cache_client

            shared = job_cache_client.shared_slugs(".", "smartrecruiters")
            cache_targets = sorted(shared & set(companies))
            if cache_targets:
                cached_jobs = job_cache_client.get_cached_jobs(".", "smartrecruiters", cache_targets)
                if cached_jobs:
                    wanted = set(cache_targets)
                    for job in cached_jobs:
                        if job.get("company") in wanted and job.get("title") and job.get("external_job_id"):
                            jobs.append(job)
                            cache_covered.add(job["company"])
        except Exception as exc:  # cache is always optional — never let a cache bug break a live-capable run
            warn(f"job cache check failed, continuing live: {exc}")
        if cache_covered:
            fetched += len(cache_covered)

    for company in companies:
        if company in cache_covered:
            continue
        offset = 0
        count = 0
        try:
            while True:
                data = api_get(
                    f"{API_BASE}/{company}/postings?offset={offset}&limit={PAGE_SIZE}{query_part}",
                    args.timeout,
                )
                postings = data.get("content") or []
                for posting in postings:
                    if not isinstance(posting, dict):
                        continue
                    raw = to_raw_job(posting, company)
                    if raw["title"] and raw["external_job_id"]:
                        jobs.append(raw)
                        count += 1
                    if args.limit and count >= args.limit:
                        break
                offset += PAGE_SIZE
                total = int(data.get("totalFound", 0))
                if not postings or (args.limit and count >= args.limit) or offset >= total:
                    break
            fetched += 1
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            warn(f"company '{company}' failed to fetch: {exc} — skipped")
            failed += 1

    jobs.sort(key=lambda j: (j["company"], j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_smartrecruiters_listings: complete companies={fetched} jobs={len(jobs)} failed={failed}",
        file=sys.stderr,
    )
    if failed and not fetched:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
