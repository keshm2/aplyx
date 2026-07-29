#!/usr/bin/env python3
"""validate_local_config.py — startup config validation for the job agent.

Cross-platform (stdlib-only) port of validate_local_config.sh: no jq/bash, so
it runs natively on Windows as well as macOS/Linux. Behaviour, messages, and
exit codes match the shell version.

Usage:
  validate_local_config.py [project_root]
  (project_root defaults to the repo root, two levels above this script)

Exit codes:
  0  config valid (may include warnings)
  1  required config missing, invalid JSON, or missing required fields
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

WEBHOOK_RE = re.compile(
    r"^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]+/.+$"
)

SAFE_KEYS = [
    "first_name", "last_name", "email", "phone",
    "graduation_date", "gpa", "authorized_to_work", "require_sponsorship",
    "citizenship_status", "currently_enrolled",
]

# linkedin/github moved to a username-or-legacy-url OR-check (see
# check_safe_field_either below): either the new `<kind>_username` or the
# legacy `<kind>_url` must be a non-empty string.
SAFE_KEY_PAIRS = [
    ("linkedin_username", "linkedin_url"),
    ("github_username", "github_url"),
]


def warn(msg: str) -> None:
    sys.stderr.write(f"validate_local_config: WARNING: {msg}\n")


def fail(msg: str) -> "None":
    sys.stderr.write(f"validate_local_config: ERROR: {msg}\n")
    raise SystemExit(1)


def load_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        fail(f"invalid JSON in {path}")


def main(argv: list) -> None:
    project_root = argv[0] if argv else os.path.dirname(os.path.dirname(SCRIPT_DIR))
    targets_path = os.path.join(project_root, "src", "config", "targets.json")
    discord_path = os.path.join(project_root, "src", "config", "discord_config.json")

    # --- Existence + JSON validity -----------------------------------------
    if not os.path.isfile(targets_path):
        fail(f"missing required config file: {targets_path}")
    targets = load_json(targets_path)
    if not isinstance(targets, dict):
        fail(f"invalid JSON in {targets_path}")

    # Discord is OPTIONAL.
    discord_enabled = True
    discord = None
    if not os.path.isfile(discord_path):
        discord_enabled = False
        warn(f"{discord_path} missing — Discord reporting disabled; outcomes "
             "stay local (enable via 'aplyx setup')")
    else:
        discord = load_json(discord_path)
        if not isinstance(discord, dict):
            fail(f"invalid JSON in {discord_path}")
        if discord.get("enabled", True) is False:
            discord_enabled = False
            warn(f"Discord reporting disabled in {discord_path} — outcomes stay "
                 "local (enable via 'aplyx setup')")

    # --- targets.json field validation -------------------------------------
    def is_array(v):
        return isinstance(v, list)

    def check_array_nonempty(key):
        if not (is_array(targets.get(key)) and len(targets[key]) > 0):
            fail(f"{targets_path}: field '{key}' must be a non-empty array")

    def check_array(key):
        if not is_array(targets.get(key)):
            fail(f"{targets_path}: field '{key}' must be an array")

    def check_array_or_absent(key):
        v = targets.get(key, None)
        if not (is_array(v) or v is None):
            fail(f"{targets_path}: field '{key}' must be an array if present")

    def check_string_nonempty(key):
        v = targets.get(key)
        if not (isinstance(v, str) and len(v) > 0):
            fail(f"{targets_path}: field '{key}' must be a non-empty string")

    def check_object(obj, path, key):
        if not isinstance(obj.get(key), dict):
            fail(f"{path}: field '{key}' must be an object")

    def check_safe_field(key):
        sf = targets.get("safe_fields")
        if not (isinstance(sf, dict) and isinstance(sf.get(key), str) and len(sf[key]) > 0):
            fail(f"{targets_path}: safe_fields.{key} must be a non-empty string")

    def has_safe_field(key):
        sf = targets.get("safe_fields")
        return isinstance(sf, dict) and isinstance(sf.get(key), str) and len(sf[key]) > 0

    def check_safe_field_either(key_a, key_b):
        if not (has_safe_field(key_a) or has_safe_field(key_b)):
            fail(f"{targets_path}: safe_fields.{key_a} or safe_fields.{key_b} must be a non-empty string")

    check_array_nonempty("role_keywords")
    check_array_nonempty("level_keywords")
    check_array("preferred_locations")
    check_string_nonempty("fallback_scope")
    check_array_nonempty("boards")
    check_array_or_absent("ashby_company_slugs")
    check_array_or_absent("lever_company_slugs")
    check_array_or_absent("greenhouse_company_slugs")
    check_array_or_absent("smartrecruiters_company_slugs")
    check_array_or_absent("simplify_feeds")
    check_array_or_absent("workday_tenants")
    check_array_or_absent("oracle_tenants")
    check_object(targets, targets_path, "safe_fields")

    for k in SAFE_KEYS:
        check_safe_field(k)
    for key_a, key_b in SAFE_KEY_PAIRS:
        check_safe_field_either(key_a, key_b)

    # --- discord_config.json field validation ------------------------------
    if discord_enabled and discord is not None:
        check_object(discord, discord_path, "webhooks")
        webhooks = discord["webhooks"]

        def check_webhook_route_required(route):
            val = webhooks.get(route)
            if not (isinstance(val, str) and val):
                fail(f"{discord_path}: webhooks.{route} is missing or empty")
            if val == "REPLACE_ME":
                fail(f"{discord_path}: webhooks.{route} is still the REPLACE_ME placeholder")
            if not WEBHOOK_RE.match(val):
                fail(f"{discord_path}: webhooks.{route} does not look like a Discord webhook URL")

        check_webhook_route_required("success")
        check_webhook_route_required("needs_review")
        check_webhook_route_required("failed")

        summary_url = webhooks.get("summary") or ""
        if summary_url and summary_url != "REPLACE_ME":
            if not WEBHOOK_RE.match(summary_url):
                warn(f"{discord_path}: webhooks.summary does not look like a Discord "
                     "webhook URL — summary will fall back to the success webhook at runtime")

    # --- vetted slug auto-seeding (non-fatal) ------------------------------
    seeder = os.path.join(SCRIPT_DIR, "seed_vetted_slugs.py")
    try:
        r = subprocess.run(
            [sys.executable, seeder, "--targets", targets_path],
            stdout=subprocess.DEVNULL, stderr=sys.stderr,
        )
        if r.returncode != 0:
            warn("vetted slug auto-seeding failed — continuing with existing slug config")
        else:
            targets = load_json(targets_path)  # reload after possible seeding
    except OSError:
        warn("vetted slug auto-seeding skipped (python not found)")

    # --- Placeholder slug warnings (non-fatal) -----------------------------
    def placeholder_slugs(key):
        v = targets.get(key)
        if not is_array(v):
            return ""
        return ",".join(str(x) for x in v if x in ("REPLACE_ME", ""))

    def key_absent(key):
        return key not in targets

    for key, board in (
        ("ashby_company_slugs", "Ashby"),
        ("lever_company_slugs", "Lever"),
        ("greenhouse_company_slugs", "Greenhouse"),
        ("smartrecruiters_company_slugs", "SmartRecruiters"),
    ):
        if key_absent(key):
            warn(f"{key} is not configured — {board} board will be skipped this run")
        else:
            ph = placeholder_slugs(key)
            if ph:
                warn(f"{key} contains placeholder value(s): {ph} — {board} board will be skipped this run")

    for key, board in (
        ("workday_tenants", "Workday"),
        ("oracle_tenants", "Oracle"),
        ("simplify_feeds", "SimplifyJobs"),
    ):
        if key_absent(key):
            warn(f"{key} is not configured — {board} board will be skipped this run")
        else:
            ph = placeholder_slugs(key)
            if ph:
                warn(f"{key} contains placeholder value(s): {ph} — {board} board will be skipped this run")

    # --- Google Sheets sync config (optional) ------------------------------
    sheets_path = os.path.join(project_root, "src", "config", "google_sheets_config.json")
    if not os.path.isfile(sheets_path):
        warn(f"Google Sheets sync config not found ({sheets_path}) — Sheets sync "
             "will be skipped. See docs/SETUP.md section 3.")
    else:
        try:
            with open(sheets_path, "r", encoding="utf-8") as fh:
                sheets = json.load(fh)
            if not isinstance(sheets, dict):
                raise ValueError
        except (OSError, json.JSONDecodeError, ValueError):
            warn(f"{sheets_path}: invalid JSON — Sheets sync will be skipped.")
            sheets = None

        if isinstance(sheets, dict):
            enabled = sheets.get("enabled", True)
            if enabled is False:
                warn(f"Google Sheets sync is disabled (enabled=false in {sheets_path}).")
            elif enabled is not True:
                warn(f"{sheets_path}: 'enabled' is not a boolean — Sheets sync will be skipped.")
            else:
                sheets_id = sheets.get("spreadsheet_id") or ""
                sheets_tab = sheets.get("worksheet_title") or ""
                sheets_key = sheets.get("service_account_key_path") or ""
                if not sheets_id or sheets_id == "REPLACE_ME":
                    warn(f"{sheets_path}: spreadsheet_id is missing or placeholder — Sheets sync will be skipped.")
                if not sheets_tab:
                    warn(f"{sheets_path}: worksheet_title is missing — Sheets sync will be skipped.")
                if not sheets_key or sheets_key == "REPLACE_ME":
                    warn(f"{sheets_path}: service_account_key_path is missing or placeholder — Sheets sync will be skipped.")
                else:
                    if not sheets_key.endswith(".json"):
                        warn(f"{sheets_path}: service_account_key_path should end with .json — got: {sheets_key}")
                    key_abs = sheets_key
                    if not os.path.isabs(key_abs):
                        key_abs = os.path.join(project_root, key_abs)
                    if not os.path.isfile(key_abs):
                        warn(f"{sheets_path}: service-account key file not found at {sheets_key} — "
                             "Sheets sync will be skipped until the key is placed. See docs/SETUP.md section 3.3.")

    # --- Phase 11: hosted Supabase backend config (optional) ---------------
    # Hosted/signed-in mode is opt-in from the desktop app
    # (docs/app-integration-plan.md) — a local-only setup never needs this
    # file. Same warn-and-continue contract as the Sheets check above:
    # absence or a placeholder value only means "Sign in" isn't usable yet
    # on this machine, never a failing run.
    supabase_path = os.path.join(project_root, "src", "config", "supabase.json")
    if not os.path.isfile(supabase_path):
        warn(f"Hosted backend config not found ({supabase_path}) — hosted sign-in "
             "will be unavailable in the desktop app. See src/config/supabase.example.json.")
    else:
        try:
            with open(supabase_path, "r", encoding="utf-8") as fh:
                supabase_cfg = json.load(fh)
            if not isinstance(supabase_cfg, dict):
                raise ValueError
        except (OSError, json.JSONDecodeError, ValueError):
            warn(f"{supabase_path}: invalid JSON — hosted sign-in will be unavailable.")
            supabase_cfg = None

        if isinstance(supabase_cfg, dict):
            url = supabase_cfg.get("url") or ""
            anon_key = supabase_cfg.get("anonKey") or ""
            if not url or "YOUR_PROJECT_REF" in url:
                warn(f"{supabase_path}: url is missing or still the placeholder — hosted sign-in will be unavailable.")
            if not anon_key or anon_key == "YOUR_SUPABASE_ANON_KEY":
                warn(f"{supabase_path}: anonKey is missing or still the placeholder — hosted sign-in will be unavailable.")

    print("validate_local_config: OK")


if __name__ == "__main__":
    main(sys.argv[1:])
