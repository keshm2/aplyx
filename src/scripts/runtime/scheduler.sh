#!/bin/bash
# scheduler.sh: schedule management (Unix shim).
#
# Logic now lives in src/scripts/runtime/scheduler.py (launchd on macOS, schtasks on
# Windows, systemd note on Linux). This shim keeps `bash src/scripts/runtime/scheduler.sh
# install|uninstall|status|plist` working unchanged.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "scheduler: no python3/python interpreter found on PATH" >&2
  exit 1
fi

exec "$PY" "$SCRIPT_DIR/scheduler.py" "$@"
