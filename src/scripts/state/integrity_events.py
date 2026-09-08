#!/usr/bin/env python3
"""integrity_events.py: append-only local log of client-integrity violations.

verify_integrity.py detects tampering (a modified enforcement file, a
re-created hosted-only agent def, a missing cap check). Each finding is
recorded here, in data/integrity_events.jsonl, one JSON object per line,
never rewritten. The desktop app / TUI read the unreported tail on the
next sign-in and POST it to the `integrity_events` Supabase table
(INSERT-only), then mark those lines reported.

A user can delete this file; that is itself a signal (the server's
`profiles.integrity_checked_at` stops advancing) and does not erase rows
already synced.

  integrity_events.py record '<json>'      append one event {kind, detail, ...}
  integrity_events.py list                 all events
  integrity_events.py unreported           events not yet marked reported
  integrity_events.py mark-reported <ids>  JSON array of event ids
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import uuid

DEFAULT_PATH = "data/integrity_events.jsonl"

VALID_KINDS = {
    "file_modified", "file_missing", "forbidden_file_present",
    "disabled_feature_reenabled", "cap_logic_missing", "manifest_unavailable",
}


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read(path: str) -> list:
    if not os.path.exists(path):
        return []
    out = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # a hand-corrupted line is ignored, not fatal
    return out


def record(path: str, event: dict) -> dict:
    kind = str(event.get("kind", ""))
    if kind not in VALID_KINDS:
        raise SystemExit(f"integrity_events: unknown kind {kind!r}")
    row = {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "detail": event.get("detail", {}),
        "client_version": event.get("client_version"),
        "source": event.get("source", "local"),
        "detected_at": _now(),
        "reported": False,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def mark_reported(path: str, ids: list) -> dict:
    ids = set(str(i) for i in ids)
    rows = _read(path)
    changed = 0
    for r in rows:
        if r.get("id") in ids and not r.get("reported"):
            r["reported"] = True
            changed += 1
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.replace(tmp, path)
    return {"ok": True, "marked": changed}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="integrity_events.py")
    sub = parser.add_subparsers(dest="command", required=True)
    p_rec = sub.add_parser("record")
    p_rec.add_argument("event_json")
    p_rec.add_argument("--path", default=DEFAULT_PATH)
    for name in ("list", "unreported"):
        p = sub.add_parser(name)
        p.add_argument("--path", default=DEFAULT_PATH)
    p_mark = sub.add_parser("mark-reported")
    p_mark.add_argument("ids_json")
    p_mark.add_argument("--path", default=DEFAULT_PATH)
    args = parser.parse_args(argv)

    if args.command == "record":
        try:
            event = json.loads(args.event_json)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"integrity_events: record: invalid JSON: {exc.msg}")
        print(json.dumps(record(args.path, event), ensure_ascii=False))
        return 0
    if args.command == "list":
        print(json.dumps(_read(args.path), ensure_ascii=False))
        return 0
    if args.command == "unreported":
        print(json.dumps([r for r in _read(args.path) if not r.get("reported")], ensure_ascii=False))
        return 0
    if args.command == "mark-reported":
        try:
            ids = json.loads(args.ids_json)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"integrity_events: mark-reported: invalid JSON: {exc.msg}")
        if not isinstance(ids, list):
            raise SystemExit("integrity_events: mark-reported: expected a JSON array of ids")
        print(json.dumps(mark_reported(args.path, ids), ensure_ascii=False))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
