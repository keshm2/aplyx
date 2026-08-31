#!/usr/bin/env python3
"""fetch_oracle_listings.py: Oracle Recruiting Cloud ingestion (Phase 16B).

Fetches job postings from configured Oracle Recruiting Cloud (ORC) tenants
via the public, auth-free Fusion HCM REST API (no scraping, no Playwright
needed) and emits one raw-job JSON object per line on stdout, shaped for
`src/scripts/state/job_state.py canonicalize`. This is a distinct, more modern
product from the legacy "Taleo" ATS (already covered by the `taleo.net`
URL pattern in job_state.py); ORC-hosted career sites live at
`<tenant>.fa.<region>.oraclecloud.com` and are used by many employers
beyond Oracle itself, discovered here via Oracle's own careers site
(careers.oracle.com, itself ORC-hosted) as the first configured tenant.

Tenants are configured in src/config/targets.json as "<host>/<siteNumber>"
strings, the same "<host>/<site>" convention Workday tenants already use:

  "oracle_tenants": ["eeho.fa.us2.oraclecloud.com/CX_45001"]

Skip behavior mirrors the other optional boards: a missing, empty, or
placeholder-only ("REPLACE_ME") oracle_tenants array means the board is
skipped: a warning goes to stderr, nothing on stdout, exit 0.

The list feed carries NO JD body (confirmed live; ExternalQualificationsStr/
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
  stdout: raw-job JSONL (list mode) or a single JD JSON (--jd-url),
           list mode sorted by (company, title, external_job_id).
  stderr: warnings and a machine-parseable summary line:
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
import concurrent.futures
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

from _jd_text import extract_pay, join_sections

DEFAULT_TARGETS = "src/config/targets.json"
DEFAULT_DISCOVERED = "src/config/discovered_companies.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/phase16b"
# The Fusion HCM REST API accepts at least limit=100 in one request
# (confirmed live); the original 25 here was copied from what the
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
        warn("oracle_tenants is not configured: Oracle board skipped this run")
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
            warn(f"malformed oracle tenant '{text}' (expected <host>/<siteNumber>): skipped")
            continue
        tenants.append(parsed)
    if not tenants:
        warn("oracle_tenants is empty or placeholder-only: Oracle board skipped this run")
    return tenants


def api_get(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def job_url(host: str, site: str, job_id: str) -> str:
    return f"https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{job_id}"


def load_tenant_company_names(discovered_path: str) -> dict:
    """'<host>/<site>' (lowercased) -> human company name, from
    discovered_companies.json's discovered_tenants (see
    build_discovered_companies.py); best-effort: a missing/unreadable/
    malformed file just yields an empty map, so a lookup miss falls back
    to the tenant's own site id (today's behavior), never an error."""
    try:
        with open(discovered_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    names: dict = {}
    for entry in data.get("discovered_tenants") or []:
        if not isinstance(entry, dict):
            continue
        tenant = str(entry.get("tenant", "")).strip().lower()
        name = str(entry.get("company_name", "")).strip()
        if tenant and name and tenant not in names:
            names[tenant] = name
    return names


def to_raw_job(req: dict, host: str, site: str, company_name: str) -> dict:
    job_id = str(req.get("Id", "")).strip()
    return {
        "source": "oracle",
        "company": company_name or site,
        "title": str(req.get("Title", "")).strip(),
        "url": job_url(host, site, job_id),
        "external_job_id": job_id,
        "location": str(req.get("PrimaryLocation", "")).strip(),
        # jd_text intentionally absent: fetch per candidate with
        # --jd-url after role filtering and BEFORE the fit gate (same
        # rule as the SimplifyJobs/Workday/SmartRecruiters feeds).
        "posted_at": (str(req.get("PostedDate", "")).strip() + "T00:00:00Z") if req.get("PostedDate") else None,
    }


def fetch_jd(url: str, timeout: int, discovered_path: str) -> dict:
    """Posting URL -> JD JSON via the requisition-detail endpoint."""
    m = re.match(
        r"https?://([^/]+)/hcmUI/CandidateExperience/en/sites/([^/]+)/job/(\d+)",
        url.strip(),
    )
    if m is None:
        die(f"unrecognized Oracle posting URL shape: {url}")
    host, site, job_id = m.group(1), m.group(2), m.group(3)
    company_name = load_tenant_company_names(discovered_path).get(f"{host}/{site}".lower(), "")
    finder = urllib.parse.quote(f'ById;Id="{job_id}",siteNumber={site}', safe="=;,")
    info = api_get(
        f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"
        f"?onlyData=true&expand=all&finder={finder}",
        timeout,
    )
    items = info.get("items") or []
    detail = items[0] if items else {}
    jd_text = join_sections(
        [
            (None, str(detail.get("ExternalDescriptionStr", ""))),
            ("Responsibilities", str(detail.get("ExternalResponsibilitiesStr", ""))),
            ("Qualifications", str(detail.get("ExternalQualificationsStr", ""))),
        ]
    )
    return {
        "source": "oracle",
        "company": company_name or site,
        "title": str(detail.get("Title", "")).strip(),
        "location": str(detail.get("PrimaryLocation", "")).strip(),
        "url": url,
        "external_job_id": str(detail.get("Id", job_id)).strip(),
        "jd_text": jd_text,
        "pay_text": extract_pay(jd_text),
    }


def _fetch_one_tenant(host: str, site: str, company_name: str, args) -> tuple[list, str | None]:
    """One tenant's full paginated fetch. Returns (jobs, error_message_or_None)."""
    jobs = []
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
            # `expand=requisitionList` is required: without it the
            # API returns search metadata only, no actual postings
            # (confirmed live). Dropped the unused `.workLocation`
            # sub-expand (to_raw_job below never reads it); that
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
                raw = to_raw_job(req, host, site, company_name)
                if raw["title"] and raw["external_job_id"]:
                    jobs.append(raw)
                    count += 1
                if args.limit and count >= args.limit:
                    break
            offset += PAGE_SIZE
            total = int(items[0].get("TotalJobsCount", 0)) if items else 0
            if not reqs or (args.limit and count >= args.limit) or offset >= total:
                break
    except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError, IndexError) as exc:
        return jobs, str(exc)
    return jobs, None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_oracle_listings.py",
        description="Fetch Oracle Recruiting Cloud tenant postings via the public Fusion HCM REST API (Phase 16B).",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument("--discovered", default=DEFAULT_DISCOVERED,
                         help="discovered_companies.json path, for tenant->company-name lookup (best-effort)")
    parser.add_argument("--search", default="", help="keyword to narrow the feed (e.g. 'intern')")
    parser.add_argument("--limit", type=int, default=200, help="max postings per tenant (0 = no cap)")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--jd-url", default="", help="fetch one posting's JD JSON instead of listing")
    args = parser.parse_args(argv)

    if args.jd_url:
        try:
            result = fetch_jd(args.jd_url, args.timeout, args.discovered)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            die(f"JD fetch failed for {args.jd_url}: {exc}")
        else:
            print(json.dumps(result, ensure_ascii=False))
        return 0

    tenants = load_configured_tenants(args.targets)
    if not tenants:
        print("fetch_oracle_listings: complete tenants=0 jobs=0 failed=0", file=sys.stderr)
        return 0

    company_names = load_tenant_company_names(args.discovered)

    fetched = 0
    failed = 0
    jobs = []
    # Tenants fetched concurrently, not one after another: Oracle's own API
    # costs ~1.9-2s per request regardless of tenant (see the comment on
    # expand=requisitionList below), so N tenants in sequence is N*2s,
    # confirmed live to blow past the interactive search's 2.2s per-source
    # deadline (src/core/src/jobs.ts SOURCE_DEADLINE_MS) with as few as 2
    # tenants configured. Each tenant call is independent I/O, so plain
    # threads (stdlib concurrent.futures, no new dependency) are enough:
    # no shared state to race on, each thread only appends to its own
    # tenant_jobs list.
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(tenants))) as executor:
        future_to_tenant = {
            executor.submit(
                _fetch_one_tenant, host, site,
                company_names.get(f"{host}/{site}".lower(), ""), args,
            ): (host, site)
            for host, site in tenants
        }
        for future in concurrent.futures.as_completed(future_to_tenant):
            host, site = future_to_tenant[future]
            tenant_jobs, error = future.result()
            if error is not None:
                warn(f"tenant '{site}' ({host}) failed to fetch: {error}; skipped")
                failed += 1
            else:
                fetched += 1
            jobs.extend(tenant_jobs)

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
