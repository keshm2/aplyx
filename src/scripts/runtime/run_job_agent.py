#!/usr/bin/env python3
"""Job application agent: cross-platform entry point.

Canonical runner logic, ported from run_job_agent.sh so it runs natively on
Windows (PowerShell / cmd.exe) as well as macOS/Linux. run_job_agent.sh is a
thin shim that execs this file, so Unix cron/launchd keep working unchanged.

Responsibilities (identical to the shell version):
  - load persisted src/config/env.json overrides (APLYX_*/FLUX_*/ARES_* only; real env wins)
  - auto-update via update.py --auto (fail-open), re-exec on update
  - single-flight lock with stale/hung reclaim
  - config validation, state-file bootstrap, agent-definition drift check
  - harness selection (opencode|claude|codex|copilot) + degraded path
  - run the harness, snapshot outcome deltas, write heartbeat, retain logs

Log line formats (parsed by the TUI/heartbeat) are preserved verbatim.
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

# Sibling import: the runner is invoked as a path (`python3
# src/scripts/runtime/run_job_agent.py`) from the repo root, not as a package, so
# its own directory isn't guaranteed to be on sys.path under every harness.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_adapter  # noqa: E402

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.chdir(PROJECT_ROOT)
IS_WINDOWS = os.name == "nt"

# --- Stop-run support (POSIX only) ------------------------------------------
# Contract with the TUI (src/tui/src/ui/RunScreen.tsx + src/tui/src/platform.ts):
#   - POSIX: the TUI sends a real SIGTERM to *this* process (its direct Node
#     child), nothing else. _handle_stop_signal below kills the harness's
#     whole process group (started via start_new_session=True below so it's
#     a separate group from ours) and lets control return normally through
#     _run()'s existing lock-release path.
#   - Windows: the TUI does NOT rely on Python signal handling; Windows
#     doesn't deliver real POSIX signals through Node's child_process.kill(),
#     it just force-terminates. Instead the TUI shells out to
#     `taskkill /PID <this pid> /T /F` itself, killing the whole tree
#     (Python + harness + descendants) from the outside in one shot. This is
#     a known, accepted platform limitation: our signal handler will likely
#     never get a chance to run gracefully on Windows. Safety there comes
#     from the already-atomic state writes (tempfile + os.replace, see
#     write_heartbeat.py / append_state_entry.py) and acquire_lock()'s
#     existing stale-holder-PID self-heal on the next run attempt, not from
#     anything in this file.
_harness_proc = None  # subprocess.Popen | None (set while the harness runs)
_stop_requested = False  # set by _handle_stop_signal on SIGTERM/SIGINT
_stop_signum = None  # the signal number that triggered the stop, if any
_lock_dir = None  # set in main() before the harness starts; lets a *different*
# process (one reclaiming a stale lock left by this one) find this run's
# harness pid on disk; see _run_harness_cmd's harness_pid file and
# _kill_stale_harness below.


def now_local() -> str:
    # Mirrors bash `date` (local time, ctime-like) used in RUN_LOG prefixes.
    return datetime.now().strftime("%a %b %d %H:%M:%S %Y")


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(run_log: str, msg: str) -> None:
    with open(run_log, "a", encoding="utf-8") as fh:
        fh.write(f"[{now_local()}] {msg}\n")


def debug_logging_enabled() -> bool:
    return os.environ.get("APLYX_DEBUG_LOGGING", os.environ.get("FLUX_DEBUG_LOGGING", "0")) == "1"


def debug_log(logs_dir: str, msg: str) -> None:
    """Separate, opt-in debug log (Settings > Preferences > Debug logging,
    default off): internal orchestration detail (harness selection, the
    exact command argv, session-cap resolution, timing) that isn't part of
    the always-on session_*.log (the harness's own transcript, which
    RunScreen's live tail and StatusScreen's "last run" both depend on) or
    run_job_agent.log (the always-on scheduler-health log). Neither of
    those is touched by this toggle; this only adds a third, optional
    file for troubleshooting a specific run, never removes one anything
    else relies on."""
    if not debug_logging_enabled():
        return
    path = os.path.join(logs_dir, "debug.log")
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"[{now_local()}] {msg}\n")


def env_truthy(*names_defaults) -> str:
    for name, default in names_defaults:
        v = os.environ.get(name)
        if v is not None:
            return v
    return names_defaults[-1][1]


def load_env_overrides() -> None:
    """src/config/env.json → environment, honoring only APLYX_*/FLUX_*/ARES_* keys
    (older rebrands' names carried forward so a persisted override never
    silently stops applying) and never overriding a variable already present
    in the real environment."""
    path = os.path.join("src", "config", "env.json")
    if not os.path.isfile(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(data, dict):
        return
    import re

    key_re = re.compile(r"^(APLYX|FLUX|ARES)_[A-Z_]+$")
    for k, v in data.items():
        if not key_re.match(k):
            continue
        if v is None or v == "":
            continue
        if os.environ.get(k):  # real env (non-empty) wins
            continue
        os.environ[k] = str(v)


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if IS_WINDOWS:
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return False
        finally:
            kernel32.CloseHandle(handle)
    else:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True


def kill_pid(pid: int) -> None:
    try:
        if IS_WINDOWS:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            os.kill(pid, 15)
            time.sleep(5)
            try:
                os.kill(pid, 9)
            except OSError:
                pass
    except OSError:
        pass


def py_run(args, **kw):
    """Run a bundled Python helper under the current interpreter."""
    return subprocess.run([sys.executable, *args], **kw)


# Mirrors check_postings_open.py's own MIN_HOURS_BETWEEN_RUNS; kept in sync
# by hand since it's a small, rarely-changed constant; see
# _postings_check_due for why this duplication is worth it.
POSTINGS_CHECK_MIN_HOURS = 20


def _postings_check_due(state_path: str, min_hours: float) -> bool:
    """Peek at check_postings_open.py's own throttle stamp before spawning
    it at all: avoids a full Python interpreter start on the ~47-of-48
    daily ticks where it would just read the same stamp and no-op anyway.
    Errs toward True (spawn it) whenever the stamp is missing or
    unparseable; check_postings_open.py's own internal throttle stays the
    real authority; this is purely an optimization to skip the subprocess,
    never a second, independently-drifting throttle policy."""
    try:
        with open(state_path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return True
    last = state.get("last_run_at")
    if not last:
        return True
    try:
        last_dt = datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    return (datetime.now(timezone.utc) - last_dt).total_seconds() >= min_hours * 3600


def _terminate_group(pgid: int, is_alive, grace_sec: float = 5.0) -> None:
    """Shared TERM-then-wait-then-KILL sequence for a whole process group.

    POSIX only. `is_alive` is a zero-arg callable so the two call sites can
    check liveness their own way: _kill_harness_group has a live Popen
    handle and can just poll() it; _kill_stale_harness only has a pid read
    back off disk (a different process wrote it) and has to ask the OS via
    pid_alive(). Same shape as kill_pid()'s single-pid version, applied to
    a whole group via os.killpg instead of a single pid via os.kill.
    """
    try:
        os.killpg(pgid, signal.SIGTERM)
    except OSError:
        # ProcessLookupError: group already gone. PermissionError: also
        # possible in practice (observed in testing) if the group died
        # between the caller's own lookup and killpg() and the now-unused
        # pgid was recycled for an unrelated process; either way, nothing
        # left of ours to signal.
        return
    deadline = time.time() + grace_sec
    while time.time() < deadline:
        if not is_alive():
            return
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass


def _kill_harness_group(grace_sec: float = 5.0) -> None:
    """Terminate the harness's whole process group.

    POSIX only: the harness Popen is started with start_new_session=True
    precisely so it (and everything it shells out to: bash, curl,
    Playwright/browser) lives in its own process group, separate from this
    process's own group.
    """
    if _harness_proc is None or IS_WINDOWS:
        return
    try:
        pgid = os.getpgid(_harness_proc.pid)
    except OSError:  # ProcessLookupError: already gone
        return
    _terminate_group(pgid, lambda: _harness_proc.poll() is None, grace_sec)


def _kill_stale_harness(lock_dir: str, run_log: str) -> None:
    """Kill an orphaned harness left behind by a stale/dead runner.

    POSIX only (on Windows, kill_pid()'s `taskkill /PID <runner> /T /F`
    already recurses the whole process tree, since the harness there isn't
    split into a separate session; see the module-level comment near
    IS_WINDOWS). On POSIX, the harness deliberately runs in its own process
    group (start_new_session=True in _run_harness_cmd) so the live
    in-process stop-signal path can kill just the harness without touching
    the runner, but that same split means killing the *runner's* pid alone
    (kill_pid(old_pid), used when reclaiming a stale lock) never reaches the
    harness. Without this, a stale-lock reclaim (whether the old runner is
    simply dead or was force-killed for being wedged) leaves a real harness
    (potentially mid-Playwright-click on a real application's Submit button)
    running unsupervised while a new run starts under a freshly acquired
    lock: two runs racing the same job boards and state files, and a
    real-world submission that may complete with no run left alive to record
    it. The harness's own pid is persisted to lock_dir/harness_pid by
    _run_harness_cmd while it runs, precisely so a *different* process (this
    one, reclaiming someone else's lock) has a way to find it: the
    in-memory _harness_proc global only exists inside the process that
    started it.
    """
    if IS_WINDOWS:
        return
    pid_file = os.path.join(lock_dir, "harness_pid")
    try:
        with open(pid_file, "r", encoding="utf-8") as fh:
            harness_pid = int((fh.read().strip() or "0"))
    except (OSError, ValueError):
        return
    if not harness_pid or not pid_alive(harness_pid):
        return
    log(run_log, f"stale_harness_killed: reclaimed lock left harness pid {harness_pid} "
                 f"running unsupervised; killing its process group")
    _terminate_group(harness_pid, lambda: pid_alive(harness_pid))


def _handle_stop_signal(signum, frame):  # noqa: ARG001 - frame required by signal API
    """SIGTERM/SIGINT handler: request a stop and kill the harness group.

    Deliberately does NOT call sys.exit() or attempt to run the rest of
    _run()'s normal post-processing (Discord summary, etc.) from inside the
    handler: it just flags the stop and kills the subprocess tree, then
    lets control fall back out of the (now-dead) Popen.wait() in
    _run_harness_cmd and continue through _run()'s normal return path, so
    the existing `finally: shutil.rmtree(lock_dir, ...)` in main() still
    releases the lock correctly.
    """
    global _stop_requested, _stop_signum
    _stop_requested = True
    _stop_signum = signum
    _kill_harness_group()


def _run_harness_cmd(cmd, out) -> int:
    """Launch the harness CLI and wait for it, tracking it for stop support.

    POSIX: start_new_session=True puts the harness (and everything it
    spawns) into a new process group separate from ours, so
    _kill_harness_group() can kill that whole group without touching this
    process. Windows: plain Popen; Windows has no equivalent primitive, and
    per the stop-support contract the Windows TUI kills the whole tree from
    outside via `taskkill /T /F` instead of relying on Python-side signal
    handling (see the module-level comment near IS_WINDOWS).
    """
    global _harness_proc
    # Uses harness_env(), not the bare inherited environment. The harness's
    # own children (opencode spawning `npx @playwright/mcp@latest` for its
    # MCP server, say) need a real PATH too, not just this process finding
    # the harness executable. See harness_env()'s docstring for why.
    popen_kwargs = {"stdout": out, "stderr": subprocess.STDOUT, "env": harness_adapter.harness_env()}
    if not IS_WINDOWS:
        popen_kwargs["start_new_session"] = True
    proc = subprocess.Popen(cmd, **popen_kwargs)
    _harness_proc = proc
    harness_pid_file = os.path.join(_lock_dir, "harness_pid") if (_lock_dir and not IS_WINDOWS) else None
    if harness_pid_file:
        try:
            with open(harness_pid_file, "w", encoding="utf-8") as fh:
                fh.write(str(proc.pid))
        except OSError:
            pass
    rc = proc.wait()
    _harness_proc = None
    if harness_pid_file:
        try:
            os.remove(harness_pid_file)
        except OSError:
            pass
    return rc


def main() -> int:
    load_env_overrides()

    logs_dir = os.environ.get("APLYX_LOG_DIR", os.environ.get("FLUX_LOG_DIR", "logs"))
    os.makedirs("data", exist_ok=True)
    os.makedirs(logs_dir, exist_ok=True)
    os.makedirs("logs", exist_ok=True)
    # Per-run fetch scratch (AGENTS.md): raw dumps here, not in the transcript.
    shutil.rmtree(os.path.join("logs", "tmp"), ignore_errors=True)
    os.makedirs(os.path.join("logs", "tmp"), exist_ok=True)

    run_log = os.path.join(logs_dir, "run_job_agent.log")
    run_start = datetime.now()
    if debug_logging_enabled():
        env_snapshot = {k: v for k, v in sorted(os.environ.items()) if k.startswith(("APLYX_", "FLUX_", "ARES_"))}
        debug_log(logs_dir, f"run starting; resolved env: {json.dumps(env_snapshot)}")

    # --- Auto-update (fail-open) --------------------------------------------
    auto_update = os.environ.get("APLYX_AUTO_UPDATE", os.environ.get("FLUX_AUTO_UPDATE", os.environ.get("ARES_AUTO_UPDATE", "1")))
    if auto_update != "0" and os.environ.get("APLYX_SKIP_UPDATE", os.environ.get("FLUX_SKIP_UPDATE")) != "1":
        update_result = ""
        try:
            with open(run_log, "a", encoding="utf-8") as errfh:
                p = py_run([os.path.join("src", "scripts", "install", "update.py"), "--auto"],
                           stdout=subprocess.PIPE, stderr=errfh, text=True)
            lines = [ln for ln in (p.stdout or "").splitlines() if ln.strip()]
            update_result = lines[-1] if lines else ""
        except OSError:
            update_result = ""
        log(run_log, update_result)
        if update_result.startswith("update: updated"):
            log(run_log, "re-executing updated runner")
            os.environ["APLYX_SKIP_UPDATE"] = "1"
            # os.path.abspath(__file__) was resolved when THIS process
            # started, before the update above ran: if that update moved
            # this very script (as the 2026-07-29 src/ restructure did for
            # every pre-existing install, moving scripts/ -> src/scripts/),
            # this path may no longer exist on disk, and os.execv raises
            # FileNotFoundError for a missing target. That must never
            # crash an otherwise-successful scheduled run: catch it, log a
            # clear pointer to the one reliable fix (re-running the
            # installer, a fresh process every time and immune to this
            # exact staleness problem), and fall through to finish this
            # run with whatever code is already loaded in memory; the
            # files on disk are already correctly updated; only this
            # process's own re-exec of itself is what's stale.
            try:
                os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)])
            except OSError as exc:
                log(run_log, f"WARNING: could not re-exec the updated runner ({exc}); "
                              "continuing this run with already-loaded code. If this "
                              "keeps happening, re-run the installer to repair the install "
                              "(see docs/SETUP.md).")

    # --- Single-flight lock --------------------------------------------------
    lock_dir = os.path.join(logs_dir, ".run_job_agent.lock")
    lock_pid_file = os.path.join(lock_dir, "pid")
    lock_max_age_min = int(os.environ.get("APLYX_LOCK_MAX_AGE_MIN", os.environ.get("FLUX_LOCK_MAX_AGE_MIN",
                            os.environ.get("ARES_LOCK_MAX_AGE_MIN", "60"))) or "60")

    global _lock_dir
    _lock_dir = lock_dir

    def lock_age_min() -> int:
        try:
            mtime = os.path.getmtime(lock_dir)
        except OSError:
            mtime = time.time()
        return int((time.time() - mtime) / 60)

    def write_pid():
        with open(lock_pid_file, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))

    def acquire_lock() -> bool:
        try:
            os.mkdir(lock_dir)  # atomic
            write_pid()
            return True
        except FileExistsError:
            pass
        try:
            with open(lock_pid_file, "r", encoding="utf-8") as fh:
                old_pid = int((fh.read().strip() or "0"))
        except (OSError, ValueError):
            old_pid = 0
        if old_pid and not pid_alive(old_pid):
            log(run_log, f"stale_lock_reclaimed: holder pid {old_pid} is dead")
            # The runner died, but if it had a harness running (Playwright,
            # mid-apply), that harness lives in its own process group and
            # does not die with the runner; check for it explicitly rather
            # than assuming "runner dead" means "nothing left running".
            _kill_stale_harness(lock_dir, run_log)
            shutil.rmtree(lock_dir, ignore_errors=True)
        elif old_pid:
            age = lock_age_min()
            if age >= lock_max_age_min:
                log(run_log, f"stale_lock_reclaimed: holder pid {old_pid} alive but lock is "
                             f"{age}min old (threshold {lock_max_age_min}min); terminating")
                kill_pid(old_pid)
                _kill_stale_harness(lock_dir, run_log)
                shutil.rmtree(lock_dir, ignore_errors=True)
            else:
                return False
        else:
            return False
        try:
            os.mkdir(lock_dir)
            write_pid()
            return True
        except FileExistsError:
            return False

    if not acquire_lock():
        log(run_log, f"skipped_overlap: another run is already in progress "
                     f"(lock: {lock_dir}, age {lock_age_min()}min)")
        return 0

    try:
        return _run(logs_dir, run_log, run_start)
    finally:
        shutil.rmtree(lock_dir, ignore_errors=True)


def _count_outcomes():
    counts = {"applied": 0, "needs_review": 0, "failed": 0}
    try:
        with open(os.path.join("data", "applied_jobs.json"), "r", encoding="utf-8") as fh:
            arr = json.load(fh)
        for el in arr if isinstance(arr, list) else []:
            st = el.get("status") if isinstance(el, dict) else None
            if st in counts:
                counts[st] += 1
    except (OSError, json.JSONDecodeError):
        pass
    return counts


def _count_skipped_unfit() -> int:
    n = 0
    try:
        with open(os.path.join("data", "job_events.jsonl"), "r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    if json.loads(line).get("status") == "skipped_unfit":
                        n += 1
                except json.JSONDecodeError:
                    if '"status": "skipped_unfit"' in line or '"status":"skipped_unfit"' in line:
                        n += 1
    except OSError:
        pass
    return n


def _run(logs_dir: str, run_log: str, run_start: datetime) -> int:
    # --- Config validation ---------------------------------------------------
    if py_run([os.path.join("src", "scripts", "validate", "validate_local_config.py"), PROJECT_ROOT]).returncode != 0:
        log(run_log, "ABORTED: local config validation failed. Run manually to fix.")
        return 1

    # --- Ensure persistent state files --------------------------------------
    for f in ("data/applied_jobs.json", "data/review_queue.json"):
        if py_run([os.path.join("src", "scripts", "state", "append_state_entry.py"), "ensure", f]).returncode != 0:
            log(run_log, f"ABORTED: failed to ensure {f}. Run manually to fix.")
            return 1

    if py_run([os.path.join("src", "scripts", "state", "job_state.py"), "ensure-files"]).returncode != 0:
        log(run_log, "ABORTED: failed to ensure canonical registry/event files. Run manually to fix.")
        return 1

    # Interest-letter store. A warning, not an abort: a run that can't read it
    # simply never parks a job for an essay question, which is degraded but
    # safe: the apply loop's own rule still forbids inventing an answer.
    if py_run([os.path.join("src", "scripts", "state", "interest_letter.py"), "ensure-file"]).returncode != 0:
        log(run_log, "WARNING: could not ensure data/interest_letters.json; "
                     "interest-letter parking will be unavailable this run.")

    # Lightweight direct closed/expired posting check: deterministic,
    # non-LLM, self-throttled to roughly once/day internally (see
    # check_postings_open.py's own docstring). _postings_check_due peeks at
    # its throttle stamp first so the ~47-of-48 daily ticks that would just
    # no-op skip the interpreter spawn entirely rather than paying startup
    # cost for nothing. Best-effort: a network hiccup here must never abort
    # or slow down the real run.
    if _postings_check_due(os.path.join("data", "postings_check_state.json"), POSTINGS_CHECK_MIN_HOURS):
        check_postings_proc = py_run(
            [os.path.join("src", "scripts", "jobs", "check_postings_open.py")],
            stderr=subprocess.PIPE, text=True,
        )
        if check_postings_proc.stderr:
            log(run_log, check_postings_proc.stderr.strip())

    if py_run([os.path.join("src", "scripts", "validate", "generate_agent_definitions.py"), "--check"]).returncode != 0:
        log(run_log, "WARNING: generated agent definitions are stale; run src/scripts/validate/generate_agent_definitions.py")

    # --- Harness selection ---------------------------------------------------
    harness = os.environ.get("APLYX_HARNESS", os.environ.get("FLUX_HARNESS", os.environ.get("ARES_HARNESS", ""))) or ""
    if not harness and os.path.isfile(os.path.join("src", "config", "harness.json")):
        try:
            with open(os.path.join("src", "config", "harness.json"), "r", encoding="utf-8") as fh:
                harness = (json.load(fh).get("harness") or "")
        except (OSError, json.JSONDecodeError):
            harness = ""
    if not harness:
        for candidate in ("opencode", "claude", "codex", "copilot"):
            if shutil.which(candidate) or harness_adapter.resolve_harness_exe(candidate) != candidate:
                harness = candidate
                break
    if harness not in ("opencode", "claude", "codex", "copilot"):
        if not harness:
            log(run_log, "ABORTED: no supported harness found (opencode, claude, codex, or copilot). "
                         "Install one or set src/config/harness.json.")
        else:
            log(run_log, f"ABORTED: unsupported harness '{harness}' (supported: opencode, claude, codex, copilot).")
        return 1
    debug_log(logs_dir, f"harness resolved: {harness}")

    before = _count_outcomes()
    before_skipped = _count_skipped_unfit()

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    session_log = os.path.join(logs_dir, f"session_{timestamp}.log")
    with open(session_log, "a", encoding="utf-8") as fh:
        fh.write(f"run_job_agent: start {now_utc()} harness={harness}\n")
        # Seed the first progress marker deterministically rather than relying
        # on the orchestrator to print it. src/agents/bodies/job-scraper.md asks
        # for `[•] Scraping job boards` as the run's first line, but a model
        # can and does forget: a real 794-line session emitted nothing until
        # line 428, so the TUI could not name the phase for the first half of
        # the run and showed a bare "run in progress…". Scrape is always
        # phase 1, and this line is written before the harness is invoked, so
        # it is true by construction. The agent's own `[✓] Scraping job
        # boards` later supersedes it.
        fh.write("[•] Scraping job boards\n")

    # --- Session cap ---------------------------------------------------------
    raw_cap = os.environ.get("APLYX_SESSION_CAP", os.environ.get("FLUX_SESSION_CAP", os.environ.get("ARES_SESSION_CAP", "25"))) or "25"
    if not raw_cap.isdigit():
        log(run_log, f"WARNING: APLYX_SESSION_CAP='{raw_cap}' is not an integer; using default 25")
        session_cap = 25
    else:
        session_cap = int(raw_cap)
        if session_cap > 25:
            log(run_log, f"WARNING: APLYX_SESSION_CAP={session_cap} exceeds the maximum; clamping to 25")
            session_cap = 25
        elif session_cap < 1:
            log(run_log, f"WARNING: APLYX_SESSION_CAP={session_cap} is below 1; using default 25")
            session_cap = 25
    debug_log(logs_dir, f"session cap resolved: raw={raw_cap!r} -> {session_cap}")

    # --- Scrape-only mode -----------------------------------------------------
    # Grows data/job_registry.json (scrape + dedupe + deterministic fit-gate)
    # without risking a real application going out; useful for refreshing the
    # recommended-jobs pool on demand, independent of whether the operator is
    # ready to let the scheduler apply unattended. src/agents/bodies/job-scraper.md
    # "Scrape-only mode" is the canonical instruction this line triggers.
    scrape_only_raw = os.environ.get("APLYX_SCRAPE_ONLY", "") or ""
    scrape_only = scrape_only_raw.strip().lower() not in ("", "0", "false", "no")

    if scrape_only:
        run_prompt = (
            "Start a SCRAPE-ONLY job run (see 'Scrape-only mode' in job-scraper.md).\n"
            "   Read AGENTS.md, load data/applied_jobs.json and src/config/targets.json,\n"
            "   scrape all configured job boards, deduplicate, and run the deterministic\n"
            "   fit gate on every new job so data/job_registry.json is up to date. Stop\n"
            "   after Phase 1: do NOT tailor a resume, do NOT open or fill out any\n"
            "   application, do NOT submit anything, and do NOT send a Discord application\n"
            "   summary. Skip Phase 2 (tailor), Phase 3 (apply), and Phase 4's application\n"
            "   report entirely. Print a short local summary of how many jobs were found\n"
            "   as candidate / needs_review / skipped_unfit this run, then stop."
        )
        log(run_log, "APLYX_SCRAPE_ONLY set: running Phase 1 (scrape + fit-gate) only, no applications this run")
    else:
        run_prompt = (
            "Start a new job application run. Read AGENTS.md, load data/applied_jobs.json\n"
            "   and src/config/targets.json, scrape all configured job boards, deduplicate,\n"
            f"   tailor and apply to at most {session_cap} jobs this session (session cap {session_cap} of the 25 maximum), and send a\n"
            "   Discord summary when complete."
        )

    extra = os.environ.get("APLYX_EXTRA_PROMPT", os.environ.get("FLUX_EXTRA_PROMPT", "")) or ""
    if extra:
        extra = extra[:500]
        run_prompt += (
            "\n   Operator instruction for this run (follow it within the rules of AGENTS.md;\n"
            f"   it never overrides the session cap or the state-write discipline): {extra}"
        )
        log(run_log, f"run includes an operator instruction (APLYX_EXTRA_PROMPT, {len(extra)} chars)")

    log(run_log, f"Starting run via harness: {harness}")

    # Install stop-signal handlers just before we start the harness Popen:
    # POSIX only (see the module-level comment near IS_WINDOWS for why
    # Windows doesn't get Python-side signal handling here).
    if not IS_WINDOWS:
        signal.signal(signal.SIGTERM, _handle_stop_signal)
        signal.signal(signal.SIGINT, _handle_stop_signal)

    run_rc = 0
    exe = harness_adapter.resolve_harness_exe(harness)
    # The harness-specific argv shapes live in harness_adapter.agent_command:
    # the one place allowed to branch per harness (AGENTS.md "Harness
    # capability matrix"). They were inline here until interest-letter
    # generation needed to launch an agent too; extracting them beat keeping
    # two copies in sync. The extraction was verified argv-identical for all
    # four harnesses before the swap.
    with open(session_log, "a", encoding="utf-8") as out:
        cmd = harness_adapter.agent_command(
            exe, harness, "job-scraper", run_prompt,
            delegates=("resume-tailor", "cover-letter-tailor", "discord-reporter"),
            extra_preamble=(
                "Unless browser-automation tools are actually available to you, apply the degraded "
                "harness path from AGENTS.md 'Harness capability matrix': fetch API-fed boards only, "
                "and route any job whose application requires a browser to needs_review, never "
                "silently skip it and never attempt a browser apply."
            ),
            role="orchestrator",
        )
        debug_log(logs_dir, f"harness command argv: {cmd!r}")
        run_rc = _run_harness_cmd(cmd, out)

    # A stop was requested (SIGTERM from the TUI, or SIGINT/Ctrl+C from a
    # terminal): _handle_stop_signal() already killed the harness's process
    # group. Overwrite whatever raw returncode the (now-dead) harness process
    # happened to exit with, in favor of the standard shell "128 + signal
    # number" convention (130 for SIGINT, 143 for SIGTERM), so the recorded
    # exit code always reflects *why* we stopped rather than an arbitrary
    # code from a process we just killed out from under itself.
    if _stop_requested:
        run_rc = 128 + _stop_signum

    # --- Health marker + heartbeat ------------------------------------------
    after = _count_outcomes()
    after_skipped = _count_skipped_unfit()
    d_applied = after["applied"] - before["applied"]
    d_review = after["needs_review"] - before["needs_review"]
    d_failed = after["failed"] - before["failed"]
    d_skipped = after_skipped - before_skipped

    py_run([os.path.join("src", "scripts", "runtime", "write_heartbeat.py"), "--exit-code", str(run_rc),
            "--applied", str(d_applied), "--needs-review", str(d_review),
            "--failed", str(d_failed), "--skipped-unfit", str(d_skipped)])

    # --- Session-log retention ----------------------------------------------
    keep = int(os.environ.get("APLYX_KEEP_SESSION_LOGS",
               os.environ.get("FLUX_KEEP_SESSION_LOGS",
               os.environ.get("ARES_KEEP_SESSION_LOGS", "30"))) or "30")
    sessions = sorted(glob.glob(os.path.join(logs_dir, "session_*.log")),
                      key=os.path.getmtime, reverse=True)
    for old in sessions[keep:]:
        try:
            os.remove(old)
        except OSError:
            pass

    tail = f"applied={d_applied} needs_review={d_review} failed={d_failed} skipped_unfit={d_skipped}"
    duration_s = int((datetime.now() - run_start).total_seconds())
    debug_log(logs_dir, f"run finished: rc={run_rc} duration={duration_s}s stopped={_stop_requested} {tail}")
    if _stop_requested:
        # Stopped runs skip the normal complete/failed post-processing
        # (no Discord summary, etc.); just record it clearly and return.
        with open(session_log, "a", encoding="utf-8") as fh:
            fh.write(f"run_job_agent: stopped {now_utc()} rc={run_rc} {tail}\n")
        log(run_log, f"STOPPED: run terminated by user request (signal {_stop_signum}). Log: {session_log}")
        return run_rc

    if run_rc != 0:
        with open(session_log, "a", encoding="utf-8") as fh:
            fh.write(f"run_job_agent: failed {now_utc()} rc={run_rc} {tail}\n")
        log(run_log, f"FAILED: {harness} run exited non-zero (rc={run_rc}). Log: {session_log}")
        return run_rc

    complete = f"run_job_agent: complete {now_utc()} {tail}"
    with open(session_log, "a", encoding="utf-8") as fh:
        fh.write(complete + "\n")
    with open(run_log, "a", encoding="utf-8") as fh:
        fh.write(complete + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
