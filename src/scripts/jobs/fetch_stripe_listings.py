#!/usr/bin/env python3
"""fetch_stripe_listings.py — Stripe careers search (Phase 16B, rewritten
2026-08-10 — the original HTML-parsed approach broke).

Stripe's careers site moved from stripe.com/jobs/search to
stripe.com/careers/search (Next.js-rendered) at some point after this
adapter first shipped — confirmed live: the old regex parser (looking
for `<tr class="TableRow">` rows) found nothing on the new markup and
silently returned zero jobs on every query, which read as "no jobs
right now" instead of "this adapter needs a rewrite."

Investigating the new page found something better than a parser rewrite
would have been anyway: Stripe's own careers listings carry a
`greenhouseId` field, and Stripe is, underneath its custom front end,
fully served by the standard public Greenhouse Jobs API — confirmed live
against `boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true`
(550 real postings, full JD text included, same API every other
Greenhouse-hosted company in this codebase already uses). This is
exactly the "Class 3 — branded front-end, standard ATS back-end" pattern
`docs/ATS.md` already documents for Datadog/Palantir/OpenAI (Greenhouse/
Lever/Ashby respectively) — Stripe just wasn't recognized as belonging
to that class before. This adapter is kept as its own file (rather than
just adding "stripe" to `greenhouse_company_slugs` and retiring this
file) so the "stripe" board name in targets.json "boards" keeps working
unchanged for anyone who already has it configured — it's just backed by
a reliable API now instead of a regex over markup that could (and did)
change without notice. `source` in the raw-job output stays "stripe",
not "greenhouse", for the same backward-compat reason.

Unlike the old adapter, the list response carries FULL JD text
(`content`, HTML) — no separate per-posting detail fetch needed, same
as Amazon/Google/Muse. `--jd-url` is kept only for backward
compatibility with anything that saved an old-style stripe.com/jobs/
listing/... or gh_jid=... URL and wants to re-fetch its JD; new list
fetches never need it.

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
  python3 src/scripts/jobs/fetch_stripe_listings.py --jd-url 'https://stripe.com/jobs/search?gh_jid=8023928'
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request

from _jd_text import extract_pay, html_to_text

USER_AGENT = "aplyx-job-agent/phase16b (+https://github.com/keshm2/aplyx)"
BOARD_TOKEN = "stripe"
API_BASE = f"https://boards-api.greenhouse.io/v1/boards/{BOARD_TOKEN}/jobs"
_JD_URL_ID_RE = re.compile(r"[?&]gh_jid=(\d+)|/jobs/listing/[a-z0-9-]+/(\d+)", re.I)


def warn(msg: str) -> None:
    print(f"fetch_stripe_listings: WARNING: {msg}", file=sys.stderr)


def die(msg: str, code: int = 1) -> None:
    print(f"fetch_stripe_listings: ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def api_get(url: str, timeout: int) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def to_raw_job(job: dict) -> dict:
    jd_text = html_to_text(str(job.get("content", "")))
    return {
        "source": "stripe",
        "company": "Stripe",
        "title": str(job.get("title", "")).strip(),
        "url": str(job.get("absolute_url", "")).strip(),
        "external_job_id": str(job.get("id", "")).strip(),
        "location": str((job.get("location") or {}).get("name", "")).strip(),
        "jd_text": jd_text,
        "pay_text": extract_pay(jd_text),
        "posted_at": str(job.get("first_published", "")).strip() or None,
    }


def fetch_jd(url: str, timeout: int) -> dict:
    m = _JD_URL_ID_RE.search(url.strip())
    if m is None:
        die(f"unrecognized Stripe posting URL shape: {url}")
    job_id = m.group(1) or m.group(2)
    job = api_get(f"{API_BASE}/{job_id}?questions=false", timeout)
    raw = to_raw_job(job)
    return {"url": raw["url"], "title": raw["title"], "jd_text": raw["jd_text"], "pay_text": raw["pay_text"]}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fetch_stripe_listings.py",
        description="Fetch Stripe postings via the public Greenhouse Jobs API (Phase 16B).",
    )
    parser.add_argument("--search", default="", help="case-insensitive substring filter on title (client-side)")
    parser.add_argument("--limit", type=int, default=200, help="max postings total (0 = no cap)")
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

    jobs: list[dict] = []
    failed = False
    try:
        data = api_get(f"{API_BASE}?content=true", args.timeout)
        for job in data.get("jobs") or []:
            raw = to_raw_job(job)
            if raw["title"] and raw["url"] and raw["external_job_id"]:
                jobs.append(raw)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError, OSError) as exc:
        warn(f"request failed: {exc}")
        failed = True

    if args.search:
        terms = [t for t in args.search.strip().lower().split() if t]
        jobs = [j for j in jobs if all(t in j["title"].lower() for t in terms)]
    if args.limit:
        jobs = jobs[: args.limit]

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
