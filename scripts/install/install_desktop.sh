#!/bin/bash
# install_desktop.sh — installs the aplyx desktop app (Tauri + React) for
# macOS and Linux.
#
# Prefers downloading a prebuilt bundle from this checkout's matching
# GitHub release (built once, on CI, by .github/workflows/desktop-release.yml)
# — that path needs nothing beyond curl: no Rust, no Xcode Command Line
# Tools, no OS-native GUI build dependencies, same as installing any other
# compiled macOS/Linux app. Building from source is the FALLBACK, only
# used when no matching prebuilt bundle exists (an unreleased checkout, a
# release with no CI-built assets yet, or an arch with none) — that path
# is the one that needs Rust + native build tools, because it's actually
# compiling the app on this machine instead of just installing an
# already-compiled one.
#
# This is a separate script from install.sh (which calls into this one as
# an opt-in step) so it can also be re-run standalone after fixing a
# missing dependency:
#
#   bash scripts/install/install_desktop.sh
#
# Early-preview status: the desktop app ships ALONGSIDE the TUI, not in
# place of it — this script never touches the TUI install and a failure
# here is never allowed to take down install.sh's main flow (see the
# caller in install.sh, which treats a non-zero exit as a warning, not a
# hard failure).

set -euo pipefail

say()  { echo "install-desktop: $*"; }
warn() { echo "install-desktop: WARNING: $*" >&2; }
fail() { echo "install-desktop: ERROR: $*" >&2; exit 1; }

# Builds a $2-column bar with a $3-wide highlighted segment that slides
# back and forth (ping-pong) as $1 increases — the indeterminate-progress
# analog of _draw_download_bar below, for steps with no byte total to
# measure against (npm install, cargo build). Not a percentage — there's
# nothing to measure it against — but visually one system with the
# byte-tracked download bar instead of a bare spinner character.
_indeterminate_bar() {
  local i="$1" width="$2" block="$3"
  local range=$(( width - block ))
  local period=$(( range * 2 ))
  local pos=$(( i % period ))
  [ "$pos" -gt "$range" ] && pos=$(( period - pos ))
  local bar
  bar="$(printf '%*s' "$pos" '' | tr ' ' '.')"
  bar="${bar}$(printf '%*s' "$block" '' | tr ' ' '=')"
  bar="${bar}$(printf '%*s' "$((width - pos - block))" '' | tr ' ' '.')"
  printf '%s' "$bar"
}

# Runs "$@" with an indeterminate sliding bar next to $1 while it's in the
# background — for steps with no byte total to show (npm install, cargo
# build), unlike the prebuilt-bundle downloads below which use
# download_with_progress instead. Falls back to a plain "$msg..." line
# with no live redraw when stdout isn't a TTY.
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

# Renders a fixed-width [====>.....] bar plus "current/total" in MB
# (decimal) for $current/$total bytes into $width columns. $total <= 0
# (Content-Length wasn't available) degrades to a bytes-downloaded
# counter with no bar/percentage.
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
# TTY.
download_with_progress() {
  local outfile="$1" url="$2"
  local total
  total="$(curl -fsIL "$url" 2>/dev/null | tr -d '\r' | grep -i '^content-length:' | tail -1 | awk '{print $2}')"
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

# Pin this checkout's location to ~/.aplyx/root, same as install.sh —
# written here too since this script is documented as independently
# re-runnable on its own, not only as install.sh's opt-in step. The
# desktop app (Finder/Dock-launched, no shell env vars, no meaningful
# working directory) reads this as its primary way to find the checkout;
# see packages/core/src/project.ts's findProjectRoot().
mkdir -p "$HOME/.aplyx"
printf '%s' "$PROJECT_ROOT" > "$HOME/.aplyx/root"

# Marker file the TUI's Settings screen checks (see
# @aplyx/core/desktopApp.ts's isDesktopAppInstalled) to show "already
# installed" instead of offering to install again. Plain text, one line —
# same convention as the root pin file above. Written once install
# actually succeeds (both the prebuilt-download and build-from-source
# paths call this — see the two call sites below), not here at the top,
# so an interrupted/failed run doesn't falsely claim success.
mark_desktop_installed() {
  printf '%s' "$(cat "$PROJECT_ROOT/VERSION" 2>/dev/null || echo unknown)" > "$HOME/.aplyx/desktop_installed"
}

[ -f "desktop/package.json" ] || fail "desktop/ not found in this checkout — nothing to install."

OS="$(uname -s)"
SUDO=""
[ "$(id -u 2>/dev/null || echo 0)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
REPO="keshm2/aplyx"

# --- macOS: install an already-built .app (shared by the prebuilt-download
# and build-from-source paths) ------------------------------------------------
install_macos_app() { # <path to a built/extracted aplyx.app>
  local app_src="$1"
  local dest="/Applications"
  [ -w "$dest" ] || dest="$HOME/Applications"
  mkdir -p "$dest"
  osascript -e 'quit app "aplyx"' >/dev/null 2>&1 || true
  rm -rf "$dest/aplyx.app"
  cp -R "$app_src" "$dest/aplyx.app"
  say "installed: $dest/aplyx.app"
  say "open it from Finder/Launchpad, or: open '$dest/aplyx.app'"
}

# --- Linux: install whichever bundle format is available (shared by both
# paths) -----------------------------------------------------------------------
install_linux_bundle() { # <dir containing candidate .deb/.rpm/.AppImage files>
  local dir="$1"
  local deb rpm appimage
  deb="$(find "$dir" -maxdepth 2 -name '*.deb' 2>/dev/null | head -n1 || true)"
  rpm="$(find "$dir" -maxdepth 2 -name '*.rpm' 2>/dev/null | head -n1 || true)"
  appimage="$(find "$dir" -maxdepth 2 -name '*.AppImage' 2>/dev/null | head -n1 || true)"

  if [ -n "$deb" ] && command -v apt-get >/dev/null 2>&1; then
    # apt (not dpkg -i) so it resolves the bundle's runtime deps too.
    $SUDO apt-get install -y "./$deb" || fail "apt install of $deb failed."
    say "installed via apt: $deb"
    return 0
  elif [ -n "$rpm" ] && command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y "./$rpm" || fail "dnf install of $rpm failed."
    say "installed via dnf: $rpm"
    return 0
  elif [ -n "$appimage" ]; then
    local appdir="$HOME/.local/share/aplyx"
    mkdir -p "$appdir" "$HOME/.local/share/applications" "$HOME/.local/bin"
    cp "$appimage" "$appdir/aplyx.AppImage"
    chmod +x "$appdir/aplyx.AppImage"
    ln -sf "$appdir/aplyx.AppImage" "$HOME/.local/bin/aplyx-app"
    local icon_src="desktop/src-tauri/icons/128x128.png"
    [ -f "$icon_src" ] && cp "$icon_src" "$appdir/icon.png"
    cat > "$HOME/.local/share/applications/aplyx.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=aplyx
Comment=aplyx desktop app
Exec=$appdir/aplyx.AppImage
Icon=$appdir/icon.png
Categories=Office;
Terminal=false
DESKTOP
    command -v update-desktop-database >/dev/null 2>&1 \
      && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
    say "installed: $appdir/aplyx.AppImage (find \"aplyx\" in your application launcher, or run: aplyx-app)"
    return 0
  fi
  return 1
}

# --- 0. Try a prebuilt bundle from this version's GitHub release --------------
# VERSION (repo root) is a plain tracked file present in both a git
# checkout and an unpacked release tarball, so this works either way —
# unlike deriving the tag from `git describe`, which needs a real .git dir.
try_prebuilt_install() {
  command -v jq >/dev/null 2>&1 || { say "jq not found — skipping the prebuilt-download check, building from source instead."; return 1; }
  [ -f VERSION ] || { say "no VERSION file in this checkout — skipping the prebuilt-download check."; return 1; }
  local tag="v$(cat VERSION)"

  say "checking the $tag GitHub release for a prebuilt desktop app…"
  local release_json
  release_json="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$tag" 2>/dev/null || true)"
  if [ -z "$release_json" ] || ! printf '%s' "$release_json" | jq -e '.assets' >/dev/null 2>&1; then
    say "no $tag release with build assets found on GitHub — will build from source instead."
    return 1
  fi

  local work_dir
  work_dir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work_dir'" RETURN

  if [ "$OS" = "Darwin" ]; then
    local arch asset_url
    arch="$(uname -m)"
    # Tauri's own bundle-naming isn't symmetric: Apple Silicon gets
    # "aarch64" but Intel gets "x64", not "x86_64" — verified against a
    # real build's asset names, not assumed. Match uname -m's actual
    # output to Tauri's actual filename token for each.
    case "$arch" in
      arm64) arch="aarch64" ;;
      x86_64) arch="x64" ;;
    esac
    asset_url="$(printf '%s' "$release_json" | jq -r --arg a "$arch" \
      '[.assets[] | select(.name | endswith(".dmg")) | select(.name | contains($a))][0].browser_download_url // empty')"
    [ -n "$asset_url" ] || { say "no prebuilt macOS ($arch) bundle in $tag — will build from source instead."; return 1; }

    say "downloading the prebuilt desktop app…"
    download_with_progress "$work_dir/aplyx.dmg" "$asset_url" \
      || { warn "download failed — will build from source instead."; return 1; }
    local mount_dir="$work_dir/mnt"
    mkdir -p "$mount_dir"
    hdiutil attach "$work_dir/aplyx.dmg" -mountpoint "$mount_dir" -nobrowse -quiet \
      || { warn "couldn't mount the downloaded .dmg — will build from source instead."; return 1; }
    install_macos_app "$mount_dir/aplyx.app"
    hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
    say "(prebuilt — no Rust or Xcode Command Line Tools needed)"
    return 0

  elif [ "$OS" = "Linux" ]; then
    # .deb uses dpkg's "amd64"/"arm64" arch names; .rpm/.AppImage typically
    # use uname's "x86_64"/"aarch64" instead — match whichever token this
    # machine's arch maps to, in either convention, rather than assuming
    # the one CI currently produces (x86_64 only) is the only one that
    # will ever exist.
    local arch_tokens
    case "$(uname -m)" in
      x86_64) arch_tokens="amd64|x86_64" ;;
      aarch64|arm64) arch_tokens="arm64|aarch64" ;;
      *) arch_tokens="$(uname -m)" ;;
    esac
    local asset_urls
    asset_urls="$(printf '%s' "$release_json" | jq -r --arg re "\\.(deb|rpm|AppImage)$" --arg arch "($arch_tokens)" \
      '.assets[] | select(.name | test($re)) | select(.name | test($arch)) | .browser_download_url')"
    [ -n "$asset_urls" ] || { say "no prebuilt Linux ($(uname -m)) bundle in $tag — will build from source instead."; return 1; }

    say "downloading the prebuilt desktop app…"
    local url name
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      name="$(basename "$url")"
      say "  $name"
      download_with_progress "$work_dir/$name" "$url" || warn "failed to download $name — skipping it."
    done <<< "$asset_urls"

    install_linux_bundle "$work_dir" || { warn "no compatible package manager for the downloaded bundle(s) — will build from source instead."; return 1; }
    say "(prebuilt — no Rust or OS-native build tools needed)"
    return 0
  fi
  return 1
}

if try_prebuilt_install; then
  mark_desktop_installed
  say "done."
  exit 0
fi

# --- Fallback: build from source ----------------------------------------------
# Reached only when no prebuilt bundle was available. THIS is the path that
# actually needs Rust + OS-native GUI build dependencies (Tauri wraps the
# system webview) — real, sometimes multi-minute-to-install prerequisites.
# Checks for each, offers to install what's missing (same "detect
# everything first, ask once" pattern as install.sh's own step 1).
say "no prebuilt bundle available — building the desktop app from source instead."

# --- 1. Rust toolchain --------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  warn "not detected: Rust (cargo) — required to compile the desktop app's native shell."
  INSTALL_RUST="y"
  if [ -t 0 ]; then
    printf "Install Rust now via rustup (official installer, ~minimal profile)? [Y/n] "
    read -r INSTALL_RUST || INSTALL_RUST="y"
    [ -z "$INSTALL_RUST" ] && INSTALL_RUST="y"
  else
    warn "non-interactive — installing Rust automatically (re-run interactively to be asked first)."
  fi
  case "$INSTALL_RUST" in
    y|Y) ;;
    *) fail "cannot build the desktop app without Rust. Install it yourself (https://rustup.rs) and re-run." ;;
  esac
  # --profile minimal: rustc + cargo + the stdlib only, skips rustfmt/
  # clippy/docs — this script only ever compiles, never lints/formats.
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal \
    || fail "rustup install failed — install Rust yourself (https://rustup.rs) and re-run."
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  command -v cargo >/dev/null 2>&1 || fail "Rust installed but cargo still not on PATH — open a new shell and re-run."
  say "installed Rust ($(rustc --version))."
fi

# --- 2. OS-native build dependencies ------------------------------------------
if [ "$OS" = "Darwin" ]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    warn "Xcode Command Line Tools not found — required to link the macOS app when building from source."
    INSTALL_CLT="y"
    if [ -t 0 ]; then
      printf "Install them now (opens Apple's installer — a few minutes)? [Y/n] "
      read -r INSTALL_CLT || INSTALL_CLT="y"
      [ -z "$INSTALL_CLT" ] && INSTALL_CLT="y"
    else
      warn "non-interactive — triggering the install automatically (re-run interactively to be asked first)."
    fi
    case "$INSTALL_CLT" in
      y|Y) ;;
      *) fail "cannot build the desktop app without Xcode Command Line Tools. Install them yourself (xcode-select --install) and re-run." ;;
    esac
    # Unlike every other dependency in this script, this one can't be
    # waited on: xcode-select --install hands off to an async native GUI
    # installer with no CLI completion signal to poll. Trigger it and stop
    # here — the next run picks up cleanly once it's done.
    xcode-select --install >/dev/null 2>&1 || true
    fail "a Command Line Tools installer window should have opened — finish that, then re-run: bash scripts/install/install_desktop.sh"
  fi
elif [ "$OS" = "Linux" ]; then
  # Tauri wraps the system webview (webkit2gtk) rather than bundling one —
  # these are the documented Tauri v2 Linux build deps, one line per
  # package manager (same detection order as install.sh's step 1).
  if command -v apt-get >/dev/null 2>&1; then
    PKGS="libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev"
    PKG_CHECK="dpkg -s libwebkit2gtk-4.1-dev"
    PKG_INSTALL="$SUDO apt-get update && $SUDO apt-get install -y $PKGS"
  elif command -v dnf >/dev/null 2>&1; then
    PKGS="webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel gcc gcc-c++ make"
    PKG_CHECK="rpm -q webkit2gtk4.1-devel"
    PKG_INSTALL="$SUDO dnf install -y $PKGS"
  elif command -v pacman >/dev/null 2>&1; then
    PKGS="webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg"
    PKG_CHECK="pacman -Qi webkit2gtk-4.1"
    PKG_INSTALL="$SUDO pacman -Sy --noconfirm $PKGS"
  else
    warn "no supported package manager found (apt/dnf/pacman) — install Tauri's Linux dependencies yourself:"
    warn "  https://v2.tauri.app/start/prerequisites/#linux"
    PKG_CHECK=""
    PKG_INSTALL=""
  fi
  if [ -n "$PKG_CHECK" ] && ! eval "$PKG_CHECK" >/dev/null 2>&1; then
    warn "desktop build dependencies not detected ($PKGS)."
    INSTALL_DEPS="y"
    if [ -t 0 ]; then
      printf "Install them now (needs sudo)? [Y/n] "
      read -r INSTALL_DEPS || INSTALL_DEPS="y"
      [ -z "$INSTALL_DEPS" ] && INSTALL_DEPS="y"
    else
      warn "non-interactive — installing them automatically (re-run interactively to be asked first)."
    fi
    case "$INSTALL_DEPS" in
      y|Y) eval "$PKG_INSTALL" || fail "dependency install failed — install manually (https://v2.tauri.app/start/prerequisites/#linux) and re-run." ;;
      *) fail "cannot build the desktop app without these — install manually and re-run." ;;
    esac
    say "installed desktop build dependencies."
  fi
else
  fail "unsupported OS for this script ($OS) — Windows uses scripts/install/install_desktop.ps1."
fi

# --- 3. Build ------------------------------------------------------------------
# packages/core has no install/prepare hook that builds it automatically —
# both the TUI and the desktop app need its dist/ built explicitly first.
spin "building the shared core" npm run build:core --silent || fail "core build failed."

_desktop_frontend_build() { (cd desktop && npm install --silent && npm run build --silent); }
spin "building the desktop frontend" _desktop_frontend_build \
  || fail "desktop frontend build failed."

say "compiling the desktop app (first run downloads + compiles Tauri's Rust dependencies — this can take several minutes)…"
(cd desktop && npx tauri build) \
  || fail "desktop app build failed — see the error above. Common causes: missing native deps (previous step), or a stale Cargo cache (try: rm -rf desktop/src-tauri/target && re-run)."

BUNDLE_DIR="desktop/src-tauri/target/release/bundle"

# --- 4. Install the built bundle ------------------------------------------------
if [ "$OS" = "Darwin" ]; then
  APP_SRC="$BUNDLE_DIR/macos/aplyx.app"
  [ -d "$APP_SRC" ] || fail "expected bundle not found at $APP_SRC — build may have failed silently."
  install_macos_app "$APP_SRC"
elif [ "$OS" = "Linux" ]; then
  install_linux_bundle "$BUNDLE_DIR" || fail "no installable bundle found under $BUNDLE_DIR — build may have failed silently."
fi

mark_desktop_installed
say "done."
