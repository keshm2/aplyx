#!/usr/bin/env python3
"""update.py — cross-platform self-updater.

Ported from update.sh so updates work natively on Windows as well as
macOS/Linux, with no curl/tar binary dependency (stdlib urllib + tarfile).
update.sh remains as a thin Unix shim that execs this file.

Compares the local VERSION against upstream main and, when they differ,
updates in place:
  - git checkout:    git pull --ff-only origin main
  - tarball install: download the main tarball and overlay it
Per-user files (live config/*.json, data/ incl. resumes, logs/,
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

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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
                    # Guard against path traversal in a hostile tarball.
                    dest = os.path.normpath(os.path.join(ROOT, rel))
                    if not dest.startswith(os.path.normpath(ROOT) + os.sep):
                        continue
                    m.name = rel
                    members.append(m)
                _safe_extractall(tar, ROOT, members)
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
    scheduler = os.path.join("scripts", "runtime", "scheduler.py")
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
        say("WARNING: could not refresh the existing schedule — run scripts/runtime/scheduler.py install")


def _post_update(say) -> None:
    # Each step warn-only so a hiccup never bricks an already-updated install.
    if subprocess.run([sys.executable, "scripts/validate/generate_agent_definitions.py"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        say("WARNING: agent-definition regeneration failed — run scripts/validate/generate_agent_definitions.py")
    if subprocess.run([sys.executable, "scripts/validate/validate_local_config.py"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        say("WARNING: config validation reported issues — run scripts/validate/validate_local_config.py")
    _refresh_schedule_if_installed(say)
    npm = shutil.which("npm")
    if npm:
        # packages/core has no install/prepare hook that builds it
        # automatically — app/'s and extension's own `tsc` builds both
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
        core_pkg = os.path.join(ROOT, "packages", "core", "package.json")
        core_ok = True
        if os.path.isfile(core_pkg):
            core_ok = (
                subprocess.run([npm, "install", "--silent"], cwd=os.path.join(ROOT, "packages", "core"),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
                and subprocess.run([npm, "run", "build", "--silent"], cwd=os.path.join(ROOT, "packages", "core"),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            )
            if not core_ok:
                say("WARNING: shared core rebuild failed — the TUI/extension rebuilds below will likely fail too. Run: cd packages/core && npm install && npm run build")
        for rel, label in (("app", "TUI"), ("extension", "browser extension")):
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
