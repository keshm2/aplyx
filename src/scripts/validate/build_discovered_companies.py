#!/usr/bin/env python3
"""build_discovered_companies.py: derive a large company+ATS+slug/tenant
directory from public, community-maintained job-listing feeds.

The hand-vetted lists (src/config/{ashby,lever,greenhouse,smartrecruiters}_
vetted_slugs.json) are deliberately small: every entry there was
individually verified against its ATS's public API by a human, in a PR.
This script covers the opposite end of the tradeoff: it mines much larger,
community-maintained feeds for (company, vendor, slug) tuples (for
slug-based ATSes: Ashby/Lever/Greenhouse/SmartRecruiters/Workable/Rippling/
Recruitee/Breezy) and (company, vendor, tenant) tuples (for host+site-based
systems: Workday/Oracle Recruiting Cloud/Eightfold), and writes everything
it can parse to config/discovered_companies.json.

Sources (all fetched fresh on every run: nothing here is a static
snapshot committed once and forgotten):

1. Four community listing-tracker feeds (the same feeds
   scripts/jobs/fetch_simplify_listings.py already fetches at runtime):
   SimplifyJobs' Summer-Internships + New-Grad-Positions, and vanshb03's
   independently-scraped siblings sharing the same listings.json schema.
   Job-posting URLs are regex-matched for a vendor+slug. Only resolves
   Ashby/Lever/Greenhouse/SmartRecruiters this way (the other vendors'
   URLs don't carry a clean slug in the posting link itself).
   No LICENSE file on any of these repos as of this writing: no explicit
   written grant to redistribute a derived dataset. This project already
   fetches the same raw JSON at runtime for job listings (an established,
   narrower use); caching a derived company/slug directory is a related
   but distinct downstream use worth revisiting if this project's
   distribution ever broadens.
2. zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships
   (MIT-licensed, github.com/zshah101): an independently-maintained,
   continuously-updated (automated GitHub Actions discovery/audit/retry
   workflows; observed pushing within the same hour this script was
   written) directory of ~4,300 companies with ATS type ALREADY resolved,
   including full tenant components for Workday (`wd` + `site`) and
   Oracle Recruiting Cloud (`host` + `site`): the two systems this
   script previously had no way to discover at all, since their public
   endpoints need a full tenant string, not a slug pulled from a job URL.
   This is the primary source for `discovered_tenants` below.

Slug-based entries land in the `companies` key (unchanged shape from
before this script had multiple sources; src/core/src/data/
companyDirectory.ts reads this key directly for the onboarding/Settings
company-autocomplete picker, tier "discovered", ranked below "vetted").
Vendors with no current aplyx fetch adapter (Workable, Rippling,
Recruitee, Breezy) are still captured under `companies` for forward
reference: companyDirectory.ts's KNOWN_VENDORS allowlist already
filters unknown vendors safely, so this is inert until an adapter for
one of them ships, not a live behavior change.

Host+site tenant entries (Workday/Oracle/Eightfold) land in a separate
`discovered_tenants` key: NOT wired into companyDirectory.ts (that
picker is deliberately slug-only; see its own top-of-file comment) and
NOT auto-applied into any targets.json. These are candidates for a
human to hand-copy into `workday_tenants` / `oracle_tenants` /
`eightfold_tenants` after a quick spot-check: some companies carry
more than one tenant/site (e.g. a lateral-hire site vs a campus/early-
careers site, or a regional variant), and picking the wrong one just
means that tenant returns zero postings at runtime (every fetch helper
already degrades a bad/empty tenant to a warning, never a crash: see
AGENTS.md), not a wrong-company mix-up.

This is NOT hand-verified the way the vetted lists are: it's best-
effort extraction over third-party data, reviewed here only in
aggregate. This is a manual/periodic refresh, not part of any automated
run or schedule; re-run it by hand when you want a bigger/fresher
company pool, review the diff, and commit it like any other vetted-list
change.

Usage:
  python3 src/scripts/validate/build_discovered_companies.py
  python3 src/scripts/validate/build_discovered_companies.py --out src/config/discovered_companies.json
  python3 src/scripts/validate/build_discovered_companies.py --skip-zshah101   # SimplifyJobs only
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_OUT = "src/config/discovered_companies.json"
USER_AGENT = "aplyx-job-agent/phase16b (+https://github.com/keshm2/aplyx)"

# Same four feeds fetch_simplify_listings.py already pulls at runtime:
# kept as a separate copy here (not imported) since this is a one-off
# maintenance script, not part of the request-time fetch path. Repo names
# in this ecosystem get renamed every hiring cycle (...2026... -> ...2027...);
# these are the current canonical names as of 2026-08-09; see
# fetch_simplify_listings.py's FEEDS comment for the rename history.
SIMPLIFY_FEED_URLS = [
    "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
    "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json",
    "https://raw.githubusercontent.com/vanshb03/New-Grad-2027/dev/.github/scripts/listings.json",
]

ZSHAH101_COMPANIES_URL = (
    "https://raw.githubusercontent.com/zshah101/"
    "Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships/"
    "main/data/companies.json"
)

# (vendor, slug) from a SimplifyJobs job-posting URL. Ashby/Lever job URLs
# always carry the slug as the first path segment; Greenhouse uses either
# hostname interchangeably (both boards.* and job-boards.* are seen in the
# wild) and is occasionally slug-less (an opaque embed token); that shape
# just won't match and is silently skipped. SmartRecruiters job URLs carry
# the company identifier the same way.
SIMPLIFY_URL_PATTERNS = [
    ("ashby", re.compile(r"^https?://jobs\.ashbyhq\.com/([^/?#]+)", re.IGNORECASE)),
    ("lever", re.compile(r"^https?://jobs\.lever\.co/([^/?#]+)", re.IGNORECASE)),
    ("greenhouse", re.compile(r"^https?://(?:boards|job-boards)\.greenhouse\.io/([^/?#]+)", re.IGNORECASE)),
    ("smartrecruiters", re.compile(r"^https?://jobs\.smartrecruiters\.com/([^/?#]+)", re.IGNORECASE)),
]

# Vendors zshah101's feed already resolves that map straight to aplyx's
# `companies` (slug-based) shape: no host/site tenant needed.
ZSHAH101_SLUG_VENDORS = {
    "ashby", "lever", "greenhouse", "smartrecruiters", "workable", "rippling",
    "recruitee", "breezy",
}
# Vendors that need a full tenant string (host+site) instead of a slug.
ZSHAH101_TENANT_VENDORS = {"workday", "oracle", "eightfold"}
# "amazon" (single-company plain board, not multi-tenant) is intentionally
# excluded from both; it's already handled as a plain "amazon" boards.json
# toggle (fetch_amazon_listings.py), not a slug or tenant lookup.


def warn(msg: str) -> None:
    print(f"build_discovered_companies: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    print(f"build_discovered_companies: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def fetch_json(url: str, timeout: int) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def extract_simplify_vendor_slug(url: str) -> tuple[str, str] | None:
    for vendor, pattern in SIMPLIFY_URL_PATTERNS:
        m = pattern.match(url.strip())
        if m:
            return vendor, m.group(1).lower()
    return None


def atomic_write_json(path: str, data: dict) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".discovered.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, sort_keys=False)
            f.write("\n")
        os.replace(tmp_path, path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def collect_from_simplify(timeout: int) -> tuple[dict[str, dict[str, set]], int, int]:
    """Returns (companies, total_listings, failed_feeds)."""
    companies: dict[str, dict[str, set]] = {}
    total_listings = 0
    failed_feeds = 0

    for url in SIMPLIFY_FEED_URLS:
        try:
            listings = fetch_json(url, timeout)
        except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
            warn(f"could not fetch {url}: {exc}")
            failed_feeds += 1
            continue
        if not isinstance(listings, list):
            warn(f"{url} did not return a JSON array")
            failed_feeds += 1
            continue
        total_listings += len(listings)
        for listing in listings:
            if not isinstance(listing, dict):
                continue
            name = str(listing.get("company_name", "")).strip()
            raw_url = str(listing.get("url", "")).strip()
            if not name or not raw_url:
                continue
            hit = extract_simplify_vendor_slug(raw_url)
            if hit is None:
                continue
            vendor, slug = hit
            companies.setdefault(name, {}).setdefault(vendor, set()).add(slug)

    return companies, total_listings, failed_feeds


def collect_from_zshah101(timeout: int) -> tuple[dict[str, dict[str, set]], list[dict], int]:
    """Returns (slug_companies, tenant_entries, entries_scanned)."""
    slug_companies: dict[str, dict[str, set]] = {}
    tenant_entries: list[dict] = []

    try:
        records = fetch_json(ZSHAH101_COMPANIES_URL, timeout)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
        warn(f"could not fetch {ZSHAH101_COMPANIES_URL}: {exc}")
        return slug_companies, tenant_entries, 0
    if not isinstance(records, list):
        warn(f"{ZSHAH101_COMPANIES_URL} did not return a JSON array")
        return slug_companies, tenant_entries, 0

    for rec in records:
        if not isinstance(rec, dict):
            continue
        name = str(rec.get("name", "")).strip()
        ats = str(rec.get("ats", "")).strip().lower()
        if not name or not ats:
            continue

        if ats in ZSHAH101_SLUG_VENDORS:
            slug = str(rec.get("slug", "")).strip()
            if not slug:
                continue
            slug_companies.setdefault(name, {}).setdefault(ats, set()).add(slug.lower())
        elif ats == "workday":
            slug = str(rec.get("slug", "")).strip()
            wd = str(rec.get("wd", "")).strip()
            site = str(rec.get("site", "")).strip()
            if not (slug and wd and site):
                continue
            tenant_entries.append({
                "company_name": name,
                "vendor": "workday",
                "tenant": f"{slug}.{wd}.myworkdayjobs.com/{site}",
                "source": "zshah101",
            })
        elif ats == "oracle":
            host = str(rec.get("host", "")).strip()
            site = str(rec.get("site", "")).strip()
            if not (host and site):
                continue
            tenant_entries.append({
                "company_name": name,
                "vendor": "oracle",
                "tenant": f"{host}/{site}",
                "source": "zshah101",
            })
        elif ats == "eightfold":
            host = str(rec.get("host", "")).strip()
            domain = str(rec.get("domain", "")).strip()
            if not (host and domain):
                continue
            tenant_entries.append({
                "company_name": name,
                "vendor": "eightfold",
                "tenant": f"{host}/{domain}",
                "source": "zshah101",
            })
        # "amazon" and any future/unknown ats values: skip; no
        # slug/tenant shape this script knows how to emit for them yet.

    return slug_companies, tenant_entries, len(records)


def merge_companies(a: dict[str, dict[str, set]], b: dict[str, dict[str, set]]) -> None:
    """Merges b into a in place."""
    for name, vendors in b.items():
        dest = a.setdefault(name, {})
        for vendor, slugs in vendors.items():
            dest.setdefault(vendor, set()).update(slugs)


def dedupe_tenants(entries: list[dict]) -> list[dict]:
    seen: set[tuple[str, str]] = set()
    out = []
    for e in sorted(entries, key=lambda e: (e["vendor"], e["company_name"], e["tenant"])):
        key = (e["vendor"], e["tenant"].lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="build_discovered_companies.py",
        description="Derive a large company/ATS/slug-or-tenant directory from public listing feeds.",
    )
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--skip-zshah101", action="store_true",
                         help="SimplifyJobs feeds only (skip the zshah101 tenant-resolving source).")
    args = parser.parse_args(argv)

    companies, simplify_scanned, simplify_failed = collect_from_simplify(args.timeout)
    if simplify_failed == len(SIMPLIFY_FEED_URLS):
        warn("every SimplifyJobs feed failed to fetch")

    zshah101_scanned = 0
    tenant_entries: list[dict] = []
    if not args.skip_zshah101:
        zshah_companies, tenant_entries, zshah101_scanned = collect_from_zshah101(args.timeout)
        merge_companies(companies, zshah_companies)

    if simplify_failed == len(SIMPLIFY_FEED_URLS) and zshah101_scanned == 0:
        die("every source failed to fetch: nothing to write")

    entries = []
    for name in sorted(companies):
        for vendor in sorted(companies[name]):
            for slug in sorted(companies[name][vendor]):
                entries.append({"company_name": name, "vendor": vendor, "slug": slug})

    tenant_entries = dedupe_tenants(tenant_entries)

    by_vendor: dict[str, int] = {}
    for e in entries:
        by_vendor[e["vendor"]] = by_vendor.get(e["vendor"], 0) + 1
    by_tenant_vendor: dict[str, int] = {}
    for e in tenant_entries:
        by_tenant_vendor[e["vendor"]] = by_tenant_vendor.get(e["vendor"], 0) + 1

    output = {
        "_provenance": (
            "Auto-generated by src/scripts/validate/build_discovered_companies.py "
            "from (1) four community listing-tracker feeds: SimplifyJobs' "
            "Summer-Internships + New-Grad-Positions and vanshb03's independently-"
            "scraped siblings (github.com/SimplifyJobs, github.com/vanshb03; no "
            "LICENSE file on either, see this script's own docstring), and "
            "(2) zshah101's MIT-licensed, continuously-updated company/ATS directory "
            "(github.com/zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-"
            "Tech-Internships), NOT individually hand-verified the way "
            "src/config/*_vetted_slugs.json entries are. Re-run the script to "
            "refresh; review the diff before committing."
        ),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source_urls": SIMPLIFY_FEED_URLS + ([] if args.skip_zshah101 else [ZSHAH101_COMPANIES_URL]),
        "source_listings_scanned": simplify_scanned,
        "source_companies_scanned_zshah101": zshah101_scanned,
        "companies": entries,
        "discovered_tenants": tenant_entries,
        "_discovered_tenants_help": (
            "Workday/Oracle Recruiting Cloud/Eightfold candidates: full host+site "
            "tenant strings, not slugs. NOT wired into the onboarding/Settings "
            "company picker (that picker is deliberately slug-only; see "
            "src/core/src/data/companyDirectory.ts's top-of-file comment) and NOT "
            "auto-applied into any targets.json. Hand-copy a tenant string into "
            "'workday_tenants' / 'oracle_tenants' / 'eightfold_tenants' after a "
            "quick spot-check. Some companies carry more than one tenant/site here "
            "(e.g. a lateral-hire site vs. a campus/early-careers site); a wrong "
            "pick just returns zero postings at runtime, every fetch helper already "
            "degrades a bad tenant to a warning, never a crash."
        ),
    }

    try:
        atomic_write_json(args.out, output)
    except OSError as exc:
        die(f"could not write {args.out}: {exc}")

    print(
        f"build_discovered_companies: complete companies={len(entries)} "
        f"by_vendor={by_vendor} tenants={len(tenant_entries)} "
        f"by_tenant_vendor={by_tenant_vendor} "
        f"simplify_scanned={simplify_scanned} zshah101_scanned={zshah101_scanned}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
