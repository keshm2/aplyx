#!/usr/bin/env python3
"""Interest-letter store — the deterministic owner of data/interest_letters.json.

Some applications ask a free-text motivation question ("Why do you want to
work at X?"). The agent must never invent that answer, and a run is a
headless subprocess that cannot stop and ask: the scheduler fires every 30
minutes and a wedged run is killed at APLYX_LOCK_MAX_AGE_MIN. So the
interaction is asynchronous — the run *parks* the job here and moves on, the
user answers later in the TUI, and the next run applies with the approved
text.

Why parking is not `needs_review`: `job_state.py can-apply` blocks on
needs_review, so a job routed there can never be retried — but retrying is
the whole point once the user supplies text. Parking therefore records no
registry event and no applied_jobs.json row; the job simply stays eligible.
job-scraper.md reads `pending` before tailoring so a parked job isn't
re-tailored every run. job_state.py's interface stays frozen (PLAN §5.2).

Statuses: pending (asked, unanswered) -> approved (text ready to paste).
A draft may be saved without approving; only `approve` unblocks applying.

Writes are atomic (temp file + os.replace) and stdlib-only, mirroring
job_state.py.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

DEFAULT_STORE = os.path.join("data", "interest_letters.json")

PENDING = "pending"
APPROVED = "approved"


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read(store: str) -> list:
    try:
        with open(store, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _write(store: str, records: list) -> None:
    parent = os.path.dirname(store) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=".interest_letters.", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(records, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, store)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _find(records: list, job_key: str):
    for i, rec in enumerate(records):
        if rec.get("job_key") == job_key:
            return i, rec
    return -1, None


def _load_payload(raw: str) -> dict:
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"interest_letter: invalid JSON payload: {exc}")
    if not isinstance(obj, dict):
        raise SystemExit("interest_letter: payload must be a JSON object")
    return obj


def cmd_ensure_file(args) -> int:
    records = _read(args.store)
    _write(args.store, records)
    print(json.dumps({"ok": True, "store": args.store, "records": len(records)}))
    return 0


def cmd_request(args) -> int:
    """Park a job: the agent hit a motivation question it must not answer."""
    payload = _load_payload(args.payload)
    job_key = str(payload.get("job_key") or "").strip()
    if not job_key:
        raise SystemExit("interest_letter: request requires job_key")
    records = _read(args.store)
    idx, existing = _find(records, job_key)
    if existing is not None:
        # Idempotent: a re-run hitting the same question must not reset an
        # answer the user already wrote, nor duplicate the row.
        print(json.dumps({"ok": True, "job_key": job_key, "status": existing.get("status"),
                          "note": "already tracked"}))
        return 0
    rec = {
        "job_key": job_key,
        "company": str(payload.get("company") or ""),
        "title": str(payload.get("title") or ""),
        "url": str(payload.get("url") or ""),
        "apply_url": str(payload.get("apply_url") or ""),
        "question": str(payload.get("question") or ""),
        "jd_excerpt": str(payload.get("jd_excerpt") or "")[:4000],
        "status": PENDING,
        "letter": "",
        "requested_at": now_utc(),
        "updated_at": now_utc(),
    }
    records.append(rec)
    _write(args.store, records)
    print(json.dumps({"ok": True, "job_key": job_key, "status": PENDING}))
    return 0


def cmd_pending(args) -> int:
    """One JSON object per line — the TUI's list and the agent's skip-set."""
    for rec in _read(args.store):
        if rec.get("status") == PENDING:
            print(json.dumps(rec))
    return 0


def cmd_list(args) -> int:
    print(json.dumps(_read(args.store)))
    return 0


def cmd_get(args) -> int:
    _, rec = _find(_read(args.store), args.job_key)
    if rec is None:
        print(json.dumps({"ok": False, "error": "not found"}))
        return 2
    print(json.dumps(rec))
    return 0


def _set_text(args, status: str) -> int:
    records = _read(args.store)
    idx, rec = _find(records, args.job_key)
    if rec is None:
        print(json.dumps({"ok": False, "error": "not found"}))
        return 2
    text = args.text
    if text == "-":
        text = sys.stdin.read()
    text = text.strip()
    if status == APPROVED and not text:
        # Approving empty text would submit a blank essay — refuse.
        print(json.dumps({"ok": False, "error": "refusing to approve empty letter"}))
        return 2
    rec["letter"] = text
    rec["status"] = status
    rec["updated_at"] = now_utc()
    records[idx] = rec
    _write(args.store, records)
    print(json.dumps({"ok": True, "job_key": args.job_key, "status": status,
                      "chars": len(text)}))
    return 0


def cmd_save_draft(args) -> int:
    """Store text without approving — a draft the user can still edit."""
    return _set_text(args, PENDING)


def cmd_approve(args) -> int:
    return _set_text(args, APPROVED)


def cmd_approved_text(args) -> int:
    """Text to paste. rc=2 when not approved, so a caller can branch on the
    exit code alone without parsing stdout (same contract as can-apply)."""
    _, rec = _find(_read(args.store), args.job_key)
    if rec is None or rec.get("status") != APPROVED or not rec.get("letter"):
        return 2
    sys.stdout.write(rec["letter"])
    return 0


def cmd_discard(args) -> int:
    records = _read(args.store)
    idx, rec = _find(records, args.job_key)
    if rec is None:
        print(json.dumps({"ok": False, "error": "not found"}))
        return 2
    records.pop(idx)
    _write(args.store, records)
    print(json.dumps({"ok": True, "job_key": args.job_key, "discarded": True}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="interest_letter", description=__doc__)
    p.add_argument("--store", default=DEFAULT_STORE,
                   help=f"store path (default {DEFAULT_STORE})")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ensure-file").set_defaults(func=cmd_ensure_file)

    sp = sub.add_parser("request")
    sp.add_argument("payload")
    sp.set_defaults(func=cmd_request)

    sub.add_parser("pending").set_defaults(func=cmd_pending)
    sub.add_parser("list").set_defaults(func=cmd_list)

    sp = sub.add_parser("get")
    sp.add_argument("job_key")
    sp.set_defaults(func=cmd_get)

    sp = sub.add_parser("save-draft")
    sp.add_argument("job_key")
    sp.add_argument("text", help="letter text, or - to read stdin")
    sp.set_defaults(func=cmd_save_draft)

    sp = sub.add_parser("approve")
    sp.add_argument("job_key")
    sp.add_argument("text", help="letter text, or - to read stdin")
    sp.set_defaults(func=cmd_approve)

    sp = sub.add_parser("approved-text")
    sp.add_argument("job_key")
    sp.set_defaults(func=cmd_approved_text)

    sp = sub.add_parser("discard")
    sp.add_argument("job_key")
    sp.set_defaults(func=cmd_discard)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
