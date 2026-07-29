#!/usr/bin/env python3
"""fetch_stripe_listings.py — Stripe careers search (HTML-first adapter).

Stripe has no public JSON search API; the search page itself is fully
server-side rendered, one <tr class="TableRow"> per listing row with the
title link, department, and location — no JS execution required. Second
HTML-parsed (not JSON-API) adapter in this codebase, same stdlib-only
convention as fetch_apple_listings.py (no beautifulsoup4/lxml).

  GET https://stripe.com/jobs/search?query=<query>&office_locations=<region>

No pagination mechanism was found live (no page/offset param, no "load
more" affordance in the static HTML) — the full result set for a query
renders in one response. This script does a single fetch, not a loop.

Confirmed live: a single posting duplicates across multiple <tr> rows,
one per location it's open in (its /jobs/listing/<slug>/<id> URL is
identical across those rows) — this script deduplicates by listing ID
and aggregates every distinct location into one job's `location` field,
joined with "; ", same convention fetch_microsoft_listings.py uses for
Microsoft's own multi-location array.

The list rows carry no JD text. Each detail page
(stripe.com/jobs/listing/<slug>/<id>) server-renders the full JD inside
a `<div class="ArticleMarkdown">` container — extracted here via a
simple div-depth scan (not a real HTML parser) since nested markup
inside it makes a single regex unreliable. Same two-step pattern as
Oracle/Workday/SmartRecruiters/Apple: list mode omits jd_text; after
role filtering and before the fit gate, fetch the JD per surviving
candidate via --jd-url.

Output contract:
  stdout — raw-job JSONL (list mode) or a single JD JSON (--jd-url),
           list mode sorted by (title, external_job_id).
  stderr — a machine-parseable summary line:
           fetch_stripe_listings: complete jobs=<n> failed=<true|false>

Exit codes:
  0  success (including zero matches)
  1  usage error
  3  the request failed entirely

Usage:
  python3 src/scripts/jobs/fetch_stripe_listings.py --search "software engineer" --limit 200
  python3 src/scripts/jobs/fetch_stripe_listings.py --jd-url 'https://stripe.com/jobs/listing/software-engineer-intern/8031833'
"""

from __future__ import annotations

import argparse
import html as html_lib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "aplyx-job-agent/ats-expansion"
SEARCH_BASE = "https://stripe.com/jobs/search"
SITE_BASE = "https://stripe.com"

_ROW_LINK_RE = re.compile(r'href="(/jobs/listing/[a-z0-9-]+/([A-Za-z0-9]+))"[^>]*>\s*([^<]+?)\s*</a>')
_LOCATION_RE = re.compile(r'class="JobsListings__locationDisplayName"[^>]*>([^<]*)</span>')
_DEPARTMENT_ITEM_RE = re.compile(r'class="[^"]*ListItem[^"]*"[^>]*>\s*([^<]+?)\s*</li>', re.S)


def warn(msg: str) -> None:
    print(f"fetch_stripe_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    print(f"fetch_stripe_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def http_get(url: str, timeout: int) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_search_page(content: str) -> list[dict]:
    """One <tr class="TableRow"> per (posting, location) pair — split on
    that boundary, pull the title/href/id from the link, department from
    the nested <li> list, and location from its display span, then
    aggregate rows sharing the same listing id into one job entry with
    every distinct location joined together."""
    by_id: dict[str, dict] = {}
    order: list[str] = []
    rows = re.split(r'<tr class="TableRow">', content)[1:]
    for row in rows:
        link_m = _ROW_LINK_RE.search(row)
        if not link_m:
            continue
        href, job_id, title = link_m.group(1), link_m.group(2), link_m.group(3)
        title = html_lib.unescape(title.strip())
        loc_m = _LOCATION_RE.search(row)
        location = html_lib.unescape(loc_m.group(1).strip()) if loc_m else ""
        dept_m = _DEPARTMENT_ITEM_RE.search(row)
        department = html_lib.unescape(dept_m.group(1).strip()) if dept_m else ""
        if job_id not in by_id:
            by_id[job_id] = {
                "source": "stripe",
                "company": "Stripe",
                "title": title,
                "url": f"{SITE_BASE}{href}",
                "external_job_id": job_id,
                "_locations": [],
            }
            order.append(job_id)
            if department:
                by_id[job_id]["department"] = department
        if location and location not in by_id[job_id]["_locations"]:
            by_id[job_id]["_locations"].append(location)
    jobs = []
    for job_id in order:
        job = by_id[job_id]
        job["location"] = "; ".join(job.pop("_locations"))
        jobs.append(job)
    return jobs


def _find_balanced_div(content: str, open_tag: str) -> str | None:
    """Scans forward from open_tag's end, counting <div ...> / </div>
    depth, and returns the inner HTML once depth returns to 0. A plain
    regex can't do this reliably because the JD content itself contains
    arbitrarily nested <div>/<p>/<ul> markup."""
    start_idx = content.find(open_tag)
    if start_idx == -1:
        return None
    start = start_idx + len(open_tag)
    depth = 1
    for m in re.finditer(r"<div\b|</div>", content[start:]):
        depth += 1 if m.group(0) == "<div" else -1
        if depth == 0:
            return content[start : start + m.start()]
    return None


def _strip_tags(markup: str) -> str:
    text = re.sub(r"<[^>]+>", " ", markup)
    return html_lib.unescape(re.sub(r"\s+", " ", text)).strip()


def fetch_jd(url: str, timeout: int) -> dict:
    content = http_get(url, timeout)
    inner = _find_balanced_div(content, '<div class="ArticleMarkdown">')
    jd_text = _strip_tags(inner) if inner else ""
    title_m = re.search(r'<meta property="og:title" content="([^"]+)"', content)
    return {
        "url": url,
        "title": html_lib.unescape(title_m.group(1)) if title_m else "",
        "jd_text": jd_text,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_stripe_listings.py",
        description="Fetch Stripe postings via HTML parsing of stripe.com/jobs/search (no public JSON API).",
    )
    parser.add_argument("--search", default="", help="search query, e.g. 'software engineer'")
    parser.add_argument("--location", default="", help="Stripe's office_locations filter value, if any")
    parser.add_argument("--limit", type=int, default=200, help="max postings total (0 = no cap)")
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

    jobs: list[dict] = []
    failed = False
    try:
        params = {"query": args.search}
        if args.location:
            params["office_locations"] = args.location
        content = http_get(f"{SEARCH_BASE}?{urllib.parse.urlencode(params)}", args.timeout)
        jobs = parse_search_page(content)
        if args.limit:
            jobs = jobs[: args.limit]
    except (urllib.error.URLError, OSError) as exc:
        warn(f"request failed: {exc}")
        failed = True

    jobs.sort(key=lambda j: (j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_stripe_listings: complete jobs={len(jobs)} failed={str(failed).lower()}",
        file=sys.stderr,
    )
    if failed and not jobs:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
