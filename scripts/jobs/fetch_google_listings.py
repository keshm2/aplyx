#!/usr/bin/env python3
"""fetch_google_listings.py — Google Careers (fragile, HTML-embedded-data adapter).

Google's careers search page has no public JSON API (a claimed internal
endpoint was never found — see research-notes.md). What it DOES have is
a fully server-rendered `AF_initDataCallback({key: 'ds:1', ..., data: [...]})`
block embedding the real search results as a POSITIONAL (unlabeled) JSON
array — confirmed live (2026-07-26). This is explicitly the most fragile
adapter in this codebase: there are no field names to key off, only array
indices, and Google can reshape this at any time with zero notice. See
the module-level HEALTH CHECK below — every run validates the structural
shape it depends on BEFORE trusting any parsed output; a shape mismatch
is a loud, distinct failure (exit 4), never silently-garbled titles or
locations.

  GET https://www.google.com/about/careers/applications/jobs/results/?q=<query>&page=<n>

Confirmed live field layout of one job record (data[0][<i>]), 21 fields:
  0  job ID (string)
  1  title
  2  application/signin URL (auth-gated — NOT used as this script's
     `url`; see below)
  3  [null, responsibilities_html]
  4  [null, minimum_qualifications_html]
  5  internal tenant/company path (opaque, not user-facing)
  7  company display name (e.g. "Google")
  9  locations: [[display_name, [alt_names], null, null, city, country], ...]
  10 [null, description_html] — the main "about this job" narrative
  12 [seconds, nanos] — posted timestamp (protobuf Timestamp shape)
  19 [null, qualifications_html] — a second, list-only rendering of
     quals (4 includes an <h3> header, this doesn't) — either is fine
     as JD content, this script prefers 19 for a cleaner concatenation
Fields not listed (6, 8, 11, 13-18, 20) are ignored — present but not
needed for this adapter's raw-job contract.

The FULL JD is embedded directly in the list response (description +
responsibilities + qualifications, confirmed live, no truncation
observed) — unlike almost every other adapter in this codebase, there
is NO separate --jd-url mode here; nothing else to fetch.

`url` is constructed as `.../jobs/results/<id>` — confirmed live this
resolves correctly (an exact slug isn't required; Google resolves by ID
alone) and, unlike field 2's signin link, needs no authentication to view.

Output contract:
  stdout — raw-job JSONL, sorted by (title, external_job_id).
  stderr — a machine-parseable summary line:
           fetch_google_listings: complete jobs=<n> failed=<true|false>

Exit codes:
  0  success (including zero matches)
  1  usage error
  3  the request failed entirely (network error on the first page)
  4  HEALTH CHECK FAILED — Google's embedded-data shape no longer
     matches what this script depends on; nothing was emitted, because
     trusting a reshaped structure risks silently-wrong titles/locations
     rather than a loud, obvious failure

Usage:
  python3 scripts/jobs/fetch_google_listings.py --search "software engineer intern" --limit 200
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
from datetime import datetime, timezone

USER_AGENT = "aplyx-job-agent/ats-expansion"
SEARCH_BASE = "https://www.google.com/about/careers/applications/jobs/results/"
SITE_BASE = "https://www.google.com/about/careers/applications/jobs/results"
PAGE_SIZE = 20
MAX_PAGES = 50


def warn(msg: str) -> None:
    print(f"fetch_google_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    print(f"fetch_google_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def http_get(url: str, timeout: int) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _extract_balanced_array(content: str, start: int) -> str | None:
    """Scans forward from `start` (which must point at a `[`), tracking
    bracket depth while respecting JSON string literals (so a `[` or `]`
    inside a quoted string, e.g. in JD HTML content, never miscounts).
    Returns the balanced array's raw text, or None if it never closes."""
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(content)):
        c = content[i]
        if in_string:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
        else:
            if c == '"':
                in_string = True
            elif c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0:
                    return content[start : i + 1]
    return None


def extract_ds1(content: str) -> list | None:
    key_idx = content.find("key: 'ds:1'")
    if key_idx == -1:
        return None
    data_idx = content.find("data:[", key_idx)
    if data_idx == -1:
        return None
    start = data_idx + len("data:")
    raw = _extract_balanced_array(content, start)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def health_check(data) -> str | None:
    """Validates the structural shape every field access below assumes,
    BEFORE any of it is trusted — see module docstring. Returns None if
    healthy, or a human-readable reason string if not. Deliberately
    checks types/shapes, not exact values (values legitimately vary
    job to job; a JD's URL always starting with "http" doesn't)."""
    if not isinstance(data, list) or len(data) < 3:
        return f"top-level data is not a list of >=3 elements (got {type(data).__name__}, len={len(data) if isinstance(data, list) else '?'})"
    jobs, total = data[0], data[2]
    if not isinstance(jobs, list):
        return f"data[0] (job list) is not a list (got {type(jobs).__name__})"
    if not isinstance(total, int):
        return f"data[2] (total count) is not an int (got {type(total).__name__})"
    if not jobs:
        return None  # an empty page is a legitimate outcome, not a shape problem
    sample = jobs[0]
    if not isinstance(sample, list) or len(sample) < 20:
        return f"a job record has {len(sample) if isinstance(sample, list) else '?'} fields, expected >=20"
    if not (isinstance(sample[0], str) and sample[0].strip()):
        return "job record field 0 (id) is not a non-empty string"
    if not (isinstance(sample[1], str) and sample[1].strip()):
        return "job record field 1 (title) is not a non-empty string"
    # A plain non-empty-string check alone can't tell fields 0 and 1
    # apart if they were silently swapped (both are non-empty strings
    # either way) — id is purely digits, a real title never is, so this
    # catches exactly that failure mode specifically.
    if not sample[0].isdigit():
        return "job record field 0 (id) does not look numeric — possible field reorder"
    if sample[1].isdigit():
        return "job record field 1 (title) looks purely numeric — possible field reorder with id"
    if not (isinstance(sample[2], str) and sample[2].startswith("http")):
        return "job record field 2 (application URL) does not look like a URL"
    if not isinstance(sample[9], list):
        return "job record field 9 (locations) is not a list"
    return None


def strip_html(markup) -> str:
    if not isinstance(markup, str):
        return ""
    text = re.sub(r"<[^>]+>", " ", markup)
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def _text_field(job: list, index: int) -> str:
    """Fields 3/4/10/19 are [null, "<html>"] wrappers, or occasionally
    just null/missing entirely — normalizes either into a plain string."""
    if index >= len(job):
        return ""
    val = job[index]
    if isinstance(val, list) and len(val) > 1:
        return strip_html(val[1])
    return ""


def to_raw_job(job: list) -> dict:
    job_id = str(job[0]).strip()
    locations = job[9] if len(job) > 9 and isinstance(job[9], list) else []
    location_names = [str(loc[0]).strip() for loc in locations if isinstance(loc, list) and loc and loc[0]]
    jd_parts = [_text_field(job, 10), _text_field(job, 3), _text_field(job, 19) or _text_field(job, 4)]
    raw = {
        "source": "google",
        "company": "Google",
        "title": str(job[1]).strip(),
        "url": f"{SITE_BASE}/{urllib.parse.quote(job_id)}",
        "external_job_id": job_id,
        "location": "; ".join(location_names),
        "jd_text": " ".join(p for p in jd_parts if p).strip(),
    }
    posted = job[12] if len(job) > 12 else None
    if isinstance(posted, list) and posted and isinstance(posted[0], (int, float)):
        try:
            raw["posted_at"] = datetime.fromtimestamp(int(posted[0]), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (ValueError, OSError):
            pass
    return raw


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_google_listings.py",
        description="Fetch Google Careers postings by parsing the embedded AF_initDataCallback search-results data.",
    )
    parser.add_argument("--search", default="", help="search query, e.g. 'software engineer intern'")
    parser.add_argument("--limit", type=int, default=200, help="max postings total (0 = no cap)")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args(argv)

    jobs: list[dict] = []
    seen_ids = set()
    failed = False
    checked_health = False
    try:
        for page in range(1, MAX_PAGES + 1):
            params = {"page": page}
            if args.search:
                params["q"] = args.search
            content = http_get(f"{SEARCH_BASE}?{urllib.parse.urlencode(params)}", args.timeout)
            data = extract_ds1(content)
            if data is None:
                die("could not locate/parse the AF_initDataCallback ds:1 block — Google's page structure has changed", code=4)
            if not checked_health:
                reason = health_check(data)
                if reason is not None:
                    die(f"health check failed — {reason} — refusing to emit possibly-garbled data", code=4)
                checked_health = True
            page_jobs = data[0]
            if not page_jobs:
                break
            for job in page_jobs:
                if len(job) < 20:
                    continue  # a malformed individual record — skip it, don't fail the whole run
                raw = to_raw_job(job)
                if raw["external_job_id"] in seen_ids:
                    continue
                seen_ids.add(raw["external_job_id"])
                jobs.append(raw)
                if args.limit and len(jobs) >= args.limit:
                    break
            if args.limit and len(jobs) >= args.limit:
                break
            if len(page_jobs) < PAGE_SIZE:
                break  # short page — this was the last one
    except (urllib.error.URLError, OSError) as exc:
        warn(f"request failed: {exc}")
        failed = True

    jobs.sort(key=lambda j: (j["title"].lower(), j["external_job_id"]))
    for job in jobs:
        print(json.dumps(job, ensure_ascii=False))
    print(
        f"fetch_google_listings: complete jobs={len(jobs)} failed={str(failed).lower()}",
        file=sys.stderr,
    )
    if failed and not jobs:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
