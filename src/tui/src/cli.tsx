#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findProjectRoot } from "@aplyx/core/project.js";
import { py } from "@aplyx/core/platform.js";
import { loadState, isResolved, lastRunLine, latestSessionLog, readHeartbeat } from "@aplyx/core/state.js";
import { App, type Tab } from "./ui/App.js";
import { StatusScreen } from "./ui/StatusScreen.js";
import { OnboardingWizard } from "./ui/onboarding/OnboardingWizard.js";
import { runWizard } from "./wizard.js";
import { runAgent } from "./run.js";
import { withAltScreen } from "./altScreen.js";

const HELP = `aplyx — persistent TUI for the aplyx job-application agent

Usage: aplyx [command]

  (no command)      open the app (status · jobs · review · history) —
                    runs the setup wizard first if onboarding isn't done
  review | history  open the app on that screen
  resumes           open the app on the Resumes screen
  status            one-shot pipeline overview (scripting/CI friendly)
  run               trigger a run in the current terminal (no app shell)
  setup [--check]   (re)open the guided setup wizard; --check only validates
  update            check upstream and self-update now
  version           print the installed version (shows "(latest)" if it matches upstream main)
  uninstall         remove the schedule, command, and (after confirming) the install
  help              show this help

Updates are checked on every app launch (the TUI asks before
installing) and auto-install on scheduled runs
(APLYX_AUTO_UPDATE=0 disables).

With no core checkout found, aplyx installs it automatically
(--no-core or APLYX_SKIP_CORE=1 skips this and prints the manual
install command instead).

Inside the app, press ? for the full key reference.

State writes go through the repo's Python/bash helpers — the TUI never
edits state JSON directly. Set APLYX_ROOT to run outside the repo.`;

const VERSION_URL = "https://raw.githubusercontent.com/keshm2/aplyx/main/VERSION";
const BOOTSTRAP_URL = "https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.sh";
const BOOTSTRAP_URL_PS1 = "https://raw.githubusercontent.com/keshm2/aplyx/main/src/scripts/install/install.ps1";

/** The one-command core bootstrap for the current OS. */
function bootstrapOneLiner(): string {
  return process.platform === "win32"
    ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${BOOTSTRAP_URL_PS1} | iex"`
    : `curl -fsSL ${BOOTSTRAP_URL} | bash`;
}

/** Fetches the remote VERSION file (upstream main), or null on any
 *  failure/timeout — shared by detectUpdate (the launch-time probe) and
 *  the `aplyx version` command below. */
async function fetchRemoteVersion(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(VERSION_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const remote = (await res.text()).trim();
    return remote || null;
  } catch {
    return null;
  }
}

/** Launch-time update probe: compare the local VERSION to upstream
 *  main and return the remote version when it differs, so the TUI can
 *  ask before installing (see App's UpdateBox). Strictly fail-open — a
 *  dead network, missing VERSION, or slow GitHub never delays launch
 *  more than the 2.5 s fetch timeout, and APLYX_AUTO_UPDATE=0 skips it. */
async function detectUpdate(root: string): Promise<string | null> {
  if (process.env.APLYX_AUTO_UPDATE === "0" || process.env.FLUX_AUTO_UPDATE === "0" || process.env.ARES_AUTO_UPDATE === "0") return null;
  if (!process.stdout.isTTY) return null; // never in piped/CI renders
  try {
    const local = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
    const remote = await fetchRemoteVersion();
    if (!remote || remote === local) return null;
    return remote;
  } catch {
    /* fail-open — updating is a convenience, never a launch blocker */
  }
  return null;
}

/** `aplyx version` — prints the local VERSION, with " (latest)" appended
 *  when it matches upstream main. Unlike detectUpdate (the launch-time
 *  probe this shares its fetch with), this always checks regardless of
 *  APLYX_AUTO_UPDATE or TTY-ness — an explicit `aplyx version` should
 *  always get a real answer instead of being silently skipped the way
 *  the launch-time convenience probe is allowed to be. Never fails the
 *  command outright on a dead network — it just can't say "(latest)"
 *  then, same fail-open spirit as detectUpdate. */
async function printVersion(root: string): Promise<number> {
  let local = "unknown";
  try {
    local = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || "unknown";
  } catch {
    /* fail-open — still print something rather than crashing */
  }
  const remote = await fetchRemoteVersion();
  const suffix = remote && remote === local ? " (latest)" : "";
  console.log(`${local}${suffix}`);
  return 0;
}

/** Run the updater now (after the TUI has left the alternate screen).
 *  Mirrors the old silent auto-update install step.
 *
 *  Refreshing a stale desktop app used to be checked here too, but that
 *  only covers `aplyx update` run through the TUI — the launchd/schtasks
 *  scheduler and run_job_agent.py's own pre-run auto-update both call
 *  src/scripts/install/update.py directly and never go through this file at
 *  all, so a desktop app that only ever updates via a scheduled run
 *  stayed permanently stale even after that fix (reported live as
 *  "still not updating everything properly"). The check now lives in
 *  update.py's own _post_update() instead — the one place every
 *  invocation path already funnels through — so `--auto` below already
 *  covers it; doing it here too would just race a second install attempt
 *  against the one update.py already started. */
function installUpdate(root: string): void {
  const upd = py(["src/scripts/install/update.py", "--auto"]);
  const r = spawnSync(upd.cmd, upd.args, { cwd: root, stdio: "inherit" });
  if (r.status === 0) {
    console.log("Update installed — restart aplyx to load it.\n");
  }
}

/** Run install_desktop.sh/.ps1 now (after the TUI has left the alternate
 *  screen, same handoff installUpdate above uses) — triggered from
 *  Settings' "Install desktop app" action. Runs the LOCAL copy already in
 *  this checkout (not a fresh curl/irm download like bootstrapCore's
 *  first-run path), since a core checkout already exists by the time this
 *  can even be reached. The script itself is interactive (its own
 *  prompts, progress bars) — stdio: "inherit" puts it on the real
 *  terminal, not inside Ink's raw mode. */
function installDesktopApp(root: string): void {
  const r =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "src", "scripts", "install", "install_desktop.ps1")],
          { cwd: root, stdio: "inherit" },
        )
      : spawnSync("bash", [path.join(root, "src", "scripts", "install", "install_desktop.sh")], { cwd: root, stdio: "inherit" });
  if (r.status === 0) {
    console.log("Desktop app installed — open it from your applications menu; `aplyx` still works the same as before.\n");
  } else {
    console.log(
      "Desktop app install did not complete — see the output above. Retry any time with: bash src/scripts/install/install_desktop.sh " +
        "(or: powershell -ExecutionPolicy Bypass -File scripts\\install\\install_desktop.ps1 on Windows).\n",
    );
  }
}

/** No core checkout found: install it right here (one-command promise),
 *  unless the user opted out with --no-core / APLYX_SKIP_CORE=1, in
 *  which case just print the manual one-liner. */
async function bootstrapCore(): Promise<string | null> {
  const target = process.env.APLYX_HOME ?? process.env.FLUX_HOME ?? path.join(os.homedir(), "aplyx");
  const oneLiner = bootstrapOneLiner();
  if (process.argv.includes("--no-core") || process.env.APLYX_SKIP_CORE === "1" || process.env.FLUX_SKIP_CORE === "1") {
    console.log(`Skipped. Install later with: ${oneLiner}`);
    return null;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "aplyx: no aplyx core found. Install it with one command:\n\n" +
        `  ${oneLiner}\n\n` +
        `(installs to ${target}; set APLYX_HOME to change, or APLYX_ROOT to point\n` +
        "at an existing checkout), then re-run aplyx.",
    );
    return null;
  }
  const r =
    process.platform === "win32"
      ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
          `irm ${BOOTSTRAP_URL_PS1} | iex`], { stdio: "inherit" })
      : spawnSync("bash", ["-c", oneLiner], { stdio: "inherit" });
  if (r.status !== 0 || !fs.existsSync(path.join(target, "AGENTS.md"))) {
    console.error("aplyx: core install did not complete — see the output above.");
    return null;
  }
  return target;
}

/** Ensure non-TTY stdout has flushed so process.exit() doesn't truncate
 *  piped/CI output from one-shot renders. */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    const out = process.stdout;
    if (out.isTTY || !out.writableNeedDrain) {
      resolve();
      return;
    }
    out.once("drain", () => resolve());
  });
}

/** Full-screen app render, alt-screen managed by `withAltScreen`. */
async function openApp(root: string, initialTab: Tab, updateVersion?: string): Promise<number> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    // Piped/CI: render one frame, wait for the unmount lifecycle to flush,
    // then leave. No update prompt — there's no keyboard to answer it.
    const app = render(<App root={root} initialTab={initialTab} />);
    app.unmount();
    await app.waitUntilExit();
    await flushStdout();
    return 0;
  }
  // The UpdateBox calls this when the user accepts the update; we run
  // src/scripts/install/update.py AFTER the alt screen is restored below so its
  // stdio-inherit output lands on the normal screen, not inside the TUI.
  // Settings' "Install desktop app" action uses the identical handoff.
  let installAfterExit = false;
  let installDesktopAfterExit = false;
  await withAltScreen(() =>
    render(
      <App
        root={root}
        initialTab={initialTab}
        updateVersion={updateVersion}
        onUpdateInstall={() => {
          installAfterExit = true;
        }}
        onInstallDesktopApp={() => {
          installDesktopAfterExit = true;
        }}
      />,
    ),
  );
  // Alt screen is now left; a user-accepted update/desktop-install runs
  // here so its stdio-inherit output is visible on the normal screen.
  if (installAfterExit) installUpdate(root);
  if (installDesktopAfterExit) installDesktopApp(root);
  return 0;
}

/** First-run (and not-yet-onboarded) auto-launch: a fresh or incomplete
 * `_onboarding` block means `<App>` must not mount yet — render the wizard
 * first and only fall through once its `onDone` fires. Only applies to a
 * plain `aplyx` invocation on a real TTY; every other command/context
 * behaves exactly as before. */
async function maybeRunOnboarding(root: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const targetsPath = path.join(root, "src", "config", "targets.json");
  let completed = false;
  if (fs.existsSync(targetsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(targetsPath, "utf8")) as {
        _onboarding?: { completed?: boolean };
      };
      completed = parsed._onboarding?.completed === true;
    } catch {
      completed = false;
    }
  }
  if (completed) return;
  await withAltScreen(() => {
    let instance: ReturnType<typeof render>;
    instance = render(<OnboardingWizard root={root} onDone={() => instance.unmount()} />);
    return instance;
  });
}

async function main(): Promise<number> {
  // Piped/CI renders: Ink falls back to 80 columns when stdout is not a
  // TTY, while the app honors $COLUMNS/$LINES — sync Ink to the same
  // values so one-frame test renders lay out exactly like a real
  // terminal of that size.
  if (!process.stdout.isTTY) {
    const cols = Number.parseInt(process.env.COLUMNS ?? "", 10);
    const rows = Number.parseInt(process.env.LINES ?? "", 10);
    if (Number.isFinite(cols) && cols > 0) (process.stdout as { columns?: number }).columns = cols;
    if (Number.isFinite(rows) && rows > 0) (process.stdout as { rows?: number }).rows = rows;
  }
  const [command = "", ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  // npm-installed global `aplyx` with no core checkout: offer to install
  // the core right here (interactive), or print the one-liner (piped).
  let root: string;
  try {
    root = findProjectRoot();
  } catch {
    const installed = await bootstrapCore();
    if (!installed) return 1;
    root = installed;
  }

  // Plain `aplyx` with no core config yet (or an unfinished wizard run):
  // run the wizard first so <App>'s WelcomeScreen/SidePanel never mount
  // ahead of onboarding. Every other command/context is untouched.
  if (command === "") await maybeRunOnboarding(root);

  // Auto-update only on a plain app open — one-shot commands
  // (status/run/review) stay instant and scriptable. The probe reuses
  // the existing VERSION fetch; the TUI prompts before installing.
  let pendingUpdate: string | null = null;
  switch (command) {
    case "":
      pendingUpdate = await detectUpdate(root);
      break;
    case "update": {
      const upd = py(["src/scripts/install/update.py"]);
      const r = spawnSync(upd.cmd, upd.args, { cwd: root, stdio: "inherit" });
      return r.status ?? 1;
    }
    case "version":
      return printVersion(root);
    case "uninstall": {
      const un = py(["src/scripts/install/uninstall.py", ...rest]);
      const r = spawnSync(un.cmd, un.args, { cwd: root, stdio: "inherit" });
      return r.status ?? 1;
    }
  }

  switch (command) {
    case "":
      return openApp(root, "status", pendingUpdate ?? undefined);
    case "review":
      return openApp(root, "review");
    case "history":
      return openApp(root, "history");
    case "resumes":
      return openApp(root, "resumes");
    case "status": {
      const state = loadState(root);
      const unresolved = state.queue.filter((e) => !isResolved(state, e)).length;
      const app = render(
        <StatusScreen
          state={state}
          lastRun={lastRunLine(root)}
          sessionLog={latestSessionLog(root)}
          unresolvedQueue={unresolved}
          heartbeat={readHeartbeat(root)}
        />,
      );
      app.unmount();
      await app.waitUntilExit();
      await flushStdout();
      return 0;
    }
    case "run":
      return runAgent(root);
    case "setup":
      return runWizard(root, rest.includes("--check"));
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
