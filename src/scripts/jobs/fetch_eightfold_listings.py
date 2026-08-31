#!/usr/bin/env python3
"""fetch_eightfold_listings.py: Eightfold-powered careers sites (multi-tenant).

Eightfold is a white-labeled ATS platform many large employers run their
careers site on: Microsoft's `apply.careers.microsoft.com` and Netflix's
`explore.jobs.netflix.net` are both Eightfold deployments, confirmed live,
under completely different custom domains (Eightfold has no single common
hostname suffix the way Workday/Oracle tenants do). Two DIFFERENT search
APIs exist on the same platform, and which one is enabled is a per-tenant
setting, not a platform constant; confirmed live: Microsoft's tenant has
PCSX enabled and its host rejects the generic endpoint ("Not authorized
for PCSX"); Netflix's has the generic endpoint enabled and rejects PCSX
("PCSX is not enabled for this user"). This script tries PCSX first, and
falls back to the generic endpoint on a 403/"not enabled" response,
per tenant, per request.

  PCSX:    GET https://<host>/api/pcsx/search?domain=<domain>&query=<q>&location=&start=<n>&num=<n>
  Generic: GET https://<host>/api/apply/v2/jobs?domain=<domain>&start=<n>&num=<n>&query=<q>

Both cap page size at 10 regardless of a larger `num` (confirmed live for
both). Tenants are configured in src/config/targets.json as "<host>/<domain>"
strings; NOT the same shape as Oracle/Workday's "<host>/<site>" (site is
an ATS-internal identifier; domain here is the employer's own domain,
e.g. "microsoft.com", used as an API parameter, not a path segment):

  "eightfold_tenants": [
    "apply.careers.microsoft.com/microsoft.com",
    "explore.jobs.netflix.net/netflix.com"
  ]

Unlike Microsoft's old Microsoft-only adapter, this one has a WORKING JD
detail endpoint (`/api/apply/v2/jobs/<id>?domain=<domain>`), confirmed
live for BOTH Microsoft and Netflix, returning full `job_description`
HTML regardless of which search endpoint (PCSX or generic) is enabled for
that tenant's LISTING. (An earlier, narrower Microsoft-specific version of
this adapter incorrectly concluded no JD-detail endpoint existed; it had
only tried a wrong guess at the URL shape, `api/pcsx/jobdetails`, not this
one. Corrected here.) So unlike Oracle/Workday/SmartRecruiters, this
adapter does NOT need a Playwright JD-enrichment fallback.

Output contract:
  stdout: raw-job JSONL (list mode) or a single JD JSON (--jd-url),
           list mode sorted by (company, title, external_job_id).
  stderr: warnings and a machine-parseable summary line:
           fetch_eightfold_listings: complete tenants=<n> jobs=<n> failed=<n>

Exit codes:
  0  success, or a clean configured skip
  1  usage/config error
  3  every configured tenant failed to fetch (partial failure exits 0)

Usage:
  python3 src/scripts/jobs/fetch_eightfold_listings.py --search "intern" --limit 200
  python3 src/scripts/jobs/fetch_eightfold_listings.py --jd-url 'https://apply.careers.microsoft.com/careers/job/1970393556911730'
"""

from __future__ import annotations

import argparse
import concurrent.futures
import ipaddress
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

from _jd_text import extract_pay, html_to_text

DEFAULT_TARGETS = "src/config/targets.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/ats-expansion"
# Confirmed live: both endpoints cap page size at 10 regardless of a
# larger `num` request (tested up to 50 on each).
PAGE_SIZE = 10


def warn(msg: str) -> None:
    print(f"fetch_eightfold_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> "int":
    print(f"fetch_eightfold_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


_HOST_LABEL_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


def _is_safe_host(host: str) -> bool:
    """Reject anything that isn't a plausible public DNS hostname.

    Unlike the Workday/Oracle adapters, this can't anchor to a single fixed
    suffix: Eightfold tenants live on arbitrary employer-owned custom
    domains (module docstring above: Microsoft's apply.careers.microsoft.com,
    Netflix's explore.jobs.netflix.net, no shared suffix). This host comes
    straight from src/config/targets.json's eightfold_tenants and is used
    to build the literal request URL (f"https://{host}/api/..."), so instead
    it rejects the SSRF-classic shapes: raw IP literals (including the
    169.254.169.254 cloud-metadata address and loopback/private ranges),
    bracketed/IPv6 forms, "localhost", and numeric-shorthand IPs like
    "127.1" that some resolvers still expand to a loopback address, while
    still accepting any real multi-label DNS hostname.
    """
    host = host.strip().lower()
    if not host or host == "localhost" or "[" in host or "]" in host or ":" in host:
        return False
    try:
        ipaddress.ip_address(host)
        return False  # raw IP literal: reject regardless of scope
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) < 2:
        return False
    if labels[-1].isdigit():
        return False  # no real TLD is all-numeric; blocks "127.1"-style shorthand
    return all(_HOST_LABEL_RE.match(label) for label in labels)


def parse_tenant(entry: str):
    """'<host>/<domain>' -> (host, domain) or None when malformed."""
    entry = entry.strip().removeprefix("https://").removeprefix("http://").rstrip("/")
    parts = entry.split("/")
    if len(parts) != 2 or not _is_safe_host(parts[0]) or "." not in parts[1]:
        return None
    return parts[0], parts[1]


def load_configured_tenants(targets_path: str) -> list:
    if not os.path.exists(targets_path):
        die(f"targets config not found: {targets_path}")
    try:
        with open(targets_path, "r", encoding="utf-8") as f:
            targets = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read targets config {targets_path}: {exc}")
    raw = targets.get("eightfold_tenants")
    if raw is None:
        warn("eightfold_tenants is not configured: Eightfold board skipped this run")
        return []
    if not isinstance(raw, list):
        die("targets config field 'eightfold_tenants' must be an array")
    tenants = []
    for entry in raw:
        text = str(entry).strip()
        if not text or text.lower() == PLACEHOLDER:
            continue
        parsed = parse_tenant(text)
        if parsed is None:
            warn(f"malformed eightfold tenant '{text}' (expected <host>/<domain>), skipped")
            continue
        tenants.append(parsed)
    if not tenants:
        warn("eightfold_tenants is empty or placeholder-only: Eightfold board skipped this run")
    return tenants


def api_get(url: str, timeout: int) -> tuple[int, dict]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as exc:
        try:
            body = json.load(exc)
        except (json.JSONDecodeError, OSError):
            body = {}
        return exc.code, body


def search_page(host: str, domain: str, query: str, start: int, timeout: int) -> tuple[list, int, str]:
    """Tries PCSX, falls back to the generic v2 endpoint on any non-2xx
    response. Returns (positions, total_count, variant): variant is
    "pcsx" or "v2", used by to_raw_job to know which field names apply."""
    pcsx_params = urllib.parse.urlencode({"domain": domain, "query": query, "location": "", "start": start, "num": PAGE_SIZE})
    status, body = api_get(f"https://{host}/api/pcsx/search?{pcsx_params}", timeout)
    if status == 200 and isinstance(body.get("data"), dict):
        data = body["data"]
        return data.get("positions") or [], int(data.get("count", 0)), "pcsx"

    v2_params = urllib.parse.urlencode({"domain": domain, "start": start, "num": PAGE_SIZE, "query": query})
    status, body = api_get(f"https://{host}/api/apply/v2/jobs?{v2_params}", timeout)
    if status == 200 and "positions" in body:
        return body.get("positions") or [], int(body.get("count", 0)), "v2"

    raise RuntimeError(f"neither PCSX nor the generic endpoint worked for {host} (last status {status}: {body.get('message', '')})")


def to_raw_job(position: dict, host: str, domain: str, variant: str) -> dict:
    job_id = str(position.get("id", "")).strip()
    if variant == "pcsx":
        position_url = str(position.get("positionUrl", "")).strip()
        url = f"https://{host}{position_url}" if position_url else ""
        posted_ts = position.get("postedTs")
        department = position.get("department")
    else:
        url = str(position.get("canonicalPositionUrl", "")).strip()
        # t_update, not t_create: closer to PCSX's postedTs semantics
        # (most recent posting activity) than the tenant's internal
        # first-creation timestamp.
        posted_ts = position.get("t_update")
        department = position.get("department")
    locations = position.get("locations") or ([position["location"]] if position.get("location") else [])
    raw = {
        "source": "eightfold",
        "company": domain,
        "title": str(position.get("name", "")).strip(),
        "url": url,
        "external_job_id": job_id,
        "location": "; ".join(str(loc).strip() for loc in locations if str(loc).strip()),
    }
    if department:
        raw["department"] = str(department).strip()
    try:
        if posted_ts:
            import datetime
            raw["posted_at"] = datetime.datetime.fromtimestamp(int(posted_ts), tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError, OSError):
        pass
    return raw


def fetch_jd(url: str, targets_path: str, timeout: int) -> dict:
    """Posting URL -> JD JSON via the per-tenant detail endpoint. Needs
    `domain` (an API parameter, not present in the posting URL itself),
    recovered by matching the URL's host against the configured tenant
    list; same reason fetch_oracle_listings.py's --jd-url needs the
    posting URL to already encode host+site, except here the domain
    genuinely isn't derivable from the URL alone."""
    m = re.match(r"https?://([^/]+)/careers/job/(\d+)", url.strip())
    if m is None:
        die(f"unrecognized Eightfold posting URL shape: {url}")
    host, job_id = m.group(1), m.group(2)
    tenants = load_configured_tenants(targets_path)
    domain = next((d for h, d in tenants if h == host), None)
    if domain is None:
        die(f"host '{host}' is not in any configured eightfold_tenants entry; cannot recover its domain param")
    status, detail = api_get(f"https://{host}/api/apply/v2/jobs/{job_id}?domain={urllib.parse.quote(domain)}", timeout)
    if status != 200:
        die(f"JD detail fetch failed for {url}: HTTP {status}")
    jd_text = html_to_text(str(detail.get("job_description", "")))
    return {
        "source": "eightfold",
        "company": domain,
        "title": str(detail.get("name", "")).strip(),
        "location": "; ".join(str(loc).strip() for loc in (detail.get("locations") or [])),
        "url": url,
        "external_job_id": str(detail.get("id", job_id)).strip(),
        "jd_text": jd_text,
        "pay_text": extract_pay(jd_text),
    }


def _fetch_one_tenant(host: str, domain: str, args) -> tuple[list, str | None]:
    """One tenant's full paginated fetch. Returns (jobs, error_message_or_None)."""
    jobs = []
    start = 0
    count = 0
    try:
        while True:
            positions, total, variant = search_page(host, domain, args.search, start, args.timeout)
            for position in positions:
                raw = to_raw_job(position, host, domain, variant)
                if raw["title"] and raw["url"] and raw["external_job_id"]:
                    jobs.append(raw)
                    count += 1
                if args.limit and count >= args.limit:
                    break
            start += len(positions) if positions else PAGE_SIZE
            if not positions or start >= total or (args.limit and count >= args.limit):
                break
    except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError, RuntimeError) as exc:
        return jobs, str(exc)
    return jobs, None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_eightfold_listings.py",
        description="Fetch postings from Eightfold-powered careers sites (multi-tenant: Microsoft, Netflix, and others).",
    )
    parser.add_argument("--targets", default=DEFAULT_TARGETS)
    parser.add_argument("--search", default="", help="search query, e.g. 'software engineer intern'")
    parser.add_argument("--limit", type=int, default=200, help="max postings per tenant (0 = no cap)")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--jd-url", default="", help="fetch one posting's JD JSON instead of listing")
    args = parser.parse_args(argv)

    if args.jd_url:
        try:
            result = fetch_jd(args.jd_url, args.targets, args.timeout)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            die(f"JD fetch failed for {args.jd_url}: {exc}")
        else:
            print(json.dumps(result, ensure_ascii=False))
        return 0

    tenants = load_configured_tenants(args.targets)
    if not tenants:
        print("fetch_eightfold_listings: complete tenants=0 jobs=0 failed=0", file=sys.stderr)
        return 0

    fetched = 0
    failed = 0
    jobs = []
    # Tenants fetched concurrently, not one after another; see the
    # matching comment in fetch_oracle_listings.py's main(). Eightfold
    # tenants also each try up to two endpoint variants per page (see
    # search_page), so this matters even more per-tenant here than for
    # Oracle/Workday.
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(tenants))) as executor:
        future_to_tenant = {
            executor.submit(_fetch_one_tenant, host, domain, args): (host, domain)
            for host, domain in tenants
        }
        for future in concurrent.futures.as_completed(future_to_tenant):
            host, domain = future_to_tenant[future]
            tenant_jobs, error = future.result()
            if error is not None:
                warn(f"tenant '{host}/{domain}' failed to fetch: {error}; skipped")
                failed += 1
            else:
                fetched += 1
            jobs.extend(tenant_jobs)

    jobs.sort(key=lambda j: (j["company"], j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_eightfold_listings: complete tenants={fetched} jobs={len(jobs)} failed={failed}",
        file=sys.stderr,
    )
    if failed and not fetched:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
