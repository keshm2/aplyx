#!/usr/bin/env python3
"""scheduler.py — cross-platform 30-minute schedule management.

Ported from scheduler.sh. Manages an always-on ~30-minute schedule that runs
the job agent 24/7. Overlap protection lives in the runner itself; the
scheduler only supplies cadence.

  - macOS:   launchd user agent (label com.aplyx.job-agent)
  - Windows: Task Scheduler task (name aplyx-job-agent) via schtasks
  - Linux:   prints the systemd user timer to install by hand

Usage:
  scheduler.py install     # register + start (a run starts now on macOS)
  scheduler.py uninstall   # remove the schedule
  scheduler.py status      # schedule state + heartbeat
  scheduler.py status --json  # same, machine-readable (Home dashboard widget)
  scheduler.py plist       # macOS: print the plist (dry run)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
LABEL = "com.aplyx.job-agent"
OLD_LABELS = ("com.flux.job-agent", "com.ares.job-agent")
TASK_NAME = "aplyx-job-agent"
INTERVAL = int(os.environ.get("APLYX_SCHEDULE_INTERVAL_SEC",
               os.environ.get("FLUX_SCHEDULE_INTERVAL_SEC",
               os.environ.get("ARES_SCHEDULE_INTERVAL_SEC", "1800"))) or "1800")


# ---------------------------------------------------------------- macOS ------
def _plist_path() -> str:
    return os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents", f"{LABEL}.plist")


def _old_plist_paths() -> list[str]:
    return [os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents", f"{label}.plist")
            for label in OLD_LABELS]


def _launchd_path() -> str:
    """PATH to bake into the plist. launchd's own default environment for a
    GUI agent is a bare `/usr/bin:/bin:/usr/sbin:/sbin` — none of opencode,
    claude, codex, or copilot live there (they're typically under
    ~/.opencode/bin, a global npm prefix, Homebrew, etc., all only on the
    PATH your interactive shell builds via .zshrc/.bash_profile). Without
    this, `scheduler.py install` "succeeds" but every scheduled run crashes
    immediately with FileNotFoundError on the harness binary — silent until
    someone reads logs/launchd.err.log. Capturing the *installing* shell's
    own PATH (already proven to resolve the harness, or install couldn't
    have been run from it) and writing it into the plist is the general
    fix — not a hardcoded guess at where any particular harness lives."""
    return os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")


def _plist_body() -> str:
    runner = os.path.join(PROJECT_ROOT, "src", "scripts", "runtime", "run_job_agent.sh")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>{runner}</string>
  </array>
  <key>WorkingDirectory</key><string>{PROJECT_ROOT}</string>
  <key>StartInterval</key><integer>{INTERVAL}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{PROJECT_ROOT}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>{PROJECT_ROOT}/logs/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{_launchd_path()}</string>
  </dict>
</dict>
</plist>
"""


def _launchd_loaded(uid: int, label: str) -> bool:
    return subprocess.run(["launchctl", "print", f"gui/{uid}/{label}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def _bootout_and_verify(uid: int, label: str, attempts: int = 10, poll_interval: float = 0.5) -> bool:
    """`launchctl bootout` can return before a *live* job has actually torn
    down — reproduced live: toggling the scheduler off while a real scrape/
    apply session is mid-flight, bootout returns success immediately, but
    `launchctl print` still shows the job loaded (its process — run_job_
    agent.py, still running opencode — hasn't finished dying yet; SIGTERM
    reaches it correctly, but a live harness can take a few seconds to
    actually exit). The old code trusted bootout's immediate return and
    reported "uninstalled" regardless, then deleted the plist — leaving an
    orphaned, still-loaded launchd registration with no plist backing it.
    The next `install` call's `bootstrap` then failed outright ("Bootstrap
    failed: 5: Input/output error", a real launchd error for "a job with
    this label is already loaded") — surfacing to the UI as a toggle that
    visually flips on click, then silently reverts, over and over, exactly
    the "have to spam click it" symptom this was reported as. Polling
    bootout+print until the job is verifiably gone (or genuinely exhausting
    attempts) makes both install and uninstall tell the truth about what
    actually happened instead of guessing."""
    for _ in range(attempts):
        subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not _launchd_loaded(uid, label):
            return True
        time.sleep(poll_interval)
    return not _launchd_loaded(uid, label)


def _mac_install() -> int:
    plist = _plist_path()
    os.makedirs(os.path.dirname(plist), exist_ok=True)
    os.makedirs(os.path.join(PROJECT_ROOT, "logs"), exist_ok=True)
    with open(plist, "w", encoding="utf-8") as fh:
        fh.write(_plist_body())
    subprocess.run(["plutil", "-lint", plist], stdout=subprocess.DEVNULL, check=True)
    uid = os.getuid()  # type: ignore[attr-defined]
    for label, old_plist in zip(OLD_LABELS, _old_plist_paths()):
        _bootout_and_verify(uid, label)
        try:
            os.remove(old_plist)
        except OSError:
            pass
    # Clear any stale/orphaned registration for our own label first (see
    # _bootout_and_verify's docstring) — bootstrap fails outright if one is
    # still live, and this is exactly how that happens in practice: a prior
    # uninstall that didn't fully land before the app (or user) tried to
    # turn it back on again.
    if not _bootout_and_verify(uid, LABEL):
        sys.stderr.write(
            f"scheduler: a stale {LABEL} registration would not clear — "
            "its previous process may still be shutting down. Try again "
            "in a few seconds.\n"
        )
        return 1
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", plist],
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        # No check=True: an uncaught CalledProcessError here used to crash
        # with a raw Python traceback on stderr — which the JS bridge still
        # treated as a rejected promise, but with no clean error message to
        # show, just a stack trace. A clear one-line message + a real exit
        # code lets the UI surface something a user can actually read.
        sys.stderr.write(f"scheduler: bootstrap failed: {r.stderr.strip()}\n")
        return 1
    print(f"scheduler: installed {LABEL} (every {INTERVAL // 60} min, 24/7).")
    print("scheduler: NOTE — RunAtLoad is true: a run starts now.")
    return 0


def _mac_uninstall() -> int:
    uid = os.getuid()  # type: ignore[attr-defined]
    ok = True
    for label in (LABEL, *OLD_LABELS):
        if not _bootout_and_verify(uid, label):
            ok = False
    for p in (_plist_path(), *_old_plist_paths()):
        try:
            os.remove(p)
        except OSError:
            pass
    if not ok:
        sys.stderr.write(
            f"scheduler: {LABEL} still appears loaded — its process may "
            "still be shutting down a live run. It will finish on its own; "
            "try again in a few seconds if it still shows as running.\n"
        )
        return 1
    print(f"scheduler: uninstalled {LABEL}.")
    return 0


def _mac_installed() -> bool:
    return _launchd_loaded(os.getuid(), LABEL)  # type: ignore[attr-defined]


def _mac_status(json_mode: bool) -> int:
    loaded = _mac_installed()
    if json_mode:
        return _print_status_json(loaded)
    print(f"scheduler: {LABEL} is {'loaded' if loaded else 'NOT loaded'}"
          f"{f' (interval {INTERVAL // 60} min)' if loaded else ''}.")
    _print_heartbeat()
    return 0


# -------------------------------------------------------------- Windows ------
def _win_runner_cmd() -> str:
    runner = os.path.join(PROJECT_ROOT, "src", "scripts", "runtime", "run_job_agent.py")
    return f'"{sys.executable}" "{runner}"'


def _win_install() -> int:
    os.makedirs(os.path.join(PROJECT_ROOT, "logs"), exist_ok=True)
    for old_task in ("flux-job-agent", "ares-job-agent"):
        subprocess.run(["schtasks", "/Delete", "/TN", old_task, "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    r = subprocess.run(
        ["schtasks", "/Create", "/TN", TASK_NAME, "/TR", _win_runner_cmd(),
         "/SC", "MINUTE", "/MO", str(max(1, INTERVAL // 60)), "/F"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    if r.returncode != 0:
        sys.stderr.write(f"scheduler: schtasks create failed: {r.stderr.strip()}\n")
        return 1
    print(f"scheduler: installed scheduled task '{TASK_NAME}' (every {max(1, INTERVAL // 60)} min).")
    return 0


def _win_uninstall() -> int:
    for task in (TASK_NAME, "flux-job-agent", "ares-job-agent"):
        subprocess.run(["schtasks", "/Delete", "/TN", task, "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"scheduler: uninstalled scheduled task '{TASK_NAME}'.")
    return 0


def _win_installed() -> bool:
    return subprocess.run(["schtasks", "/Query", "/TN", TASK_NAME],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def _win_status(json_mode: bool) -> int:
    loaded = _win_installed()
    if json_mode:
        return _print_status_json(loaded)
    print(f"scheduler: task '{TASK_NAME}' is {'registered' if loaded else 'NOT registered'}.")
    _print_heartbeat()
    return 0


# ---------------------------------------------------------------- shared -----
def _read_heartbeat() -> dict | None:
    hb = os.path.join(PROJECT_ROOT, "logs", "heartbeat.json")
    if not os.path.isfile(hb):
        return None
    try:
        with open(hb, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def _print_heartbeat() -> None:
    heartbeat = _read_heartbeat()
    if heartbeat is not None:
        print("heartbeat:")
        print(json.dumps(heartbeat, indent=2))
    else:
        print("heartbeat: none yet (no completed runs).")


def _print_status_json(installed: bool) -> int:
    print(json.dumps({
        "installed": installed,
        "supported": True,
        "interval_min": INTERVAL // 60,
        "heartbeat": _read_heartbeat(),
    }))
    return 0


def _linux_note(json_mode: bool = False) -> int:
    if json_mode:
        print(json.dumps({
            "installed": False,
            "supported": False,
            "interval_min": INTERVAL // 60,
            "heartbeat": _read_heartbeat(),
        }))
        return 0
    minutes = INTERVAL // 60
    sys.stderr.write(
        "scheduler: no built-in Linux scheduler — install a systemd user timer "
        f"running src/scripts/runtime/run_job_agent.sh every {minutes} min "
        "(APLYX_SCHEDULE_INTERVAL_SEC). See docs/SETUP.md section 5.\n"
    )
    return 1


def main(argv) -> int:
    cmd = argv[0] if argv else ""
    is_mac = sys.platform == "darwin"
    is_win = os.name == "nt"

    if cmd == "plist":
        if is_mac:
            print(_plist_body(), end="")
            return 0
        sys.stderr.write("scheduler: 'plist' is macOS-only.\n")
        return 1
    if cmd == "install":
        return _mac_install() if is_mac else _win_install() if is_win else _linux_note()
    if cmd == "uninstall":
        # uninstall is best-effort on every OS so cleanup never fails hard.
        if is_mac:
            return _mac_uninstall()
        if is_win:
            return _win_uninstall()
        return 0
    if cmd == "status":
        json_mode = "--json" in argv[1:]
        return _mac_status(json_mode) if is_mac else _win_status(json_mode) if is_win else _linux_note(json_mode)

    sys.stderr.write("usage: scheduler.py install|uninstall|status|plist\n")
    sys.stderr.write("       scheduler.py status --json   # machine-readable\n")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
