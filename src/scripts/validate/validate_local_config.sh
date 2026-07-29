#!/bin/bash
# validate_local_config.sh — startup config validation for the job agent.
#
# Validates the live local config files (src/config/targets.json and
# src/config/discord_config.json) that the current single-user deployment relies
# on. Fails fast and clearly when required files or fields are missing or
# invalid. Warns — but does not fail — when Ashby/Lever slug config or the
# SimplifyJobs feed config still holds placeholder values, so a
# partially-configured run can proceed for the other boards.
#
# Usage:
#   validate_local_config.sh [project_root]
#   (project_root defaults to the parent of this script's directory)
#
# Exit codes:
#   0  config valid (may include warnings)
#   1  required config missing, invalid JSON, or missing required fields

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${1:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"

TARGETS="$PROJECT_ROOT/src/config/targets.json"
DISCORD="$PROJECT_ROOT/src/config/discord_config.json"

warn() { echo "validate_local_config: WARNING: $*" >&2; }
fail() { echo "validate_local_config: ERROR: $*" >&2; exit 1; }

# --- Existence + JSON validity ---------------------------------------------

[ -f "$TARGETS" ] || fail "missing required config file: $TARGETS"
jq -e . "$TARGETS" >/dev/null 2>&1 || fail "invalid JSON in $TARGETS"

# Discord is OPTIONAL: a missing file or "enabled": false disables Discord
# reporting entirely (outcomes stay local) — a warning, never an error. An
# absent `enabled` field means enabled (legacy configs).
DISCORD_ENABLED=1
if [ ! -f "$DISCORD" ]; then
  DISCORD_ENABLED=0
  warn "$DISCORD missing — Discord reporting disabled; outcomes stay local (enable via 'aplyx setup')"
else
  jq -e . "$DISCORD" >/dev/null 2>&1 || fail "invalid JSON in $DISCORD"
  if [ "$(jq -r 'if has("enabled") then .enabled else true end' "$DISCORD")" = "false" ]; then
    DISCORD_ENABLED=0
    warn "Discord reporting disabled in $DISCORD — outcomes stay local (enable via 'aplyx setup')"
  fi
fi

# --- targets.json field validation -----------------------------------------

check_array_nonempty() {
  local file="$1" key="$2"
  jq -e --arg k "$key" '.[$k] | type == "array" and length > 0' "$file" >/dev/null 2>&1 \
    || fail "$file: field '$key' must be a non-empty array"
}

check_array() {
  local file="$1" key="$2"
  jq -e --arg k "$key" '.[$k] | type == "array"' "$file" >/dev/null 2>&1 \
    || fail "$file: field '$key' must be an array"
}

# Like check_array, but a missing key is tolerated (treated as unconfigured
# board state downstream) rather than failing the run.
check_array_or_absent() {
  local file="$1" key="$2"
  jq -e --arg k "$key" '.[$k] | (type == "array" or type == "null")' "$file" >/dev/null 2>&1 \
    || fail "$file: field '$key' must be an array if present"
}

check_string_nonempty() {
  local file="$1" key="$2"
  jq -e --arg k "$key" '.[$k] | type == "string" and length > 0' "$file" >/dev/null 2>&1 \
    || fail "$file: field '$key' must be a non-empty string"
}

check_object() {
  local file="$1" key="$2"
  jq -e --arg k "$key" '.[$k] | type == "object"' "$file" >/dev/null 2>&1 \
    || fail "$file: field '$key' must be an object"
}

check_safe_field() {
  local file="$1" key="$2"
  jq -e --arg k "$key" \
    '.safe_fields | type == "object" and (.[$k] | type == "string" and length > 0)' \
    "$file" >/dev/null 2>&1 \
    || fail "$file: safe_fields.$key must be a non-empty string"
}

# linkedin/github moved to a username-or-legacy-url OR-check: either the new
# `<kind>_username` or the legacy `<kind>_url` must be a non-empty string.
check_safe_field_either() {
  local file="$1" key_a="$2" key_b="$3"
  jq -e --arg a "$key_a" --arg b "$key_b" \
    '.safe_fields | type == "object" and (((.[$a] // "") | type == "string" and length > 0) or ((.[$b] // "") | type == "string" and length > 0))' \
    "$file" >/dev/null 2>&1 \
    || fail "$file: safe_fields.$key_a or safe_fields.$key_b must be a non-empty string"
}

check_array_nonempty "$TARGETS" role_keywords
check_array_nonempty "$TARGETS" level_keywords
check_array         "$TARGETS" preferred_locations
check_string_nonempty "$TARGETS" fallback_scope
check_array_nonempty "$TARGETS" boards
check_array_or_absent "$TARGETS" ashby_company_slugs
check_array_or_absent "$TARGETS" lever_company_slugs
check_array_or_absent "$TARGETS" greenhouse_company_slugs
check_array_or_absent "$TARGETS" smartrecruiters_company_slugs
check_array_or_absent "$TARGETS" simplify_feeds
check_array_or_absent "$TARGETS" workday_tenants
check_array_or_absent "$TARGETS" oracle_tenants
check_object        "$TARGETS" safe_fields

# Required safe_fields keys for form filling.
SAFE_KEYS=(
  first_name last_name email phone
  graduation_date gpa authorized_to_work require_sponsorship
  citizenship_status currently_enrolled
)
for k in "${SAFE_KEYS[@]}"; do
  check_safe_field "$TARGETS" "$k"
done
check_safe_field_either "$TARGETS" linkedin_username linkedin_url
check_safe_field_either "$TARGETS" github_username github_url

# --- discord_config.json field validation ----------------------------------
# Phase 2: per-outcome webhook routing. Routes live under a `webhooks` object.
# success, needs_review, and failed are required per-outcome routes.
# summary is optional and falls back to success at runtime.
# The legacy top-level `webhook_url` field is no longer read.

if [ "$DISCORD_ENABLED" -eq 1 ]; then

check_object "$DISCORD" webhooks

# Discord webhook URL shape: https://discord.com/api/webhooks/<numeric_id>/<token>
WEBHOOK_RE='^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]+/.+$'

# Required route — hard-fail when missing/placeholder/invalid.
check_webhook_route_required() {
  local file="$1" route="$2" val
  val="$(jq -r --arg r "$route" '.webhooks[$r] // empty' "$file")"
  [ -n "$val" ] || fail "$file: webhooks.$route is missing or empty"
  [ "$val" != "REPLACE_ME" ] || fail "$file: webhooks.$route is still the REPLACE_ME placeholder"
  printf '%s' "$val" | grep -Eq "$WEBHOOK_RE" \
    || fail "$file: webhooks.$route does not look like a Discord webhook URL"
}

check_webhook_route_required "$DISCORD" success
check_webhook_route_required "$DISCORD" needs_review
check_webhook_route_required "$DISCORD" failed

# summary is optional and falls back to success at runtime. Only warn if it is
# present but clearly invalid; absence is expected and silent.
SUMMARY_URL="$(jq -r '.webhooks.summary // empty' "$DISCORD")"
if [ -n "$SUMMARY_URL" ] && [ "$SUMMARY_URL" != "REPLACE_ME" ]; then
  printf '%s' "$SUMMARY_URL" | grep -Eq "$WEBHOOK_RE" \
    || warn "$DISCORD: webhooks.summary does not look like a Discord webhook URL — summary will fall back to the success webhook at runtime"
fi

fi # DISCORD_ENABLED

# --- Phase 6: vetted slug auto-seeding (non-fatal) --------------------------
# Seeds ashby_company_slugs / lever_company_slugs from the project-owned
# vetted lists (src/config/*_vetted_slugs.json) when the user's array is unset,
# empty, or placeholder-only. Never overwrites a non-placeholder value. The
# seeder prints a visible WARNING for each seeded array; failures here warn
# and never raise the exit code. Runs before the placeholder warnings below
# so a freshly seeded config does not also warn about placeholders.

if command -v python3 >/dev/null 2>&1; then
  python3 "$SCRIPT_DIR/seed_vetted_slugs.py" --targets "$TARGETS" \
    || warn "vetted slug auto-seeding failed — continuing with existing slug config"
else
  warn "python3 not found — vetted slug auto-seeding skipped"
fi

# --- Placeholder slug warnings (non-fatal) ---------------------------------

placeholder_slugs() {
  local file="$1" key="$2"
  jq -r --arg k "$key" \
    '.[$k] | map(select(. == "REPLACE_ME" or . == "")) | join(",")' \
    "$file" 2>/dev/null || true
}

key_absent() {
  local file="$1" key="$2"
  jq -e --arg k "$key" 'has($k) | not' "$file" >/dev/null 2>&1
}

ASHBY_PLACEHOLDER="$(placeholder_slugs "$TARGETS" ashby_company_slugs)"
LEVER_PLACEHOLDER="$(placeholder_slugs "$TARGETS" lever_company_slugs)"
GREENHOUSE_PLACEHOLDER="$(placeholder_slugs "$TARGETS" greenhouse_company_slugs)"
SMARTRECRUITERS_PLACEHOLDER="$(placeholder_slugs "$TARGETS" smartrecruiters_company_slugs)"

if key_absent "$TARGETS" ashby_company_slugs; then
  warn "ashby_company_slugs is not configured — Ashby board will be skipped this run"
elif [ -n "$ASHBY_PLACEHOLDER" ]; then
  warn "ashby_company_slugs contains placeholder value(s): $ASHBY_PLACEHOLDER — Ashby board will be skipped this run"
fi
if key_absent "$TARGETS" lever_company_slugs; then
  warn "lever_company_slugs is not configured — Lever board will be skipped this run"
elif [ -n "$LEVER_PLACEHOLDER" ]; then
  warn "lever_company_slugs contains placeholder value(s): $LEVER_PLACEHOLDER — Lever board will be skipped this run"
fi
if key_absent "$TARGETS" greenhouse_company_slugs; then
  warn "greenhouse_company_slugs is not configured — Greenhouse board will be skipped this run"
elif [ -n "$GREENHOUSE_PLACEHOLDER" ]; then
  warn "greenhouse_company_slugs contains placeholder value(s): $GREENHOUSE_PLACEHOLDER — Greenhouse board will be skipped this run"
fi
if key_absent "$TARGETS" smartrecruiters_company_slugs; then
  warn "smartrecruiters_company_slugs is not configured — SmartRecruiters board will be skipped this run"
elif [ -n "$SMARTRECRUITERS_PLACEHOLDER" ]; then
  warn "smartrecruiters_company_slugs contains placeholder value(s): $SMARTRECRUITERS_PLACEHOLDER — SmartRecruiters board will be skipped this run"
fi

# SimplifyJobs feeds (phase 5): same warn-and-skip contract as the slug
# arrays. Known feed names are owned by src/scripts/jobs/fetch_simplify_listings.py;
# unknown names are warned about there at fetch time, not here.
# Workday tenants (phase 7): same warn-and-skip contract. Tenant strings
# are parsed/validated by src/scripts/jobs/fetch_workday_listings.py at fetch time.
WORKDAY_PLACEHOLDER="$(placeholder_slugs "$TARGETS" workday_tenants)"
if key_absent "$TARGETS" workday_tenants; then
  warn "workday_tenants is not configured — Workday board will be skipped this run"
elif [ -n "$WORKDAY_PLACEHOLDER" ]; then
  warn "workday_tenants contains placeholder value(s): $WORKDAY_PLACEHOLDER — Workday board will be skipped this run"
fi

# Oracle Recruiting Cloud tenants (phase 16B): same warn-and-skip contract.
# Tenant strings are parsed/validated by src/scripts/jobs/fetch_oracle_listings.py
# at fetch time.
ORACLE_PLACEHOLDER="$(placeholder_slugs "$TARGETS" oracle_tenants)"
if key_absent "$TARGETS" oracle_tenants; then
  warn "oracle_tenants is not configured — Oracle board will be skipped this run"
elif [ -n "$ORACLE_PLACEHOLDER" ]; then
  warn "oracle_tenants contains placeholder value(s): $ORACLE_PLACEHOLDER — Oracle board will be skipped this run"
fi

SIMPLIFY_PLACEHOLDER="$(placeholder_slugs "$TARGETS" simplify_feeds)"
if key_absent "$TARGETS" simplify_feeds; then
  warn "simplify_feeds is not configured — SimplifyJobs board will be skipped this run"
elif [ -n "$SIMPLIFY_PLACEHOLDER" ]; then
  warn "simplify_feeds contains placeholder value(s): $SIMPLIFY_PLACEHOLDER — SimplifyJobs board will be skipped this run"
fi

# --- Phase 3: Google Sheets sync config (optional) -------------------------
# The Sheets sync config is optional. If absent, warn and continue — job-board
# runs must not break when Sheets sync is not yet configured. If present and
# enabled, validate required fields and the service-account key path shape.
# All findings here are WARNINGs only; none raise the exit code.

SHEETS="$PROJECT_ROOT/src/config/google_sheets_config.json"

if [ ! -f "$SHEETS" ]; then
  warn "Google Sheets sync config not found ($SHEETS) — Sheets sync will be skipped. See docs/SETUP.md section 3."
else
  if ! jq -e . "$SHEETS" >/dev/null 2>&1; then
    warn "$SHEETS: invalid JSON — Sheets sync will be skipped."
  else
    # Use an explicit null-check instead of `//`: jq's alternative operator
    # treats `false` as falsy, so `.enabled // true` would turn an explicit
    # `enabled: false` into `true` and fall through to the validation branch.
    # Default to true only when the key is absent (null); preserve `false`.
    SHEETS_ENABLED="$(jq -r 'if .enabled == null then true else .enabled end' "$SHEETS" 2>/dev/null)"
    if [ "$SHEETS_ENABLED" = "false" ]; then
      warn "Google Sheets sync is disabled (enabled=false in $SHEETS)."
    elif [ "$SHEETS_ENABLED" != "true" ]; then
      warn "$SHEETS: 'enabled' is not a boolean — Sheets sync will be skipped."
    else
      # enabled (or enabled absent, defaulting to true) — validate fields.
      SHEETS_ID="$(jq -r '.spreadsheet_id // empty' "$SHEETS")"
      SHEETS_TAB="$(jq -r '.worksheet_title // empty' "$SHEETS")"
      SHEETS_KEY="$(jq -r '.service_account_key_path // empty' "$SHEETS")"

      if [ -z "$SHEETS_ID" ] || [ "$SHEETS_ID" = "REPLACE_ME" ]; then
        warn "$SHEETS: spreadsheet_id is missing or placeholder — Sheets sync will be skipped."
      fi
      if [ -z "$SHEETS_TAB" ]; then
        warn "$SHEETS: worksheet_title is missing — Sheets sync will be skipped."
      fi
      if [ -z "$SHEETS_KEY" ] || [ "$SHEETS_KEY" = "REPLACE_ME" ]; then
        warn "$SHEETS: service_account_key_path is missing or placeholder — Sheets sync will be skipped."
      else
        # Key path shape: should end with .json.
        case "$SHEETS_KEY" in
          *.json) ;;
          *) warn "$SHEETS: service_account_key_path should end with .json — got: $SHEETS_KEY" ;;
        esac
        # Resolve relative to project root and check existence (warn only).
        KEY_ABS="$SHEETS_KEY"
        case "$KEY_ABS" in
          /*) ;;
          *) KEY_ABS="$PROJECT_ROOT/$KEY_ABS" ;;
        esac
        if [ ! -f "$KEY_ABS" ]; then
          warn "$SHEETS: service-account key file not found at $SHEETS_KEY — Sheets sync will be skipped until the key is placed. See docs/SETUP.md section 3.3."
        fi
      fi
    fi
  fi
fi

# --- Phase 11: hosted Supabase backend config (optional) -------------------
# Hosted/signed-in mode is opt-in from the desktop app (docs/app-integration-plan.md)
# — a local-only setup never needs this file. Same warn-and-continue contract
# as the Google Sheets check above: absence or a placeholder value only means
# "Sign in" isn't usable yet on this machine, never a failing run.

SUPABASE="$PROJECT_ROOT/src/config/supabase.json"

if [ ! -f "$SUPABASE" ]; then
  warn "Hosted backend config not found ($SUPABASE) — hosted sign-in will be unavailable in the desktop app. See src/config/supabase.example.json."
else
  if ! jq -e . "$SUPABASE" >/dev/null 2>&1; then
    warn "$SUPABASE: invalid JSON — hosted sign-in will be unavailable."
  else
    SUPABASE_URL="$(jq -r '.url // empty' "$SUPABASE")"
    SUPABASE_ANON_KEY="$(jq -r '.anonKey // empty' "$SUPABASE")"
    if [ -z "$SUPABASE_URL" ] || [ "$SUPABASE_URL" = "YOUR_PROJECT_REF" ] || printf '%s' "$SUPABASE_URL" | grep -q "YOUR_PROJECT_REF"; then
      warn "$SUPABASE: url is missing or still the placeholder — hosted sign-in will be unavailable."
    fi
    if [ -z "$SUPABASE_ANON_KEY" ] || [ "$SUPABASE_ANON_KEY" = "YOUR_SUPABASE_ANON_KEY" ]; then
      warn "$SUPABASE: anonKey is missing or still the placeholder — hosted sign-in will be unavailable."
    fi
  fi
fi

echo "validate_local_config: OK"