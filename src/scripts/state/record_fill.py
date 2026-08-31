#!/usr/bin/env python3
"""record_fill.py: durable field-provenance records for filled applications
(Phase 16C).

Deterministic, stdlib-only helper. Persists exactly what an application form
was filled with: the durable "we can prove what we typed" artifact behind
`fill_record_path` in applied_jobs.json / review_queue.json entries (see
AGENTS.md "Fill records"). Run from the project root, same as job_state.py.

Local state files (relative to the current working directory):
  data/fill_records/<job_id>.json   one record per job that reached fill

Subcommands:
  record '<job_id>' '<fields-json>'   Write a fill record for one job.

Exit codes:
  0  success
  1  usage / IO / JSON validation error
"""

import argparse
import datetime
import json
import os
import re
import sys
import tempfile

DEFAULT_DIR = "data/fill_records"

ALLOWED_SOURCE_PREFIXES = (
    "safe_fields:",
    "constructed",
    "resume_upload",
    "cover_letter",
    "conservative_default",
)

# job_id is normally "{ats_source}-{external_job_id}" or a "jk:<sha256>" job_key
# (see src/scripts/state/job_state.py derive_job_id); both are filesystem-safe as
# written, but this is a defense-in-depth guard against a malformed/hostile
# job_id being used to build a file path (e.g. containing "/" or "..").
_SAFE_JOB_ID = re.compile(r"^[A-Za-z0-9_.:-]+$")


def die(msg, code=1):
    print(f"record_fill: {msg}", file=sys.stderr)
    sys.exit(code)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_json_arg(arg, label):
    try:
        return json.loads(arg)
    except json.JSONDecodeError as exc:
        die(f"{label}: not valid JSON: {exc.msg}")


def validate_fields(fields):
    if not isinstance(fields, list):
        die("fields-json: expected a JSON array")
    if not fields:
        die("fields-json: must be non-empty; a fill record with no fields means nothing was filled")
    for i, entry in enumerate(fields):
        if not isinstance(entry, dict):
            die(f"fields-json[{i}]: expected a JSON object, got {type(entry).__name__}")
        for required in ("field_name", "filled_value", "source", "verified"):
            if required not in entry:
                die(f"fields-json[{i}]: missing required key '{required}'")
        if not isinstance(entry["field_name"], str) or not entry["field_name"].strip():
            die(f"fields-json[{i}]: 'field_name' must be a non-empty string")
        if not isinstance(entry["source"], str) or not entry["source"].strip():
            die(f"fields-json[{i}]: 'source' must be a non-empty string")
        if entry["source"] not in ALLOWED_SOURCE_PREFIXES and not entry["source"].startswith("safe_fields:"):
            die(
                f"fields-json[{i}]: 'source' must be 'safe_fields:<key>', "
                f"'constructed', 'resume_upload', 'cover_letter', or "
                f"'conservative_default' (got '{entry['source']}')"
            )
        if entry["source"] == "conservative_default" and not (
            isinstance(entry.get("note"), str) and entry["note"].strip()
        ):
            die(
                f"fields-json[{i}]: source 'conservative_default' requires a non-empty "
                f"'note' explaining what default was chosen and why"
            )
        if not isinstance(entry["verified"], bool):
            die(f"fields-json[{i}]: 'verified' must be a JSON boolean")


def record_fill(job_id, fields, out_dir):
    if not job_id or not job_id.strip():
        die("record: job_id must be non-empty")
    job_id = job_id.strip()
    if not _SAFE_JOB_ID.match(job_id):
        die(f"record: job_id contains characters unsafe for a filename: {job_id!r}")
    validate_fields(fields)

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{job_id}.json")
    record = {
        "job_id": job_id,
        "recorded_at": now_iso(),
        "fields": fields,
    }

    fd, tmp = tempfile.mkstemp(dir=out_dir, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except Exception as exc:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        die(f"could not write {path}: {exc}")

    return path, record


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="record_fill.py",
        description="Persist a durable field-provenance record for a filled application (Phase 16C).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_record = sub.add_parser(
        "record", help="write a fill record for one job that reached the fill step"
    )
    p_record.add_argument("job_id")
    p_record.add_argument(
        "fields_json",
        help='JSON array of {"field_name","filled_value","source","verified"} objects',
    )
    p_record.add_argument("--dir", default=DEFAULT_DIR)

    args = parser.parse_args(argv)

    if args.command == "record":
        fields = parse_json_arg(args.fields_json, "fields_json")
        path, record = record_fill(args.job_id, fields, args.dir)
        print(json.dumps({"ok": True, "path": path, "job_id": record["job_id"]}, ensure_ascii=False))
        return 0

    return 0  # unreachable: argparse enforces a known subcommand


if __name__ == "__main__":
    sys.exit(main())
