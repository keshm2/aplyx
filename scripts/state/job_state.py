#!/usr/bin/env python3
"""job_state.py — canonical internal job/event model helpers (Phase 1).

Deterministic, stdlib-only helpers for the canonical local job registry and
the internal event log. Run from the project root (scripts/runtime/run_job_agent.sh
cd's there before invoking this).

Local state files (relative to the current working directory):
  data/job_registry.json   canonical registry (JSON array)
  data/job_events.jsonl    internal event log (JSON Lines)
  data/applied_jobs.json   existing user-facing outcome log (read-only here)

Subcommands:
  ensure-files                       Create/validate the registry + event files.
  canonicalize '<raw-job-json>'      Produce a canonical job record from raw input.
  upsert-job '<canonical-job-json>'  Insert or merge a canonical job into the registry.
  can-apply '<canonical-job-json>'   Pre-apply dedupe recheck (registry + applied_jobs).
  record-event '<event-json>'        Append an event to the log; update registry status.

Exit codes:
  0  success (can-apply reports can_apply=true)
  1  usage / IO / JSON validation error
  2  can-apply reports can_apply=false (job should not be applied again)
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.parse

# --- Defaults --------------------------------------------------------------

DEFAULT_REGISTRY = "data/job_registry.json"
DEFAULT_EVENTS = "data/job_events.jsonl"
DEFAULT_APPLIED = "data/applied_jobs.json"

# Marketing/tracking query params stripped during URL normalization. Anything
# beginning with "utm_" is also stripped. Kept conservative so that params
# which can carry meaning on job boards (e.g. "ref", "source", "src") survive.
TRACKING_PARAMS = frozenset({
    "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid",
    "_ga", "_gl", "hsctatracking", "igshid", "vero_id",
    "yclid", "twclid", "li_fat_id", "mkt_tok", "vero_conv",
    "ref_src", "ref_url", "trk", "tracking_source", "tracking",
})

# (ats_system, registrable-domain) pairs. The apply URL is checked before the
# listing URL because it identifies the actual ATS handling submissions.
ATS_URL_PATTERNS = [
    ("greenhouse", ("greenhouse.io", "grnh.us")),
    ("lever", ("lever.co",)),
    ("ashby", ("ashbyhq.com",)),
    ("workday", ("myworkdayjobs.com", "myworkdaysite.com")),
    ("smartrecruiters", ("smartrecruiters.com",)),
    ("amazon", ("amazon.jobs",)),
    ("oracle", ("oraclecloud.com",)),
    ("apple", ("jobs.apple.com",)),
    ("stripe", ("stripe.com",)),
    ("gem", ("jobs.gem.com",)),
    ("icims", ("icims.com",)),
    ("taleo", ("taleo.net",)),
    ("successfactors", ("successfactors.com", "successfactors.eu")),
    ("wellfound", ("wellfound.com", "angel.co")),
    ("handshake", ("joinhandshake.com", "handshake.com")),
    ("linkedin", ("linkedin.com",)),
    ("indeed", ("indeed.com",)),
]

ATS_SOURCE_MAP = {
    "greenhouse": "greenhouse",
    "lever": "lever",
    "ashbyhq": "ashby",
    "ashby": "ashby",
    "smartrecruiters": "smartrecruiters",
    "amazon": "amazon",
    "oracle": "oracle",
    # No URL-pattern entry for Eightfold above — its hosts vary per
    # tenant with no common suffix (apply.careers.microsoft.com,
    # explore.jobs.netflix.net, ... — confirmed live, see
    # fetch_eightfold_listings.py's header), so this source-name
    # fallback is the only reliable signal.
    "eightfold": "eightfold",
    # No URL-pattern entry for Google either — google.com is too broad a
    # domain to safely match on (risks false-positives against unrelated
    # Google-hosted URLs that might appear in some other source's apply
    # flow), so this is source-fallback-only too.
    "google": "google",
    "apple": "apple",
    "stripe": "stripe",
    "gem": "gem",
    "wellfound": "wellfound",
    "linkedin": "linkedin",
    "indeed": "indeed",
    "handshake": "handshake",
}

# Statuses allowed in the event log and a registry record's latest_status.
ALLOWED_STATUSES = frozenset({
    "new", "seen", "applied", "needs_review", "failed", "skipped_unfit",
})

# Registry statuses that block re-application in can-apply. A resumed or
# retried run must not re-apply a job whose registry record already reflects
# an applied, needs_review, failed, or skipped_unfit outcome; only the
# pre-outcome states (new, seen) leave the job eligible.
BLOCKING_STATUSES = frozenset({
    "applied", "needs_review", "failed", "skipped_unfit",
})

# --- Small helpers ---------------------------------------------------------


def die(msg, code=1):
    """Print an error to stderr and exit."""
    print(f"job_state: {msg}", file=sys.stderr)
    sys.exit(code)


def now_iso():
    """Current UTC time as a fixed-format ISO 8601 string (sortable, no microseconds)."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pick(d, keys):
    """Return the first non-empty string value among d[keys], else ''."""
    for k in keys:
        v = d.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    return ""


def parse_json_arg(arg, label):
    """Parse a JSON object from a CLI argument string."""
    try:
        obj = json.loads(arg)
    except json.JSONDecodeError as exc:
        die(f"{label}: not valid JSON: {exc.msg}")
    if not isinstance(obj, dict):
        die(f"{label}: expected a JSON object, got {type(obj).__name__}")
    return obj


def _earliest(a, b):
    """Return the earlier of two ISO 8601 UTC strings (lexicographic); non-empty wins."""
    if a and b:
        return min(a, b)
    return a or b


def _latest(a, b):
    """Return the later of two ISO 8601 UTC strings (lexicographic); non-empty wins."""
    if a and b:
        return max(a, b)
    return a or b


# --- File I/O --------------------------------------------------------------


def load_json_array(path):
    """Load a JSON array file; return [] if it does not exist."""
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read {path}: {exc}")
    if not isinstance(data, list):
        die(f"{path}: expected a JSON array, got {type(data).__name__}")
    return data


def save_json_array(path, data):
    """Atomically write a JSON array (pretty, trailing newline)."""
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except Exception as exc:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        die(f"could not write {path}: {exc}")


def append_jsonl(path, obj):
    """Append one JSON object as a line to a JSONL file."""
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    line = json.dumps(obj, ensure_ascii=False)
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as exc:
        die(f"could not append to {path}: {exc}")


# --- URL normalization -----------------------------------------------------


def _is_tracking_param(name):
    n = name.lower()
    return n.startswith("utm_") or n in TRACKING_PARAMS


def _host_matches(host, pattern):
    """True when host is the registrable domain or a subdomain of it."""
    return host == pattern or host.endswith("." + pattern)


def normalize_url(url):
    """Normalize a URL: add scheme, lowercase host, drop default port, drop
    fragment and tracking query params, and sort the remaining params for stable
    comparison. Returns '' for empty input."""
    if not url:
        return ""
    url = url.strip()
    if not url:
        return ""
    if "://" not in url and not url.startswith("//"):
        url = "https://" + url
    parts = urllib.parse.urlsplit(url)
    scheme = parts.scheme.lower() or "https"
    netloc = parts.netloc.lower()
    if netloc.endswith(":80"):
        netloc = netloc[:-3]
    elif netloc.endswith(":443"):
        netloc = netloc[:-4]
    kept = sorted(
        (k, v)
        for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=False)
        if not _is_tracking_param(k)
    )
    query = urllib.parse.urlencode(kept)
    return urllib.parse.urlunsplit((scheme, netloc, parts.path, query, ""))


# --- ATS inference ---------------------------------------------------------


def infer_ats_system(source, normalized_url, normalized_apply_url):
    """Infer the ATS from the apply URL, then the listing URL, then the source."""
    for candidate in (normalized_apply_url, normalized_url):
        if not candidate:
            continue
        host = (urllib.parse.urlsplit(candidate).hostname or "").lower()
        if not host:
            continue
        for ats, patterns in ATS_URL_PATTERNS:
            if any(_host_matches(host, p) for p in patterns):
                return ats
    return ATS_SOURCE_MAP.get(source, "")


# --- External ID extraction ------------------------------------------------

_EXT_ID_PATTERNS = [
    re.compile(r"wellfound\.com/jobs/(\d+)", re.I),
    re.compile(r"linkedin\.com/jobs/view/(\d+)", re.I),
    re.compile(r"[?&]gh_jid=(\d+)", re.I),
    re.compile(r"lever\.co/posting/([0-9a-f-]+)", re.I),
    re.compile(r"[?&]jk=(\w+)", re.I),
    re.compile(r"ashbyhq\.com/[^/]+/([0-9a-f-]+)", re.I),
    re.compile(r"smartrecruiters\.com/[^/]+/(\d+)", re.I),
    re.compile(r"amazon\.jobs/[a-z-]+/jobs/(\d+)", re.I),
    re.compile(r"oraclecloud\.com/hcmUI/CandidateExperience/[a-z-]+/sites/[^/]+/job/(\d+)", re.I),
]


def extract_external_id(url, raw):
    """Best-effort external job id: explicit fields first, then URL patterns."""
    for k in ("external_job_id", "external_id", "id"):
        v = raw.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    if url:
        for pat in _EXT_ID_PATTERNS:
            m = pat.search(url)
            if m:
                return m.group(1)
    return ""


# --- Canonicalization ------------------------------------------------------


def derive_job_key(canonical):
    """Stable SHA-256 job key. Priority: apply URL, URL, source+ext id, natural key."""
    apply_url = canonical.get("normalized_apply_url", "")
    url = canonical.get("normalized_url", "")
    ext = canonical.get("external_job_id", "")
    source = canonical.get("source", "")
    if apply_url:
        material = "apply:" + apply_url
    elif url:
        material = "url:" + url
    elif ext and source:
        material = "src:" + source + ":" + ext
    else:
        company = canonical.get("company", "").strip().lower()
        title = canonical.get("title", "").strip().lower()
        location = canonical.get("location", "").strip().lower()
        role_type = canonical.get("role_type", "").strip().lower()
        material = "nat:" + "|".join([company, title, location, role_type])
    return "jk:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def derive_job_id(canonical):
    """Human-readable internal id: '{source}-{external_job_id}' if available, else job_key."""
    ext = canonical.get("external_job_id", "")
    source = canonical.get("source", "")
    if ext and source:
        return f"{source}-{ext}"
    return canonical.get("job_key", "")


def canonicalize(raw):
    """Build a canonical job record from a raw job dict."""
    for required in ("source", "company", "title"):
        if not pick(raw, (required,)):
            die(f"canonicalize: missing required field '{required}'")
    source = pick(raw, ("source",)).lower()
    company = pick(raw, ("company",))
    title = pick(raw, ("title",))
    url = pick(raw, ("url", "link", "job_url"))
    apply_url = pick(raw, ("apply_url", "applyUrl", "application_url", "apply"))
    external_job_id = extract_external_id(url, raw)
    location = pick(raw, ("location", "location_text", "location_name"))
    location_tier = pick(raw, ("location_tier",))
    internship_term = pick(raw, ("internship_term", "term", "season"))
    role_type = pick(raw, ("role_type",))
    jd_text = pick(raw, ("jd_text", "description", "jd", "job_description", "description_text"))
    normalized_url = normalize_url(url)
    normalized_apply_url = normalize_url(apply_url)
    ats_system = infer_ats_system(source, normalized_url, normalized_apply_url)
    now = now_iso()
    first_seen_at = pick(raw, ("first_seen_at",)) or now
    last_seen_at = pick(raw, ("last_seen_at",)) or now
    latest_status = pick(raw, ("latest_status", "status")) or "new"
    canonical = {
        "job_key": "",
        "job_id": "",
        "external_job_id": external_job_id,
        "source": source,
        "sources": [
            {
                "source": source,
                "url": url,
                "external_job_id": external_job_id,
                "first_seen_at": first_seen_at,
                "last_seen_at": last_seen_at,
            }
        ],
        "company": company,
        "title": title,
        "url": url,
        "apply_url": apply_url,
        "normalized_url": normalized_url,
        "normalized_apply_url": normalized_apply_url,
        "ats_system": ats_system,
        "location": location,
        "location_tier": location_tier,
        "internship_term": internship_term,
        "role_type": role_type,
        "jd_text": jd_text,
        "first_seen_at": first_seen_at,
        "last_seen_at": last_seen_at,
        "latest_status": latest_status,
    }
    canonical["job_key"] = derive_job_key(canonical)
    canonical["job_id"] = derive_job_id(canonical)
    return canonical


# --- Upsert / merge --------------------------------------------------------


def _find_record(registry, job_key):
    for rec in registry:
        if rec.get("job_key") == job_key:
            return rec
    return None


def _merge_sources(existing_sources, new_sources):
    """Merge new source records into existing ones by (source, url)."""
    for ns in new_sources:
        ns_key = (ns.get("source", ""), ns.get("url", ""))
        found = False
        for es in existing_sources:
            if (es.get("source", ""), es.get("url", "")) == ns_key:
                es["last_seen_at"] = _latest(
                    es.get("last_seen_at", ""), ns.get("last_seen_at", "")
                )
                found = True
                break
        if not found:
            existing_sources.append(dict(ns))
    return existing_sources


def merge_job(existing, new):
    """Merge a new canonical record into an existing registry record (in place)."""
    # job_key is the identity — never changes.
    # job_id / external_job_id: keep existing if present, else adopt new.
    for f in ("job_id", "external_job_id"):
        if not existing.get(f):
            existing[f] = new.get(f, "")
    # source: keep the first-seen (primary) source.
    # sources: merge all source records instead of duplicating rows.
    existing["sources"] = _merge_sources(
        existing.get("sources", []) or [], new.get("sources", []) or []
    )
    # Adopt new values only where existing is empty.
    for f in (
        "url", "apply_url", "normalized_url", "normalized_apply_url",
        "ats_system", "location", "location_tier", "internship_term",
        "role_type",
    ):
        if not existing.get(f):
            existing[f] = new.get(f, "")
    # jd_text: prefer the longer (richer) text.
    if len(new.get("jd_text", "")) > len(existing.get("jd_text", "")):
        existing["jd_text"] = new.get("jd_text", "")
    # Timestamps: first_seen = earliest, last_seen = latest.
    existing["first_seen_at"] = _earliest(
        existing.get("first_seen_at", ""), new.get("first_seen_at", "")
    )
    existing["last_seen_at"] = _latest(
        existing.get("last_seen_at", ""), new.get("last_seen_at", "")
    )
    # latest_status: keep a non-"new" existing status; only adopt new if existing is "new".
    if existing.get("latest_status", "new") == "new":
        existing["latest_status"] = new.get("latest_status", "new")


def upsert_job(canonical, registry_path):
    """Insert or merge a canonical job into the registry. Returns (record, action)."""
    if not canonical.get("job_key"):
        canonical["job_key"] = derive_job_key(canonical)
    if not canonical.get("job_id"):
        canonical["job_id"] = derive_job_id(canonical)
    registry = load_json_array(registry_path)
    existing = _find_record(registry, canonical["job_key"])
    if existing is None:
        if not canonical.get("sources"):
            canonical["sources"] = [
                {
                    "source": canonical.get("source", ""),
                    "url": canonical.get("url", ""),
                    "external_job_id": canonical.get("external_job_id", ""),
                    "first_seen_at": canonical.get("first_seen_at", ""),
                    "last_seen_at": canonical.get("last_seen_at", ""),
                }
            ]
        registry.append(canonical)
        result, action = canonical, "inserted"
    else:
        merge_job(existing, canonical)
        result, action = existing, "merged"
    save_json_array(registry_path, registry)
    return result, action


# --- Closed-posting inference (consecutive misses) --------------------------

# How many consecutive scrapes a record can be absent from (while its
# source IS being actively scraped — see mark_seen_batch's source-scoping
# below) before it's inferred closed. 3 gives real margin against a single
# transient fetch failure/rate-limit for one board looking identical to a
# genuinely closed posting, while still catching persistently-vanished
# postings within a handful of scrape cycles.
CLOSED_MISS_THRESHOLD = 3


def _record_sources(record):
    """Every source name a registry record has ever been seen under —
    record["source"] is just the first-seen/primary one; record["sources"]
    (see upsert_job/merge_job) can carry more than one when the same
    job_key was found via multiple boards."""
    names = {record.get("source", "")}
    for s in record.get("sources", []) or []:
        if s.get("source"):
            names.add(s["source"])
    names.discard("")
    return names


def mark_seen_batch(job_keys, sources, registry_path):
    """Updates every registry record whose source overlaps `sources` (the
    sources actually scraped THIS run) — never records from sources this
    run didn't touch at all, since "absent because this board wasn't
    scraped this time" and "absent because the posting is actually gone"
    are very different things, and conflating them would infer closed on
    every record from a temporarily-disabled/skipped board. A record in
    `job_keys` (found in this run's batch) has its miss counter reset
    (and is reopened if a prior run had marked it closed — a posting
    reappearing after being inferred closed most likely means it was
    reposted/reopened, not that the inference was wrong); everything
    else eligible gets its counter incremented, crossing
    CLOSED_MISS_THRESHOLD sets closed=true. Returns a summary dict, never
    raises on a malformed individual record — this is best-effort
    bookkeeping, not a correctness-critical write path the way
    upsert-job/record-event are.
    """
    job_keys = set(job_keys)
    sources = set(sources)
    registry = load_json_array(registry_path)
    seen = 0
    missed = 0
    newly_closed = 0
    reopened = 0
    for record in registry:
        if not _record_sources(record) & sources:
            continue
        if record.get("job_key") in job_keys:
            record["consecutive_misses"] = 0
            if record.get("closed"):
                record["closed"] = False
                reopened += 1
            seen += 1
        else:
            count = int(record.get("consecutive_misses", 0)) + 1
            record["consecutive_misses"] = count
            missed += 1
            if count >= CLOSED_MISS_THRESHOLD and not record.get("closed"):
                record["closed"] = True
                newly_closed += 1
    save_json_array(registry_path, registry)
    return {
        "ok": True,
        "seen": seen,
        "missed": missed,
        "newly_closed": newly_closed,
        "reopened": reopened,
    }


# --- Pre-apply dedupe recheck ----------------------------------------------


def can_apply(canonical, registry_path, applied_path):
    """Re-check dedupe against the registry and applied_jobs.json immediately
    before application. Returns a machine-readable result dict."""
    job_key = canonical.get("job_key", "")
    job_id = canonical.get("job_id", "")
    normalized_url = canonical.get("normalized_url", "")
    normalized_apply_url = canonical.get("normalized_apply_url", "")
    url = canonical.get("url", "")
    result = {
        "can_apply": True,
        "reason": "not previously applied",
        "job_key": job_key,
        "job_id": job_id,
        "checked_registry": True,
        "checked_applied_jobs": True,
    }

    # 1. Registry: block if a record with a blocking status matches the
    #    candidate by any canonical identity field — job_key, job_id,
    #    normalized_url, or normalized_apply_url. job_key is checked first
    #    so the common single-record case produces a stable reason string.
    for rec in load_json_array(registry_path):
        status = rec.get("latest_status", "")
        if status not in BLOCKING_STATUSES:
            continue
        matched_field = None
        if job_key and rec.get("job_key") == job_key:
            matched_field = "job_key"
        elif job_id and rec.get("job_id") == job_id:
            matched_field = "job_id"
        elif normalized_url and rec.get("normalized_url") == normalized_url:
            matched_field = "normalized_url"
        elif (
            normalized_apply_url
            and rec.get("normalized_apply_url") == normalized_apply_url
        ):
            matched_field = "normalized_apply_url"
        if matched_field:
            result.update(
                can_apply=False,
                reason=(
                    f"registry record matched by {matched_field} has "
                    f"latest_status='{status}'"
                ),
                matched_in="registry",
                matched_status=status,
            )
            break

    if not result["can_apply"]:
        return result

    # 2. applied_jobs.json: block if url (normalized) or job_id already present.
    for entry in load_json_array(applied_path):
        e_url = entry.get("url", "")
        e_norm = normalize_url(e_url)
        e_job_id = entry.get("job_id", "")
        if (
            (e_norm and normalized_url and e_norm == normalized_url)
            or (e_url and url and e_url == url)
            or (e_job_id and job_id and e_job_id == job_id)
        ):
            result.update(
                can_apply=False,
                reason=f"already present in applied_jobs.json (job_id={e_job_id})",
                matched_in="applied_jobs",
                matched_status=entry.get("status", ""),
            )
            break

    return result


# --- Event recording -------------------------------------------------------


def record_event(event, registry_path, events_path):
    """Append an event to the JSONL log and update the matching registry record.

    The outcome is read from ``status``; if absent, ``event_type`` is accepted
    as an alias and validated against the same allowed local statuses. The
    resolved status is normalized back into ``event['status']`` so the
    persisted event is self-describing regardless of which key the caller used.
    """
    job_key = event.get("job_key", "")
    if not job_key:
        die("record-event: event missing 'job_key'")
    status = event.get("status", "") or event.get("event_type", "")
    if not status:
        die("record-event: event missing 'status' (or 'event_type' alias)")
    if status not in ALLOWED_STATUSES:
        die(
            f"record-event: invalid status '{status}' "
            f"(allowed: {', '.join(sorted(ALLOWED_STATUSES))})"
        )
    event["status"] = status
    if "recorded_at" not in event:
        event["recorded_at"] = now_iso()

    append_jsonl(events_path, event)

    # Update the matching registry record's latest_status when possible.
    registry = load_json_array(registry_path)
    updated = False
    for rec in registry:
        if rec.get("job_key") == job_key:
            prior = rec.get("latest_status", "")
            if prior in BLOCKING_STATUSES and status not in BLOCKING_STATUSES:
                # Status-transition guard: never downgrade a registry record
                # from a blocking outcome (applied/needs_review/failed/
                # skipped_unfit) back to a non-blocking discovery status
                # (new/seen). The event is still logged above; only the
                # registry's latest_status is protected.
                print(
                    f"job_state: record-event: keeping blocking status "
                    f"'{prior}' for job_key={job_key} "
                    f"(incoming non-blocking status '{status}' ignored)",
                    file=sys.stderr,
                )
            else:
                rec["latest_status"] = status
            rec["last_seen_at"] = event["recorded_at"]
            updated = True
            break
    if updated:
        save_json_array(registry_path, registry)
    else:
        print(
            f"job_state: record-event: no registry record for job_key={job_key} "
            f"(event still logged to {events_path})",
            file=sys.stderr,
        )
    return event


# --- ensure-files ----------------------------------------------------------


def ensure_files(registry_path, events_path):
    """Create/validate the registry (JSON array) and event log (JSONL) files."""
    # Registry: create as [] if missing; validate it is a JSON array.
    if not os.path.exists(registry_path):
        save_json_array(registry_path, [])
    else:
        load_json_array(registry_path)  # validates shape

    # Events: create empty if missing; validate each non-blank line is JSON.
    d = os.path.dirname(events_path) or "."
    os.makedirs(d, exist_ok=True)
    if not os.path.exists(events_path):
        open(events_path, "w", encoding="utf-8").close()
    else:
        with open(events_path, "r", encoding="utf-8") as f:
            for lineno, line in enumerate(f, 1):
                s = line.strip()
                if not s:
                    continue
                try:
                    json.loads(s)
                except json.JSONDecodeError as exc:
                    die(f"{events_path}:{lineno}: invalid JSON line: {exc.msg}")


# --- CLI -------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="job_state.py",
        description="Canonical internal job/event model helpers (Phase 1).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_ensure = sub.add_parser(
        "ensure-files", help="create/validate the registry and event log files"
    )
    p_ensure.add_argument("--registry", default=DEFAULT_REGISTRY)
    p_ensure.add_argument("--events", default=DEFAULT_EVENTS)

    p_canon = sub.add_parser("canonicalize", help="canonicalize a raw job JSON")
    p_canon.add_argument("raw_job_json")

    p_upsert = sub.add_parser(
        "upsert-job", help="insert or merge a canonical job into the registry"
    )
    p_upsert.add_argument("canonical_job_json")
    p_upsert.add_argument("--registry", default=DEFAULT_REGISTRY)

    p_can = sub.add_parser("can-apply", help="pre-apply dedupe recheck")
    p_can.add_argument("canonical_job_json")
    p_can.add_argument("--registry", default=DEFAULT_REGISTRY)
    p_can.add_argument("--applied", default=DEFAULT_APPLIED)

    p_record = sub.add_parser(
        "record-event", help="append an event to the log and update registry status"
    )
    p_record.add_argument("event_json")
    p_record.add_argument("--registry", default=DEFAULT_REGISTRY)
    p_record.add_argument("--events", default=DEFAULT_EVENTS)

    p_mark = sub.add_parser(
        "mark-seen-batch",
        help="update consecutive-miss/closed tracking for one run's scrape batch",
    )
    p_mark.add_argument("job_keys_json", help="JSON array of job_keys found in this run's batch")
    p_mark.add_argument(
        "--sources",
        required=True,
        help="JSON array of source names actually scraped this run (e.g. '[\"ashbyhq\",\"lever\"]') "
        "— only registry records from these sources are touched",
    )
    p_mark.add_argument("--registry", default=DEFAULT_REGISTRY)

    args = parser.parse_args(argv)

    if args.command == "ensure-files":
        ensure_files(args.registry, args.events)
        print(json.dumps({"ok": True, "registry": args.registry, "events": args.events}))
        return 0

    if args.command == "canonicalize":
        raw = parse_json_arg(args.raw_job_json, "canonicalize")
        canonical = canonicalize(raw)
        print(json.dumps(canonical, ensure_ascii=False, indent=2))
        return 0

    if args.command == "upsert-job":
        canonical = parse_json_arg(args.canonical_job_json, "upsert-job")
        result, action = upsert_job(canonical, args.registry)
        print(
            f"job_state: upsert-job: {action} job_key={result.get('job_key')}",
            file=sys.stderr,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0

    if args.command == "can-apply":
        canonical = parse_json_arg(args.canonical_job_json, "can-apply")
        if not canonical.get("job_key"):
            canonical["job_key"] = derive_job_key(canonical)
        result = can_apply(canonical, args.registry, args.applied)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["can_apply"] else 2

    if args.command == "record-event":
        event = parse_json_arg(args.event_json, "record-event")
        recorded = record_event(event, args.registry, args.events)
        print(json.dumps(recorded, ensure_ascii=False))
        return 0

    if args.command == "mark-seen-batch":
        try:
            job_keys = json.loads(args.job_keys_json)
        except json.JSONDecodeError as exc:
            die(f"mark-seen-batch: job_keys_json is not valid JSON: {exc.msg}")
        if not isinstance(job_keys, list):
            die("mark-seen-batch: job_keys_json must be a JSON array")
        try:
            sources = json.loads(args.sources)
        except json.JSONDecodeError as exc:
            die(f"mark-seen-batch: --sources is not valid JSON: {exc.msg}")
        if not isinstance(sources, list):
            die("mark-seen-batch: --sources must be a JSON array")
        result = mark_seen_batch(job_keys, sources, args.registry)
        print(json.dumps(result, ensure_ascii=False))
        return 0

    return 0  # unreachable: argparse enforces a known subcommand


if __name__ == "__main__":
    sys.exit(main())