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
  scheduler.py plist       # macOS: print the plist (dry run)
"""

from __future__ import annotations

import os
import subprocess
import sys

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
</dict>
</plist>
"""


def _mac_install() -> int:
    plist = _plist_path()
    os.makedirs(os.path.dirname(plist), exist_ok=True)
    os.makedirs(os.path.join(PROJECT_ROOT, "logs"), exist_ok=True)
    with open(plist, "w", encoding="utf-8") as fh:
        fh.write(_plist_body())
    subprocess.run(["plutil", "-lint", plist], stdout=subprocess.DEVNULL, check=True)
    uid = os.getuid()  # type: ignore[attr-defined]
    for label, old_plist in zip(OLD_LABELS, _old_plist_paths()):
        subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            os.remove(old_plist)
        except OSError:
            pass
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", plist], check=True)
    print(f"scheduler: installed {LABEL} (every {INTERVAL // 60} min, 24/7).")
    print("scheduler: NOTE — RunAtLoad is true: a run starts now.")
    return 0


def _mac_uninstall() -> int:
    uid = os.getuid()  # type: ignore[attr-defined]
    for label in (LABEL, *OLD_LABELS):
        subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for p in (_plist_path(), *_old_plist_paths()):
        try:
            os.remove(p)
        except OSError:
            pass
    print(f"scheduler: uninstalled {LABEL}.")
    return 0


def _mac_status() -> int:
    uid = os.getuid()  # type: ignore[attr-defined]
    loaded = subprocess.run(["launchctl", "print", f"gui/{uid}/{LABEL}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
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


def _win_status() -> int:
    loaded = subprocess.run(["schtasks", "/Query", "/TN", TASK_NAME],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    print(f"scheduler: task '{TASK_NAME}' is {'registered' if loaded else 'NOT registered'}.")
    _print_heartbeat()
    return 0


# ---------------------------------------------------------------- shared -----
def _print_heartbeat() -> None:
    hb = os.path.join(PROJECT_ROOT, "logs", "heartbeat.json")
    if os.path.isfile(hb):
        print("heartbeat:")
        with open(hb, "r", encoding="utf-8") as fh:
            print(fh.read().rstrip())
    else:
        print("heartbeat: none yet (no completed runs).")


def _linux_note() -> int:
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
        return _mac_status() if is_mac else _win_status() if is_win else _linux_note()

    sys.stderr.write("usage: scheduler.py install|uninstall|status|plist\n")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
