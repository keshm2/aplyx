#!/bin/bash
# Job application agent: cron/launchd entry point (Unix shim).
#
# The runner logic now lives in src/scripts/runtime/run_job_agent.py so it runs natively
# on Windows (PowerShell/cmd) as well as macOS/Linux with a single codebase.
# This shim keeps existing crontab/launchd entries that point at the .sh
# working unchanged; it just execs the Python runner, forwarding arguments.
#
# Schedule (unchanged): the 30-minute launchd job installed by scheduler.sh
# invokes this file; it in turn runs run_job_agent.py.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prefer python3, fall back to python.
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "run_job_agent: no python3/python interpreter found on PATH" >&2
  exit 1
fi

exec "$PY" "$SCRIPT_DIR/run_job_agent.py" "$@"
