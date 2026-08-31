import { spawn } from "node:child_process";
import fs from "node:fs";
import { latestSessionLog } from "@aplyx/core/state.js";
import { py } from "@aplyx/core/platform.js";

/**
 * Trigger a run via the cross-platform runner and stream the session log
 * while it executes. The runner owns locking, validation, and the harness
 * invocation; the TUI only launches and observes it. Cross-platform: it
 * spawns the Python runner (no bash) and tails the session log in-process
 * (no `tail` binary), so it works on Windows PowerShell/cmd too.
 */
export async function runAgent(root: string): Promise<number> {
  const before = latestSessionLog(root);
  console.log("Starting a run via src/scripts/runtime/run_job_agent.py …");
  const { cmd, args } = py(["src/scripts/runtime/run_job_agent.py"]);
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  });

  // The session transcript goes to logs/session_<ts>.log, not stdout; tail
  // the new session file once it appears. Implemented in-process (read the
  // appended tail on an interval) so no external `tail` binary is required.
  let streaming: string | undefined;
  let offset = 0;
  const drain = () => {
    if (!streaming) return;
    try {
      const size = fs.statSync(streaming).size;
      if (size > offset) {
        const fd = fs.openSync(streaming, "r");
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = size;
        process.stdout.write(buf.toString("utf8"));
      }
    } catch {
      /* file may rotate/vanish; ignore and retry next tick */
    }
  };
  const poll = setInterval(() => {
    const current = latestSessionLog(root);
    if (current && current !== before && fs.existsSync(current) && !streaming) {
      console.log(`Streaming ${current}\n`);
      streaming = current;
      offset = 0;
    }
    drain();
  }, 500);

  try {
    const code: number = await new Promise<number>((resolve, reject) => {
      child.on("close", (c) => resolve(c ?? 1));
      child.on("error", reject);
    });
    drain();
    console.log(code === 0 ? "\nRun complete." : `\nRun exited with code ${code}: see logs/run_job_agent.log.`);
    return code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    clearInterval(poll);
  }
}
