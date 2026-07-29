#!/usr/bin/env python3
"""uninstall.py — cross-platform uninstaller.

Ported from uninstall.sh so it runs natively on Windows as well as
macOS/Linux. uninstall.sh remains a thin Unix shim.

  uninstall.py            # interactive (asks before deleting the dir)
  uninstall.py --yes      # no prompts (still prints what it did)
  uninstall.py --keep-data  # remove schedule + command, keep the install dir

Removes, in order:
  1. The schedule (scheduler.py uninstall — launchd/schtasks).
  2. The `aplyx` command on PATH — only aplyx's own wrapper/shim pointing
     at THIS install.
  2b. The desktop app (early preview), if it was installed alongside the
      TUI via src/scripts/install/install_desktop.sh|ps1 — best-effort,
      never fails the uninstall.
  3. The install directory (live config, data/ incl. resumes, logs/ — PII),
     only after an explicit confirmation (or --yes).

npm installs: `npm uninstall -g @keshm/aplyx` removes the TUI command (a
reminder is printed when one is detected). The npm package never owns the
core directory — this script does.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
IS_WINDOWS = os.name == "nt"


def say(msg: str) -> None:
    print(f"uninstall: {msg}")


def _remove_readonly(func, path, _exc):
    # Windows: clear the read-only bit and retry (git objects are read-only).
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except OSError:
        pass


# Historical command names, newest first — a wrapper/shim from an
# earlier rebrand is still cleaned up on the current uninstall rather
# than left behind as an orphan.
_OLD_NAMES = ("aplyx", "flux", "aplyx")


def _remove_unix_wrapper() -> None:
    bin_dir = (os.environ.get("APLYX_BIN") or os.environ.get("FLUX_BIN")
               or os.path.join(os.path.expanduser("~"), ".local", "bin"))
    for name in _OLD_NAMES:
        wrapper = os.path.join(bin_dir, name)
        if not os.path.isfile(wrapper):
            continue
        try:
            with open(wrapper, "r", encoding="utf-8", errors="ignore") as fh:
                body = fh.read()
        except OSError:
            continue
        if f"{name} wrapper" not in body:
            continue
        if ROOT in body:
            try:
                os.remove(wrapper)
                say(f"removed the {name} command ({wrapper}).")
            except OSError:
                pass
        else:
            say(f"{wrapper} points at a different install — left alone.")


def _remove_windows_wrapper() -> None:
    bin_dir = (os.environ.get("APLYX_BIN") or os.environ.get("FLUX_BIN")
               or os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "aplyx", "bin"))
    for name in _OLD_NAMES:
        for ext in (".cmd", ".ps1"):
            shim = os.path.join(bin_dir, f"{name}{ext}")
            if not os.path.isfile(shim):
                continue
            try:
                with open(shim, "r", encoding="utf-8", errors="ignore") as fh:
                    body = fh.read()
            except OSError:
                continue
            if f"{name} wrapper" not in body:
                continue
            if ROOT in body:
                try:
                    os.remove(shim)
                    say(f"removed the {name} command ({shim}).")
                except OSError:
                    pass
            else:
                say(f"{shim} points at a different install — left alone.")


def _remove_desktop_app() -> None:
    """Best-effort removal of the early-preview desktop app (Tauri), installed
    by src/scripts/install/install_desktop.sh|ps1 alongside the TUI. Every branch
    is best-effort and silent on failure — a leftover desktop app is a minor
    annoyance, not worth failing the whole uninstall over."""
    if sys.platform == "darwin":
        for base in ("/Applications", os.path.join(os.path.expanduser("~"), "Applications")):
            for name in _OLD_NAMES:
                app = os.path.join(base, f"{name}.app")
                if os.path.isdir(app):
                    subprocess.run(["osascript", "-e", f'quit app "{name}"'],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    try:
                        shutil.rmtree(app)
                        say(f"removed the desktop app ({app}).")
                    except OSError:
                        say(f"couldn't remove the desktop app ({app}) — delete it manually.")
    elif IS_WINDOWS:
        # Tauri's NSIS template (the installer src/scripts/install/install_desktop.ps1
        # prefers) registers a per-user uninstaller here; run it silently if found.
        # No registry access without pywin32, so this shells out to reg.exe's
        # query output rather than importing winreg's ambiguous 32/64-bit views.
        for name in _OLD_NAMES:
            try:
                key = rf"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{name}"
                result = subprocess.run(["reg", "query", key, "/v", "UninstallString"],
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                if result.returncode == 0:
                    for line in result.stdout.splitlines():
                        if "UninstallString" in line:
                            uninstall_cmd = line.split("REG_SZ", 1)[-1].strip()
                            if uninstall_cmd:
                                subprocess.run(f'{uninstall_cmd} /S', shell=True,
                                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                                say("removed the desktop app.")
                            break
            except OSError:
                pass
    else:
        # Linux: whichever install path install_desktop.sh took.
        home = os.path.expanduser("~")
        removed_any = False
        for name in _OLD_NAMES:
            appdir = os.path.join(home, ".local", "share", name)
            desktop_entry = os.path.join(home, ".local", "share", "applications", f"{name}.desktop")
            symlink = os.path.join(home, ".local", "bin", f"{name}-app")
            for path in (appdir, desktop_entry, symlink):
                if os.path.exists(path) or os.path.islink(path):
                    try:
                        if os.path.isdir(path) and not os.path.islink(path):
                            shutil.rmtree(path)
                        else:
                            os.remove(path)
                        removed_any = True
                    except OSError:
                        pass
        if removed_any:
            say("removed the AppImage-installed desktop app.")
        # Package-manager installs (.deb/.rpm) — best-effort, needs sudo, so
        # just ask rather than silently invoking a privileged command.
        for name in _OLD_NAMES:
            for pkg_mgr, query, remove in (
                ("dpkg", ["dpkg", "-s", name], ["apt-get", "remove", "-y", name]),
                ("rpm", ["rpm", "-q", name], ["dnf", "remove", "-y", name]),
            ):
                if shutil.which(pkg_mgr) and subprocess.run(
                    query, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                ).returncode == 0:
                    say(f"the desktop app is also installed as a system package — remove it with:")
                    say(f"  sudo {' '.join(remove)}")


def main(argv) -> int:
    yes = keep_data = False
    for arg in argv:
        if arg in ("--yes", "-y"):
            yes = True
        elif arg == "--keep-data":
            keep_data = True
        else:
            sys.stderr.write(f"uninstall: unknown option: {arg}\n")
            return 1

    os.chdir(ROOT)

    # 1. Schedule.
    scheduler = os.path.join("src", "scripts", "runtime", "scheduler.py")
    if os.path.isfile(scheduler):
        rc = subprocess.run([sys.executable, scheduler, "uninstall"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
        say("removed the schedule." if rc == 0 else "no schedule installed — skipped.")

    # 2. PATH wrapper — only aplyx's own, pointing here.
    if IS_WINDOWS:
        _remove_windows_wrapper()
    else:
        _remove_unix_wrapper()

    # 2b. The desktop app (early preview, opt-in install — see
    # src/scripts/install/install_desktop.sh|ps1), if present.
    _remove_desktop_app()

    # npm-installed TUI reminder.
    npm = shutil.which("npm")
    if npm:
        detected = subprocess.run([npm, "ls", "-g", "@keshm/aplyx"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if detected:
            say("npm package detected — also run: npm uninstall -g @keshm/aplyx")

    # 3. The install directory (PII).
    if keep_data:
        say(f"kept the install directory ({ROOT}) — delete it later manually.")
        say("done.")
        return 0

    if not yes:
        if sys.stdin.isatty():
            print()
            print("About to permanently delete the install directory and EVERYTHING in it:")
            print(f"  {ROOT}")
            print("This includes your live config, application history and resumes (data/), and logs.")
            try:
                reply = input("Delete it? [y/N] ").strip()
            except EOFError:
                reply = ""
            if reply not in ("y", "Y"):
                say(f"kept the install directory ({ROOT}). Re-run with --yes when ready.")
                say("done.")
                return 0
        else:
            say(f"non-interactive and no --yes: keeping the install directory ({ROOT}).")
            say("done.")
            return 0

    os.chdir(os.path.abspath(os.sep))
    shutil.rmtree(ROOT, onerror=_remove_readonly)
    print(f"uninstall: removed {ROOT}. aplyx is uninstalled.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
