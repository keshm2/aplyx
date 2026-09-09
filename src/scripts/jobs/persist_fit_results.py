#!/usr/bin/env python3
"""Persist fit-gate results for a scrape-only run.

For each entry in logs/tmp/fit_results.jsonl:
  skipped_unfit -> local-only record-event
  needs_review   -> append to applied_jobs.json + review_queue.json +
                    record-event
  candidate      -> record-event (no applied entry: scrape-only does not
                    reserve candidates for application)

Source/role_type/location are looked up from the canonical registry
record keyed by URL (best-effort). For URLs that aren't in the registry
yet (shouldn't happen, since we upserted before fit-gating), we still
write the event with the fit-gate's bare fields.

Per the run prompt: do NOT send Discord notifications in scrape-only mode
even for needs_review (the per-outcome Discord route is part of Phase 3).
"""
import json
import subprocess
import sys

# Use job_state's normalize_url so we match the registry's exact key form.
sys.path.insert(0, "src/scripts/state")
from job_state import normalize_url

FIT_PATH = "logs/tmp/fit_results.jsonl"
PRE_PATH = "logs/tmp/prefiltered.jsonl"


def load_registry():
    with open("data/job_registry.json") as f:
        return json.load(f)


def index_by_url(registry):
    by_url = {}
    by_apply = {}
    by_company_title = {}
    for rec in registry:
        u = (rec.get("normalized_url") or "").strip()
        if u:
            by_url[u] = rec
        au = (rec.get("normalized_apply_url") or "").strip()
        if au:
            by_apply[au] = rec
        ckey = (rec.get("company", "").strip().lower(), rec.get("title", "").strip().lower())
        if ckey[0] and ckey[1]:
            by_company_title.setdefault(ckey, []).append(rec)
    return by_url, by_apply, by_company_title


def look_up(by_url, by_apply, by_company_title, by_jk, company, title, url, raw_obj):
    n = normalize_url(url)
    rec = by_url.get(n) or by_apply.get(n)
    if rec:
        return rec
    ckey = (company.strip().lower(), title.strip().lower())
    cands = by_company_title.get(ckey)
    if cands:
        return cands[0]
    # Last resort: canonicalize the full raw obj to get job_key, then lookup
    r = subprocess.run(
        ["python3", "src/scripts/state/job_state.py", "canonicalize",
         json.dumps(raw_obj, ensure_ascii=False)],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        try:
            canon = json.loads(r.stdout)
            return by_jk.get(canon.get("job_key", ""))
        except json.JSONDecodeError:
            return None
    return None


def record_event(event):
    r = subprocess.run(
        ["python3", "src/scripts/state/job_state.py", "record-event",
         json.dumps(event, ensure_ascii=False)],
        capture_output=True, text=True,
    )
    return r.returncode == 0


def append_state(path, entry):
    r = subprocess.run(
        ["bash", "src/scripts/state/append_state_entry.sh", path,
         json.dumps(entry, ensure_ascii=False)],
        capture_output=True, text=True,
    )
    return r.returncode == 0


def safe_fields():
    with open("src/config/targets.json") as f:
        return json.load(f).get("safe_fields", {})


def main():
    # Build full pre-filtered index keyed by URL, then iterate fit_results
    prefilter_by_url = {}
    with open(PRE_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            url = obj.get("url", "") or ""
            if url:
                prefilter_by_url[url] = obj

    registry = load_registry()
    by_url, by_apply, by_company_title = index_by_url(registry)
    by_jk = {r.get("job_key"): r for r in registry}
    sf = safe_fields()
    counts = {"skipped_unfit": 0, "needs_review": 0, "candidate": 0, "errors": 0}
    with open(FIT_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                res = json.loads(line)
            except json.JSONDecodeError:
                counts["errors"] += 1
                continue
            url = res.get("url", "")
            company = res.get("company", "")
            title = res.get("title", "")
            fit_status = res.get("fit_status", "unknown")
            fit_score = res.get("fit_score")
            reasoning = res.get("reasoning", "")
            # Attach jd_text from jds_map (fit_results doesn't carry it)
            try:
                jds = json.load(open("logs/tmp/jds_map.json"))
            except (FileNotFoundError, json.JSONDecodeError):
                jds = {}
            raw_obj = prefilter_by_url.get(url, {})
            raw_obj["jd_text"] = jds.get(url, "")
            rec = (
                look_up(by_url, by_apply, by_company_title, by_jk, company, title, url, raw_obj)
                or {}
            )
            job_key = rec.get("job_key") or ""
            job_id = rec.get("job_id") or job_key or url
            apply_url = rec.get("normalized_apply_url") or rec.get("apply_url") or url
            source = rec.get("source", "scrape_only")
            location = rec.get("location", "")
            role_type = rec.get("role_type") or "internship"

            # Map fit-gate status -> event status. "candidate" from the fit
            # gate is just a candidate pool marker; the canonical registry
            # record keeps latest_status="new", no terminal event needed.
            event_status = fit_status
            if fit_status == "candidate":
                # Don't record a terminal event for candidates; they
                # remain "new" in the registry and are eligible for
                # tailoring in a future apply run.
                counts["candidate"] += 1
                continue
            if fit_status not in (
                "applied", "failed", "needs_review", "new", "seen", "skipped_unfit"
            ):
                counts["errors"] += 1
                sys.stderr.write(f"unknown fit_status: {fit_status}\n")
                continue

            if not job_key:
                # The registry really doesn't have this canonical key;
                # synthesize a stable job_key from the URL+company+title
                # so record-event will accept it (rc=0 with a warning).
                # The event is still logged to job_events.jsonl; future
                # runs that fetch the JD via Playwright will re-canonicalize
                # and merge.
                import hashlib
                seed = (url + "|" + company + "|" + title).encode("utf-8")
                digest = hashlib.sha256(seed).hexdigest()
                job_key = "jk:" + digest
                job_id = job_key

            event = {
                "job_key": job_key,
                "job_id": job_id,
                "status": event_status,
                "company": company,
                "title": title,
                "url": url,
                "reasoning": reasoning,
                "fit_score": fit_score,
                "source": source,
                "role_type": role_type,
                "location_tier": "fallback",
            }
            if not record_event(event):
                counts["errors"] += 1
                sys.stderr.write(f"record-event err: {event}\n")
                continue

            if fit_status == "needs_review":
                entry = {
                    "job_id": job_id,
                    "job_key": job_key,
                    "company": company,
                    "title": title,
                    "url": url,
                    "apply_url": apply_url,
                    "date_applied": "2026-09-08",
                    "status": "needs_review",
                    "role_type": role_type,
                    "source": source,
                    "resume_used": "n/a",
                    "ats_score": fit_score or 0,
                    "location_tier": "fallback",
                    "cover_letter_used": False,
                    "reasoning": reasoning,
                    "doubt_signals": ["non_candidate_fit"],
                }
                append_state("data/applied_jobs.json", entry)
                append_state("data/review_queue.json", entry)
                counts["needs_review"] += 1
            elif fit_status == "skipped_unfit":
                counts["skipped_unfit"] += 1
    sys.stderr.write(f"persist_fit_results: {counts}\n")


if __name__ == "__main__":
    main()