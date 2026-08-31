import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { activeRunPid, latestSessionLog, readHeartbeat } from "@aplyx/core/state.js";
import { py, stopPid, stopProcessTree } from "@aplyx/core/platform.js";
import { parsePhaseChecklist, markersIn, parseCurrentApplication, type PhaseInfo } from "@aplyx/core/runProgress.js";
import { theme, statusGlyph, capTier, harnessGradient, HARNESS_WAVE_TICK_MS, HARNESS_WAVE_STEP } from "../theme.js";
import { resolveHarnessId } from "../harness.js";
import { RainbowText, AutoSparkleText, SpinnerGlyph, GradientProgressBar, KeyHints } from "./KeyHints.js";
import {
  InlineTextInput,
  deleteBackward,
  insertAtCursor,
  moveCursorLeft,
  moveCursorRight,
} from "./TextInput.js";

// Keep a deep buffer; how many lines actually render is derived from the
// live terminal height so the log fills the content region. This bound is
// for *display* only: progress parsing must never read from it, see
// markersIn/applyProgress below.
const TAIL_BUFFER = 200;
const GAUGE_WIDTH = 14;
const PROMPT_MAX = 500;
const PROGRESS_BAR_WIDTH = 26;

type Phase = "idle" | "running" | "stopping" | "done" | "stopped";

export { parsePhaseChecklist, markersIn, parseCurrentApplication };

/**
 * Trigger a run without leaving the app: spawns run_job_agent.py and
 * tails the session log into the content region. The script owns
 * locking, validation, and the harness invocation.
 *
 * Two typed inputs, both opt-in (never captured on mount): `e` sets the
 * per-cycle application cap (1–25, tier-colored, MAX warns loudly), and
 * `p` sets an optional extra instruction the orchestrator receives via
 * APLYX_EXTRA_PROMPT; leave it empty to run the standard workflow.
 *
 * While a run is live, `x` opens a two-step stop confirmation (`x` again
 * stops; `c` instead opens the same prompt editor to type a correction,
 * which stops the run cleanly and immediately relaunches it with the
 * correction folded into the extra prompt: an opaque CLI harness has no
 * checkpoint format, so "correct and continue" is really "stop, then
 * start a fresh run with the same cap"). `l` toggles the raw session-log
 * tail as a fallback/debug view; the default running view is a phase
 * checklist derived from a best-effort parse of the log tail.
 */
export function RunScreen({
  root,
  active,
  onInputActiveChange,
  onRunningChange,
  contentRows = 20,
}: {
  root: string;
  active: boolean;
  onInputActiveChange: (active: boolean) => void;
  onRunningChange: (running: boolean) => void;
  /** Rows the shell hands this screen: the log tail fills them. */
  contentRows?: number;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [countInput, setCountInput] = useState("");
  const [countCursor, setCountCursor] = useState(0);
  const [sessionCap, setSessionCap] = useState<number | null>(null);
  // Browse mode first: entering automatic mode must never steal the
  // keyboard: typing starts only when the user presses e or p.
  const [editingCount, setEditingCount] = useState(false);
  const [promptInput, setPromptInput] = useState("");
  const [promptCursor, setPromptCursor] = useState(0);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [inputMessage, setInputMessage] = useState("Press e to set this cycle's application cap (1–25).");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Stop / correct-and-continue flow. confirmStop gates the x/c/esc menu;
  // showLog toggles the opt-in raw log view; pendingRestart carries the
  // {cap, prompt} to relaunch with once a correction-triggered stop has
  // fully exited (see the restart effect below).
  const [confirmStop, setConfirmStop] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [pendingRestart, setPendingRestart] = useState<{ cap: number; prompt: string } | null>(null);
  // Progress is accumulated across the whole run rather than re-derived per
  // render from `lines`; see applyProgress for why that distinction is
  // load-bearing.
  const [progress, setProgress] = useState<PhaseInfo | null>(null);
  const [applyTarget, setApplyTarget] = useState<{ title: string; company: string } | null>(null);
  const markerLines = useRef<string[]>([]);
  // A run in flight that this screen did not spawn: a scheduler tick, or a
  // run left alive after the user quit the TUI with `q`. Adopted so `x` can
  // stop it too, otherwise the only way to end one is to hunt the PID.
  const [foreignPid, setForeignPid] = useState<number | undefined>(undefined);
  const child = useRef<ChildProcess | null>(null);
  const logBefore = useRef<string | undefined>(undefined);
  // Set right before we kill the child ourselves, so its `close` handler
  // can tell a user-requested stop apart from the harness exiting on its
  // own: a stop is neither success nor failure and gets its own phase.
  const stoppedByUser = useRef(false);

  // Adopt any run this screen didn't spawn by reading the runner's own lock
  // pid file. Two ways that happens: the 30-minute scheduler fired, or the
  // user quit the TUI with `q` mid-run (which deliberately leaves the run
  // going). Without this the screen shows "No run in progress" while one is
  // very much in progress, and the only way to stop it is to find the PID by
  // hand. Skipped while our own run is live: `phase` already tracks that,
  // and the lock would just report our own runner back to us.
  useEffect(() => {
    if (phase === "running" || phase === "stopping") {
      setForeignPid(undefined);
      return;
    }
    const check = () => setForeignPid(activeRunPid(root));
    check();
    const timer = setInterval(check, 2000);
    return () => clearInterval(timer);
  }, [phase, root]);

  // Elapsed-run clock: ticks only while a run is live.
  useEffect(() => {
    if ((phase !== "running" && phase !== "stopping") || startedAt === null) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase, startedAt]);

  useEffect(() => {
    // Whenever the user is actually typing (cap or prompt, including the
    // in-run correction editor, which reuses editingPrompt) the parent
    // must stop stealing keystrokes, regardless of run phase.
    const capturesInput = active && (editingCount || editingPrompt);
    onInputActiveChange(capturesInput);
    return () => onInputActiveChange(false);
  }, [active, editingCount, editingPrompt, onInputActiveChange]);

  useEffect(() => {
    // "stopping" still has a live child we're waiting on: keep
    // navigation locked (and the confirm-quit warning active) until it
    // actually exits.
    onRunningChange(phase === "running" || phase === "stopping");
    return () => onRunningChange(false);
  }, [onRunningChange, phase]);

  /**
   * Recompute the phase checklist and apply-target from every marker the
   * run has emitted so far.
   *
   * This deliberately does NOT read `lines`. That array is capped at
   * TAIL_BUFFER for display, and on a real run an early phase's marker
   * scrolls out of it long before the run ends (a recent 794-line session
   * log emitted `[✓] Scraping job boards` at line 428, 166 lines past the
   * cutoff by the time the run finished). Re-deriving the whole checklist
   * from that window silently reverted completed slots to "pending", and
   * once the live `[•]` marker scrolled out too, currentIndex fell back to
   * the first pending slot, so the screen reported "Scraping job boards
   * (phase 1 of 5)" while the agent was actually applying, and the
   * apply-target line (gated on currentKey === "apply") disappeared at the
   * same moment. Progress state must be sticky; only the log view truncates.
   */
  const applyProgress = (markers: string[]) => {
    markerLines.current = markers;
    setProgress(parsePhaseChecklist(markers));
    setApplyTarget(parseCurrentApplication(markers));
  };

  const commitCount = (): number | null => {
    if (!countInput) {
      setInputMessage("Type a count from 1 to 25 first, then press enter.");
      return null;
    }
    const cap = Math.max(1, Math.min(25, Number.parseInt(countInput, 10)));
    setCountInput(String(cap));
    setCountCursor(String(cap).length);
    setSessionCap(cap);
    setEditingCount(false);
    setInputMessage(
      cap === 25
        ? "MAX cap set: press s to start anyway, or e to lower it."
        : `Ready: press s to start with a ${cap}-application cap.`,
    );
    return cap;
  };

  // POSIX: the concurrent Python-side change gives run_job_agent.py a
  // SIGTERM handler that kills its harness subprocess group and cleans up
  // state gracefully; Node's job there is just to send the plain signal.
  // Windows: graceful signal handling from a Node parent isn't reliably
  // achievable, so force-kill the whole tree via stopProcessTree/taskkill.
  const stopChild = () => {
    const proc = child.current;
    if (!proc) return;
    if (process.platform === "win32") {
      if (proc.pid !== undefined) stopProcessTree(proc.pid);
    } else {
      proc.kill("SIGTERM");
    }
  };

  const start = (capOverride?: number, promptOverride?: string) => {
    const cap = capOverride ?? sessionCap;
    if (phase === "running" || phase === "stopping" || cap === null) return;
    stoppedByUser.current = false;
    setConfirmStop(false);
    setShowLog(false);
    setInputMessage("");
    logBefore.current = latestSessionLog(root);
    setLines([]);
    applyProgress([]);
    setExitCode(null);
    setStartedAt(Date.now());
    setElapsed(0);
    setPhase("running");
    if (promptOverride !== undefined) setPromptInput(promptOverride);
    const extraPrompt = (promptOverride ?? promptInput).trim();
    const runner = py(["src/scripts/runtime/run_job_agent.py"]);
    const proc = spawn(runner.cmd, runner.args, {
      cwd: root,
      // APLYX_SESSION_CAP is the documented name; the legacy FLUX_*/ARES_*
      // names are still set so an un-migrated runner copy honors the cap too.
      env: {
        ...process.env,
        APLYX_SESSION_CAP: String(cap),
        FLUX_SESSION_CAP: String(cap),
        ARES_SESSION_CAP: String(cap),
        ...(extraPrompt ? { APLYX_EXTRA_PROMPT: extraPrompt, FLUX_EXTRA_PROMPT: extraPrompt } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.current = proc;
    const push = (chunk: Buffer) => {
      const incoming = chunk.toString().split("\n").filter(Boolean);
      // Markers accumulate; only the display tail is bounded.
      applyProgress([...markerLines.current, ...markersIn(incoming)]);
      setLines((prev) => [...prev, ...incoming].slice(-TAIL_BUFFER));
    };
    proc.stdout?.on("data", push);
    proc.stderr?.on("data", push);
    proc.on("error", (err) => {
      setLines([`could not start runner: ${err.message}`]);
      setExitCode(1);
      setPhase("done");
    });
    proc.on("close", (code) => {
      setExitCode(code ?? 1);
      // Fast failures (the harness errors out in under a second, before
      // the 1s log-tail poll below ever gets a tick) would otherwise leave
      // `lines` empty and the screen stuck on "waiting for session log…"
      // with no way to see why it failed short of leaving the TUI. By the
      // time close fires, run_job_agent.py has already closed the session
      // log file (its own trailer line is written before it exits), so a
      // direct final read here is always complete and race-free.
      const finalLog = latestSessionLog(root);
      if (finalLog && fs.existsSync(finalLog)) {
        try {
          const content = fs.readFileSync(finalLog, "utf8").trimEnd().split("\n");
          applyProgress(markersIn(content));
          setLines(content.slice(-TAIL_BUFFER));
        } catch {
          /* transient read race; the poll below already stopped mattering */
        }
      }
      if (stoppedByUser.current) {
        stoppedByUser.current = false;
        setPhase("stopped");
        setInputMessage("Run stopped: press s to start again (same cap), or e/p to change it first.");
      } else {
        setPhase("done");
      }
    });
  };

  // Restart-after-correction: once the stopped process has fully exited,
  // relaunch with the same cap and the correction folded in as the extra
  // prompt: the only "resume" a checkpoint-less CLI harness allows. Only
  // fires when a correction actually queued a restart; a plain stop
  // leaves pendingRestart null and "stopped" stays a terminal state.
  useEffect(() => {
    if (phase === "stopped" && pendingRestart) {
      const { cap, prompt } = pendingRestart;
      setPendingRestart(null);
      start(cap, prompt);
    }
    // start() is intentionally not in the dep array: it's a plain
    // function redefined every render, and including it here would just
    // re-run this effect on every keystroke without changing behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pendingRestart]);

  // While running, tail the new session log (the transcript goes to a
  // file, not stdout).
  useEffect(() => {
    if (phase !== "running" && phase !== "stopping") return;
    const poll = setInterval(() => {
      const current = latestSessionLog(root);
      if (current && current !== logBefore.current && fs.existsSync(current)) {
        try {
          const content = fs.readFileSync(current, "utf8").trimEnd().split("\n");
          // The session log is the superset of what `push` saw, so replacing
          // (not appending) the marker set here can't drop or double-count.
          applyProgress(markersIn(content));
          setLines(content.slice(-TAIL_BUFFER));
        } catch {
          /* transient read race; next tick */
        }
      }
    }, 1000);
    return () => clearInterval(poll);
  }, [phase, root]);

  useInput(
    (input, key) => {
      if (editingCount && phase !== "running") {
        if (key.return) commitCount();
        else if (input === "s") {
          // s while typing commits the typed count and starts immediately;
          // otherwise s is a silently dead key until enter is pressed.
          const cap = commitCount();
          if (cap !== null) start(cap);
        } else if (key.escape) {
          setEditingCount(false);
          if (sessionCap === null) {
            setInputMessage("Cap not set: press e to type a count (1–25).");
          }
        } else if (key.leftArrow) {
          const next = moveCursorLeft({ value: countInput, cursor: countCursor });
          setCountCursor(next.cursor);
        } else if (key.rightArrow) {
          const next = moveCursorRight({ value: countInput, cursor: countCursor });
          setCountCursor(next.cursor);
        } else if (key.backspace || key.delete) {
          // macOS Backspace arrives as DEL (0x7f) → key.delete in Ink;
          // both erase backward (see SearchScreen).
          const next = deleteBackward({ value: countInput, cursor: countCursor });
          setCountInput(next.value);
          setCountCursor(next.cursor);
          setSessionCap(null);
        } else if (/^\d+$/.test(input)) {
          const next = insertAtCursor(
            { value: countInput, cursor: countCursor },
            input,
            { maxLength: 2, sanitize: (value) => value.replace(/\D+/g, "") },
          );
          setCountInput(next.value);
          setCountCursor(next.cursor);
          setSessionCap(null);
        }
        return;
      }
      if (editingPrompt && phase === "running") {
        // Correction editor: reuses the exact same InlineTextInput/prompt
        // state as the pre-run p-flow, but submitting here stops the
        // current run and queues a restart instead of just closing.
        if (key.return) {
          if (sessionCap === null) {
            setEditingPrompt(false);
            return;
          }
          const correction = promptInput.trim();
          setEditingPrompt(false);
          setPendingRestart({ cap: sessionCap, prompt: correction });
          stoppedByUser.current = true;
          setInputMessage("Stopping: restarting with your correction…");
          setPhase("stopping");
          stopChild();
        } else if (key.escape) {
          setEditingPrompt(false);
          setInputMessage("Correction cancelled: run continues.");
        } else if (key.leftArrow) {
          const next = moveCursorLeft({ value: promptInput, cursor: promptCursor });
          setPromptCursor(next.cursor);
        } else if (key.rightArrow) {
          const next = moveCursorRight({ value: promptInput, cursor: promptCursor });
          setPromptCursor(next.cursor);
        } else if (key.backspace || key.delete) {
          const next = deleteBackward({ value: promptInput, cursor: promptCursor });
          setPromptInput(next.value);
          setPromptCursor(next.cursor);
        } else if (!key.ctrl && !key.meta && input && !/\p{C}/u.test(input)) {
          const next = insertAtCursor(
            { value: promptInput, cursor: promptCursor },
            input,
            { maxLength: PROMPT_MAX },
          );
          setPromptInput(next.value);
          setPromptCursor(next.cursor);
        }
        return;
      }
      if (editingPrompt && phase !== "running") {
        if (key.return || key.escape) {
          setEditingPrompt(false);
          setInputMessage(
            promptInput.trim()
              ? "Extra prompt set: it is passed to the agent with the run."
              : "No extra prompt: the agent runs the standard workflow.",
          );
        } else if (key.leftArrow) {
          const next = moveCursorLeft({ value: promptInput, cursor: promptCursor });
          setPromptCursor(next.cursor);
        } else if (key.rightArrow) {
          const next = moveCursorRight({ value: promptInput, cursor: promptCursor });
          setPromptCursor(next.cursor);
        } else if (key.backspace || key.delete) {
          const next = deleteBackward({ value: promptInput, cursor: promptCursor });
          setPromptInput(next.value);
          setPromptCursor(next.cursor);
        } else if (!key.ctrl && !key.meta && input && !/\p{C}/u.test(input)) {
          const next = insertAtCursor(
            { value: promptInput, cursor: promptCursor },
            input,
            { maxLength: PROMPT_MAX },
          );
          setPromptInput(next.value);
          setPromptCursor(next.cursor);
        }
        return;
      }
      if (phase === "running") {
        if (confirmStop) {
          if (input === "x") {
            setConfirmStop(false);
            setPendingRestart(null);
            stoppedByUser.current = true;
            setInputMessage("⏹ stopping…");
            setPhase("stopping");
            stopChild();
          } else if (input === "c") {
            setConfirmStop(false);
            setEditingPrompt(true);
            setPromptCursor(promptInput.length);
            setInputMessage("Type a correction, enter to stop & restart with it, esc to cancel.");
          } else if (key.escape) {
            setConfirmStop(false);
            setInputMessage("");
          }
          return;
        }
        if (input === "x") {
          setConfirmStop(true);
          setInputMessage("");
          return;
        }
        if (input === "l") {
          setShowLog((v) => !v);
          return;
        }
        return;
      }
      if (phase === "stopping") return;
      // A run we didn't spawn is still stoppable from here: same two-step
      // x/x confirmation as our own, just signalled by PID instead of
      // through a ChildProcess handle.
      if (foreignPid !== undefined) {
        if (confirmStop) {
          if (input === "x") {
            setConfirmStop(false);
            stopPid(foreignPid);
            setInputMessage(`⏹ stop signal sent to run ${foreignPid}.`);
            setForeignPid(undefined);
          } else if (key.escape) {
            setConfirmStop(false);
            setInputMessage("");
          }
          return;
        }
        if (input === "x") {
          setConfirmStop(true);
          setInputMessage("");
          return;
        }
        if (input === "s") {
          // The runner is single-flight: starting now would just log
          // skipped_overlap and exit 0, which reads as a silent no-op.
          setInputMessage(`A run is already in progress (pid ${foreignPid}): press x to stop it first.`);
          return;
        }
      }
      if (input === "e") {
        setEditingCount(true);
        setSessionCap(null);
        setCountCursor(countInput.length);
        setInputMessage("Enter this cycle's application cap (1–25).");
      }
      if (input === "p") {
        setEditingPrompt(true);
        setPromptCursor(promptInput.length);
        setInputMessage("Optional: type an extra instruction for the agent, enter when done (empty = standard workflow).");
      }
      if (input === "s") {
        if (sessionCap === null) {
          setInputMessage("Set the cycle cap first: press e, type a count (1–25), then enter.");
        } else {
          start();
        }
      }
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );

  // Tier feedback follows what the user is typing, not just the committed
  // value, so "25" glows before enter is pressed.
  const displayCap = editingCount
    ? (countInput ? Math.min(25, Number.parseInt(countInput, 10)) : null)
    : sessionCap;
  const tier = displayCap !== null && Number.isFinite(displayCap) ? capTier(displayCap) : null;

  // Cockpit gauge + outcome counters: idle/done/stopped only (see
  // showCockpit below); the live running view replaces all of this with
  // the phase checklist.
  const gaugeFill =
    displayCap !== null && Number.isFinite(displayCap)
      ? Math.max(1, Math.round((displayCap / 25) * GAUGE_WIDTH))
      : 0;
  const gauge = "█".repeat(gaugeFill) + "░".repeat(GAUGE_WIDTH - gaugeFill);
  const heartbeat = readHeartbeat(root);
  const runClock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  // Which coding agent this run actually invokes doesn't change mid-run;
  // resolving it fresh each render is a cheap couple of small file reads,
  // not worth caching in state for a value that only affects a color.
  const runGradient = harnessGradient(resolveHarnessId(root));
  // Cockpit chrome: title, gauge, prompt, counters, message, log header,
  // margins. What's left belongs to the log tail (only shown via the l
  // toggle while running, or always once a run is done/stopped).
  const tailRows = Math.max(5, contentRows - (displayCap === 25 ? 10 : 9));

  const isLive = phase === "running" || phase === "stopping";
  const showCockpit = !isLive;
  const phaseInfo = isLive ? progress : null;
  const doneCount = phaseInfo ? phaseInfo.slots.filter((s) => s.state === "done").length : 0;
  const allDone = phaseInfo ? doneCount === phaseInfo.slots.length : false;
  const progressRatio = phaseInfo
    ? allDone
      ? 1
      : Math.min(1, (doneCount + 0.5) / phaseInfo.slots.length)
    : 0;
  // Only meaningful while the apply phase is actually current: once the
  // run moves on to Report, the last apply-marker is stale and showing it
  // would misleadingly suggest that job is still in progress.
  const currentApplication = isLive && phaseInfo?.currentKey === "apply" ? applyTarget : null;

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Jobs <Text dimColor>automatic run</Text>{" "}
        {phase === "running" ? (
          <Text>
            <SpinnerGlyph color={runGradient[0]} />{" "}
            <AutoSparkleText gradient={runGradient} tickMs={HARNESS_WAVE_TICK_MS} offsetStep={HARNESS_WAVE_STEP}>
              {`running ${runClock}`}
            </AutoSparkleText>
          </Text>
        ) : phase === "stopping" ? (
          <Text color={theme.warn}>
            <SpinnerGlyph color={theme.warn} /> stopping…
          </Text>
        ) : phase === "stopped" ? (
          <Text color={theme.warn}>⏹ stopped at {runClock}</Text>
        ) : phase === "done" ? (
          exitCode === 0 ? (
            <Text color={theme.good}>{statusGlyph.applied} complete in {runClock}</Text>
          ) : (
            <Text color={theme.danger}>
              {statusGlyph.failed} exited {exitCode}: see session log below
            </Text>
          )
        ) : (
          <Text dimColor>idle</Text>
        )}
      </Text>

      {showCockpit ? (
        <>
          <Box marginTop={1}>
            <Text dimColor>cap     </Text>
            {displayCap === 25 ? (
              // MAX: the gauge itself goes rainbow, matching the warning line.
              <RainbowText>{gauge}</RainbowText>
            ) : (
              <Text color={tier?.color}>{gauge}</Text>
            )}
            <Text>{"  "}</Text>
            <InlineTextInput
              value={countInput}
              cursor={countCursor}
              active={editingCount}
              placeholder="1–25"
            />
            <Text dimColor>/25</Text>
            {tier ? (
              <Text bold color={tier.color}>
                {"  "}{tier.name}
              </Text>
            ) : null}
          </Box>
          {displayCap === 25 ? (
            <Box>
              <Text>{"             "}</Text>
              <RainbowText>⚠ MAX: 25 applications will eat through your token budget</RainbowText>
            </Box>
          ) : null}

          <Box>
            <Text dimColor>prompt  </Text>
            <InlineTextInput
              value={promptInput}
              cursor={promptCursor}
              active={editingPrompt}
              placeholder="(none: standard workflow)"
              wrap="truncate-end"
            />
          </Box>

          {/* Outcome counters: heartbeat counts from the last completed
              run. Only shown idle/done/stopped; while a run is live these
              are stale (previous run's numbers) so the phase checklist
              replaces them entirely. */}
          <Box>
            <Text dimColor>{phase === "done" || phase === "stopped" ? "run     " : "last    "}</Text>
            {heartbeat ? (
              <>
                <Text bold color={theme.good}>{heartbeat.last_run_counts?.applied ?? 0}</Text>
                <Text dimColor> applied  </Text>
                <Text bold color={theme.warn}>{heartbeat.last_run_counts?.needs_review ?? 0}</Text>
                <Text dimColor> review  </Text>
                <Text bold color={theme.danger}>{heartbeat.last_run_counts?.failed ?? 0}</Text>
                <Text dimColor> failed  </Text>
                <Text dimColor>{heartbeat.last_run_counts?.skipped_unfit ?? 0} unfit</Text>
              </>
            ) : (
              <Text dimColor>no runs recorded yet</Text>
            )}
          </Box>
        </>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">{inputMessage}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {phase === "idle" && foreignPid !== undefined ? (
          <Box flexDirection="column">
            <Text color={theme.warn}>
              <SpinnerGlyph color={theme.warn} /> A run is in progress (pid {foreignPid}), started by the
              scheduler, or left running when the TUI was last quit.
            </Text>
            <Text dimColor>Its progress isn't streamed here, but you can stop it.</Text>
            <Box marginTop={1}>
              {confirmStop ? (
                <KeyHints hints="x confirm stop · esc cancel" />
              ) : (
                <KeyHints hints="x stop this run" />
              )}
            </Box>
          </Box>
        ) : phase === "idle" ? (
          <Box flexDirection="column">
            <Text dimColor>{statusGlyph.needs_review} No run in progress.</Text>
            <Box marginTop={1} flexDirection="column">
              <Text>
                {sessionCap === null ? (
                  <>Press <Text bold color={theme.accent}>e</Text>, type a count, then enter. Optional: <Text bold color={theme.accent}>p</Text> for an extra prompt.</>
                ) : (
                  <>Press <Text bold color={theme.accent}>s</Text> to start via{" "}<Text dimColor>src/scripts/runtime/run_job_agent.py</Text></>
                )}
              </Text>
              <Text dimColor>scrapes configured boards · fit-gates · tailors · applies ({sessionCap ?? "–"}/25 cap)</Text>
            </Box>
          </Box>
        ) : isLive ? (
          editingPrompt ? (
            <Box flexDirection="column">
              <Text dimColor>correction</Text>
              <Box>
                <Text dimColor>prompt  </Text>
                <InlineTextInput
                  value={promptInput}
                  cursor={promptCursor}
                  active={editingPrompt}
                  placeholder="(type your correction)"
                  wrap="truncate-end"
                />
              </Box>
            </Box>
          ) : showLog ? (
            lines.length === 0 ? (
              <Text dimColor>waiting for session log…</Text>
            ) : (
              <Box flexDirection="column">
                <Text dimColor>session log</Text>
                {lines.slice(-tailRows).map((line, i) => (
                  <Text key={i} dimColor wrap="truncate-end">
                    {line}
                  </Text>
                ))}
              </Box>
            )
          ) : (
            <Box flexDirection="column">
              <Box>
                <Text dimColor>[</Text>
                <GradientProgressBar ratio={progressRatio} width={PROGRESS_BAR_WIDTH} gradient={runGradient} />
                <Text dimColor>]</Text>
                <Text>{"  "}</Text>
                {phaseInfo ? (
                  <Text dimColor wrap="truncate-end">
                    {phaseInfo.caption} (phase {phaseInfo.currentIndex + 1} of {phaseInfo.slots.length})
                  </Text>
                ) : (
                  <AutoSparkleText gradient={runGradient} tickMs={HARNESS_WAVE_TICK_MS} offsetStep={HARNESS_WAVE_STEP}>
                    {"run in progress…"}
                  </AutoSparkleText>
                )}
              </Box>
              {phaseInfo ? (
                <Box marginTop={1}>
                  <Text wrap="truncate-end">
                    {phaseInfo.slots.map((s, i) => (
                      <Text key={i}>
                        {i > 0 ? "   " : ""}
                        <Text
                          bold={s.state === "current"}
                          dimColor={s.state === "pending"}
                          color={s.state === "done" ? theme.good : s.state === "current" ? theme.accent : undefined}
                        >
                          {s.state === "done" ? (
                            "✓"
                          ) : s.state === "current" ? (
                            <SpinnerGlyph color={theme.accent} />
                          ) : (
                            "○"
                          )}{" "}
                          {s.label}
                        </Text>
                      </Text>
                    ))}
                  </Text>
                </Box>
              ) : null}
              {currentApplication ? (
                <Box marginTop={1}>
                  <Text dimColor>applying to </Text>
                  <Text bold color={theme.accent} wrap="truncate-end">
                    {currentApplication.title}
                  </Text>
                  <Text dimColor> @ </Text>
                  <Text bold color={theme.accent} wrap="truncate-end">
                    {currentApplication.company}
                  </Text>
                </Box>
              ) : null}
              <Box marginTop={1}>
                {phase === "stopping" ? null : confirmStop ? (
                  <KeyHints hints="x confirm stop · c stop & correct · esc cancel" />
                ) : (
                  <KeyHints hints={`x stop this run · l ${showLog ? "hide" : "view"} log`} />
                )}
              </Box>
            </Box>
          )
        ) : lines.length === 0 ? (
          <Text dimColor>waiting for session log…</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>session log</Text>
            {lines.slice(-tailRows).map((line, i) => (
              <Text key={i} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export const RUN_HINTS = "e cap · p prompt · s start";
// While a run is live e/p/s are all dead keys: the hint bar must advertise
// what actually works, or `x` stays undiscoverable and `q` (which leaves the
// run going) looks like the only way out.
export const RUN_LIVE_HINTS = "x stop this run · c stop & correct · l log";
export const RUN_EDIT_HINTS = "type · ←→ move · backspace erase · enter set · esc done";
