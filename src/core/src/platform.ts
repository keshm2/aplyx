import { spawnSync, execFileSync, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-platform interpreter resolution. The runtime helpers are Python
 * and (historically) bash; neither `python3` nor `bash` exists by that
 * literal name on native Windows. This module resolves the real command
 * once per process so the TUI runs on PowerShell / cmd.exe without WSL.
 */

const isWindows = process.platform === "win32";

let cachedPython: { cmd: string; prefix: string[] } | undefined;

type PyCandidate = { cmd: string; prefix: string[] };

/**
 * A Finder-launched .app inherits launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), which does not include Homebrew, pyenv,
 * or conda/miniconda install locations — so a bare "python3" resolves to
 * Apple's bundled system interpreter, which has none of the user's `pip3
 * install -r requirements.txt` packages (playwright, google-api-python-client,
 * pypdf). That surfaced as "the 'playwright' pip package is not installed"
 * errors (Export PDF, Apply-with-aplyx, board fetches) even though the user
 * genuinely had installed it — just onto a different python3 than the app
 * could see. Mirrors node_binary()'s fix for the identical PATH problem in
 * lib.rs. Probe common non-PATH install locations before falling back to
 * bare "python3"/"python" lookup.
 */
function unixPythonCandidates(): PyCandidate[] {
  const home = process.env.HOME ?? "";
  const knownPaths = [
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/opt/local/bin/python3",
    ...(home
      ? [
          join(home, "miniconda3", "bin", "python3"),
          join(home, "anaconda3", "bin", "python3"),
          join(home, ".pyenv", "shims", "python3"),
        ]
      : []),
  ];
  const found = knownPaths.filter((p) => existsSync(p)).map((cmd) => ({ cmd, prefix: [] as string[] }));
  return [...found, { cmd: "python3", prefix: [] }, { cmd: "python", prefix: [] }];
}

/** --version success (a real Python) plus whether `import playwright` works there. */
function probePython(c: PyCandidate): { valid: boolean; hasPlaywright: boolean } {
  try {
    const v = spawnSync(c.cmd, [...c.prefix, "--version"], { stdio: "ignore" });
    if (v.status !== 0) return { valid: false, hasPlaywright: false };
  } catch {
    return { valid: false, hasPlaywright: false };
  }
  try {
    const p = spawnSync(c.cmd, [...c.prefix, "-c", "import playwright"], { stdio: "ignore" });
    return { valid: true, hasPlaywright: p.status === 0 };
  } catch {
    return { valid: true, hasPlaywright: false };
  }
}

/**
 * Resolve a working Python 3. On Windows the py-launcher (`py -3`) is
 * preferred, then `python`; elsewhere common non-PATH install locations are
 * probed first (see unixPythonCandidates), then bare `python3`/`python`.
 * Among candidates that are a real Python 3, prefers one that already has
 * `playwright` importable — the interpreter the user actually ran `pip3
 * install -r requirements.txt` against — over the first one merely found.
 * Falls back to the first valid candidate (which then fails loudly with the
 * real "pip3 install -r requirements.txt" message) if none have it, and to
 * the first candidate outright if none respond at all.
 */
export function pythonCmd(): PyCandidate {
  if (cachedPython) return cachedPython;
  const candidates: PyCandidate[] = isWindows
    ? [
        { cmd: "py", prefix: ["-3"] },
        { cmd: "python", prefix: [] },
        { cmd: "python3", prefix: [] },
      ]
    : unixPythonCandidates();
  let firstValid: PyCandidate | undefined;
  for (const c of candidates) {
    const { valid, hasPlaywright } = probePython(c);
    if (!valid) continue;
    if (!firstValid) firstValid = c;
    if (hasPlaywright) {
      cachedPython = c;
      return c;
    }
  }
  cachedPython = firstValid ?? candidates[0];
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
 * Like a promisified execFile, but delivers `input` over the child's
 * stdin instead of argv — argv (and the whole environment) shares a
 * single OS-enforced budget (ARG_MAX; 1MB on macOS), which a large JSON
 * payload can blow past (hit this for real with a big job-registry batch —
 * see getRecommendedJobs in jobs.ts). Callers pass "-" as the script's
 * positional arg so it reads stdin instead.
 */
export function execFileWithStdin(
  command: string, args: string[], input: string,
  opts: { cwd: string; maxBuffer: number; timeout: number },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout });
    });
    // The child may exit (e.g. a usage error) before we finish writing —
    // without this, that EPIPE surfaces as an unhandled 'error' event and
    // crashes the process instead of just failing the execFile callback.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
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
