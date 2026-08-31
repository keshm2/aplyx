#!/usr/bin/env python3
"""sync_internship_tracker.py: append one application row to the user's
Google Sheet internship tracker (Phase 3).

Unattended, single-user, service-account auth. Reads a single JSON object
payload from the shell/agent, maps it to exactly one row in the
'Internship Tracker' tab, and appends it using Google's official Python
client. Only the visible tracker columns are written: internal-only
fields (job_key, source, ats_score, reasoning, etc.) are never sent to
the sheet.

Local config: src/config/google_sheets_config.json (gitignored). If the config
is absent or sync is disabled, the helper prints a machine-readable skip
result and exits 0 so the application run can continue. Local job state
(data/applied_jobs.json, data/job_registry.json) remains the source of
truth regardless of sync outcome.

Usage:
  python3 src/scripts/jobs/sync_internship_tracker.py '<payload-json>'
  python3 src/scripts/jobs/sync_internship_tracker.py -            # read payload from stdin
  python3 src/scripts/jobs/sync_internship_tracker.py '<payload-json>' --config <path>

Payload fields (all optional unless noted):
  title            (required) → Role Name
  company          (required) → Company
  date_applied     (optional) → Date Applied (defaults to today, YYYY-MM-DD)
  internship_term  (optional) → Internship Term
  notes            (optional, user-facing only) → Notes

Output: a single machine-readable JSON object on stdout. Nothing is written
to stderr so the caller can always parse stdout as JSON.

Exit codes:
  0  success or skip (sync disabled / unconfigured)
  1  payload, config, or API error (JSON error result on stdout)
"""

import argparse
import datetime
import json
import os
import sys

DEFAULT_CONFIG = "src/config/google_sheets_config.json"

# Visible tracker columns, in sheet order. The helper always writes exactly
# these columns and nothing else: internal-only fields stay local.
COLUMNS = [
    "Role Name",
    "Company",
    "Date Applied",
    "Status",
    "Response Received",
    "Internship Term",
    "Date of Response",
    "Notes",
]

DEFAULT_STATUS = "Application Submitted / In Process"
DEFAULT_RESPONSE_RECEIVED = "–"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def emit(result):
    """Print a machine-readable JSON result on stdout."""
    print(json.dumps(result, ensure_ascii=False))


def die(msg, **extra):
    """Emit a machine-readable error result and exit 1."""
    out = {"ok": False, "synced": False, "error": msg}
    out.update(extra)
    emit(out)
    sys.exit(1)


def skip(reason, **extra):
    """Emit a machine-readable skip result and exit 0."""
    out = {"ok": True, "synced": False, "skipped": True, "reason": reason}
    out.update(extra)
    emit(out)
    sys.exit(0)


def today_local():
    """Current local date as YYYY-MM-DD."""
    return datetime.date.today().strftime("%Y-%m-%d")


def load_config(path):
    """Load the Google Sheets config JSON. Returns the parsed dict or None."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        die(f"could not read config {path}: {exc}")
    if not isinstance(cfg, dict):
        die(f"config {path}: expected a JSON object, got {type(cfg).__name__}")
    return cfg


def read_payload(arg):
    """Read the payload JSON object from a CLI arg ('-' = stdin)."""
    if arg == "-":
        raw = sys.stdin.read()
    else:
        raw = arg
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        die(f"payload is not valid JSON: {exc.msg}")
    if not isinstance(obj, dict):
        die(f"payload: expected a JSON object, got {type(obj).__name__}")
    return obj


# Leading characters Sheets (and Excel/CSV consumers generally) treat as a
# formula/DDE trigger rather than literal text. company/title/internship_term
# ultimately come from a scraped, third-party job posting; anyone can name a
# job listing or company anything, so these are the one genuinely untrusted
# input this script ever writes into a live spreadsheet cell.
_FORMULA_TRIGGER_CHARS = ("=", "+", "-", "@", "\t", "\r")


def _defang_formula(value):
    """Neutralize spreadsheet formula injection (CWE-1236): prefix a leading
    apostrophe when the value starts with a formula-trigger character.
    Sheets (like Excel) treats a leading `'` as "force this cell to plain
    text", the standard mitigation for this class, and applied here
    unconditionally rather than relying solely on value_input_option, so a
    config that opts back into "USER_ENTERED" for its date/number
    auto-formatting doesn't silently reopen this."""
    if value and value[0] in _FORMULA_TRIGGER_CHARS:
        return "'" + value
    return value


def build_row(payload):
    """Map the payload to exactly one tracker row (8 visible columns).

    Internal-only fields in the payload (job_key, source, ats_score,
    reasoning, etc.) are deliberately ignored: they never reach the sheet.
    """
    title = str(payload.get("title") or "").strip()
    company = str(payload.get("company") or "").strip()
    if not title:
        die("payload missing required field 'title'")
    if not company:
        die("payload missing required field 'company'")

    date_applied = str(payload.get("date_applied") or "").strip() or today_local()
    internship_term = str(payload.get("internship_term") or "").strip()
    # Notes: only an explicit, user-facing note is written. Internal reasoning
    # is never used here even if present in the payload.
    notes = str(payload.get("notes") or "").strip()

    return [
        _defang_formula(title),         # Role Name
        _defang_formula(company),       # Company
        date_applied,                    # Date Applied
        DEFAULT_STATUS,                 # Status
        DEFAULT_RESPONSE_RECEIVED,      # Response Received
        _defang_formula(internship_term),  # Internship Term
        "",                              # Date of Response (blank)
        _defang_formula(notes),          # Notes (blank unless supplied)
    ]


def append_row(cfg, row):
    """Authenticate with the service account and append one row to the sheet.

    Google's official client/auth libraries are imported lazily so the
    helper can still emit skip/error results when the packages are not yet
    installed.
    """
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError as exc:
        skip(
            "Google Python libraries not installed: run "
            "`pip3 install -r requirements.txt` to enable Sheets sync",
            missing_dependency=str(exc),
        )

    key_path = cfg["service_account_key_path"]
    if not os.path.exists(key_path):
        skip(
            f"service-account key file not found: {key_path}; "
            "place the key file locally (see docs/SETUP.md)",
        )

    try:
        creds = service_account.Credentials.from_service_account_file(
            key_path, scopes=SCOPES
        )
    except Exception as exc:
        die(f"service-account auth failed: {exc}")

    try:
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    except Exception as exc:
        die(f"could not build Sheets service: {exc}")

    spreadsheet_id = cfg["spreadsheet_id"]
    worksheet_title = cfg["worksheet_title"]
    # Optional append knobs with sensible defaults so a minimal config
    # (enabled/spreadsheet_id/worksheet_title/service_account_key_path)
    # still works without these fields.
    header_range = cfg.get("header_range", "A1:H")
    # USER_ENTERED remains the default (gives Date Applied a real, sortable
    # Sheets date type instead of literal text); this is safe against
    # formula injection specifically because _defang_formula above already
    # neutralizes a leading =/+/-/@ with a forced-text apostrophe before any
    # value reaches here, regardless of which valueInputOption is in effect.
    value_input_option = cfg.get("value_input_option", "USER_ENTERED")
    insert_data_option = cfg.get("insert_data_option", "INSERT_ROWS")
    # Escape single quotes in the sheet title for the A1 range literal.
    safe_title = worksheet_title.replace("'", "''")
    # Append range covers the 8 visible columns (A–H). The API finds the
    # first empty row after existing data in this range and inserts there.
    append_range = f"'{safe_title}'!{header_range}"

    body = {"values": [row]}
    try:
        result = (
            service.spreadsheets()
            .values()
            .append(
                spreadsheetId=spreadsheet_id,
                range=append_range,
                valueInputOption=value_input_option,
                insertDataOption=insert_data_option,
                body=body,
            )
            .execute()
        )
    except Exception as exc:
        die(f"Sheets append failed: {exc}")

    return result


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="sync_internship_tracker.py",
        description=(
            "Append one application row to the Google Sheet internship "
            "tracker (Phase 3)."
        ),
    )
    parser.add_argument(
        "payload",
        help="JSON object payload (use '-' to read from stdin)",
    )
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)

    payload = read_payload(args.payload)

    cfg = load_config(args.config)
    if cfg is None:
        skip(
            f"config not found: {args.config}; "
            "Sheets sync is not configured yet"
        )
    if not cfg.get("enabled", True):
        skip(f"sync disabled in {args.config} (enabled=false)")

    for field in ("spreadsheet_id", "worksheet_title", "service_account_key_path"):
        val = cfg.get(field)
        if not isinstance(val, str) or not val.strip():
            die(
                f"config {args.config}: field '{field}' "
                "must be a non-empty string"
            )
        if val.strip() == "REPLACE_ME":
            die(
                f"config {args.config}: field '{field}' "
                "is still the REPLACE_ME placeholder"
            )

    row = build_row(payload)
    append_result = append_row(cfg, row)

    updates = append_result.get("updates", {}) if isinstance(append_result, dict) else {}
    out = {
        "ok": True,
        "synced": True,
        "skipped": False,
        "spreadsheet_id": cfg["spreadsheet_id"],
        "worksheet_title": cfg["worksheet_title"],
        "columns": COLUMNS,
        "appended_row": row,
        "updated_range": updates.get("updatedRange", ""),
        "updated_rows": updates.get("updatedRows", 0),
    }
    emit(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())