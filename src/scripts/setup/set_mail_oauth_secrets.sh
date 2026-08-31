#!/bin/bash
# set_mail_oauth_secrets.sh: configure Gmail (and optionally Microsoft)
# OAuth secrets on the linked Supabase project so the hosted mail-oauth
# Edge Functions can run the inbox-consent flow.
#
# The mail-oauth-start / mail-oauth-callback functions (src/supabase/
# functions/) read these from Deno.env at runtime; Supabase Edge
# Functions surface `supabase secrets set` values as Deno.env. This
# script is the one-time + on-rotation entry point for those secrets.
#
# Required from the operator: either Microsoft OR Google credentials.
# Gmail: CLIENT_ID, CLIENT_SECRET from Google Cloud Console.
# Microsoft: CLIENT_ID, CLIENT_SECRET from Azure AD app registration.
# MAIL_OAUTH_STATE_SECRET is auto-generated (32 random bytes, hex) the
# first time it is missing, so the operator never has to hand-roll it.
#
# Usage:
#   bash src/scripts/setup/set_mail_oauth_secrets.sh \
#     [--client-id <id>] [--client-secret <secret>]
#     [--tenant <id>] [--callback-url <url>]
#     [--google-client-id <id> --google-client-secret <secret>]
#     [-h, --help]
#
# Run from anywhere; this script cd's into src/supabase so `supabase
# secrets set` targets the linked project (aplyx-users).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$SCRIPT_DIR/../../supabase"

MICROSOFT_CLIENT_ID=""
MICROSOFT_CLIENT_SECRET=""
MICROSOFT_TENANT_ID=""
MAIL_CALLBACK_URL=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

usage() {
  cat <<EOF
Usage: $0 [options]

Required: configure at least one OAuth provider (Microsoft or Google).

Options:
  --client-id <id>                 MICROSOFT_CLIENT_ID (Azure app registration)
  --client-secret <secret>         MICROSOFT_CLIENT_SECRET
  --tenant <id>                    MICROSOFT_TENANT_ID (default: "common")
  --callback-url <url>             MAIL_CALLBACK_URL (default: aplyx://mail-callback)
  --google-client-id <id>          GOOGLE_CLIENT_ID (Google Cloud Console)
  --google-client-secret <secret>  GOOGLE_CLIENT_SECRET
  -h, --help                        Show this help
EOF
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client-id) MICROSOFT_CLIENT_ID="$2"; shift 2 ;;
    --client-secret) MICROSOFT_CLIENT_SECRET="$2"; shift 2 ;;
    --tenant) MICROSOFT_TENANT_ID="$2"; shift 2 ;;
    --callback-url) MAIL_CALLBACK_URL="$2"; shift 2 ;;
    --google-client-id) GOOGLE_CLIENT_ID="$2"; shift 2 ;;
    --google-client-secret) GOOGLE_CLIENT_SECRET="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

# At least one provider must be configured
if [[ -z "$MICROSOFT_CLIENT_ID" && -z "$GOOGLE_CLIENT_ID" ]]; then
  echo "error: at least one of --client-id (Microsoft) or --google-client-id (Google) is required" >&2
  usage 1
fi

cd "$SUPABASE_DIR"

# MAIL_OAUTH_STATE_SECRET: generate on first use.
# `supabase secrets list` only exposes a digest, so we cannot read the value back:
# if it is already set we leave it untouched (rotation is a separate explicit step).
STATE_SECRET=""
if ! supabase secrets list 2>/dev/null | grep -q '^ *MAIL_OAUTH_STATE_SECRET'; then
  STATE_SECRET="$(openssl rand -hex 32)"
  echo "Generating MAIL_OAUTH_STATE_SECRET (32 random bytes)…"
fi

SECRETS=()
[[ -n "$STATE_SECRET" ]] && SECRETS+=("MAIL_OAUTH_STATE_SECRET=$STATE_SECRET")
[[ -n "$MICROSOFT_CLIENT_ID" ]] && SECRETS+=("MICROSOFT_CLIENT_ID=$MICROSOFT_CLIENT_ID")
[[ -n "$MICROSOFT_CLIENT_SECRET" ]] && SECRETS+=("MICROSOFT_CLIENT_SECRET=$MICROSOFT_CLIENT_SECRET")
[[ -n "$MICROSOFT_TENANT_ID" ]] && SECRETS+=("MICROSOFT_TENANT_ID=$MICROSOFT_TENANT_ID")
[[ -n "$MAIL_CALLBACK_URL" ]] && SECRETS+=("MAIL_CALLBACK_URL=$MAIL_CALLBACK_URL")
[[ -n "$GOOGLE_CLIENT_ID" ]] && SECRETS+=("GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID")
[[ -n "$GOOGLE_CLIENT_SECRET" ]] && SECRETS+=("GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET")

echo "Setting ${#SECRETS[@]} secret(s) on the linked Supabase project…"
supabase secrets set "${SECRETS[@]}"

# The callback URL that must be registered in the developer console: must
# match _shared/mail_oauth.ts's callbackUrl() exactly (SUPABASE_URL +
# /functions/v1/mail-oauth-callback). NOT the <ref>.functions.supabase.co
# form: that's the domain `supabase functions deploy` mentions, but
# supabase-js (2.111.0+) invokes functions at <ref>.supabase.co/functions/v1/,
# and Google rejects a redirect_uri that doesn't match byte-for-byte
# (caught 2026-08-21: it silently produced a mismatched URL and Google
# rejected the request as invalid).
PROJECT_REF="$(grep -o '"ref":"[^"]*"' .temp/linked-project.json 2>/dev/null | head -1 | cut -d'"' -f4 || true)"
if [[ -n "$PROJECT_REF" ]]; then
  echo
  echo "Redirect URI to register in console:"
  echo "  https://${PROJECT_REF}.supabase.co/functions/v1/mail-oauth-callback"
  echo
  echo "Then, for each provider:"
  echo "  • Google: add this URI under OAuth 2.0 redirect URIs in the Google Cloud Console"
  echo "  • Microsoft: add this URI under Authentication → Add platform → Web in the Azure Portal"
fi

echo
echo "Done. Redeploy the functions if code changed:"
echo "  supabase functions deploy mail-oauth-start"
echo "  supabase functions deploy mail-oauth-callback --no-verify-jwt"