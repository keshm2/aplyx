#!/usr/bin/env python3
"""Apply fit-gate results to the registry and append outcomes to state files.

Reads logs/tmp/fit_input.json (the canonical jobs fed to evaluate_job_fit)
and logs/tmp/fit_output.jsonl (one result per line, in input order) and:

  - skipped_unfit: record-event (local only); update registry latest_status
  - needs_review:  append applied_jobs.json + review_queue.json; record-event;
                   update registry latest_status
  - candidate:     update registry latest_status

No Discord per-outcome: scrape-only mode skips Phase 4's summary and we
treat per-outcome Discord the same way (the local review_queue.json is
the user's signal surface for triage).
"""
import json
import os
import sys

sys.path.insert(0, "src/scripts/state")
import job_state  # noqa: E402

REGISTRY = "data/job_registry.json"
EVENTS = "data/job_events.jsonl"
APPLIED = "data/applied_jobs.json"
REVIEW = "data/review_queue.json"


def main():
    with open("logs/tmp/fit_input.json") as f:
        inputs = json.load(f)
    outputs = []
    with open("logs/tmp/fit_output.jsonl") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            outputs.append(json.loads(line))
    if len(inputs) != len(outputs):
        die(f"mismatch: {len(inputs)} inputs vs {len(outputs)} outputs")
    registry = job_state.load_json_array(REGISTRY)
    by_key = {r.get("job_key"): r for r in registry}

    counts = {"candidate": 0, "needs_review": 0, "skipped_unfit": 0}
    events_batch = []
    applied_batch = []
    review_batch = []
    for job, result in zip(inputs, outputs):
        key = job.get("job_key")
        if not key:
            continue
        status = result.get("fit_status")
        if status not in ("candidate", "needs_review", "skipped_unfit"):
            continue
        rec = by_key.get(key)
        if rec is None:
            continue
        rec["latest_status"] = status
        if "fit_score" not in rec:
            rec["fit_score"] = result.get("fit_score")
        if "fit_status" not in rec:
            rec["fit_status"] = status
        if "reasoning" not in rec:
            rec["reasoning"] = result.get("reasoning")
        counts[status] += 1

        if status in ("skipped_unfit", "needs_review", "applied", "failed"):
            ev = {
                "job_key": key,
                "status": status,
                "company": rec.get("company", ""),
                "title": rec.get("title", ""),
                "url": rec.get("url", ""),
                "source": rec.get("source", ""),
                "reasoning": result.get("reasoning", ""),
            }
            events_batch.append(ev)

        if status == "needs_review":
            entry = {
                "job_id": rec.get("job_id") or key,
                "job_key": key,
                "company": rec.get("company", ""),
                "title": rec.get("title", ""),
                "url": rec.get("url", ""),
                "apply_url": rec.get("apply_url") or rec.get("url", ""),
                "date_applied": job_state.now_iso()[:10],
                "status": "needs_review",
                "role_type": rec.get("role_type", "internship"),
                "source": rec.get("source", ""),
                "resume_used": "n/a",
                "ats_score": 0,
                "location_tier": rec.get("location_tier", ""),
                "cover_letter_used": False,
                "reasoning": result.get("reasoning", ""),
                "doubt_signals": ["non_candidate_fit"],
            }
            applied_batch.append(entry)
            review_batch.append(entry)

    # Batch writes
    job_state.save_json_array(REGISTRY, registry)

    # Append events in one shot (each event is a JSONL line)
    if events_batch:
        with open(EVENTS, "a") as f:
            for ev in events_batch:
                f.write(json.dumps(ev, sort_keys=False) + "\n")

    if applied_batch:
        existing_applied = job_state.load_json_array(APPLIED)
        existing_applied.extend(applied_batch)
        job_state.save_json_array(APPLIED, existing_applied)

    if review_batch:
        existing_review = job_state.load_json_array(REVIEW)
        existing_review.extend(review_batch)
        job_state.save_json_array(REVIEW, existing_review)

    job_state.save_json_array(REGISTRY, registry)
    print(json.dumps({"counts": counts, "total_in_registry": len(registry)}))


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()