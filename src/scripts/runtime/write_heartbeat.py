#!/usr/bin/env python3
"""write_heartbeat.py: run heartbeat writer (Phase 8).

Called by src/scripts/runtime/run_job_agent.sh at the end of every run (success or
failure). Writes logs/heartbeat.json atomically with the last-run
timestamp, exit code, per-outcome counts for that run, a monotonic
run counter, and a consecutive-nonzero-exit counter (the restart-loop
signal). Informational only; never blocks or fails the run: any error
prints a warning and exits 0.

--usage-limited flags a failed run whose harness transcript matched a
known provider billing/quota wall (see run_job_agent.py's
_session_hit_usage_limit) rather than a real bug, so the dashboard can
say "usage limit reached" instead of surfacing the raw provider error or
counting it toward the scary consecutive-failure alert. There's no
per-provider reset timestamp to show (that's not a queryable number
across harnesses), so this is a plain flag, not a countdown.

Usage:
  python3 src/scripts/runtime/write_heartbeat.py --exit-code 0 \
      --applied 2 --needs-review 1 --failed 0 --skipped-unfit 5
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import tempfile

# APLYX_LOG_DIR (Settings screen / env) relocates the log directory.
HEARTBEAT = os.path.join(os.environ.get("APLYX_LOG_DIR", os.environ.get("FLUX_LOG_DIR", "logs")), "heartbeat.json")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="write_heartbeat.py")
    parser.add_argument("--exit-code", type=int, required=True)
    parser.add_argument("--applied", type=int, default=0)
    parser.add_argument("--needs-review", type=int, default=0)
    parser.add_argument("--failed", type=int, default=0)
    parser.add_argument("--skipped-unfit", type=int, default=0)
    parser.add_argument("--usage-limited", action="store_true",
                         help="this run's failure was a provider billing/quota wall, not a real error")
    parser.add_argument("--path", default=HEARTBEAT)
    args = parser.parse_args(argv)

    try:
        previous = {}
        if os.path.exists(args.path):
            try:
                with open(args.path, "r", encoding="utf-8") as f:
                    previous = json.load(f)
            except (OSError, json.JSONDecodeError):
                previous = {}
        consecutive = int(previous.get("consecutive_nonzero_exits", 0))
        if args.exit_code == 0:
            consecutive = 0
        elif not args.usage_limited:
            # A real failure. A usage-limited one leaves this counter
            # frozen instead: it's not evidence of a bug, so it shouldn't
            # feed the "N runs in a row have failed, check logs" alert,
            # but it shouldn't quietly reset it to 0 either (that would
            # hide a genuine failure streak sitting right before a
            # provider outage started).
            consecutive = consecutive + 1
        heartbeat = {
            "last_run_completed_at": datetime.datetime.now(datetime.timezone.utc)
            .isoformat(timespec="seconds"),
            "last_run_exit_code": args.exit_code,
            "last_run_counts": {
                "applied": args.applied,
                "needs_review": args.needs_review,
                "failed": args.failed,
                "skipped_unfit": args.skipped_unfit,
            },
            "run_counter": int(previous.get("run_counter", 0)) + 1,
            "consecutive_nonzero_exits": consecutive,
            "usage_limited": bool(args.usage_limited),
        }
        directory = os.path.dirname(os.path.abspath(args.path)) or "."
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".heartbeat.", suffix=".tmp", dir=directory)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(heartbeat, f, indent=2)
            f.write("\n")
        os.replace(tmp, args.path)
    except Exception as exc:  # heartbeat must never block the run
        print(f"write_heartbeat: WARNING: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
