import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Does `dir` look like a aplyx checkout? Same two-file check
 *  findProjectRoot() walks upward looking for; exported so a manual
 *  root picker (the desktop app's recovery path when auto-detection
 *  finds nothing) can validate a user-chosen folder before accepting it. */
export function isValidProjectRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "src", "scripts", "state", "job_state.py")) &&
    fs.existsSync(path.join(dir, "AGENTS.md"))
  );
}

/**
 * A tiny installer-written pointer file (`~/.aplyx/root`, one absolute
 * path, no other content), the primary resolution signal for a
 * Finder/Dock-launched desktop app. Every other signal findProjectRoot()
 * has is meaningless there: no shell env vars, a working directory
 * that's never the checkout, and a compiled bridge that (now that it's
 * bundled as a Tauri resource so a downloaded install works at all; see
 * src/tauri/src-tauri/src/lib.rs) lives inside the app bundle, nowhere near
 * the user's actual checkout. `src/scripts/install/install.sh`,
 * `install_desktop.sh`, and their `.ps1` equivalents all write this file
 * once they know the checkout path; a manual "browse for my aplyx folder"
 * pick (validateRoot in bridge.ts) writes it too, so a one-time pick self
 * -heals future launches and reinstalls, not just this browser's
 * localStorage.
 */
export function pinnedRootFile(): string {
  return path.join(os.homedir(), ".aplyx", "root");
}

export function readPinnedRoot(): string | undefined {
  try {
    const raw = fs.readFileSync(pinnedRootFile(), "utf8").trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export function writePinnedRoot(root: string): void {
  const file = pinnedRootFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, root, "utf8");
}

/**
 * Locate the aplyx project root. The TUI is an overlay over the repo's
 * Python core: every command needs the root to find src/scripts/,
 * src/config/, data/, and logs/. Resolution order: $APLYX_ROOT (legacy $FLUX_ROOT,
 * then $ARES_ROOT, honored), then the installer-written pin file, then
 * upward from the working directory, then upward from this module
 * (covers running the repo-local build from anywhere).
 */
export function findProjectRoot(): string {
  const starts: string[] = [];
  if (process.env.APLYX_ROOT) starts.push(process.env.APLYX_ROOT);
  if (process.env.FLUX_ROOT) starts.push(process.env.FLUX_ROOT);
  if (process.env.ARES_ROOT) starts.push(process.env.ARES_ROOT);
  const pinned = readPinnedRoot();
  if (pinned) starts.push(pinned);
  starts.push(process.cwd());
  starts.push(path.dirname(fileURLToPath(import.meta.url)));

  for (const start of starts) {
    let dir = path.resolve(start);
    for (;;) {
      if (isValidProjectRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    "Could not locate the aplyx project root (src/scripts/state/job_state.py + AGENTS.md). " +
      "Run from inside the repo or set APLYX_ROOT.",
  );
}
