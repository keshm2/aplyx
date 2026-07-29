#!/bin/bash
# update.sh — self-updater (Unix shim).
#
# The updater logic now lives in src/scripts/install/update.py so it runs natively on
# Windows as well as macOS/Linux with no curl/tar dependency. This shim keeps
# callers that invoke `bash src/scripts/install/update.sh [--auto]` working unchanged.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "update: check-failed no python3/python interpreter found"
  [ "${1:-}" = "--auto" ] && exit 0 || exit 1
fi

exec "$PY" "$SCRIPT_DIR/update.py" "$@"
