#!/usr/bin/env python3
"""fetch_apple_listings.py: Apple careers search (HTML-first adapter).

Apple has no working public JSON search API (a community-claimed POST
endpoint `jobs.apple.com/api/role/search` returned 404 in live testing;
don't re-attempt without captured session cookies/CSRF headers). The
search page itself, however, is fully server-side rendered: each job
card in the HTML contains title, team, location, posted date, and the
role's URL, no JS execution required. This is the first HTML-parsed (not
JSON-API) adapter in this codebase; parsing is stdlib-only
(`re`/`html.unescape`), matching every other script in this directory's
zero-dependency convention, not a general HTML/DOM parser.

  GET https://jobs.apple.com/en-us/search?search=<query>&location=united-states-USA&page=<n>

Pagination is a plain `page=<n>` query param (confirmed live: page 2
returns a disjoint set of job IDs from page 1); this script stops once a
page yields zero new job listings or --limit is reached.

The search page's inline description is a truncated preview, not the
full JD (confirmed live: cuts off mid-sentence with no closing
punctuation). Each detail page (`jobs.apple.com/en-us/details/<id>/...`)
embeds the FULL job data (jobSummary, description, minimumQualifications,
preferredQualifications) as an escaped JSON string inside a
`window.__staticRouterHydrationData = JSON.parse("...")` script tag;
confirmed live. Same two-step pattern as Oracle/Workday/SmartRecruiters:
list mode omits jd_text; after role filtering and before the fit gate,
fetch the JD per surviving candidate via --jd-url.

Output contract:
  stdout: raw-job JSONL (list mode) or a single JD JSON (--jd-url),
           list mode sorted by (title, external_job_id).
  stderr: a machine-parseable summary line:
           fetch_apple_listings: complete jobs=<n> failed=<true|false>

Exit codes:
  0  success (including zero matches)
  1  usage error
  3  the request failed entirely (network error on the first page)

Usage:
  python3 src/scripts/jobs/fetch_apple_listings.py --search "software engineer" --limit 200
  python3 src/scripts/jobs/fetch_apple_listings.py --jd-url 'https://jobs.apple.com/en-us/details/200674164-3401/acoustic-transducer-engineer?team=HRDWR'
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

from _jd_text import extract_pay, join_sections

USER_AGENT = "aplyx-job-agent/ats-expansion"
SEARCH_BASE = "https://jobs.apple.com/en-us/search"
SITE_BASE = "https://jobs.apple.com"
# Apple's search list caps around 20 cards/page regardless of any page-size
# param (none was found); bounded purely by the `page=<n>` cursor.
MAX_PAGES = 50

_JOB_CARD_RE = re.compile(r'<a[^>]*aria-label="([^"]+)"[^>]*href="(/en-us/details/[^"]+)"')
_TEAM_RE = re.compile(r'class="team-name[^"]*"[^>]*>([^<]*)</span>')
_DATE_RE = re.compile(r'class="job-posted-date"[^>]*>([^<]*)</span>')
_LOCATION_RE = re.compile(r'id="search-store-name[^"]*"[^>]*>([^<]*)</span>')


def warn(msg: str) -> None:
    print(f"fetch_apple_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    print(f"fetch_apple_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def http_get(url: str, timeout: int) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_search_page(content: str) -> list[dict]:
    """Split on each job-detail anchor and pull the sibling team/date/
    location spans from the following slice of markup. Each job appears
    twice (the title link, and a duplicate "See full role description:"
    link inside its expanded accordion body); keep only the first,
    title-bearing occurrence per unique href."""
    jobs = []
    seen_hrefs = set()
    parts = re.split(r'(?=<a[^>]*href="/en-us/details/)', content)
    for part in parts[1:]:
        m = _JOB_CARD_RE.match(part)
        if not m:
            continue
        label, href = m.group(1), m.group(2)
        if label.startswith("See full role description"):
            continue
        if href in seen_hrefs:
            continue
        seen_hrefs.add(href)
        # aria-label is "<title>  <role number>": split off the trailing
        # numeric id to recover the title alone.
        title_m = re.match(r"^(.*?)\s+(\d+)$", label.strip())
        title = html_lib.unescape(title_m.group(1).strip() if title_m else label.strip())
        window = part[:2000]
        team_m = _TEAM_RE.search(window)
        date_m = _DATE_RE.search(window)
        loc_m = _LOCATION_RE.search(window)
        # The href's job-id segment (e.g. "200674164-3401") is more stable
        # than the aria-label's numeric id alone; some postings share a
        # role number across locations, differentiated only by this suffix.
        id_m = re.match(r"/en-us/details/([^/]+)/", href)
        job = {
            "source": "apple",
            "company": "Apple",
            "title": title,
            "url": f"{SITE_BASE}{href}",
            "external_job_id": id_m.group(1) if id_m else href,
            "location": html_lib.unescape(loc_m.group(1).strip()) if loc_m else "",
        }
        if team_m:
            job["department"] = html_lib.unescape(team_m.group(1).strip())
        if date_m:
            job["posted_at_display"] = date_m.group(1).strip()
        jobs.append(job)
    return jobs


# Fields present in the detail page's embedded job-data JSON, in the
# order they should be concatenated into jd_text, each with the heading
# it should render under: Apple's own page already separates these into
# a Summary/Description/Minimum/Preferred structure (confirmed live:
# these fields carry no inline HTML at all, unlike every other source
# here, but they were still being joined with zero labels, leaving no
# way to tell where "Description" ended and "Minimum Qualifications"
# began).
_JD_FIELDS = [
    ("jobSummary", "Summary"),
    ("description", "Description"),
    ("minimumQualifications", "Minimum Qualifications"),
    ("preferredQualifications", "Preferred Qualifications"),
]


def _extract_escaped_field(content: str, key: str) -> str | None:
    """Pulls one field's value out of the escaped-JSON-inside-a-JS-string
    blob (window.__staticRouterHydrationData = JSON.parse("...")) without
    needing to correctly bound and fully re-parse the entire multi-hundred-
    KB blob: find `\"<key>\":\"`, read up to the next unescaped `\"` that's
    followed by `,\"<nextKey>\":` or `}`, then decode just that slice as a
    JSON string literal (handles \\n, \\", \\\\ escaping correctly)."""
    m = re.search(re.escape(f'\\"{key}\\":\\"'), content)
    if m is None:
        return None
    start = m.end()
    end_m = re.search(r'(?<!\\\\)\\"(,\\"[a-zA-Z]+\\":|\})', content[start:])
    if end_m is None:
        return None
    raw = content[start : start + end_m.start()]
    try:
        once = json.loads(f'"{raw}"')
        # Doubly escaped: the JD text is JSON-escaped once for its own
        # storage, then that whole JSON document is escaped again as a JS
        # string literal for JSON.parse("..."). Confirmed live: a single
        # unescape pass leaves literal "\\n"/"\\"" sequences behind
        # instead of real newlines/quotes. A second pass resolves them;
        # falls back to the single-unescaped value if the second pass
        # isn't valid (e.g. a lone backslash from a genuinely different
        # source), rather than losing the field entirely.
        try:
            return json.loads(f'"{once}"')
        except json.JSONDecodeError:
            return once
    except json.JSONDecodeError:
        return None


def fetch_jd(url: str, timeout: int) -> dict:
    content = http_get(url, timeout)
    jd_text = join_sections([(label, _extract_escaped_field(content, key) or "") for key, label in _JD_FIELDS])
    # postingTitle is one of the same embedded-JSON fields jobSummary/
    # description/etc. come from; more reliable than scraping a <title>
    # tag (this page's <title> isn't a simple static element).
    title = _extract_escaped_field(content, "postingTitle") or ""
    return {
        "url": url,
        "title": title,
        "jd_text": jd_text,
        "pay_text": extract_pay(jd_text),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_apple_listings.py",
        description="Fetch Apple postings via HTML parsing of jobs.apple.com/en-us/search (no public JSON API).",
    )
    parser.add_argument("--search", default="", help="search query, e.g. 'software engineer'")
    parser.add_argument("--location", default="united-states-USA", help="Apple's location-picker slug")
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
    seen_ids = set()
    failed = False
    try:
        for page in range(1, MAX_PAGES + 1):
            params = {"search": args.search, "location": args.location, "page": page}
            content = http_get(f"{SEARCH_BASE}?{urllib.parse.urlencode(params)}", args.timeout)
            page_jobs = parse_search_page(content)
            new_jobs = [j for j in page_jobs if j["external_job_id"] not in seen_ids]
            if not new_jobs:
                break
            for job in new_jobs:
                seen_ids.add(job["external_job_id"])
                jobs.append(job)
                if args.limit and len(jobs) >= args.limit:
                    break
            if args.limit and len(jobs) >= args.limit:
                break
    except (urllib.error.URLError, OSError) as exc:
        warn(f"request failed: {exc}")
        failed = True

    jobs.sort(key=lambda j: (j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_apple_listings: complete jobs={len(jobs)} failed={str(failed).lower()}",
        file=sys.stderr,
    )
    if failed and not jobs:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
