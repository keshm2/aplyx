#!/usr/bin/env python3
"""update.py — cross-platform self-updater.

Ported from update.sh so updates work natively on Windows as well as
macOS/Linux, with no curl/tar binary dependency (stdlib urllib + tarfile).
update.sh remains as a thin Unix shim that execs this file.

Compares the local VERSION against upstream main and, when they differ,
updates in place:
  - git checkout:    git pull --ff-only origin main
  - tarball install: download the main tarball and overlay it
Per-user files (live src/config/*.json, data/ incl. resumes, logs/,
.playwright-mcp/) are gitignored and absent from the tarball, so an
overlay cannot clobber them. An already-installed launchd/schtasks
schedule is also refreshed post-update (see _refresh_schedule_if_installed)
so a future script relocation can't strand it on a stale path the way
the 0.8.4a scripts/ reorg did for pre-existing schedules.

  update.py           # manual, verbose
  update.py --auto    # hook mode: quiet, ALWAYS exits 0 (fail-open)

Result line (always printed, last):
  update: up-to-date <version>
  update: updated <old> -> <new>
  update: check-failed <reason>   (auto mode: exit 0)
  update: failed <reason>         (auto mode: exit 0)

Env overrides: APLYX_UPDATE_URL, APLYX_TARBALL_URL.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

VERSION_URL = os.environ.get(
    "APLYX_UPDATE_URL",
    os.environ.get(
        "FLUX_UPDATE_URL",
        "https://raw.githubusercontent.com/keshm2/aplyx/main/VERSION",
    ),
)
TARBALL_URL = os.environ.get(
    "APLYX_TARBALL_URL",
    os.environ.get(
        "FLUX_TARBALL_URL",
        "https://codeload.github.com/keshm2/aplyx/tar.gz/refs/heads/main",
    ),
)

# Dev-only cruft install.sh/install.ps1's fresh-install path already trims
# (CI workflow definitions, per-harness agent files
# generate_agent_definitions.py regenerates fresh from src/agents/ on every
# install/update anyway, hosted-backend Supabase migrations, internal
# design/process docs) — applied here too so a clean install doesn't
# reaccumulate it on the next `aplyx update`'s tarball overlay.
_EXCLUDED_DIRS = (".github", ".claude", ".opencode", ".codex", "src/supabase", "docs/assets")
_EXCLUDED_FILES = (
    ".gitignore",
    "CLAUDE.md",
    "research-notes.md",
    "docs/CHANGELOG.md",
    "docs/RELEASE.md",
    "docs/ui-development-plan.md",
)


def _is_excluded(rel: str) -> bool:
    rel = rel.rstrip("/")
    if rel in _EXCLUDED_FILES:
        return True
    return any(rel == d or rel.startswith(d + "/") for d in _EXCLUDED_DIRS)


def _remove_excluded(root: str) -> None:
    for rel in (*_EXCLUDED_DIRS, *_EXCLUDED_FILES):
        target = os.path.join(root, *rel.split("/"))
        try:
            if os.path.isdir(target) and not os.path.islink(target):
                shutil.rmtree(target, ignore_errors=True)
            elif os.path.exists(target) or os.path.islink(target):
                os.remove(target)
        except OSError:
            pass


class FailOpen(Exception):
    def __init__(self, line: str):
        self.line = line


def main(argv) -> int:
    auto = "--auto" in argv
    post_only = "--post-update-only" in argv
    os.chdir(ROOT)

    def say(msg: str) -> None:
        if not auto:
            print(f"update: {msg}")

    def fail_open(line: str) -> "int":
        print(line)
        raise FailOpen(line) if not auto else SystemExit(0)

    if post_only:
        # Invoked as a fresh child process from the git-pull/tarball-overlay
        # branch below, specifically so this runs whatever _post_update
        # logic was JUST pulled to disk — see the comment down there for
        # why calling it directly in the parent process instead would run
        # stale, already-loaded logic.
        _post_update(say)
        return 0

    try:
        local = ""
        try:
            with open("VERSION", "r", encoding="utf-8") as fh:
                local = fh.read().strip()
        except OSError:
            local = ""
        local = local or "unknown"

        try:
            with urllib.request.urlopen(VERSION_URL, timeout=10) as resp:
                remote = resp.read().decode("utf-8").strip()
        except Exception:
            remote = ""
        if not remote:
            fail_open(f"update: check-failed could not fetch {VERSION_URL}")

        if remote == local:
            print(f"update: up-to-date {local}")
            return 0

        # One updater at a time; reclaim a lock older than 30 min (crashed run).
        os.makedirs("logs", exist_ok=True)
        lock = os.path.join(ROOT, "logs", ".update.lock")
        acquired = False
        try:
            os.mkdir(lock)
            acquired = True
        except FileExistsError:
            try:
                age_min = int((time.time() - os.path.getmtime(lock)) / 60)
            except OSError:
                age_min = 0
            if age_min >= 30:
                say(f"reclaiming stale update lock ({age_min}min old)")
                shutil.rmtree(lock, ignore_errors=True)
            try:
                os.mkdir(lock)
                acquired = True
            except FileExistsError:
                fail_open("update: check-failed another update is in progress")

        try:
            say(f"updating {local} -> {remote} …")
            if os.path.isdir(".git") and shutil.which("git"):
                r = subprocess.run(["git", "pull", "--ff-only", "origin", "main"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if r.returncode != 0:
                    fail_open("update: failed git pull --ff-only (dirty or diverged checkout — resolve manually)")
            else:
                _overlay_tarball(fail_open)

            new = remote
            try:
                with open("VERSION", "r", encoding="utf-8") as fh:
                    new = fh.read().strip() or remote
            except OSError:
                pass

            # Run the post-update rebuild steps in a FRESH child process
            # rather than calling _post_update() directly here: this
            # process's own update.py module — including _post_update
            # itself — was already imported and compiled into memory
            # BEFORE the git-pull/tarball-overlay above just overwrote
            # update.py's own source file on disk. Python doesn't
            # hot-reload, so calling _post_update() directly in this same
            # process would silently run whichever rebuild logic was
            # current when THIS invocation *started* — ignoring anything
            # the update itself just changed about how the rebuild works.
            # That's exactly how a single `aplyx update` run from an
            # install old enough to predate a _post_update fix kept
            # running the old, broken rebuild order even though the
            # correct new update.py was already sitting on disk by the
            # time _post_update ran — reported live: "says it updated ...
            # but none of the changes appeared," reproduced by tracing
            # through exactly this sequence. A fresh child process
            # re-imports this module from disk, so it always runs the
            # version that was JUST pulled, no matter how stale this
            # invocation's own in-memory code is. Mirrors the identical
            # self-re-exec pattern run_job_agent.py's own pre-run
            # auto-update already uses, for the same reason.
            child_argv = [sys.executable, os.path.abspath(__file__), "--post-update-only"]
            if auto:
                child_argv.append("--auto")
            r2 = subprocess.run(child_argv)
            if r2.returncode != 0:
                say("WARNING: post-update steps failed in the freshly-updated code — re-run 'aplyx update' or see the output above")

            print(f"update: updated {local} -> {new}")
            return 0
        finally:
            if acquired:
                shutil.rmtree(lock, ignore_errors=True)
    except FailOpen:
        return 1
    except SystemExit as e:
        return int(e.code or 0)


def _overlay_tarball(fail_open) -> None:
    tmp_fd, tmp_tgz = tempfile.mkstemp(suffix=".tar.gz")
    os.close(tmp_fd)
    try:
        try:
            with urllib.request.urlopen(TARBALL_URL, timeout=120) as resp, open(tmp_tgz, "wb") as out:
                shutil.copyfileobj(resp, out)
        except Exception:
            fail_open("update: failed tarball download")

        try:
            with tarfile.open(tmp_tgz, "r:gz") as tar:
                members = []
                for m in tar.getmembers():
                    # strip-components=1: drop the leading "aplyx-main/" segment.
                    parts = m.name.split("/", 1)
                    if len(parts) < 2 or not parts[1]:
                        continue
                    rel = parts[1]
                    if _is_excluded(rel):
                        continue
                    # Guard against path traversal in a hostile tarball.
                    dest = os.path.normpath(os.path.join(ROOT, rel))
                    if not dest.startswith(os.path.normpath(ROOT) + os.sep):
                        continue
                    m.name = rel
                    members.append(m)
                _safe_extractall(tar, ROOT, members)
                # An install from before this exclusion list existed may
                # still have this cruft on disk — the overlay above only
                # adds/overwrites files present in the (now-filtered)
                # tarball, it never deletes anything, so those installs
                # would otherwise never converge. Remove it here so
                # `aplyx update` finishes the cleanup install.sh/
                # install.ps1 already do for a fresh install.
                _remove_excluded(ROOT)
        except tarfile.TarError:
            fail_open("update: failed tarball extract")
    finally:
        try:
            os.remove(tmp_tgz)
        except OSError:
            pass


def _safe_extractall(tar, dest_root, members) -> None:
    for m in members:
        target = os.path.join(dest_root, m.name)
        if m.isdir():
            os.makedirs(target, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tar.extractfile(m)
            if src is None:
                continue
            with src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def _refresh_schedule_if_installed(say) -> None:
    """A launchd/schtasks entry bakes in an absolute path to the runner
    script at install time. If a future release ever relocates that
    script again (as the 0.8.4a scripts/ reorg did), an already-installed
    schedule would keep invoking the stale path forever — the tarball
    overlay never deletes old files, so nothing errors, it just silently
    stops receiving updates while VERSION reports current. Re-running
    scheduler.py install (fully idempotent — identical content when
    nothing changed) after every update keeps an existing schedule
    pointed at wherever the runner actually lives now. Only touches a
    schedule the user already opted into; never installs a new one."""
    is_mac = sys.platform == "darwin"
    is_win = os.name == "nt"
    if not (is_mac or is_win):
        return  # Linux has no scriptable schedule here (systemd is manual)
    scheduler = os.path.join("src", "scripts", "runtime", "scheduler.py")
    if not os.path.isfile(scheduler):
        return
    status = subprocess.run([sys.executable, scheduler, "status"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    installed = "NOT loaded" not in status.stdout and "NOT registered" not in status.stdout
    if not installed:
        return
    r = subprocess.run([sys.executable, scheduler, "install"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if r.returncode != 0:
        say("WARNING: could not refresh the existing schedule — run src/scripts/runtime/scheduler.py install")


_MIGRATION_BACKUP_SUFFIX = ".pre-src-migration.bak"

# Every top-level directory the 2026-07-29 src/ restructure moved, and the
# new-layout signature file that proves the just-pulled tree really does
# have the new structure (paranoia against renaming things away if a
# tarball fetch somehow landed only half-updated).
_MOVED_DIRS = (
    ("app", os.path.join("src", "tui", "package.json")),
    ("desktop", os.path.join("src", "tauri", "package.json")),
    ("packages", os.path.join("src", "core", "package.json")),
    ("scripts", os.path.join("src", "scripts", "state", "job_state.py")),
    ("agents", os.path.join("src", "agents", "bodies", "job-scraper.md")),
    ("extension", os.path.join("src", "extension", "package.json")),
    ("site", os.path.join("src", "site", "index.html")),
    ("supabase", os.path.join("src", "supabase", "migrations")),
)


def _migrate_live_config(root, say) -> None:
    """config/ (templates + live gitignored secrets) moved to src/config/ —
    but only the committed templates were ever in a git checkout/tarball,
    so an update's git-pull/tarball-overlay delivers src/config/*.example.json
    fresh while a user's real live secrets (targets.json, discord_config.json,
    the various API keys) are gitignored and simply absent from what was
    just pulled, still sitting at the OLD config/ path. Copy — never
    move-then-delete, and never overwrite something already at the
    destination (a freshly-delivered committed file must never be clobbered
    by a stale old copy) — so this is safe to run unconditionally on every
    update, including ones where it's already a no-op."""
    old_dir = os.path.join(root, "config")
    new_dir = os.path.join(root, "src", "config")
    if not os.path.isdir(old_dir):
        return
    os.makedirs(new_dir, exist_ok=True)
    for name in os.listdir(old_dir):
        old_path = os.path.join(old_dir, name)
        new_path = os.path.join(new_dir, name)
        if not os.path.isfile(old_path) or os.path.exists(new_path):
            continue
        try:
            shutil.copy2(old_path, new_path)
            say(f"migrated src/config/{name} from the old config/ location")
        except OSError as exc:
            say(f"WARNING: could not migrate config/{name} to src/config/ — {exc}. Copy it there by hand.")


def _migrate_to_src_layout(root, say) -> None:
    """2026-07-29: the whole repo moved under src/ (app -> src/tui, desktop
    -> src/tauri, packages/core -> src/core, scripts -> src/scripts, agents
    -> src/agents, extension -> src/extension, site -> src/site, supabase ->
    src/supabase, config -> src/config). A git-pull/tarball-overlay update
    only ever adds/overwrites files present in the new tree — it never
    deletes what it doesn't recognize — so without this, an existing
    install would end up with BOTH the old top-level directories AND the
    new src/ ones after updating: orphaned cruft, not a clean migration.
    Idempotent: every check below is "does the old thing still exist,"
    so this is a fast no-op on every update after the first. Renames
    (never deletes) each stale directory to a `.pre-src-migration.bak`
    sibling instead of removing it outright — reversible by hand if
    something downstream turns out wrong, cheap to delete later once the
    migration's proven stable."""
    _migrate_live_config(root, say)
    for old_name, new_signature in _MOVED_DIRS:
        old_path = os.path.join(root, old_name)
        if not os.path.isdir(old_path) or os.path.islink(old_path):
            continue
        if not os.path.exists(os.path.join(root, new_signature)):
            # The new-layout file isn't there yet — don't strand the old
            # directory on the assumption a restructure completed when it
            # may not have (e.g. a partial/interrupted tarball overlay).
            continue
        backup_path = old_path + _MIGRATION_BACKUP_SUFFIX
        if os.path.exists(backup_path):
            say(f"WARNING: {old_name}{_MIGRATION_BACKUP_SUFFIX} already exists — leaving {old_name}/ in place; remove one of them by hand.")
            continue
        try:
            os.rename(old_path, backup_path)
            say(f"moved old {old_name}/ out of the way (renamed to {old_name}{_MIGRATION_BACKUP_SUFFIX}/ — safe to delete once you've confirmed everything still works)")
        except OSError as exc:
            say(f"WARNING: could not move aside old {old_name}/ — {exc}. Remove or rename it by hand once you've confirmed src/{old_name if old_name != 'packages' else 'core'}/ works.")


def _refresh_wrapper_shim(root, say) -> None:
    """The `aplyx` command on PATH is a tiny wrapper written ONCE at install
    time (install.sh/.ps1's own final step) — it is NOT part of the repo,
    so no git-pull/tarball-overlay update ever touches it. It hardcodes a
    path to the TUI's compiled entry point relative to the install root;
    the src/ restructure moved that from app/dist/cli.js to
    src/tui/dist/cli.js, so an already-installed wrapper would keep looking
    for the old, now-nonexistent path forever until repaired here — this is
    the single biggest concrete breakage risk in the whole restructure.
    Mirrors install.sh/.ps1's own wrapper content exactly (one template,
    not two copies to keep in sync by hand). Only rewrites a wrapper that
    already exists and is confirmed to be aplyx's own — same restraint as
    _refresh_schedule_if_installed: never installs a new one for a user who
    never had the command."""
    if os.name == "nt":
        bin_dir = (os.environ.get("APLYX_BIN") or os.environ.get("FLUX_BIN")
                   or os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "aplyx", "bin"))
        cmd_shim = os.path.join(bin_dir, "aplyx.cmd")
        ps1_shim = os.path.join(bin_dir, "aplyx.ps1")
        try:
            with open(cmd_shim, "r", encoding="utf-8", errors="ignore") as fh:
                content = fh.read()
        except OSError:
            return  # no wrapper installed — nothing to refresh
        if "aplyx wrapper" not in content:
            return  # a foreign aplyx.cmd — leave it alone
        if "src\\tui\\dist\\cli.js" in content:
            return  # already current
        cmd_body = (
            "@echo off\r\n"
            "REM aplyx wrapper - generated by src/scripts/install/install.ps1; safe to delete.\r\n"
            "REM Falls back to common install locations if this was moved or renamed\r\n"
            "REM after install, before giving up with an actionable error.\r\n"
            f'set "PIN={root}"\r\n'
            'set "ROOT="\r\n'
            'if defined APLYX_ROOT if exist "%APLYX_ROOT%\\src\\tui\\dist\\cli.js" set "ROOT=%APLYX_ROOT%"\r\n'
            'if not defined ROOT if exist "%PIN%\\src\\tui\\dist\\cli.js" set "ROOT=%PIN%"\r\n'
            'if not defined ROOT if defined APLYX_HOME if exist "%APLYX_HOME%\\src\\tui\\dist\\cli.js" set "ROOT=%APLYX_HOME%"\r\n'
            'if not defined ROOT if defined FLUX_ROOT if exist "%FLUX_ROOT%\\src\\tui\\dist\\cli.js" set "ROOT=%FLUX_ROOT%"\r\n'
            'if not defined ROOT if defined FLUX_HOME if exist "%FLUX_HOME%\\src\\tui\\dist\\cli.js" set "ROOT=%FLUX_HOME%"\r\n'
            'if not defined ROOT if exist "%USERPROFILE%\\aplyx\\src\\tui\\dist\\cli.js" set "ROOT=%USERPROFILE%\\aplyx"\r\n'
            'if not defined ROOT if exist "%USERPROFILE%\\flux\\src\\tui\\dist\\cli.js" set "ROOT=%USERPROFILE%\\flux"\r\n'
            'if not defined ROOT if exist "%USERPROFILE%\\ares\\src\\tui\\dist\\cli.js" set "ROOT=%USERPROFILE%\\ares"\r\n'
            "if not defined ROOT goto :notfound\r\n"
            'if not defined APLYX_ROOT set "APLYX_ROOT=%ROOT%"\r\n'
            'node "%ROOT%\\src\\tui\\dist\\cli.js" %*\r\n'
            "goto :eof\r\n"
            ":notfound\r\n"
            f"echo aplyx: install directory not found - last known {root} 1>&2\r\n"
            "echo aplyx: if you moved it, set APLYX_ROOT to the new location or re-run its installer. 1>&2\r\n"
            "exit /b 1\r\n"
        )
        ps1_body = (
            "# aplyx wrapper - generated by src/scripts/install/install.ps1; safe to delete.\n"
            "# Falls back to common install locations if this was moved or renamed\n"
            "# after install, before giving up with an actionable error.\n"
            f'$pin = "{root}"\n'
            "$root = $null\n"
            'foreach ($c in @($env:APLYX_ROOT, $pin, $env:APLYX_HOME, $env:FLUX_ROOT, $env:FLUX_HOME, (Join-Path $env:USERPROFILE "aplyx"), (Join-Path $env:USERPROFILE "flux"), (Join-Path $env:USERPROFILE "ares"))) {\n'
            '  if ($c -and (Test-Path (Join-Path $c "src\\tui\\dist\\cli.js"))) { $root = $c; break }\n'
            "}\n"
            "if (-not $root) {\n"
            f'  Write-Host "aplyx: install directory not found (last known: {root})." -ForegroundColor Red\n'
            '  Write-Host "aplyx: if you moved it, set APLYX_ROOT to the new location or re-run its installer." -ForegroundColor Red\n'
            "  exit 1\n"
            "}\n"
            "if (-not $env:APLYX_ROOT) { $env:APLYX_ROOT = $root }\n"
            'node "$root\\src\\tui\\dist\\cli.js" @args\n'
        )
        try:
            with open(cmd_shim, "w", encoding="ascii", newline="") as fh:
                fh.write(cmd_body)
            with open(ps1_shim, "w", encoding="utf-8", newline="") as fh:
                fh.write(ps1_body)
            say(f"refreshed the aplyx command wrapper for the src/ restructure ({cmd_shim}).")
        except OSError as exc:
            say(f"WARNING: could not refresh the aplyx command wrapper — {exc}. Re-run install.ps1 to repair it.")
        return

    bin_dir = os.environ.get("APLYX_BIN") or os.environ.get("FLUX_BIN") or os.path.join(os.path.expanduser("~"), ".local", "bin")
    wrapper = os.path.join(bin_dir, "aplyx")
    try:
        with open(wrapper, "r", encoding="utf-8", errors="ignore") as fh:
            content = fh.read()
    except OSError:
        return  # no wrapper installed — nothing to refresh
    if "aplyx wrapper" not in content:
        return  # a foreign `aplyx` — leave it alone
    if "src/tui/dist/cli.js" in content:
        return  # already current
    body = (
        "#!/bin/sh\n"
        "# aplyx wrapper - generated by src/scripts/install/install.sh; safe to delete.\n"
        "# Falls back to common install locations if this was moved or renamed\n"
        "# after install, before giving up with an actionable error.\n"
        f'PIN="{root}"\n'
        'ROOT=""\n'
        'for c in "$APLYX_ROOT" "$PIN" "$APLYX_HOME" "$FLUX_ROOT" "$FLUX_HOME" "$HOME/aplyx" "$HOME/flux" "$HOME/ares"; do\n'
        '  if [ -n "$c" ] && [ -f "$c/src/tui/dist/cli.js" ]; then ROOT="$c"; break; fi\n'
        "done\n"
        'if [ -z "$ROOT" ]; then\n'
        f'  echo "aplyx: install directory not found (last known: {root})." >&2\n'
        '  echo "aplyx: if you moved it, set APLYX_ROOT to the new location or re-run its installer." >&2\n'
        "  exit 1\n"
        "fi\n"
        'APLYX_ROOT="${APLYX_ROOT:-$ROOT}" exec node "$ROOT/src/tui/dist/cli.js" "$@"\n'
    )
    try:
        with open(wrapper, "w", encoding="utf-8") as fh:
            fh.write(body)
        os.chmod(wrapper, 0o755)
        say(f"refreshed the aplyx command wrapper for the src/ restructure ({wrapper}).")
    except OSError as exc:
        say(f"WARNING: could not refresh the aplyx command wrapper — {exc}. Re-run install.sh to repair it.")


def _refresh_desktop_app_if_stale(say) -> None:
    """The desktop app's own binary and its bundled core/bridge.js resource
    are baked in at *build* time (src/tauri/src-tauri/tauri.conf.json) and
    never change after install — nothing this whole update process does
    (git pull / tarball overlay, the rebuilds below) can reach them. A
    prior fix added a version-staleness check for this, but only inside
    src/tui/src/cli.tsx's installUpdate() — the TypeScript wrapper the TUI's
    `aplyx update` calls this script through. Every OTHER path that runs
    update.py directly (the launchd/schtasks scheduler, run_job_agent.py's
    own pre-run auto-update) went through _post_update() below and never
    touched cli.tsx at all, so a desktop app that only ever updates via a
    scheduled run stayed permanently stale — reported live as "still not
    updating everything properly." Doing the check here instead, in the one
    place every invocation path already funnels through, covers all of
    them uniformly; the cli.tsx-side check was removed as the now-redundant
    duplicate (both would have raced to reinstall at once otherwise).
    """
    marker = os.path.join(os.path.expanduser("~"), ".aplyx", "desktop_installed")
    try:
        with open(marker, "r", encoding="utf-8") as fh:
            desktop_version = fh.read().strip()
    except OSError:
        return  # desktop app not installed — nothing to refresh
    if not desktop_version:
        return
    try:
        with open(os.path.join(ROOT, "VERSION"), "r", encoding="utf-8") as fh:
            current_version = fh.read().strip()
    except OSError:
        return
    if not current_version or desktop_version == current_version:
        return
    if os.name == "nt":
        script = os.path.join(ROOT, "src", "scripts", "install", "install_desktop.ps1")
        cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
    else:
        script = os.path.join(ROOT, "src", "scripts", "install", "install_desktop.sh")
        cmd = ["bash", script]
    if not os.path.isfile(script):
        return
    say(f"desktop app is on build {desktop_version}, core just updated to {current_version} — it doesn't update itself, so refreshing it too...")
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        say(f"WARNING: desktop app refresh failed — see the output above, or re-run {script}")


def _post_update(say) -> None:
    # Runs FIRST, before anything below reads config: migrates a pre-src/
    # -restructure install's live secrets to their new location and moves
    # stale top-level directories aside. A no-op (fast early-returns) on
    # every update after the first, so this is always safe to call.
    _migrate_to_src_layout(ROOT, say)
    # Each step warn-only so a hiccup never bricks an already-updated install.
    if subprocess.run([sys.executable, "src/scripts/validate/generate_agent_definitions.py"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        say("WARNING: agent-definition regeneration failed — run src/scripts/validate/generate_agent_definitions.py")
    if subprocess.run([sys.executable, "src/scripts/validate/validate_local_config.py"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        say("WARNING: config validation reported issues — run src/scripts/validate/validate_local_config.py")
    _refresh_schedule_if_installed(say)
    _refresh_desktop_app_if_stale(say)
    _refresh_wrapper_shim(ROOT, say)
    npm = shutil.which("npm")
    if npm:
        # src/core has no install/prepare hook that builds it
        # automatically — src/tui/'s and extension's own `tsc` builds both
        # resolve `@aplyx/core/*` imports against its dist/*.d.ts, which
        # this step used to leave stale. If an update changed core's
        # source (a new export, a bug fix) without this rebuild running
        # first, app/'s own `tsc` would fail type-checking against the
        # stale dist (a new export's .d.ts simply not there yet) — and
        # since the build script is `tsc && npm run bundle`, that failure
        # silently aborted before the bundle step ever ran, leaving
        # dist/cli.js completely untouched. The result: source pulled
        # down fine, VERSION bumped fine, but the compiled binary the
        # user actually runs never picked up ANY of the update — not just
        # the core-dependent parts — because the build never got that
        # far. Reproduced directly (removing a core .d.ts and running
        # app's own `npm run build` in isolation fails exactly this way)
        # before landing this fix.
        core_pkg = os.path.join(ROOT, "src", "core", "package.json")
        core_ok = True
        if os.path.isfile(core_pkg):
            core_ok = (
                subprocess.run([npm, "install", "--silent"], cwd=os.path.join(ROOT, "src", "core"),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
                and subprocess.run([npm, "run", "build", "--silent"], cwd=os.path.join(ROOT, "src", "core"),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            )
            if not core_ok:
                say("WARNING: shared core rebuild failed — the TUI/extension rebuilds below will likely fail too. Run: cd src/core && npm install && npm run build")
        for rel, label in (("src/tui", "TUI"), ("src/extension", "browser extension")):
            pkg = os.path.join(ROOT, rel, "package.json")
            if not os.path.isfile(pkg):
                continue
            ok = (
                subprocess.run([npm, "install", "--silent"], cwd=os.path.join(ROOT, rel),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
                and subprocess.run([npm, "run", "build", "--silent"], cwd=os.path.join(ROOT, rel),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            )
            if not ok:
                say(f"WARNING: {label} rebuild failed — run: cd {rel} && npm install && npm run build")
    else:
        say("node/npm not found — skipped the shared core/TUI/browser-extension rebuilds")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
