import fs from "node:fs";
import path from "node:path";

/**
 * Coding-agent (harness) detection and src/config/harness.json read/write:
 * shared by the TUI's setup flow (src/tui/src/harness.ts wraps this for its
 * own theme-aware HarnessId type) and the desktop app's onboarding wizard
 * "coding agent detection/selection" step. Framework-agnostic: no UI
 * imports, matches src/scripts/install/install.sh's menu options exactly.
 */
export type HarnessName = "opencode" | "claude" | "codex" | "copilot";

const KNOWN: ReadonlySet<string> = new Set(["opencode", "claude", "codex", "copilot"]);

export function isKnownHarness(value: string): value is HarnessName {
  return KNOWN.has(value);
}

/** PATH probe order: must stay identical to run_job_agent.py's own
 *  auto-detect loop ("Harness selection"), or the UI will name a
 *  different agent than the one that actually drives the run. */
export const HARNESS_DETECT_ORDER: readonly HarnessName[] = ["opencode", "claude", "codex", "copilot"];

/** Directories to probe beyond $PATH. A GUI-launched app (the desktop
 *  shell spawning the core bridge) inherits launchd's minimal PATH
 *  (/usr/bin:/bin:/usr/sbin:/sbin), so agents installed via Homebrew, npm
 *  globals, bun, or their own installers were invisible from the installed
 *  .app while detection from a terminal worked fine. The detect ORDER
 *  (HARNESS_DETECT_ORDER) still matches run_job_agent.py; only the set of
 *  directories searched is wider. */
function extraSearchDirs(): string[] {
  if (process.platform === "win32") return [];
  const home = process.env["HOME"] ?? "";
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
  ];
  if (home) {
    dirs.push(
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".claude", "local"), // Claude Code native installer wrapper
      path.join(home, ".opencode", "bin"), // opencode standalone installer
      path.join(home, ".volta", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, "Library", "pnpm"),
    );
    // nvm: each installed node version has its own global-bin dir
    const nvmVersions = path.join(home, ".nvm", "versions", "node");
    try {
      for (const entry of fs.readdirSync(nvmVersions)) {
        dirs.push(path.join(nvmVersions, entry, "bin"));
      }
    } catch {
      /* no nvm, fine */
    }
  }
  return dirs;
}

function onPath(cmd: string): boolean {
  const pathDirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const dirs = [...new Set([...pathDirs, ...extraSearchDirs()])];
  const exts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (process.platform === "win32") {
          if (fs.statSync(candidate).isFile()) return true;
        } else {
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        }
      } catch {
        /* not here, keep looking */
      }
    }
  }
  return false;
}

/** Which agent "Auto" would actually pick right now, or undefined when
 *  none of the four is installed. Never cached: installing an agent
 *  while the app is open should be reflected without a restart. */
export function detectHarnessOnPath(): HarnessName | undefined {
  for (const candidate of HARNESS_DETECT_ORDER) {
    if (onPath(candidate)) return candidate;
  }
  return undefined;
}

/** Every harness found on PATH, in detect-order, for a selection UI that
 *  wants to show all installed options, not just the first match. */
export function detectAllHarnessesOnPath(): HarnessName[] {
  return HARNESS_DETECT_ORDER.filter(onPath);
}

const harnessConfigPath = (root: string) => path.join(root, "src", "config", "harness.json");

export function readHarnessConfig(root: string): HarnessName | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(harnessConfigPath(root), "utf8")) as { harness?: unknown };
    const value = typeof parsed.harness === "string" ? parsed.harness.trim() : "";
    return isKnownHarness(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeHarnessConfig(root: string, harness: HarnessName): void {
  fs.writeFileSync(harnessConfigPath(root), `{\n  "harness": "${harness}"\n}\n`, "utf8");
}
