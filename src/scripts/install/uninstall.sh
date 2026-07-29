#!/bin/bash
# uninstall.sh — uninstaller (Unix shim).
#
# Logic now lives in src/scripts/install/uninstall.py so it runs natively on Windows as
# well as macOS/Linux. This shim keeps `bash src/scripts/install/uninstall.sh [flags]`
# working unchanged, forwarding --yes / --keep-data.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "uninstall: no python3/python interpreter found on PATH" >&2
  exit 1
fi

exec "$PY" "$SCRIPT_DIR/uninstall.py" "$@"
