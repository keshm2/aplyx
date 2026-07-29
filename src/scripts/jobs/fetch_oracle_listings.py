#!/usr/bin/env python3
"""fetch_oracle_listings.py — Oracle Recruiting Cloud ingestion (Phase 16B).

Fetches job postings from configured Oracle Recruiting Cloud (ORC) tenants
via the public, auth-free Fusion HCM REST API (no scraping, no Playwright
needed) and emits one raw-job JSON object per line on stdout, shaped for
`src/scripts/state/job_state.py canonicalize`. This is a distinct, more modern
product from the legacy "Taleo" ATS (already covered by the `taleo.net`
URL pattern in job_state.py) — ORC-hosted career sites live at
`<tenant>.fa.<region>.oraclecloud.com` and are used by many employers
beyond Oracle itself, discovered here via Oracle's own careers site
(careers.oracle.com, itself ORC-hosted) as the first configured tenant.

Tenants are configured in src/config/targets.json as "<host>/<siteNumber>"
strings, the same "<host>/<site>" convention Workday tenants already use:

  "oracle_tenants": ["eeho.fa.us2.oraclecloud.com/CX_45001"]

Skip behavior mirrors the other optional boards: a missing, empty, or
placeholder-only ("REPLACE_ME") oracle_tenants array means the board is
skipped — a warning goes to stderr, nothing on stdout, exit 0.

The list feed carries NO JD body (confirmed live — ExternalQualificationsStr/
ExternalResponsibilitiesStr are null in the search response; only the
per-requisition detail endpoint has them). After role filtering and before
the fit gate, the orchestrator fetches the JD per surviving candidate, same
rule as SimplifyJobs/Workday/SmartRecruiters:

  python3 src/scripts/jobs/fetch_oracle_listings.py --jd-url '<posting-url>'

which prints one JSON object with jd_text (HTML stripped), title, location,
and url. The public job URL uses ORC's generic hcmUI path (works for any
tenant, not just Oracle's own custom-branded careers.oracle.com domain):
https://<host>/hcmUI/CandidateExperience/en/sites/<siteNumber>/job/<id>

Output contract:
  stdout — raw-job JSONL (list mode) or a single JD JSON (--jd-url),
           list mode sorted by (company, title, external_job_id).
  stderr — warnings and a machine-parseable summary line:
           fetch_oracle_listings: complete tenants=<n> jobs=<n> failed=<n>

Exit codes:
  0  success, or a clean configured skip
  1  usage/config error
  3  every configured tenant failed to fetch (partial failure exits 0)

Usage:
  python3 src/scripts/jobs/fetch_oracle_listings.py
  python3 src/scripts/jobs/fetch_oracle_listings.py --search intern --limit 200
  python3 src/scripts/jobs/fetch_oracle_listings.py --jd-url 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/334333'
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_TARGETS = "src/config/targets.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/phase16b"
# The Fusion HCM REST API accepts at least limit=100 in one request
# (confirmed live) — the original 25 here was copied from what the
# careers.oracle.com UI itself requests (its own page-size choice, not an
# API-enforced cap), and needlessly forced 2+ sequential requests per
# tenant for every typical search.
PAGE_SIZE = 100


def warn(msg: str) -> None:
    print(f"fetch_oracle_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "int":
    print(f"fetch_oracle_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def parse_tenant(entry: str):
    """'<host>/<siteNumber>' -> (host, site) or None when malformed."""
    entry = entry.strip().removeprefix("https://").removeprefix("http://").rstrip("/")
    parts = entry.split("/")
    if len(parts) != 2 or ".oraclecloud.com" not in parts[0]:
        return None
    host, site = parts
    return host, site


def load_configured_tenants(targets_path: str) -> list:
    if not os.path.exists(targets_path):
        die(f"targets config not found: {targets_path}")
    try:
        with open(targets_path, "r", encoding="utf-8") as f:
            targets = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read targets config {targets_path}: {exc}")
    raw = targets.get("oracle_tenants")
    if raw is None:
        warn("oracle_tenants is not configured — Oracle board skipped this run")
        return []
    if not isinstance(raw, list):
        die("targets config field 'oracle_tenants' must be an array")
    tenants = []
    for entry in raw:
        text = str(entry).strip()
        if not text or text.lower() == PLACEHOLDER:
            continue
        parsed = parse_tenant(text)
        if parsed is None:
            warn(f"malformed oracle tenant '{text}' (expected <host>/<siteNumber>) — skipped")
            continue
        tenants.append(parsed)
    if not tenants:
        warn("oracle_tenants is empty or placeholder-only — Oracle board skipped this run")
    return tenants


def api_get(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def strip_html(markup: str) -> str:
    text = re.sub(r"<[^>]+>", " ", markup or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def job_url(host: str, site: str, job_id: str) -> str:
    return f"https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{job_id}"


def to_raw_job(req: dict, host: str, site: str) -> dict:
    job_id = str(req.get("Id", "")).strip()
    return {
        "source": "oracle",
        "company": site,
        "title": str(req.get("Title", "")).strip(),
        "url": job_url(host, site, job_id),
        "external_job_id": job_id,
        "location": str(req.get("PrimaryLocation", "")).strip(),
        # jd_text intentionally absent — fetch per candidate with
        # --jd-url after role filtering and BEFORE the fit gate (same
        # rule as the SimplifyJobs/Workday/SmartRecruiters feeds).
        "posted_at": (str(req.get("PostedDate", "")).strip() + "T00:00:00Z") if req.get("PostedDate") else None,
    }


def fetch_jd(url: str, timeout: int) -> dict:
    """Posting URL -> JD JSON via the requisition-detail endpoint."""
    m = re.match(
        r"https?://([^/]+)/hcmUI/CandidateExperience/en/sites/([^/]+)/job/(\d+)",
        url.strip(),
    )
    if m is None:
        die(f"unrecognized Oracle posting URL shape: {url}")
    host, site, job_id = m.group(1), m.group(2), m.group(3)
    finder = urllib.parse.quote(f'ById;Id="{job_id}",siteNumber={site}', safe="=;,")
    info = api_get(
        f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"
        f"?onlyData=true&expand=all&finder={finder}",
        timeout,
    )
    items = info.get("items") or []
    detail = items[0] if items else {}
    jd_parts = [
        strip_html(str(detail.get("ExternalDescriptionStr", ""))),
        strip_html(str(detail.get("ExternalResponsibilitiesStr", ""))),
        strip_html(str(detail.get("ExternalQualificationsStr", ""))),
    ]
    return {
        "source": "oracle",
        "company": site,
        "title": str(detail.get("Title", "")).strip(),
        "location": str(detail.get("PrimaryLocation", "")).strip(),
        "url": url,
        "external_job_id": str(detail.get("Id", job_id)).strip(),
        "jd_text": " ".join(p for p in jd_parts if p).strip(),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_oracle_listings.py",
        description="Fetch Oracle Recruiting Cloud tenant postings via the public Fusion HCM REST API (Phase 16B).",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument("--search", default="", help="keyword to narrow the feed (e.g. 'intern')")
    parser.add_argument("--limit", type=int, default=200, help="max postings per tenant (0 = no cap)")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--jd-url", default="", help="fetch one posting's JD JSON instead of listing")
    args = parser.parse_args(argv)

    if args.jd_url:
        try:
            result = fetch_jd(args.jd_url, args.timeout)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            die(f"JD fetch failed for {args.jd_url}: {exc}")
        else:
            print(json.dumps(result, ensure_ascii=False))
        return 0

    tenants = load_configured_tenants(args.targets)
    if not tenants:
        print("fetch_oracle_listings: complete tenants=0 jobs=0 failed=0", file=sys.stderr)
        return 0

    fetched = 0
    failed = 0
    jobs = []
    for host, site in tenants:
        offset = 0
        count = 0
        try:
            while True:
                keyword_part = f',keyword="{args.search}"' if args.search else ""
                finder = urllib.parse.quote(
                    f"findReqs;siteNumber={site},limit={PAGE_SIZE},offset={offset}"
                    f"{keyword_part},sortBy=POSTING_DATES_DESC",
                    safe="=;,\"",
                )
                # `expand=requisitionList` is required — without it the
                # API returns search metadata only, no actual postings
                # (confirmed live). Dropped the unused `.workLocation`
                # sub-expand (to_raw_job below never reads it) — that
                # part turned out not to affect latency (Oracle's
                # ~1.9-2s here is the cost of populating requisitionList
                # at all, expanded or not), but there's no reason to ask
                # for data nothing uses.
                data = api_get(
                    f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions"
                    f"?onlyData=true&expand=requisitionList&finder={finder}",
                    args.timeout,
                )
                items = data.get("items") or []
                reqs = items[0].get("requisitionList") or [] if items else []
                for req in reqs:
                    if not isinstance(req, dict):
                        continue
                    raw = to_raw_job(req, host, site)
                    if raw["title"] and raw["external_job_id"]:
                        jobs.append(raw)
                        count += 1
                    if args.limit and count >= args.limit:
                        break
                offset += PAGE_SIZE
                total = int(items[0].get("TotalJobsCount", 0)) if items else 0
                if not reqs or (args.limit and count >= args.limit) or offset >= total:
                    break
            fetched += 1
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError, IndexError) as exc:
            warn(f"tenant '{site}' ({host}) failed to fetch: {exc} — skipped")
            failed += 1

    jobs.sort(key=lambda j: (j["company"], j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_oracle_listings: complete tenants={fetched} jobs={len(jobs)} failed={failed}",
        file=sys.stderr,
    )
    if failed and not fetched:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
