#!/usr/bin/env python3
"""Canonicalize and upsert a raw-job JSONL file into the registry.

Usage: python3 src/scripts/jobs/upsert_raw.py <input.jsonl>
"""
import json
import subprocess
import sys


def main():
    in_path = sys.argv[1] if len(sys.argv) > 1 else "logs/tmp/prefiltered.jsonl"
    n = 0
    errors = 0
    with open(in_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                errors += 1
                continue
            r1 = subprocess.run(
                ["python3", "src/scripts/state/job_state.py", "canonicalize",
                 json.dumps(obj, ensure_ascii=False)],
                capture_output=True, text=True,
            )
            if r1.returncode != 0:
                errors += 1
                sys.stderr.write(f"canonicalize err: {r1.stderr[:200]}\n")
                continue
            try:
                canon = json.loads(r1.stdout)
            except json.JSONDecodeError as e:
                errors += 1
                sys.stderr.write(f"canonicalize parse err: {e}\n")
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
    sys.stderr.write(f"upsert_raw: {n} upserted, {errors} errors from {in_path}\n")


if __name__ == "__main__":
    main()