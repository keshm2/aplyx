#!/usr/bin/env python3
"""append_state_entry.py — deterministic JSON-array state writer.

Cross-platform (stdlib-only) port of append_state_entry.sh: no jq/bash, so
it runs natively on Windows as well as macOS/Linux. Behaviour and exit codes
are identical, so it is a drop-in replacement.

Usage:
  append_state_entry.py ensure <file>
      Create <file> as [] if missing; verify it is a valid JSON array.
  append_state_entry.py append <file> '<json-object>'
      Append one JSON object to <file> atomically.
  append_state_entry.py <file> '<json-object>'
      Shorthand for append (matches the form referenced in AGENTS.md).

Dedup guard: if the new object contains a "job_id" and an existing element
already has the same "job_id", the append is refused with exit status 2.

Exit codes:
  0  success
  1  usage / IO / JSON validation error
  2  duplicate job_id detected (append refused)
"""

from __future__ import annotations

import json
import os
import sys
import tempfile


def die(msg: str) -> "None":
    sys.stderr.write(f"append_state_entry: {msg}\n")
    raise SystemExit(1)


def usage() -> "None":
    sys.stderr.write(
        "Usage:\n"
        "  append_state_entry.py ensure <file>\n"
        "  append_state_entry.py append <file> '<json-object>'\n"
        "  append_state_entry.py <file> '<json-object>'   (shorthand for append)\n"
    )
    raise SystemExit(1)


def load_array(file: str) -> list:
    if not os.path.isfile(file):
        die(f"not a file: {file}")
    try:
        with open(file, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        die(f"not a valid JSON array: {file}")
    if not isinstance(data, list):
        die(f"not a valid JSON array: {file}")
    return data


def ensure_file(file: str) -> list:
    if not os.path.exists(file):
        parent = os.path.dirname(file)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(file, "w", encoding="utf-8") as fh:
            fh.write("[]\n")
    return load_array(file)


def append_entry(file: str, raw_entry: str) -> "None":
    arr = ensure_file(file)
    try:
        entry = json.loads(raw_entry)
    except json.JSONDecodeError:
        die(f"entry is not a single JSON object: {raw_entry}")
    if not isinstance(entry, dict):
        die(f"entry is not a single JSON object: {raw_entry}")

    if "job_id" in entry:
        jid = entry["job_id"]
        if any(isinstance(el, dict) and el.get("job_id") == jid for el in arr):
            sys.stderr.write(
                f"append_state_entry: duplicate job_id '{jid}' already present "
                f"in {file} — append refused\n"
            )
            raise SystemExit(2)

    arr.append(entry)

    # Atomic publish: write to a temp file in the same directory, then replace.
    directory = os.path.dirname(os.path.abspath(file))
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(file) + ".", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(arr, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, file)  # atomic on the same filesystem, incl. Windows
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        die(f"append failed for {file}")


def main(argv: list) -> "None":
    cmd = argv[0] if argv else ""
    if cmd == "ensure":
        if len(argv) != 2:
            usage()
        ensure_file(argv[1])
    elif cmd == "append":
        if len(argv) != 3:
            usage()
        append_entry(argv[1], argv[2])
    elif cmd in ("", "-h", "--help"):
        usage()
    else:
        # Shorthand: <file> '<json-object>'
        if len(argv) != 2:
            usage()
        append_entry(argv[0], argv[1])


if __name__ == "__main__":
    main(sys.argv[1:])
