#!/bin/bash
# install.sh — universal first-run installer (Phase 15).
#
# One command from a fresh GitHub clone to a validated, harness-configured
# setup. Non-destructive: existing live configs are never overwritten.
#
#   bash src/scripts/install/install.sh                                      # from a clone/unpacked release
#   curl -fsSL https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.sh | bash
#
# Steps:
#   0. Bootstrap: when piped (curl | bash) or run outside the repo,
#      download and unpack the source tarball, then re-run from inside it.
#   1. Check prerequisites (jq, python3; node optional for the TUI).
#   2. Copy src/config/*.example.json to live configs where missing.
#   3. Detect installed coding agents (opencode, claude) and write
#      src/config/harness.json (only if missing).
#   4. Ask for the user's profile (safe_fields) — kept locally only.
#   5. Offer to create .claude/settings.json (headless permission
#      pre-approval) when Claude Code is the harness — asks first.
#   6. Regenerate per-harness agent definitions from src/agents/.
#   7. Run the config validator (which also auto-seeds vetted slugs).
#   8. Optionally build the TUI (src/tui/) when node is available.

set -euo pipefail

say()  { echo "install: $*"; }
warn() { echo "install: WARNING: $*" >&2; }
fail() { echo "install: ERROR: $*" >&2; exit 1; }

# Everything a fresh, non-dev install doesn't need to run: CI workflow
# definitions, per-harness agent files (step 6 below regenerates them
# fresh from src/agents/ anyway), hosted-backend (Supabase) migrations that
# only matter to whoever runs that backend, the marketing site (src/site/ —
# it's deployed straight from the repo on GitHub Pages, never built or
# read by a local install), and internal design/process/planning docs. A
# fresh install should hold exactly what it needs to work, not a mirror
# of the whole source tree. Shared by both trim call sites below (the
# piped/tarball bootstrap, and — since it's the same "not a dev clone"
# situation — an extracted release-archive checkout with no .git dir).
CRUFT_PATHS=(
  .github .claude .opencode .codex .gitignore
  CLAUDE.md research-notes.md src/supabase src/site
  docs/assets docs/CHANGELOG.md docs/RELEASE.md docs/ui-development-plan.md
  docs/ATS.md docs/system_architecture.md
  docs/hosted-paid-tier-plan.md docs/website.md
)
trim_cruft() { # <target-dir>
  local target="$1"
  for CRUFT in "${CRUFT_PATHS[@]}"; do
    rm -rf "${target:?}/$CRUFT"
  done
}

# Builds a $2-column bar with a $3-wide highlighted segment that slides
# back and forth (ping-pong) as $1 increases — the indeterminate-progress
# analog of _draw_download_bar below, for steps with no byte total to
# measure against (npm install, a tsc build). Not a percentage — there's
# nothing to measure it against — but visually one system with the
# byte-tracked download bar instead of a bare spinner character.
_indeterminate_bar() {
  local i="$1" width="$2" block="$3"
  local range=$(( width - block ))
  local period=$(( range * 2 ))
  local raw=$(( i % period ))
  local pos block_str
  if [ "$raw" -le "$range" ]; then
    pos=$raw
    block_str="$(printf '%*s' "$((block - 1))" '' | tr ' ' '=')>"
  else
    pos=$(( period - raw ))
    block_str="<$(printf '%*s' "$((block - 1))" '' | tr ' ' '=')"
  fi
  local bar
  bar="$(printf '%*s' "$pos" '' | tr ' ' '.')"
  bar="${bar}${block_str}"
  bar="${bar}$(printf '%*s' "$((width - pos - block))" '' | tr ' ' '.')"
  printf '%s' "$bar"
}

# Runs "$@" with an indeterminate sliding bar next to $1 (the message)
# while it's in the background — for steps with no byte total to show
# (npm install, a package manager resolving deps), unlike the tarball
# download below which uses download_with_progress instead. Falls back to
# a plain "$msg..." line with no live redraw when stdout isn't a TTY
# (piped install, CI, a log file) — \r redraws would just spam a log with
# junk rather than animate.
spin() {
  local msg="$1"; shift
  if [ ! -t 1 ]; then
    printf '%s...\n' "$msg"
    "$@"
    return $?
  fi
  "$@" &
  local pid=$!
  local width=20 block=6
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r%s [%s]' "$msg" "$(_indeterminate_bar "$i" "$width" "$block")"
    i=$((i + 1))
    sleep 0.1
  done
  wait "$pid"
  local rc=$?
  printf '\r%*s\r' "$((${#msg} + width + 4))" ""
  return $rc
}

# Renders a fixed-width [====>.....] bar plus "current/total" in MB (decimal
# — matches how download sizes are usually advertised) for $current/$total
# bytes into $width columns. $total <= 0 (Content-Length wasn't available)
# degrades to a bytes-downloaded counter with no bar/percentage, since
# there's nothing to measure progress against.
_draw_download_bar() {
  local current="$1" total="$2" width="$3"
  local filled=0
  if [ "$total" -gt 0 ] 2>/dev/null; then
    filled=$(( current * width / total ))
    [ "$filled" -gt "$width" ] && filled="$width"
  fi
  local bar=""
  [ "$filled" -gt 0 ] && bar="$(printf '%*s' "$((filled - 1))" '' | tr ' ' '=')>"
  bar="${bar}$(printf '%*s' "$((width - filled))" '' | tr ' ' '.')"
  local cur_mb=$(( current / 1000000 ))
  if [ "$total" -gt 0 ] 2>/dev/null; then
    printf '\r[%s] %sMB/%sMB ' "$bar" "$cur_mb" "$(( total / 1000000 ))"
  else
    printf '\r[%s] %sMB downloaded ' "$bar" "$cur_mb"
  fi
}

# Downloads $2 (url) to $1 (outfile) with a live byte-tracked bar — a HEAD
# request gets the total size, a background curl does the real download,
# and this polls the growing file's size to redraw the bar. Falls back to
# a single "downloading..." line with no live redraw when stdout isn't a
# TTY, same reasoning as spin().
download_with_progress() {
  local outfile="$1" url="$2"
  local total
  # awk-only, not grep|awk: codeload.github.com's tarball response has no
  # Content-Length header at all (confirmed live — it's a dynamically
  # generated archive, not a static file), so grep finds zero matches and
  # exits 1; under this script's `set -o pipefail`, that non-zero pipeline
  # exit silently killed the ENTIRE installer right here, before the real
  # download ever started — reproduced live, this was why `curl | bash`
  # died right after printing "downloading aplyx into ~/aplyx" with no
  # further output or error on every single run. awk's own exit status is
  # always 0 whether or not its pattern ever matched a line, so folding
  # the match into one awk program (no grep) removes the failure mode
  # entirely instead of just working around this one call site.
  total="$(curl -fsIL "$url" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "content-length" {v=$2} END {print v}')"
  [ -z "$total" ] && total=0

  if [ ! -t 1 ]; then
    say "downloading $(basename "$outfile")…"
    curl -fL -o "$outfile" "$url"
    return $?
  fi

  curl -fsL -o "$outfile" "$url" &
  local pid=$!
  local width=30 current
  while kill -0 "$pid" 2>/dev/null; do
    current=0
    [ -f "$outfile" ] && current="$(wc -c < "$outfile" 2>/dev/null | tr -d ' ')"
    [ -z "$current" ] && current=0
    _draw_download_bar "$current" "$total" "$width"
    sleep 0.2
  done
  wait "$pid"
  local rc=$?
  current=0
  [ -f "$outfile" ] && current="$(wc -c < "$outfile" 2>/dev/null | tr -d ' ')"
  _draw_download_bar "${current:-0}" "$total" "$width"
  echo
  return $rc
}

# Colors only on a TTY; the privacy notice and warnings must stand out.
if [ -t 1 ]; then
  C_NOTICE=$'\033[1;36m'; C_WARN=$'\033[1;33m'; C_RESET=$'\033[0m'
else
  C_NOTICE=""; C_WARN=""; C_RESET=""
fi

# --- 0. Bootstrap (curl | bash, or run outside the repo) ----------------------
# When the script is piped, BASH_SOURCE is empty and there is no repo around
# it. Download the source tarball, unpack, and re-exec from inside it.
# (The npm-installed `aplyx` command mirrors this bootstrap; its own
# --no-core flag / APLYX_SKIP_CORE=1 opt-out has no equivalent here since
# this script IS the install.)
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$(dirname "$SELF")/../../../AGENTS.md" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required for the one-line install"
  command -v tar  >/dev/null 2>&1 || fail "tar is required for the one-line install"
  TARGET_DIR="${APLYX_HOME:-${FLUX_HOME:-$HOME/aplyx}}"
  if [ -f "$TARGET_DIR/AGENTS.md" ]; then
    say "existing install found at $TARGET_DIR — refreshing it from GitHub before re-running."
  else
    say "downloading aplyx into $TARGET_DIR …"
  fi
  mkdir -p "$TARGET_DIR"
  # Always re-fetch and overwrite tracked files, even for an existing install:
  # heals a stale or corrupted local copy (e.g. an old script version with a
  # bug) instead of re-running whatever happens to already be on disk.
  # Gitignored local state (src/config/*.json, data/, logs/, docs/PLAN.md)
  # isn't in the tarball, so it's left untouched.
  # A full-path template ("$TMPDIR/prefix.XXXXXX"), not `mktemp -t prefix`:
  # confirmed live on macOS's BSD mktemp, `-t` treats its argument as a
  # literal prefix and does NOT substitute the XXXXXX pattern the way GNU
  # mktemp (Linux) does — produced a real, valid, still-unique file, just
  # with the literal string "aplyx-src.XXXXXX" embedded in its name
  # instead of a proper temp suffix. Harmless by itself, but confusing
  # (looked like a real bug while investigating the actual crash below)
  # and worth being correct on both platforms rather than accidentally
  # relying on BSD's own fallback random suffix.
  TARBALL="$(mktemp "${TMPDIR:-/tmp}/aplyx-src.XXXXXX").tar.gz"
  trap 'rm -f "$TARBALL"' EXIT
  download_with_progress "$TARBALL" "https://codeload.github.com/keshm2/aplyx/tar.gz/refs/heads/main"
  tar -xz --strip-components=1 -C "$TARGET_DIR" -f "$TARBALL"
  # Only runs on THIS downloaded-tarball path — never on a real git
  # checkout someone points this script at directly (the `if` branch
  # above, untouched). See CRUFT_PATHS above for what and why.
  trim_cruft "$TARGET_DIR"
  rm -f "$TARBALL"
  trap - EXIT
  # Re-attach stdin to the terminal so the interactive prompts below work
  # even though the script itself arrived on stdin.
  if [ -e /dev/tty ]; then
    exec bash "$TARGET_DIR/src/scripts/install/install.sh" </dev/tty
  else
    exec bash "$TARGET_DIR/src/scripts/install/install.sh"
  fi
fi
cd "$PROJECT_ROOT"

# The other documented non-dev install path (docs/SETUP.md's "release
# archive": download a GitHub tag's zip, unzip, run this script from
# inside it) never goes through the piped bootstrap above — $SELF is
# already set, so the `if` branch runs instead. It needs the same
# trimming for the same reason: no .git directory is the reliable signal
# that this is an extracted archive, not a real clone a developer/
# contributor is working in (which must never have files silently
# deleted out from under it).
if [ ! -d "$PROJECT_ROOT/.git" ]; then
  say "no .git directory found — trimming files a local install doesn't need to run."
  trim_cruft "$PROJECT_ROOT"
fi

# Pin this checkout's location to ~/.aplyx/root, read by
# src/core/src/project.ts's findProjectRoot() as its primary
# resolution signal. Written unconditionally, first, regardless of what
# happens in the rest of this script: a Finder/Dock-launched desktop app
# has no shell env vars and no meaningful working directory to fall back
# on, so without this pin a brand-new install would land straight on the
# app's "browse for my aplyx folder" manual recovery screen every time.
mkdir -p "$HOME/.aplyx"
printf '%s' "$PROJECT_ROOT" > "$HOME/.aplyx/root"

# --- 1. Prerequisites --------------------------------------------------------
# Detect everything missing FIRST (tools + the one required Python package,
# pypdf — resume PDF conversion silently can't work without it) and ask
# once, rather than hard-failing on the first missing thing: most users
# running the one-liner have no idea what jq/python3/pypdf even are, and
# would rather aplyx just installed them.
MISSING_TOOLS=""
command -v jq      >/dev/null 2>&1 || MISSING_TOOLS="$MISSING_TOOLS jq"
command -v python3 >/dev/null 2>&1 || MISSING_TOOLS="$MISSING_TOOLS python3"
MISSING_TOOLS="${MISSING_TOOLS# }"

MISSING_PY_PKGS=""
if command -v python3 >/dev/null 2>&1; then
  python3 -c "import pypdf" >/dev/null 2>&1 || MISSING_PY_PKGS="pypdf"
fi

if [ -n "$MISSING_TOOLS" ] || [ -n "$MISSING_PY_PKGS" ]; then
  echo
  [ -n "$MISSING_TOOLS" ]  && warn "not detected: $MISSING_TOOLS"
  [ -n "$MISSING_PY_PKGS" ] && warn "not detected (Python package): $MISSING_PY_PKGS — needed for resume PDF conversion"
  warn "these are needed to continue installing aplyx."
  INSTALL_DEPS="y"
  if [ -t 0 ]; then
    printf "Install them now? [Y/n] "
    read -r INSTALL_DEPS || INSTALL_DEPS="y"
    [ -z "$INSTALL_DEPS" ] && INSTALL_DEPS="y"
  else
    warn "non-interactive install — proceeding to install them automatically (re-run interactively to be asked first)."
  fi
  case "$INSTALL_DEPS" in
    y|Y) ;;
    *) fail "cannot continue without: ${MISSING_TOOLS}${MISSING_TOOLS:+, }${MISSING_PY_PKGS}. Install them yourself and re-run." ;;
  esac

  if [ -n "$MISSING_TOOLS" ]; then
    SUDO=""
    [ "$(id -u 2>/dev/null || echo 0)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
    if command -v brew >/dev/null 2>&1; then
      brew install $MISSING_TOOLS || fail "failed to install $MISSING_TOOLS via brew — install manually and re-run."
    elif command -v apt-get >/dev/null 2>&1; then
      $SUDO apt-get update && $SUDO apt-get install -y $MISSING_TOOLS \
        || fail "failed to install $MISSING_TOOLS via apt-get — install manually and re-run."
    elif command -v dnf >/dev/null 2>&1; then
      $SUDO dnf install -y $MISSING_TOOLS || fail "failed to install $MISSING_TOOLS via dnf — install manually and re-run."
    elif command -v yum >/dev/null 2>&1; then
      $SUDO yum install -y $MISSING_TOOLS || fail "failed to install $MISSING_TOOLS via yum — install manually and re-run."
    elif command -v pacman >/dev/null 2>&1; then
      $SUDO pacman -Sy --noconfirm $MISSING_TOOLS || fail "failed to install $MISSING_TOOLS via pacman — install manually and re-run."
    elif command -v apk >/dev/null 2>&1; then
      $SUDO apk add $MISSING_TOOLS || fail "failed to install $MISSING_TOOLS via apk — install manually and re-run."
    else
      fail "no supported package manager found (brew/apt/dnf/yum/pacman/apk) — install $MISSING_TOOLS manually and re-run."
    fi
    say "installed: $MISSING_TOOLS"
  fi

  if [ -n "$MISSING_PY_PKGS" ]; then
    python3 -m pip install --user pypdf \
      || fail "failed to install pypdf via pip — run 'python3 -m pip install --user pypdf' manually and re-run."
    say "installed: pypdf"
  fi
fi

command -v jq      >/dev/null 2>&1 || fail "jq is required and still missing — install it manually and re-run."
command -v python3 >/dev/null 2>&1 || fail "python3 is required and still missing — install it manually and re-run."

# --- 1b. Repair a stale pre-restructure layout (idempotent, always runs) ----
# The automatic update path (aplyx update / the scheduled auto-update) can
# fail to ever apply a directory-layout migration on an install whose
# currently-running code predates that migration: its self-relaunch targets
# a script path cached before the update, which the update itself may have
# just moved (this is exactly what happened to every pre-existing install
# on the 2026-07-29 src/ restructure — see update.py's --repair-layout-only
# comment for the full mechanics). Re-running this installer is the one
# path immune to that: it is a brand-new process every time, so there is no
# stale cached path to go wrong. No-op (near-instant) on an already-current
# install or a genuinely fresh one — safe to always run.
python3 src/scripts/install/update.py --repair-layout-only || true

# --- 2. Live configs from examples -------------------------------------------
if [ -f "src/config/targets.json" ]; then
  say "src/config/targets.json exists — keeping it."
else
  cp "src/config/targets.example.json" "src/config/targets.json"
  chmod 600 "src/config/targets.json"
  say "created src/config/targets.json from the example — fill in the placeholders (or run 'aplyx setup')."
fi

# --- 2b. Discord status updates (OPTIONAL, opt-in) -----------------------------
# Outcomes always land in the local state files and the TUI; Discord
# webhooks are an optional extra channel. Opting out writes a disabled
# config so the validator stays green; enable later via 'aplyx setup'.
DISCORD_LIVE="src/config/discord_config.json"
write_disabled_discord() {
  printf '{\n  "enabled": false,\n  "webhooks": {}\n}\n' > "$DISCORD_LIVE"
  chmod 600 "$DISCORD_LIVE"
}
if [ -f "$DISCORD_LIVE" ]; then
  say "$DISCORD_LIVE exists — keeping it."
elif [ -t 0 ]; then
  echo
  printf "Use Discord for status updates (applied / needs-review / failed / summary)? [y/N] "
  read -r DISCORD_OPT || DISCORD_OPT=""
  if [ "$DISCORD_OPT" = "y" ] || [ "$DISCORD_OPT" = "Y" ]; then
    echo
    echo "How should the updates be routed?"
    echo "  1) One channel for ALL status updates (one webhook link)"
    echo "  2) Separate channels per status (success / needs-review / failed / summary)"
    echo "${C_WARN}⚠  Separate channels: Discord binds each webhook to ONE channel, so${C_RESET}"
    echo "${C_WARN}   EACH channel needs its own webhook link (4 links for option 2).${C_RESET}"
    printf "Choose [1/2, default 1]: "
    read -r DISCORD_MODE || DISCORD_MODE=""
    ask_url() { # <label>
      local url
      printf "  %s webhook URL: " "$1" >&2
      read -r url || url=""
      printf '%s' "$url"
    }
    if [ "$DISCORD_MODE" = "2" ]; then
      U_SUCCESS="$(ask_url "success")"
      U_REVIEW="$(ask_url "needs-review")"
      U_FAILED="$(ask_url "failed")"
      U_SUMMARY="$(ask_url "summary (optional, enter to fall back to success)")"
    else
      U_ALL="$(ask_url "the one shared")"
      U_SUCCESS="$U_ALL"; U_REVIEW="$U_ALL"; U_FAILED="$U_ALL"; U_SUMMARY="$U_ALL"
    fi
    if [ -z "$U_SUCCESS" ]; then
      warn "no webhook URL entered — writing Discord as disabled; enable later with 'aplyx setup'."
      write_disabled_discord
    else
      jq -n --arg s "$U_SUCCESS" --arg r "$U_REVIEW" --arg f "$U_FAILED" --arg m "$U_SUMMARY" \
        '{enabled: true, webhooks: ({success: $s, needs_review: $r, failed: $f} + (if $m == "" then {} else {summary: $m} end))}' \
        > "$DISCORD_LIVE"
      chmod 600 "$DISCORD_LIVE"
      say "wrote $DISCORD_LIVE (Discord enabled)."
    fi
  else
    write_disabled_discord
    say "Discord skipped — outcomes stay local (state files + TUI). Enable any time with 'aplyx setup'."
  fi
else
  write_disabled_discord
  say "non-interactive install — wrote $DISCORD_LIVE as disabled (enable via 'aplyx setup')."
fi

# --- 3. Harness detection (Phase 15 + 16: all four major coding agents) -------
# Detected agents are offered in full-capability-first order; Codex and
# Copilot run the documented degraded path (no browser automation by
# default) — see the "Harness capability matrix" in AGENTS.md.
DETECTED=""
label_for() {
  case "$1" in
    opencode) echo "opencode" ;;
    claude)   echo "Claude Code" ;;
    codex)    echo "Codex CLI          (API boards only unless browser tooling is configured)" ;;
    copilot)  echo "GitHub Copilot CLI (API boards only unless browser tooling is configured)" ;;
  esac
}
for AGENT in opencode claude codex copilot; do
  command -v "$AGENT" >/dev/null 2>&1 && DETECTED="$DETECTED $AGENT"
done
DETECTED="${DETECTED# }"

if [ -z "$DETECTED" ]; then
  warn "no supported coding agent found (opencode, claude, codex, or copilot)."
  warn "install one, then re-run: https://opencode.ai · https://claude.com/claude-code"
  warn "  · https://developers.openai.com/codex/cli · https://docs.github.com/copilot"
fi

if [ -f "src/config/harness.json" ]; then
  say "src/config/harness.json exists — keeping it ($(jq -r '.harness // "?"' src/config/harness.json))."
else
  HARNESS=""
  set -- $DETECTED
  if [ "$#" -gt 1 ] && [ -t 0 ]; then
    # More than one agent installed and we can ask — let the user choose.
    echo
    echo "Which coding agent should aplyx use for runs?"
    i=1
    for AGENT in $DETECTED; do
      echo "  $i) $(label_for "$AGENT")"
      i=$((i + 1))
    done
    printf "Choose [1-%s, default 1]: " "$#"
    read -r CHOICE || CHOICE=""
    case "$CHOICE" in
      *[!0-9]*|"") CHOICE=1 ;;
    esac
    [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "$#" ] || CHOICE=1
    i=1
    for AGENT in $DETECTED; do
      [ "$i" -eq "$CHOICE" ] && HARNESS="$AGENT"
      i=$((i + 1))
    done
  elif [ "$#" -ge 1 ]; then
    HARNESS="$1"
  fi
  if [ -n "$HARNESS" ]; then
    printf '{\n  "harness": "%s"\n}\n' "$HARNESS" > src/config/harness.json
    say "wrote src/config/harness.json (harness: $HARNESS — change any time by editing the file or re-running this installer)."
  else
    say "skipped src/config/harness.json — no supported coding agent detected yet."
  fi
fi

# --- 4. User profile (safe_fields) ---------------------------------------
say "profile: run 'aplyx' (or 'aplyx setup') to fill in your name, contact info, and job targets through the guided wizard — or edit src/config/targets.json by hand (see the _help notes in src/config/targets.example.json)."

mkdir -p data/resumes
echo
echo "${C_NOTICE}📄  Resumes: add your base resumes (markdown + matching PDF) to${C_RESET}"
echo "${C_NOTICE}    $PROJECT_ROOT/data/resumes/${C_RESET}"
echo "${C_NOTICE}    See docs/SETUP.md for the expected filenames — aplyx picks one per${C_RESET}"
echo "${C_NOTICE}    job by category and tailors it. This folder is gitignored — local only.${C_RESET}"
echo

# --- 5. Claude Code headless permissions (opt-in, asks first) ----------------
# Headless runs need pre-approved tools; this file grants Claude Code broad
# repo-local permissions, so it is only created with explicit consent.
if command -v claude >/dev/null 2>&1 && [ ! -f ".claude/settings.json" ]; then
  echo
  echo "Claude Code headless runs need pre-approved permissions in .claude/settings.json:"
  echo '  Bash(*), Edit(*), Write(*), Read(*), mcp__playwright__* (repo-local)'
  printf "Create it now? [y/N] "
  read -r REPLY || REPLY=""
  if [ "$REPLY" = "y" ] || [ "$REPLY" = "Y" ]; then
    mkdir -p .claude
    cat > .claude/settings.json <<'JSON'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Edit(*)",
      "Write(*)",
      "Read(*)",
      "mcp__playwright__*"
    ]
  },
  "enableAllProjectMcpServers": true
}
JSON
    say "wrote .claude/settings.json."
  else
    say "skipped .claude/settings.json — headless Claude runs will prompt for permissions."
  fi
fi

# --- 6. Agent definitions ------------------------------------------------------
python3 src/scripts/validate/generate_agent_definitions.py

# --- 7. Validate (also auto-seeds vetted Ashby/Lever slugs) --------------------
if bash src/scripts/validate/validate_local_config.sh; then
  say "config valid."
else
  warn "config not valid yet — edit the files named above (or run 'aplyx setup'), then re-run:"
  warn "  bash src/scripts/validate/validate_local_config.sh"
fi

# --- 8. TUI / extension (optional) ---------------------------------------------
# --no-progress: npm's OWN fetch-progress spinner (a rotating -\|/ cursor
# on terminals without Unicode/Braille support, which is npm's fallback —
# most commonly hit on a plain Windows console) writes to the same line
# via \r as our own bar above, and the two fighting over that line is what
# looks like "the bar doesn't show, it's back to a spinner." --silent only
# lowers npm's *log level*; progress is a separate npm switch. Disabling
# it leaves our bar as the only thing animating this line.
# --workspace="$1" (run from PROJECT_ROOT, already the cwd here) scopes the
# install to just this workspace's own dependencies plus its declared
# workspace deps (e.g. @aplyx/core) — a plain `cd "$1" && npm install`
# instead resolves and hoists EVERY workspace's dependencies into the root
# node_modules regardless of which one you're building. Confirmed live:
# installing just the TUI that way also pulled in the desktop app's full
# Tauri/Vite/Supabase/font dependency tree (and installing just the desktop
# app pulled in the TUI's Ink/esbuild tree) — measured at roughly 2x the
# actual footprint either surface alone needs, adding real extra download/
# postinstall (native-binary) work on top of whatever's actually being built.
_npm_install_and_build() { npm install --workspace="$1" --silent --no-progress && (cd "$1" && npm run build --silent); }

# Total on-disk size of a built surface (node_modules + dist), human-
# readable — printed after a build so "ready" also answers "how much did
# that just cost me," the same way the tarball/installer downloads above
# already show MB downloaded instead of just "done."
_dir_size_human() {
  du -sch "$@" 2>/dev/null | tail -1 | awk '{print $1}'
}

build_node_surface() {
  local dir="$1" label="$2"
  if [ ! -f "$dir/package.json" ]; then
    return 0
  fi
  if [ -d "$dir/node_modules" ] && [ -d "$dir/dist" ]; then
    say "$label already installed ($(_dir_size_human "$dir/node_modules" "$dir/dist"))."
    return 0
  fi
  spin "building $label ($dir/)" _npm_install_and_build "$dir" \
    && say "$label ready ($(_dir_size_human "$dir/node_modules" "$dir/dist"))." \
    || warn "$label build failed — see docs/SETUP.md."
}

if command -v npm >/dev/null 2>&1; then
  # src/core has no install/prepare hook that builds it automatically —
  # src/tui/'s and src/tauri/'s own `tsc` builds both need its dist/ already
  # present to resolve `@aplyx/core/*` imports, which is never true on a
  # fresh clone. Build it first so both surfaces build clean below.
  spin "building the shared core" npm run build:core --silent \
    || warn "core build failed — the TUI build below will likely fail too. See docs/SETUP.md."
  build_node_surface src/tui "the TUI"
  build_node_surface src/extension "the browser extension"
else
  say "node/npm not found — skipping the optional TUI and browser extension (docs/SETUP.md)."
fi

# --- 8b. Desktop app (optional, early preview) ----------------------------------
# Ships ALONGSIDE the TUI at this stage, not in place of it (that flips
# later). Building it needs Rust + OS-native GUI deps on top of Node — real
# prerequisites the TUI doesn't have — so this is opt-in and its own script
# (install_desktop.sh), and a failure here never fails this installer: the
# TUI install above already succeeded and stays fully usable either way.
if [ -f "src/tauri/package.json" ] && command -v npm >/dev/null 2>&1; then
  echo
  echo "aplyx also has an early-preview desktop app (Tauri), alongside the TUI."
  echo "Building it needs a Rust toolchain and some OS build tools — this script"
  echo "offers to install anything missing, and first-time compiling can take"
  echo "several minutes."
  INSTALL_APP="n"
  if [ -t 0 ]; then
    printf "Install the desktop app too? [y/N] "
    read -r INSTALL_APP || INSTALL_APP="n"
  else
    say "non-interactive install — skipping the desktop app (opt-in only; run 'bash src/scripts/install/install_desktop.sh' any time to add it)."
  fi
  if [ "$INSTALL_APP" = "y" ] || [ "$INSTALL_APP" = "Y" ]; then
    bash "$PROJECT_ROOT/src/scripts/install/install_desktop.sh" \
      || warn "desktop app install failed (see above) — the TUI is unaffected. Fix the issue and retry any time with: bash src/scripts/install/install_desktop.sh"
  fi
fi

# --- 9. `aplyx` command on PATH ------------------------------------------------
# One-command install ends with a working `aplyx`: a tiny wrapper in
# ~/.local/bin (override with APLYX_BIN) pins APLYX_ROOT to this
# checkout. Never overwrites a foreign `aplyx` binary.
if [ -f "src/tui/dist/cli.js" ] && command -v node >/dev/null 2>&1; then
  BIN_DIR="${APLYX_BIN:-${FLUX_BIN:-$HOME/.local/bin}}"
  WRAPPER="$BIN_DIR/aplyx"
  # Clean up an older-name wrapper from a previous rebrand so a re-run
  # doesn't leave both `flux` and `aplyx` on PATH pointing at this checkout.
  OLD_WRAPPER="$BIN_DIR/flux"
  if [ -f "$OLD_WRAPPER" ] && grep -q "flux wrapper" "$OLD_WRAPPER" 2>/dev/null && grep -q "$PROJECT_ROOT" "$OLD_WRAPPER" 2>/dev/null; then
    rm -f "$OLD_WRAPPER"
    say "removed the older \`flux\` command ($OLD_WRAPPER)."
  fi
  if [ -e "$WRAPPER" ] && ! grep -q "aplyx wrapper" "$WRAPPER" 2>/dev/null; then
    warn "$WRAPPER exists and is not aplyx's wrapper — leaving it alone."
  else
    mkdir -p "$BIN_DIR"
    cat > "$WRAPPER" <<WRAP
#!/bin/sh
# aplyx wrapper — generated by src/scripts/install/install.sh; safe to delete.
# Falls back to common install locations if this was moved or renamed
# after install, before giving up with an actionable error — rather
# than the raw Node MODULE_NOT_FOUND stack trace a stale hardcoded
# path would otherwise produce.
PIN="$PROJECT_ROOT"
ROOT=""
for c in "\$APLYX_ROOT" "\$PIN" "\$APLYX_HOME" "\$FLUX_ROOT" "\$FLUX_HOME" "\$HOME/aplyx" "\$HOME/flux" "\$HOME/ares"; do
  if [ -n "\$c" ] && [ -f "\$c/src/tui/dist/cli.js" ]; then ROOT="\$c"; break; fi
done
if [ -z "\$ROOT" ]; then
  echo "aplyx: install directory not found (last known: $PROJECT_ROOT)." >&2
  echo "aplyx: if you moved it, set APLYX_ROOT to the new location or re-run its installer." >&2
  exit 1
fi
APLYX_ROOT="\${APLYX_ROOT:-\$ROOT}" exec node "\$ROOT/src/tui/dist/cli.js" "\$@"
WRAP
    chmod +x "$WRAPPER"
    say "installed the aplyx command: $WRAPPER"
    case ":$PATH:" in
      *":$BIN_DIR:"*) ;;
      *) warn "$BIN_DIR is not on your PATH — add it (e.g. export PATH=\"$BIN_DIR:\$PATH\" in your shell profile)." ;;
    esac
  fi
fi

say "done. Try: aplyx   (updates auto-install on every run/launch; APLYX_AUTO_UPDATE=0 disables, 'aplyx update' runs one manually)."
