#!/usr/bin/env python3
"""fetch_jazzhr_listings.py — JazzHR ingestion (Phase 16B, HTML-first adapter).

JazzHR has no public, unauthenticated JSON API — the documented Apply API
requires a partner-provisioned bearer token (confirmed via
apidoc.jazzhrapis.com), not self-serve like Greenhouse/Lever/Workable.
The career-page listing, however, is fully server-side rendered HTML —
each posting is a plain `<tr>` row with no JS execution required to see
it — so this is a Class 4 HTML adapter (same class as
fetch_apple_listings.py), not a JSON API client.

Tenants are configured in src/config/targets.json as the account
subdomain (the slug in a live JazzHR posting URL, e.g. "empowerproject"
from empowerproject.applytojob.com/apply/jobs/details/...):

  "jazzhr_company_slugs": ["empowerproject"]

Skip behavior mirrors the other optional boards: a missing, empty, or
placeholder-only ("REPLACE_ME") jazzhr_company_slugs array means the
board is skipped — a warning goes to stderr, nothing on stdout, exit 0.

  GET https://<slug>.applytojob.com/apply/jobs

Confirmed live 2026-08-10 against real accounts (empowerproject,
ilsos): every posting row looks like
`<tr id="row_job_<YYYYMMDDHHMMSS>_<hash>">` containing
`<a class="job_title_link" href="/apply/jobs/details/<id>?&">Title</a>`
and a location cell. Each posting appears TWICE on the page (a desktop
table layout and a duplicate "Mobile layout" section further down) —
same duplicate-anchor pattern fetch_apple_listings.py already handles;
kept only the first occurrence per unique job id. The row id's embedded
timestamp is a real, more-precise-than-usual posted_at signal — no other
adapter in this codebase gets one for free from the list markup.

The list page carries NO JD body (confirmed live — only a title,
optional department, and location). After role filtering and before the
fit gate, the orchestrator fetches the JD per surviving candidate, same
two-step rule as Oracle/Workday/SmartRecruiters:

  python3 src/scripts/jobs/fetch_jazzhr_listings.py --jd-url '<posting-url>'

The detail page (`<slug>.applytojob.com/apply/jobs/details/<id>`) embeds
the full JD as plain server-rendered HTML in `<div class="job_description">`
— no JS execution needed — along with the real company display name in
`<h2 class="job_company">` (more reliable than title-casing the slug,
which is what list mode falls back to since the list page never shows a
company name at all).

CAPTCHA note: some JazzHR tenants enable a reCAPTCHA on the actual APPLY
FORM (confirmed live on ilsos.applytojob.com's detail page,
`<div class="g-recaptcha" data-sitekey="...">`) — this is a per-tenant
toggle, not universal, and it never blocks reading the listing or JD
text (both plain server-rendered HTML, no form interaction). It only
matters at the actual apply step, which already routes any detected
CAPTCHA to needs_review generically (AGENTS.md "Error handling") —
nothing new to handle here.

Output contract:
  stdout — raw-job JSONL (list mode) or a single JD JSON (--jd-url),
           list mode sorted by (company, title, external_job_id).
  stderr — warnings and a machine-parseable summary line:
           fetch_jazzhr_listings: complete companies=<n> jobs=<n> failed=<n>

Exit codes:
  0  success, or a clean configured skip
  1  usage/config error
  3  every configured company failed to fetch (partial failure exits 0)

Usage:
  python3 src/scripts/jobs/fetch_jazzhr_listings.py
  python3 src/scripts/jobs/fetch_jazzhr_listings.py --limit 200
  python3 src/scripts/jobs/fetch_jazzhr_listings.py --jd-url 'https://empowerproject.applytojob.com/apply/jobs/details/SOrbIgPGmV'
"""

from __future__ import annotations

import argparse
import datetime
import html as html_lib
import json
import os
import re
import sys
import urllib.error
import urllib.request

DEFAULT_TARGETS = "src/config/targets.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/phase16b"

_ROW_RE = re.compile(
    r'<tr id="row_job_(\d{14})_[^"]*"[^>]*>.*?'
    r'<a class="job_title_link" href="(/apply/jobs/details/[^"?]+)\?[^"]*">([^<]*)</a>'
    r'(?:.*?<span class="resumator_department"[^>]*>([^<]*)</span>)?'
    r'.*?<td>\s*([^<]*?)\s*</td>',
    re.S,
)


def warn(msg: str) -> None:
    print(f"fetch_jazzhr_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "int":
    print(f"fetch_jazzhr_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def load_configured_companies(targets_path: str) -> list:
    if not os.path.exists(targets_path):
        die(f"targets config not found: {targets_path}")
    try:
        with open(targets_path, "r", encoding="utf-8") as f:
            targets = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read targets config {targets_path}: {exc}")
    raw = targets.get("jazzhr_company_slugs")
    if raw is None:
        warn("jazzhr_company_slugs is not configured — JazzHR board skipped this run")
        return []
    if not isinstance(raw, list):
        die("targets config field 'jazzhr_company_slugs' must be an array")
    companies = []
    for entry in raw:
        text = str(entry).strip()
        if not text or text.lower() == PLACEHOLDER:
            continue
        companies.append(text)
    if not companies:
        warn("jazzhr_company_slugs is empty or placeholder-only — JazzHR board skipped this run")
    return companies


def http_get(url: str, timeout: int) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def strip_html(markup: str) -> str:
    text = re.sub(r"<[^>]+>", " ", markup or "")
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def _row_posted_at(timestamp: str) -> str | None:
    """The row id's embedded YYYYMMDDHHMMSS prefix -> ISO 8601, or None
    if it doesn't parse as a real datetime (defensive — never seen live,
    but a malformed id shouldn't crash the whole fetch)."""
    try:
        dt = datetime.datetime.strptime(timestamp, "%Y%m%d%H%M%S").replace(tzinfo=datetime.timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def parse_listing_page(content: str, slug: str) -> list[dict]:
    jobs = []
    seen_ids: set[str] = set()
    for m in _ROW_RE.finditer(content):
        timestamp, href, title_raw, department, location_raw = m.groups()
        title = html_lib.unescape(title_raw or "").strip()
        id_m = re.match(r"/apply/jobs/details/([^/]+)", href)
        external_id = id_m.group(1) if id_m else ""
        if not title or not external_id or external_id in seen_ids:
            continue
        seen_ids.add(external_id)
        job = {
            "source": "jazzhr",
            "company": slug,
            "title": title,
            "url": f"https://{slug}.applytojob.com{href}",
            "external_job_id": external_id,
            "location": html_lib.unescape(location_raw or "").strip(),
        }
        department_text = html_lib.unescape(department or "").strip()
        if department_text:
            job["department"] = department_text
        posted_at = _row_posted_at(timestamp)
        if posted_at:
            job["posted_at"] = posted_at
        jobs.append(job)
    return jobs


def fetch_jd(url: str, timeout: int) -> dict:
    m = re.match(r"https?://([^./]+)\.applytojob\.com/apply/jobs/details/([^/?]+)", url.strip())
    if m is None:
        die(f"unrecognized JazzHR posting URL shape: {url}")
    content = http_get(url, timeout)
    title_m = re.search(r'<h1 class="job_title">([^<]*)</h1>', content)
    company_m = re.search(r'<h2 class="job_company">([^<]*)</h2>', content)
    desc_m = re.search(r'<div class="job_description">(.*?)</div>\s*<div id="how_to_apply"', content, re.S)
    return {
        "source": "jazzhr",
        "company": html_lib.unescape(company_m.group(1)).strip() if company_m else m.group(1),
        "title": html_lib.unescape(title_m.group(1)).strip() if title_m else "",
        "url": url,
        "external_job_id": m.group(2),
        "jd_text": strip_html(desc_m.group(1)) if desc_m else "",
    }


def _fetch_one_company(slug: str, timeout: int) -> tuple[list, str | None]:
    try:
        content = http_get(f"https://{slug}.applytojob.com/apply/jobs", timeout)
    except (urllib.error.URLError, OSError) as exc:
        return [], str(exc)
    return parse_listing_page(content, slug), None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_jazzhr_listings.py",
        description="Fetch JazzHR company postings via HTML parsing of <slug>.applytojob.com (Phase 16B, no public API).",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument("--search", default="", help="case-insensitive substring filter on title (client-side — no server-side query param)")
    parser.add_argument("--limit", type=int, default=200, help="max postings per company (0 = no cap)")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--jd-url", default="", help="fetch one posting's JD JSON instead of listing")
    args = parser.parse_args(argv)

    if args.jd_url:
        try:
            result = fetch_jd(args.jd_url, args.timeout)
        except (urllib.error.URLError, OSError) as exc:
            die(f"JD fetch failed for {args.jd_url}: {exc}")
        else:
            print(json.dumps(result, ensure_ascii=False))
        return 0

    companies = load_configured_companies(args.targets)
    if not companies:
        print("fetch_jazzhr_listings: complete companies=0 jobs=0 failed=0", file=sys.stderr)
        return 0

    fetched = 0
    failed = 0
    jobs: list[dict] = []
    for slug in companies:
        company_jobs, error = _fetch_one_company(slug, args.timeout)
        if error is not None:
            warn(f"company '{slug}' failed to fetch: {error} — skipped")
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
        f"fetch_jazzhr_listings: complete companies={fetched} jobs={len(jobs)} failed={failed}",
        file=sys.stderr,
    )
    if failed and not fetched:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
