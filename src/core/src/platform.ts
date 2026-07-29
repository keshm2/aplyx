import { spawnSync, execFileSync } from "node:child_process";

/**
 * Cross-platform interpreter resolution. The runtime helpers are Python
 * and (historically) bash; neither `python3` nor `bash` exists by that
 * literal name on native Windows. This module resolves the real command
 * once per process so the TUI runs on PowerShell / cmd.exe without WSL.
 */

const isWindows = process.platform === "win32";

let cachedPython: { cmd: string; prefix: string[] } | undefined;

/**
 * Resolve a working Python 3. On Windows the py-launcher (`py -3`) is
 * preferred, then `python`; elsewhere `python3` then `python`. Falls back
 * to the first candidate (which then fails loudly) if none respond.
 */
export function pythonCmd(): { cmd: string; prefix: string[] } {
  if (cachedPython) return cachedPython;
  const candidates: { cmd: string; prefix: string[] }[] = isWindows
    ? [
        { cmd: "py", prefix: ["-3"] },
        { cmd: "python", prefix: [] },
        { cmd: "python3", prefix: [] },
      ]
    : [
        { cmd: "python3", prefix: [] },
        { cmd: "python", prefix: [] },
      ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c.cmd, [...c.prefix, "--version"], { stdio: "ignore" });
      if (r.status === 0) {
        cachedPython = c;
        return c;
      }
    } catch {
      /* try next candidate */
    }
  }
  cachedPython = candidates[0];
  return cachedPython;
}

/**
 * Build a spawn-ready { cmd, args } that runs the given Python arguments
 * under the resolved interpreter. Use everywhere instead of a literal
 * "python3" spawn target.
 */
export function py(args: string[]): { cmd: string; args: string[] } {
  const p = pythonCmd();
  return { cmd: p.cmd, args: [...p.prefix, ...args] };
}

/**
 * Force-kill a process tree by PID. POSIX callers should just call
 * `child.kill("SIGTERM")` directly instead of using this — run_job_agent.py
 * installs a SIGTERM handler there that gracefully kills its harness
 * subprocess group and flushes state, so a plain signal is sufficient.
 *
 * This helper exists only for Windows, where graceful signal handling
 * from a Node parent isn't reliably achievable: `taskkill /T /F` force-
 * kills the whole tree at once instead. That's a deliberate, accepted
 * platform difference (not a bug) — state writes are still safe under a
 * hard kill because the Python side uses atomic temp-file+rename writes
 * throughout.
 */
export function stopProcessTree(pid: number): void {
  if (process.platform !== "win32") return; // POSIX: caller sends SIGTERM directly
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already exited, or taskkill unavailable — nothing more we can do */
  }
}

/**
 * Liveness check for a PID we do not own. Signal 0 performs the kernel's
 * permission/existence check without delivering anything (Node emulates it
 * on Windows too). EPERM means the process exists but belongs to another
 * user — still alive for our purposes.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Stop a run by PID, whether or not this process spawned it. Used for runs
 * the TUI adopted from the lock file (a scheduler tick, or a run left alive
 * after the user quit with `q`), where there is no ChildProcess handle to
 * signal. Same platform split as stopProcessTree: POSIX gets a graceful
 * SIGTERM (run_job_agent.py handles it), Windows gets taskkill /T /F.
 */
export function stopPid(pid: number): void {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    stopProcessTree(pid);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* exited between the liveness check and the signal — nothing to do */
  }
}
