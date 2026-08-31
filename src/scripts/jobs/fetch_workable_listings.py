#!/usr/bin/env python3
"""fetch_workable_listings.py: Workable ingestion (Phase 16B).

Fetches job postings from configured Workable companies via the public,
auth-free widget API (the same endpoint Workable's own embeddable job
board widget calls; no scraping, no Playwright needed) and emits one
raw-job JSON object per line on stdout, shaped for
`src/scripts/state/job_state.py canonicalize`.

Companies are configured in src/config/targets.json as account slugs
(the slug in a Workable posting URL, e.g. "tarte-inc" from
https://apply.workable.com/tarte-inc/j/...):

  "workable_company_slugs": ["tarte-inc"]

Skip behavior mirrors the other optional boards: a missing, empty, or
placeholder-only ("REPLACE_ME") workable_company_slugs array means the
board is skipped: a warning goes to stderr, nothing on stdout, exit 0.

A guessed account slug (e.g. a company's own name) is NOT a reliable way
to find its real Workable slug: confirmed live 2026-08-10, several
guessed slugs (stripe, soundcloud, pipedrive, mysimpleshow) 404'd or
returned an account with a permanently empty jobs array. The real slug
is only reliably found from an actual live posting URL
(apply.workable.com/<slug>/j/...), the same way Oracle/Workday tenants
are discovered; never guess a slug from a company's public name alone.

The list response carries FULL JD text directly (`description`, HTML);
confirmed live against five real accounts, no separate per-posting
detail fetch needed, same as Amazon/Stripe/Google/Muse. No pagination
parameter exists or is needed: the endpoint returns a company's whole
open-postings list in one response (confirmed live up to 499 postings
in a single call, no truncation observed).

Output contract:
  stdout: raw-job JSONL, sorted by (company, title, external_job_id).
  stderr: warnings and a machine-parseable summary line:
           fetch_workable_listings: complete companies=<n> jobs=<n> failed=<n>

Exit codes:
  0  success, or a clean configured skip
  1  usage/config error
  3  every configured company failed to fetch (partial failure exits 0)

Usage:
  python3 src/scripts/jobs/fetch_workable_listings.py
  python3 src/scripts/jobs/fetch_workable_listings.py --search "software engineer" --limit 200
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

from _jd_text import extract_pay, html_to_text

DEFAULT_TARGETS = "src/config/targets.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/phase16b"
API_BASE = "https://apply.workable.com/api/v1/widget/accounts"


def warn(msg: str) -> None:
    print(f"fetch_workable_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "int":
    print(f"fetch_workable_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def load_configured_companies(targets_path: str) -> list:
    if not os.path.exists(targets_path):
        die(f"targets config not found: {targets_path}")
    try:
        with open(targets_path, "r", encoding="utf-8") as f:
            targets = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read targets config {targets_path}: {exc}")
    raw = targets.get("workable_company_slugs")
    if raw is None:
        warn("workable_company_slugs is not configured: Workable board skipped this run")
        return []
    if not isinstance(raw, list):
        die("targets config field 'workable_company_slugs' must be an array")
    companies = []
    for entry in raw:
        text = str(entry).strip()
        if not text or text.lower() == PLACEHOLDER:
            continue
        companies.append(text)
    if not companies:
        warn("workable_company_slugs is empty or placeholder-only: Workable board skipped this run")
    return companies


def api_get(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _location_text(job: dict) -> str:
    locations = job.get("locations") or []
    if locations:
        loc = locations[0] or {}
        parts = [str(loc.get("city") or "").strip(), str(loc.get("region") or "").strip(), str(loc.get("country") or "").strip()]
        text = ", ".join(p for p in parts if p)
        if text:
            return text
    parts = [str(job.get("city") or "").strip(), str(job.get("state") or "").strip(), str(job.get("country") or "").strip()]
    return ", ".join(p for p in parts if p)


def to_raw_job(job: dict, company_slug: str, company_name: str) -> dict:
    shortcode = str(job.get("shortcode", "")).strip()
    jd_text = html_to_text(str(job.get("description", "")))
    return {
        "source": "workable",
        "company": company_name or company_slug,
        "title": str(job.get("title", "")).strip(),
        "url": str(job.get("url") or job.get("shortlink") or "").strip(),
        "apply_url": str(job.get("application_url") or "").strip() or None,
        "external_job_id": shortcode,
        "location": _location_text(job),
        "jd_text": jd_text,
        "pay_text": extract_pay(jd_text),
        "posted_at": (str(job.get("published_on", "")).strip() + "T00:00:00Z") if job.get("published_on") else None,
    }


def _fetch_one_company(slug: str, timeout: int) -> tuple[list, str | None]:
    """Returns (jobs, error_message_or_None)."""
    try:
        data = api_get(f"{API_BASE}/{slug}?details=true", timeout)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
        return [], str(exc)
    company_name = str(data.get("name", "")).strip()
    jobs = []
    for job in data.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        raw = to_raw_job(job, slug, company_name)
        if raw["title"] and raw["url"] and raw["external_job_id"]:
            jobs.append(raw)
    return jobs, None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_workable_listings.py",
        description="Fetch Workable company postings via the public widget API (Phase 16B).",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument("--search", default="", help="case-insensitive substring filter on title (client-side; the widget API has no server-side query param)")
    parser.add_argument("--limit", type=int, default=200, help="max postings per company (0 = no cap)")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args(argv)

    companies = load_configured_companies(args.targets)
    if not companies:
        print("fetch_workable_listings: complete companies=0 jobs=0 failed=0", file=sys.stderr)
        return 0

    fetched = 0
    failed = 0
    jobs: list[dict] = []
    for slug in companies:
        company_jobs, error = _fetch_one_company(slug, args.timeout)
        if error is not None:
            warn(f"company '{slug}' failed to fetch: {error}; skipped")
            failed += 1
            continue
        fetched += 1
        if args.limit:
            company_jobs = company_jobs[: args.limit]
        jobs.extend(company_jobs)

    if args.search:
        terms = [t for t in args.search.strip().lower().split() if t]
        jobs = [j for j in jobs if all(t in j["title"].lower() for t in terms)]

    jobs.sort(key=lambda j: (j["company"], j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_workable_listings: complete companies={fetched} jobs={len(jobs)} failed={failed}",
        file=sys.stderr,
    )
    if failed and not fetched:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
