#!/usr/bin/env python3
"""fetch_workday_listings.py — Workday review-only ingestion (Phase 7).

Fetches job postings from configured Workday tenants via the public,
auth-free CXS JSON endpoints (no scraping, no Playwright needed for the
common case) and emits one raw-job JSON object per line on stdout,
shaped for `src/scripts/state/job_state.py canonicalize`.

Tenants are configured in src/config/targets.json as
"<host>/<site>" strings — the tenant is the unit of configuration:

  "workday_tenants": ["nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"]

Skip behavior mirrors the other optional boards: a missing, empty, or
placeholder-only ("REPLACE_ME") workday_tenants array means the board
is skipped — a warning goes to stderr, nothing on stdout, exit 0.

The list feed carries NO JD body. After role filtering and before the
fit gate, the orchestrator fetches the JD per surviving candidate:

  python3 src/scripts/jobs/fetch_workday_listings.py --jd-url '<posting-url>'

which prints one JSON object with jd_text (HTML stripped), title,
location, and url. Phase 7 is review-only: nothing in this helper (or
anywhere else) submits a Workday application.

Output contract:
  stdout — raw-job JSONL (list mode) or a single JD JSON (--jd-url),
           list mode sorted by (company, title, external_job_id).
  stderr — warnings and a machine-parseable summary line:
           fetch_workday_listings: complete tenants=<n> jobs=<n> failed=<n>

Exit codes:
  0  success, or a clean configured skip
  1  usage/config error
  3  every configured tenant failed to fetch (partial failure exits 0)

Usage:
  python3 src/scripts/jobs/fetch_workday_listings.py
  python3 src/scripts/jobs/fetch_workday_listings.py --search intern --limit 100
  python3 src/scripts/jobs/fetch_workday_listings.py --jd-url 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/.../X_JR123'
"""

from __future__ import annotations

import argparse
import concurrent.futures
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

DEFAULT_TARGETS = "src/config/targets.json"
DEFAULT_DISCOVERED = "src/config/discovered_companies.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/phase7"
PAGE_SIZE = 20  # CXS maximum per request


def warn(msg: str) -> None:
    print(f"fetch_workday_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "int":
    print(f"fetch_workday_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def parse_tenant(entry: str):
    """'<host>/<site>' -> (host, tenant, site) or None when malformed."""
    entry = entry.strip().removeprefix("https://").removeprefix("http://").rstrip("/")
    parts = entry.split("/")
    if len(parts) != 2 or ".myworkday" not in parts[0]:
        return None
    host, site = parts
    return host, host.split(".")[0], site


def load_configured_tenants(targets_path: str) -> list:
    if not os.path.exists(targets_path):
        die(f"targets config not found: {targets_path}")
    try:
        with open(targets_path, "r", encoding="utf-8") as f:
            targets = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read targets config {targets_path}: {exc}")
    raw = targets.get("workday_tenants")
    if raw is None:
        warn("workday_tenants is not configured — Workday board skipped this run")
        return []
    if not isinstance(raw, list):
        die("targets config field 'workday_tenants' must be an array")
    tenants = []
    for entry in raw:
        text = str(entry).strip()
        if not text or text.lower() == PLACEHOLDER:
            continue
        parsed = parse_tenant(text)
        if parsed is None:
            warn(f"malformed workday tenant '{text}' (expected <host>/<site>) — skipped")
            continue
        tenants.append(parsed)
    if not tenants:
        warn("workday_tenants is empty or placeholder-only — Workday board skipped this run")
    return tenants


def load_tenant_company_names(discovered_path: str) -> dict:
    """'<host>/<site>' (lowercased) -> human company name, from
    discovered_companies.json's discovered_tenants — see the identical
    helper (and its full doc comment) in fetch_oracle_listings.py."""
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


def cxs_post(host: str, tenant: str, site: str, payload: dict, timeout: int) -> dict:
    req = urllib.request.Request(
        f"https://{host}/wday/cxs/{tenant}/{site}/jobs",
        data=json.dumps(payload).encode("utf-8"),
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def strip_html(markup: str) -> str:
    text = re.sub(r"<[^>]+>", " ", markup)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_posted_on(text: str):
    """Workday's public job-search API only exposes a bucketed relative-age
    string ("Posted Today", "Posted 3 Days Ago", "Posted 30+ Days Ago"),
    never an exact timestamp. Approximate an ISO date from the bucket so the
    TUI's posted-date column has something to show, on the same footing as
    the other sources' exact timestamps. Returns None if unparseable."""
    if not text:
        return None
    t = text.strip().lower()
    if "today" in t:
        days = 0
    elif "yesterday" in t:
        days = 1
    else:
        m = re.search(r"(\d+)\+?\s*day", t)
        if not m:
            return None
        days = int(m.group(1))
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def to_raw_job(posting: dict, host: str, tenant: str, site: str, company_name: str) -> dict:
    path = str(posting.get("externalPath", "")).strip()
    bullet = posting.get("bulletFields") or []
    external_id = str(bullet[0]).strip() if bullet else path.rsplit("_", 1)[-1]
    job = {
        "source": "workday",
        "company": company_name or tenant,
        "title": str(posting.get("title", "")).strip(),
        "url": f"https://{host}/{site}{path}",
        "external_job_id": external_id,
        "location": str(posting.get("locationsText", "")).strip(),
        # jd_text intentionally absent — fetch per candidate with --jd-url
        # after role filtering and BEFORE the fit gate (same rule as the
        # SimplifyJobs feeds).
    }
    posted_at = parse_posted_on(str(posting.get("postedOn", "")))
    if posted_at:
        job["posted_at"] = posted_at
    return job


def fetch_jd(url: str, timeout: int, discovered_path: str) -> dict:
    """Posting URL -> JD JSON via the CXS job-detail endpoint."""
    m = re.match(r"https?://([^/]+)/([^/]+)(/job/.+)$", url.strip())
    if m is None:
        die(f"unrecognized Workday posting URL shape: {url}")
    host, site, path = m.group(1), m.group(2), m.group(3)
    tenant = host.split(".")[0]
    company_name = load_tenant_company_names(discovered_path).get(f"{host}/{site}".lower(), "")
    req = urllib.request.Request(
        f"https://{host}/wday/cxs/{tenant}/{site}{path}",
        headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        info = json.load(resp).get("jobPostingInfo", {})
    return {
        "source": "workday",
        "company": company_name or tenant,
        "title": str(info.get("title", "")).strip(),
        "location": str(info.get("location", "")).strip(),
        "url": str(info.get("canonicalPositionUrl") or url).strip(),
        "external_job_id": str(info.get("jobReqId", "")).strip(),
        "jd_text": strip_html(str(info.get("jobDescription", ""))),
    }


def _fetch_one_tenant(host: str, tenant: str, site: str, company_name: str, args) -> tuple[list, str | None]:
    """One tenant's full paginated fetch. Returns (jobs, error_message_or_None)."""
    jobs = []
    offset = 0
    count = 0
    try:
        while True:
            data = cxs_post(
                host,
                tenant,
                site,
                {
                    "appliedFacets": {},
                    "limit": PAGE_SIZE,
                    "offset": offset,
                    "searchText": args.search,
                },
                args.timeout,
            )
            postings = data.get("jobPostings") or []
            for posting in postings:
                if not isinstance(posting, dict):
                    continue
                raw = to_raw_job(posting, host, tenant, site, company_name)
                if raw["title"] and raw["url"]:
                    jobs.append(raw)
                    count += 1
                if args.limit and count >= args.limit:
                    break
            offset += PAGE_SIZE
            if (
                not postings
                or (args.limit and count >= args.limit)
                or offset >= int(data.get("total", 0))
            ):
                break
    except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
        return jobs, str(exc)
    return jobs, None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_workday_listings.py",
        description="Fetch Workday tenant postings via public CXS JSON (Phase 7, review-only).",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument("--discovered", default=DEFAULT_DISCOVERED,
                         help="discovered_companies.json path, for tenant->company-name lookup (best-effort)")
    parser.add_argument(
        "--search", default="", help="CXS searchText to narrow the feed (e.g. 'intern')"
    )
    parser.add_argument(
        "--limit", type=int, default=200, help="max postings per tenant (0 = no cap)"
    )
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument(
        "--jd-url", default="", help="fetch one posting's JD JSON instead of listing"
    )
    args = parser.parse_args(argv)

    if args.jd_url:
        try:
            print(json.dumps(fetch_jd(args.jd_url, args.timeout, args.discovered), ensure_ascii=False))
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            die(f"JD fetch failed for {args.jd_url}: {exc}")
        return 0

    tenants = load_configured_tenants(args.targets)
    if not tenants:
        print(
            "fetch_workday_listings: complete tenants=0 jobs=0 failed=0",
            file=sys.stderr,
        )
        return 0

    company_names = load_tenant_company_names(args.discovered)

    fetched = 0
    failed = 0
    jobs = []
    # Tenants fetched concurrently, not one after another — see the
    # matching comment in fetch_oracle_listings.py's main(). Same
    # reasoning applies here: N sequential tenants each costing over a
    # second means N tenants configured is N times more likely to blow
    # the interactive search's per-source deadline than 1 tenant was.
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(tenants))) as executor:
        future_to_tenant = {
            executor.submit(
                _fetch_one_tenant, host, tenant, site,
                company_names.get(f"{host}/{site}".lower(), ""), args,
            ): tenant
            for host, tenant, site in tenants
        }
        for future in concurrent.futures.as_completed(future_to_tenant):
            tenant = future_to_tenant[future]
            tenant_jobs, error = future.result()
            if error is not None:
                warn(f"tenant '{tenant}' failed to fetch: {error} — skipped")
                failed += 1
            else:
                fetched += 1
            jobs.extend(tenant_jobs)

    jobs.sort(key=lambda j: (j["company"], j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_workday_listings: complete tenants={fetched} jobs={len(jobs)} failed={failed}",
        file=sys.stderr,
    )
    if failed and not fetched:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
