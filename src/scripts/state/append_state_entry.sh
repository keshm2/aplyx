#!/bin/bash
# append_state_entry.sh — deterministic JSON-array state writer.
#
# Ensures a JSON-array state file exists and is valid, and appends one JSON
# object to it atomically. Used for data/applied_jobs.json and
# data/review_queue.json so the agent never hand-writes jq/mv pipelines.
#
# Usage:
#   append_state_entry.sh ensure <file>
#       Create <file> as [] if missing; verify it is a valid JSON array.
#   append_state_entry.sh append <file> '<json-object>'
#       Append one JSON object to <file> atomically.
#   append_state_entry.sh <file> '<json-object>'
#       Shorthand for append (matches the form referenced in AGENTS.md).
#
# Dedup guard: if the new object contains a "job_id" key and an existing
# array element already has the same "job_id", the append is refused and
# the script exits with status 2 (no file change). This is a safety net on
# top of the agent's own read-before-write dedup.
#
# Exit codes:
#   0  success
#   1  usage / IO / JSON validation error
#   2  duplicate job_id detected (append refused)

set -euo pipefail

die() { echo "append_state_entry: $*" >&2; exit 1; }

usage() {
  cat >&2 <<EOF
Usage:
  $0 ensure <file>
  $0 append <file> '<json-object>'
  $0 <file> '<json-object>'   (shorthand for append)
EOF
  exit 1
}

validate_array() {
  local file="$1"
  [ -f "$file" ] || die "not a file: $file"
  if ! jq -e 'type == "array"' "$file" >/dev/null 2>&1; then
    die "not a valid JSON array: $file"
  fi
}

ensure_file() {
  local file="$1"
  if [ ! -e "$file" ]; then
    printf '[]\n' > "$file"
  fi
  validate_array "$file"
}

append_entry() {
  local file="$1" entry="$2"
  ensure_file "$file"

  # Validate the incoming value is a single JSON object.
  if ! printf '%s' "$entry" | jq -e 'type == "object"' >/dev/null 2>&1; then
    die "entry is not a single JSON object: $entry"
  fi

  # Dedup guard on job_id when the entry carries one.
  if printf '%s' "$entry" | jq -e 'has("job_id")' >/dev/null 2>&1; then
    local jid
    jid="$(printf '%s' "$entry" | jq -r '.job_id')"
    if jq -e --arg jid "$jid" 'any(.[]?; .job_id == $jid)' "$file" >/dev/null 2>&1; then
      echo "append_state_entry: duplicate job_id '$jid' already present in $file — append refused" >&2
      exit 2
    fi
  fi

  # Atomic publish: build the new array in a temp file in the same directory
  # (same filesystem so mv is atomic), validate it, then move over the original.
  local tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if ! jq --argjson e "$entry" '. + [$e]' "$file" > "$tmp"; then
    rm -f "$tmp"
    die "jq append failed for $file"
  fi
  validate_array "$tmp"
  mv -f "$tmp" "$file"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    ensure)
      [ $# -eq 2 ] || usage
      ensure_file "$2"
      ;;
    append)
      [ $# -eq 3 ] || usage
      append_entry "$2" "$3"
      ;;
    ""|-h|--help)
      usage
      ;;
    *)
      # Shorthand: <file> '<json-object>'
      [ $# -eq 2 ] || usage
      append_entry "$1" "$2"
      ;;
  esac
}

main "$@"