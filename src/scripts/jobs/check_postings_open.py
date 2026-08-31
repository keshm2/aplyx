#!/usr/bin/env python3
"""check_postings_open.py: lightweight direct closed/expired posting check.

job_state.py's mark_seen_batch infers a posting closed only after 3
consecutive scrapes where it's absent from its source's fresh aggregate
listing (CLOSED_MISS_THRESHOLD): slow (needs the scheduler running
consistently for 1.5+ hours to accumulate) and indirect (absence from an
aggregate listing isn't the same signal as the posting itself being gone,
and a job_key split (see dedupe_registry) could defeat it entirely by
never letting one identity accumulate misses). This script instead checks
a job's own current status directly: for most sources that means fetching
its own url/apply_url and looking for a 404/410 or explicit closure
language; for Ashby specifically (a client-rendered SPA: every route,
including a made-up job id, serves the same HTML shell and always
returns HTTP 200, so a plain GET can never see a closure banner or a real
404) it instead calls the same public job-board API
(api.ashbyhq.com/posting-api/job-board/<slug>, the same endpoint
src/core/src/jobs.ts's own Ashby fetch already uses for listings) once per
company and cross-checks each tracked posting's external_job_id against
that board's current active-postings list, the actual source of truth
Ashby's own frontend reads from, not a guess from unrendered markup.

Deliberately lightweight: a real headless-browser render can see what a
plain GET can't, but it's real CPU/memory/time next to a plain HTTP
request, so it's kept as a small, capped escalation rather than the
default:
  - Self-throttled to roughly once/day (MIN_HOURS_BETWEEN_RUNS), not once
    per 30-min scrape tick; this doesn't need scrape-cycle freshness to
    be useful, and hitting every tracked posting's own page every 30
    minutes would be impolite for no real benefit. Meant to be invoked
    from the same pre-harness block that already runs other deterministic
    checks each tick (see run_job_agent.py); the throttle is what keeps
    it to ~once/day despite firing that often.
  - Caps how many postings it checks per invocation (MAX_CHECKS_PER_RUN),
    picking the stalest (or never-checked) records first via
    last_checked_at, so a large registry is swept over several days
    instead of one slow synchronous burst.
  - The plain HTTP GET (cheap, no browser) is always tried first for every
    non-Ashby candidate and resolves most of them outright (a clean
    404/410, or closure text already present in server-rendered HTML).
    Only the ones that come back genuinely ambiguous (200, nothing
    conclusive in the raw markup, which is exactly what a client-rendered
    page looks like before its JS runs) escalate to a real browser render,
    and even then only up to BROWSER_CHECK_LIMIT per run, in one shared
    headless Chrome instance: not one launch per job. Anything past that
    small cap is left ambiguous for this run and re-tried on a later one.
  - Never guesses: a timeout, network error, or ambiguous response (at
    every tier) leaves the posting untouched (checked again next cycle)
    rather than treated as evidence of closure, the same "prefer a false
    negative over a false positive" rule the rest of aplyx's fit/dropdown
    logic follows. Applied jobs and already-closed jobs are skipped
    entirely (nothing useful to learn by re-checking either).

All registry writes go through job_state.py's own record-check-results
subcommand (one load/save for both the checked and closed updates);
this script only reads data/job_registry.json directly (a plain read, no
canonicalization needed) and shells out for every write, matching every
other script in this repo.

Output contract:
  stderr: a machine-parseable summary line:
           check_postings_open: complete checked=<n> closed=<n> skipped=<reason>
  Exit 0 always: best-effort bookkeeping, like mark_seen_batch. A
  network hiccup here must never fail or block a scheduled run.

Usage:
  python3 src/scripts/jobs/check_postings_open.py
  python3 src/scripts/jobs/check_postings_open.py --force
  python3 src/scripts/jobs/check_postings_open.py --limit 20 --timeout 6
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_REGISTRY = os.path.join("data", "job_registry.json")
DEFAULT_STATE = os.path.join("data", "postings_check_state.json")
JOB_STATE_HELPER = os.path.join("src", "scripts", "state", "job_state.py")

USER_AGENT = "aplyx-job-agent/postings-check"
MAX_CHECKS_PER_RUN = 20
MIN_HOURS_BETWEEN_RUNS = 20
REQUEST_TIMEOUT_S = 6
MAX_BODY_BYTES = 200_000  # enough to catch closure language; not the whole page

# Real-browser render pass: a small, capped escalation for genuinely
# ambiguous generic/non-Ashby candidates only (see _check_generic_with_browser
# and _select_browser_escalation), not the default check. RENDER_TIMEOUT_S
# is longer than REQUEST_TIMEOUT_S because a full page load with JS
# execution is slower than a raw HTTP GET; the fixed post-load pause gives
# client-side data-fetch-then-render a moment to finish before the DOM is
# read, without the hang risk of Playwright's "networkidle" wait (a page
# with any persistent background request, like analytics or a chat widget,
# would never reach idle at all).
BROWSER_CHECK_LIMIT = 5
RENDER_TIMEOUT_S = 15
RENDER_SETTLE_MS = 1500

CLOSED_STATUS_CODES = {404, 410}

ASHBY_URL_RE = re.compile(r"^https://jobs\.ashbyhq\.com/([^/]+)/")
ASHBY_API_URL = "https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false"

# Deliberately explicit, conservative phrases only: a miss here just means
# "checked again next cycle," so there's no cost to being picky; a false
# "closed" would falsely hide a real, still-open posting.
CLOSURE_PHRASES = [
    "no longer accepting applications",
    "position has been filled",
    "posting has expired",
    "this job is no longer available",
    "this position is no longer open",
    "this job posting has expired",
    "requisition has been closed",
    "job not found",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return default


def _write_state(path, data) -> None:
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=".postings_check_state.", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _should_run(state: dict, min_hours: float, force: bool) -> bool:
    if force:
        return True
    last = state.get("last_run_at")
    if not last:
        return True
    try:
        last_dt = datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    return (datetime.now(timezone.utc) - last_dt).total_seconds() >= min_hours * 3600


def _select_candidates(registry: list, limit: int) -> list:
    """Not-yet-applied, not-already-closed records with a real URL to check,
    stalest (or never-checked) first: see module docstring for why."""
    eligible = [
        rec for rec in registry
        if rec.get("job_key")
        and not rec.get("closed")
        and (rec.get("apply_url") or rec.get("url"))
    ]
    eligible.sort(key=lambda r: r.get("last_checked_at") or "")
    return eligible[:limit]


def _fetch_status_and_body(url: str, timeout: int):
    """Returns (status_code, body_text) or (None, None) on any failure:
    network errors, timeouts, and non-HTTP exceptions are all treated the
    same: no signal, not evidence of anything."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            raw = resp.read(MAX_BODY_BYTES)
    except urllib.error.HTTPError as exc:
        # An HTTPError still carries a real, meaningful status code (404,
        # 410, etc.): that's exactly the signal this script wants, not a
        # failure to be swallowed into (None, None).
        try:
            raw = exc.read(MAX_BODY_BYTES)
        except Exception:
            raw = b""
        return exc.code, raw.decode("utf-8", errors="ignore")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None, None
    return status, raw.decode("utf-8", errors="ignore")


def _looks_closed(status, body: str) -> bool:
    if status in CLOSED_STATUS_CODES:
        return True
    if not body:
        return False
    lowered = body.lower()
    return any(phrase in lowered for phrase in CLOSURE_PHRASES)


def _check_generic_with_browser(candidates: list, timeout_s: int):
    """Render each candidate's page with a real (headless) Chrome and check
    the fully-rendered text for a closure signal or a 404/410; sees
    content a plain HTTP GET can't for any client-rendered ATS/career page
    other than Ashby (which has its own authoritative API check above).

    One browser instance for the whole batch, not one launch per job: the
    launch is the expensive part, not visiting a handful more pages once
    it's up.

    Deliberately does NOT reuse replay_fill.py's launch_persistent_context
    pattern (the user's real Chrome profile): that's built for an
    interactive, user-watched replay and can fail outright if the user's
    own Chrome is already open (a profile lock). This is a silent
    background check with nothing to show the user, so it launches a
    disposable, ephemeral browser instead (still channel="chrome", the
    user's real installed Chrome, no bundled-Chromium download, just no
    persistent profile to conflict with).

    Returns a {job_key: bool_closed} dict for every candidate it actually
    managed to check. A candidate missing from the result means the
    browser path itself is unavailable (no playwright package, no Chrome,
    launch failure) or this specific page errored: the caller falls back
    to the plain HTTP check for anything missing, never assumes open or
    closed for a page it couldn't examine.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {}

    results = {}
    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(channel="chrome", headless=True)
            except Exception:
                return {}
            try:
                page = browser.new_page(user_agent=USER_AGENT)
                for rec in candidates:
                    url = rec.get("apply_url") or rec.get("url")
                    try:
                        response = page.goto(url, wait_until="domcontentloaded", timeout=timeout_s * 1000)
                        page.wait_for_timeout(RENDER_SETTLE_MS)
                        status = response.status if response else None
                        body = page.inner_text("body")
                    except Exception:
                        continue  # this one falls back to the plain HTTP check
                    results[rec["job_key"]] = _looks_closed(status, body)
            finally:
                browser.close()
    except Exception:
        return {}
    return results


def _ashby_slug(rec: dict):
    match = ASHBY_URL_RE.match(rec.get("url") or "")
    return match.group(1) if match else None


def _fetch_ashby_active_ids(slug: str, timeout: int):
    """Every currently-listed job id for one Ashby company board, or None on
    any fetch/parse failure: None must never be treated as 'zero active
    jobs,' or a transient failure would look like every posting under that
    slug just closed at once."""
    req = urllib.request.Request(
        ASHBY_API_URL.format(slug=slug), headers={"User-Agent": USER_AGENT}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            # No read-size cap: a fixed byte cap was the actual bug here:
            # Ashby's batch response includes full HTML job descriptions
            # for every posting, and a company with a large board (Notion,
            # 133 jobs) genuinely exceeds a couple MB. A truncated read
            # produces a JSON string cut off mid-token, which the broad
            # except below silently turns into "board fetch failed":
            # exactly the failure mode that was making real closures go
            # undetected. This is one controlled call to a known public
            # API, not an unbounded/attacker-controlled stream, so reading
            # to completion is safe.
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
        return None
    jobs = data.get("jobs") if isinstance(data, dict) else None
    if not isinstance(jobs, list):
        return None
    return {str(j.get("id")) for j in jobs if isinstance(j, dict) and j.get("id")}


def _run_job_state(args) -> dict:
    proc = subprocess.run(
        [sys.executable, JOB_STATE_HELPER, *args],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return {}
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except json.JSONDecodeError:
        return {}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default=DEFAULT_REGISTRY)
    parser.add_argument("--state", default=DEFAULT_STATE)
    parser.add_argument("--limit", type=int, default=MAX_CHECKS_PER_RUN)
    parser.add_argument("--timeout", type=int, default=REQUEST_TIMEOUT_S)
    parser.add_argument("--min-hours", type=float, default=MIN_HOURS_BETWEEN_RUNS)
    parser.add_argument("--force", action="store_true", help="ignore the once/day throttle")
    args = parser.parse_args(argv)

    state = _read_json(args.state, {})
    if not _should_run(state, args.min_hours, args.force):
        print(
            f"check_postings_open: skipped=throttled last_run_at={state.get('last_run_at')}",
            file=sys.stderr,
        )
        return 0

    registry = _read_json(args.registry, [])
    if not isinstance(registry, list):
        print("check_postings_open: skipped=registry_unreadable", file=sys.stderr)
        return 0

    candidates = _select_candidates(registry, args.limit)
    checked_keys = []
    closed_keys = []

    ashby_candidates = [rec for rec in candidates if rec.get("source") == "ashbyhq" and _ashby_slug(rec)]
    ashby_keys = {rec["job_key"] for rec in ashby_candidates}
    generic_candidates = [rec for rec in candidates if rec["job_key"] not in ashby_keys]

    # One API call per distinct company slug, not per job; cheaper than
    # the generic per-job fetch below, and it's the only way to get a real
    # signal out of Ashby's client-rendered pages at all (see module
    # docstring: every Ashby route returns HTTP 200 regardless of whether
    # the job exists).
    slugs = sorted({_ashby_slug(rec) for rec in ashby_candidates})
    active_ids_by_slug = {slug: _fetch_ashby_active_ids(slug, args.timeout) for slug in slugs}
    for rec in ashby_candidates:
        active_ids = active_ids_by_slug.get(_ashby_slug(rec))
        if active_ids is None:
            # The board-level API call for this slug failed (network hiccup,
            # rate limit, etc.): nothing was actually verified for ANY job
            # under this slug, so none of them should be stamped
            # last_checked_at. Doing so anyway was a real bug: it made a
            # failed check look like a fresh, clean one, sinking these jobs
            # to the bottom of the next run's stalest-first priority and
            # leaving them unverified for a long time, exactly backwards
            # from what should happen after a failed attempt.
            continue
        checked_keys.append(rec["job_key"])
        if rec.get("external_job_id") not in active_ids:
            closed_keys.append(rec["job_key"])

    # Plain HTTP GET first for every generic candidate: cheap, and it
    # settles most of them outright (a clean 404/410, or closure text
    # already present in server-rendered HTML). A response that comes back
    # 200 with nothing conclusive is exactly what a client-rendered page
    # looks like before its JS runs; queue those for the small, capped
    # browser escalation below rather than guessing either way. A fetch
    # that fails outright (status is None: network error/timeout) is left
    # alone entirely: nothing learned, not queued for escalation either.
    generic_ambiguous = []
    for rec in generic_candidates:
        url = rec.get("apply_url") or rec.get("url")
        status, body = _fetch_status_and_body(url, args.timeout)
        if status is None:
            # Fetch failed outright (network error/timeout): nothing
            # learned, so (matching the Ashby-tier fix above) this must NOT
            # be stamped last_checked_at either; doing so would falsely
            # mark an unverified job as freshly checked and push it to the
            # back of the next run's priority queue.
            continue
        checked_keys.append(rec["job_key"])
        if _looks_closed(status, body):
            closed_keys.append(rec["job_key"])
        else:
            generic_ambiguous.append(rec)

    browser_results = _check_generic_with_browser(generic_ambiguous[:BROWSER_CHECK_LIMIT], RENDER_TIMEOUT_S)
    for job_key, is_closed in browser_results.items():
        if is_closed:
            closed_keys.append(job_key)

    if checked_keys:
        _run_job_state([
            "record-check-results", json.dumps(checked_keys), json.dumps(closed_keys),
            "--registry", args.registry,
        ])

    state["last_run_at"] = now_iso()
    _write_state(args.state, state)

    print(
        f"check_postings_open: complete checked={len(checked_keys)} closed={len(closed_keys)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
