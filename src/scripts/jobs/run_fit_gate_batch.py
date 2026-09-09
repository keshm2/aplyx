#!/usr/bin/env python3
"""Run the deterministic fit gate on prefiltered jobs with jd_text.

For each prefiltered job that has jd_text in jds_map.json: canonicalize,
run evaluate_job_fit.py, and record the outcome.

Counts: candidate, needs_review, skipped_unfit.
"""
import json
import subprocess
import sys
from collections import Counter

PRE_PATH = "logs/tmp/prefiltered.jsonl"
JDS_MAP = "logs/tmp/jds_map.json"
OUT_PATH = "logs/tmp/fit_results.jsonl"


def main():
    with open(JDS_MAP) as f:
        jds = json.load(f)
    counts = Counter()
    results = []
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
            new_jd = jds.get(url) or ""
            if not new_jd:
                continue
            obj["jd_text"] = new_jd
            r1 = subprocess.run(
                ["python3", "src/scripts/state/job_state.py", "canonicalize",
                 json.dumps(obj, ensure_ascii=False)],
                capture_output=True, text=True,
            )
            if r1.returncode != 0:
                counts["error"] += 1
                continue
            try:
                canon = json.loads(r1.stdout)
            except json.JSONDecodeError:
                counts["error"] += 1
                continue
            r2 = subprocess.run(
                ["python3", "src/scripts/jobs/evaluate_job_fit.py",
                 json.dumps(canon, ensure_ascii=False)],
                capture_output=True, text=True, timeout=60,
            )
            if r2.returncode != 0:
                counts["error"] += 1
                continue
            try:
                decision = json.loads(r2.stdout)
            except json.JSONDecodeError:
                counts["error"] += 1
                continue
            fit_status = decision.get("fit_status", "unknown")
            counts[fit_status] += 1
            results.append({
                "company": obj.get("company", ""),
                "title": obj.get("title", ""),
                "url": url,
                "fit_status": fit_status,
                "fit_score": decision.get("fit_score"),
                "reasoning": decision.get("reasoning", ""),
                "matched_role_keyword": decision.get("matched_role_keyword"),
                "matched_level_keyword": decision.get("matched_level_keyword"),
                "years_required": decision.get("years_required"),
            })
    with open(OUT_PATH, "w") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    sys.stderr.write(f"fit_gate: {dict(counts)}\n")
    # Print a tiny shortlist of candidates
    for r in results:
        if r["fit_status"] == "candidate":
            print(f"CAND: {r['company']} · {r['title']} · score={r.get('fit_score')}")
        elif r["fit_status"] == "needs_review":
            print(f"REVW: {r['company']} · {r['title']} · {r.get('reasoning','')[:80]}")
        elif r["fit_status"] == "skipped_unfit":
            print(f"SKIP: {r['company']} · {r['title']} · {r.get('reasoning','')[:80]}")


if __name__ == "__main__":
    main()