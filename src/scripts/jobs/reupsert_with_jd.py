#!/usr/bin/env python3
"""Re-upsert prefiltered jobs with jd_text from logs/tmp/jds_map.json.

Reads prefiltered.jsonl, attaches jd_text for any URL present in
jds_map.json, then canonicalizes and upserts each. Skips jd_text update
if the existing registry record already has non-empty jd_text.
"""
import json
import subprocess
import sys

PRE_PATH = "logs/tmp/prefiltered.jsonl"
JDS_MAP = "logs/tmp/jds_map.json"


def main():
    with open(JDS_MAP) as f:
        jds = json.load(f)
    n = 0
    skipped = 0
    errors = 0
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
                skipped += 1
                continue
            obj["jd_text"] = new_jd
            r1 = subprocess.run(
                ["python3", "src/scripts/state/job_state.py", "canonicalize",
                 json.dumps(obj, ensure_ascii=False)],
                capture_output=True, text=True,
            )
            if r1.returncode != 0:
                errors += 1
                continue
            try:
                canon = json.loads(r1.stdout)
            except json.JSONDecodeError:
                errors += 1
                continue
            r2 = subprocess.run(
                ["python3", "src/scripts/state/job_state.py", "upsert-job",
                 json.dumps(canon, ensure_ascii=False)],
                capture_output=True, text=True,
            )
            if r2.returncode != 0:
                errors += 1
                sys.stderr.write(f"upsert err: {r2.stderr[:200]}\n")
                continue
            n += 1
    sys.stderr.write(f"reupsert_with_jd: {n} updated, {skipped} skipped (no jd), {errors} errors\n")


if __name__ == "__main__":
    main()