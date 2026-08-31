#!/usr/bin/env python3
"""job_cache_client.py: shared read-only cache client for the automatic
job-scraper agent (Phase: search caching).

Mirrors src/core/src/jobCache.ts / jobCacheRedis.ts / jobs.ts's
maybeCached() for the Python side, so the deterministic fetch scripts
the job-scraper agent already calls as a black box (currently only
fetch_smartrecruiters_listings.py: see this module's docstring in the
project plan for why Ashby/Lever/Greenhouse aren't wired in yet) can
transparently skip a live fetch when a fresh-enough shared-cache row
already exists, without the agent's own prompt/reasoning changing at
all.

Two-tier lookup per source, both read-only, never raising: a broken
or absent cache must always degrade to exactly the caller's existing
live-fetch behavior, the same "cache is optional" contract jobCache.ts
documents on the TS side:

  1. Upstash Redis (src/config/job_cache_redis.json's read-only token):
     the browse-all (`query=""`, no title words) entry only, warmed
     daily by refreshJobCache.ts. This module never writes Redis:
     writes need a write-capable token that must never leave CI (see
     refreshJobCache.ts's own header for why).
  2. The Postgres job_cache_search RPC (src/config/job_cache_supabase.json's
     anon key): same RPC the TS path calls, so the ILIKE title
     pre-filter (src/job_cache_supabase/supabase/migrations/0005) stays entirely server-side;
     this module never reimplements that prefix-matching logic, only
     passes p_title_words through.

Company-list union logic matches maybeCached() exactly: the shared,
committed list in src/config/job_cache_targets.json is always cache-checked;
whichever of a source's *personal* src/config/targets.json companies aren't
already in that shared list are the caller's responsibility to always
live-fetch: get_cached_jobs() only ever returns cache coverage for the
shared list, by design.

Usage (as a library):
    from job_cache_client import get_cached_jobs, shared_slugs

    shared = shared_slugs(root, "smartrecruiters")
    cached = get_cached_jobs(root, "smartrecruiters", sorted(shared))
    # cached is a list[dict] of raw-job-shaped dicts, or None on a full
    # miss (Redis miss AND Postgres miss/error): the caller should
    # live-fetch exactly as if this module didn't exist.
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_TARGETS = "src/config/targets.json"
DEFAULT_JOB_CACHE_TARGETS = "src/config/job_cache_targets.json"
DEFAULT_REDIS_CONFIG = "src/config/job_cache_redis.json"
DEFAULT_SUPABASE_CONFIG = "src/config/job_cache_supabase.json"
PLACEHOLDER = "replace_me"
USER_AGENT = "aplyx-job-agent/job-cache-client"

# Matches jobCache.ts's UNFILTERED_PER_COMPANY_LIMIT: the browse-all
# cap a cached/warmed row set was built under, so a Postgres-RPC-path
# result here stays consistent with whatever a Redis-path result would
# have returned for the same lookup.
UNFILTERED_PER_COMPANY_LIMIT = 10

# Well under both this module's own request timeouts and the caller's
# live-fetch budget; a slow/hung cache must never delay the caller's
# fallback to its own normal live path.
REQUEST_TIMEOUT_SECONDS = 2

_SHARED_SLUG_KEYS = {
    "ashbyhq": "ashby_company_slugs",
    "lever": "lever_company_slugs",
    "greenhouse": "greenhouse_company_slugs",
    "smartrecruiters": "smartrecruiters_company_slugs",
}


def _warn(msg: str) -> None:
    print(f"job_cache_client: WARNING: {msg}", file=sys.stderr)


def _read_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def shared_slugs(root: str, source: str) -> set[str]:
    """The full shared, committed company list for a source: same file
    every install shares, independent of the operator's own personal
    src/config/targets.json. Never raises; a missing/unreadable file just
    means the shared list is empty, safely falling back to "nothing is
    cache-eligible" rather than breaking the caller."""
    key = _SHARED_SLUG_KEYS.get(source)
    if key is None:
        return set()
    try:
        parsed = _read_json(os.path.join(root, DEFAULT_JOB_CACHE_TARGETS))
    except (OSError, json.JSONDecodeError):
        return set()
    raw = parsed.get(key)
    if not isinstance(raw, list):
        return set()
    return {str(s).strip() for s in raw if str(s).strip() and str(s).strip().lower() != PLACEHOLDER}


def _read_redis_config(root: str) -> tuple[str, str] | None:
    try:
        parsed = _read_json(os.path.join(root, DEFAULT_REDIS_CONFIG))
    except (OSError, json.JSONDecodeError):
        return None
    url = str(parsed.get("url", "")).strip()
    token = str(parsed.get("readOnlyToken", "")).strip()
    if not url or not token:
        return None
    if "YOUR-UPSTASH-ENDPOINT" in url or token == "YOUR_UPSTASH_READ_ONLY_REST_TOKEN":
        return None
    return url, token


def _read_supabase_config(root: str) -> tuple[str, str] | None:
    try:
        parsed = _read_json(os.path.join(root, DEFAULT_SUPABASE_CONFIG))
    except (OSError, json.JSONDecodeError):
        return None
    url = str(parsed.get("url", "")).strip()
    anon_key = str(parsed.get("anonKey", "")).strip()
    if not url or not anon_key:
        return None
    if "YOUR_JOB_CACHE_PROJECT_REF" in url or anon_key == "YOUR_JOB_CACHE_SUPABASE_ANON_KEY":
        return None
    return url, anon_key


def _redis_get_browse_all(root: str, source: str) -> list[dict] | None:
    config = _read_redis_config(root)
    if config is None:
        return None
    url, token = config
    key = f"jobcache:v1:{source}:"
    body = json.dumps(["GET", key]).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            payload = json.load(resp)
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        return None
    result = payload.get("result")
    if not isinstance(result, str) or not result:
        return None
    try:
        decompressed = gzip.decompress(base64.b64decode(result))
        jobs = json.loads(decompressed.decode("utf-8"))
    except (ValueError, OSError, json.JSONDecodeError):
        return None
    if not isinstance(jobs, list) or not jobs:
        return None
    return jobs


def _postgres_search(
    root: str, source: str, company_slugs: list[str], title_words: list[str]
) -> list[dict] | None:
    config = _read_supabase_config(root)
    if config is None or not company_slugs:
        return None
    url, anon_key = config
    per_company_limit = 75 if title_words else UNFILTERED_PER_COMPANY_LIMIT
    body = json.dumps(
        {
            "p_source": source,
            "p_company_slugs": company_slugs,
            "p_query": "",
            "p_per_company_limit": per_company_limit,
            "p_title_words": title_words,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/rest/v1/rpc/job_cache_search",
        data=body,
        method="POST",
        headers={
            "apikey": anon_key,
            "Authorization": f"Bearer {anon_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS * 2) as resp:
            rows = json.load(resp)
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        return None
    if not isinstance(rows, list) or not rows:
        return None
    return rows


def _row_to_raw_job(row: dict, source: str) -> dict:
    """job_cache row shape -> the raw-job JSON contract job_state.py
    canonicalize expects, same fields fetch_smartrecruiters_listings.py's
    to_raw_job() produces."""
    job = {
        "source": source,
        "company": row.get("company", ""),
        "title": row.get("title", ""),
        "url": row.get("url", ""),
        "external_job_id": row.get("external_job_id") or "",
        "location": row.get("location") or "",
    }
    if row.get("apply_url"):
        job["apply_url"] = row["apply_url"]
    if row.get("posted_at"):
        job["posted_at"] = row["posted_at"]
    if row.get("jd_text"):
        job["jd_text"] = row["jd_text"]
    return job


def get_cached_jobs(
    root: str, source: str, company_slugs: list[str], title_words: list[str] | None = None
) -> list[dict] | None:
    """Redis (browse-all only) -> Postgres RPC -> None. Never raises.
    None means a full miss: the caller should live-fetch company_slugs
    exactly as if this function didn't exist."""
    words = title_words or []
    if not company_slugs:
        return None
    if not words:
        redis_rows = _redis_get_browse_all(root, source)
        if redis_rows is not None:
            wanted = set(company_slugs)
            filtered = [job for job in redis_rows if isinstance(job, dict) and job.get("company") in wanted]
            if filtered:
                return filtered
    rows = _postgres_search(root, source, company_slugs, words)
    if rows is None:
        return None
    return [_row_to_raw_job(row, source) for row in rows]
