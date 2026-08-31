import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Banner, bannerHeight } from "./Banner.js";
import { StatusScreen } from "./StatusScreen.js";
import { ReviewScreen, REVIEW_HINTS } from "./ReviewScreen.js";
import { DocumentsScreen, DOCUMENTS_HINTS } from "./DocumentsScreen.js";
import { HistoryScreen, HISTORY_HINTS } from "./HistoryScreen.js";
import { RunScreen, RUN_HINTS, RUN_LIVE_HINTS, RUN_EDIT_HINTS } from "./RunScreen.js";
import { LettersScreen, LETTERS_HINTS, LETTERS_EDIT_HINTS } from "./LettersScreen.js";
import { SearchScreen, SEARCH_HINTS, SEARCH_EDIT_HINTS } from "./SearchScreen.js";
import { SettingsScreen, SETTINGS_HINTS, SETTINGS_SECTION_HINTS } from "./SettingsScreen.js";
import { ResumesScreen, RESUMES_HINTS, RESUMES_PROMPT_HINTS } from "./ResumesScreen.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { WelcomeScreen, type WelcomeOption } from "./WelcomeScreen.js";
import { KeyHints, AutoSparkleText } from "./KeyHints.js";
import { SidePanel, TopStatusBar } from "./SidePanel.js";
import { UpdateBox } from "./UpdateBox.js";
import { AutomaticModeGate } from "./AutomaticModeGate.js";
import { loadState, isResolved, lastRunLine, latestSessionLog, readHeartbeat } from "@aplyx/core/state.js";
import { displayName } from "@aplyx/core/settings.js";
import { readMasterResume } from "@aplyx/core/masterResume.js";
import { effectiveHarness } from "../harness.js";
import type { AplyxState } from "@aplyx/core/state.js";
import {
  theme,
  MIN_COLUMNS,
  MIN_ROWS,
  SELECT_MARKER,
  SIDE_PANEL_WIDTH,
  applyThemeMode,
  resolveThemeMode,
  applyReducedMotion,
  resolveReducedMotion,
  resolveHour24Clock,
  bannerGradient,
} from "../theme.js";

export type Tab = "status" | "jobs" | "review" | "documents" | "letters" | "history" | "resumes" | "settings";
export type Mode = "manual" | "automatic";
const TABS: Tab[] = ["status", "jobs", "review", "documents", "letters", "history", "resumes", "settings"];
const TAB_LABEL: Record<Tab, string> = {
  status: "Status",
  jobs: "Jobs",
  review: "Review",
  documents: "Documents",
  letters: "Letters",
  history: "History",
  resumes: "Resumes",
  settings: "Config",
};
const TAB_HINTS: Omit<Record<Tab, string>, "jobs"> = {
  status: "",
  review: REVIEW_HINTS,
  documents: DOCUMENTS_HINTS,
  letters: LETTERS_HINTS,
  history: HISTORY_HINTS,
  resumes: RESUMES_HINTS,
  settings: SETTINGS_HINTS,
};

const WELCOME_OPTIONS: Array<WelcomeOption & { tab: Tab; mode?: Mode }> = [
  {
    label: "Manual job search",
    description: "Browse live postings, fit-check them on demand, and save promising roles into Review.",
    tab: "jobs",
    mode: "manual",
  },
  {
    label: "Automatic run",
    description: "Set a run cap, optionally add one extra instruction, then launch the full agent workflow.",
    tab: "jobs",
    mode: "automatic",
  },
  {
    label: "Review queue",
    description: "Open saved postings, mark them applied, or dismiss them without leaving the helper-backed flow.",
    tab: "review",
  },
  {
    label: "Documents",
    description: "Read the tailored resume bullets and cover letter aplyx produced for a queued posting: view-only, so nothing here can be mistakenly changed.",
    tab: "documents",
  },
  {
    label: "Interest letters",
    description:
      "Answer the \"why do you want to work here?\" questions aplyx parked instead of guessing. Write your own, or have aplyx draft one for you to edit and approve.",
    tab: "letters",
  },
  {
    label: "Status overview",
    description: "See outcome counts, scheduler health, and the current queue at a glance.",
    tab: "status",
  },
  {
    label: "Application history",
    description: "Browse recorded applications and outcomes in one place.",
    tab: "history",
  },
  {
    label: "Resumes",
    description: "See which base resumes aplyx can find, open the data/resumes/ folder, and convert a newly added PDF to markdown so the tailoring agent can use it.",
    tab: "resumes",
  },
  {
    label: "Settings",
    description: "See what everything is currently set to, then change it: personal info (and the name aplyx calls you), Discord webhooks, and environment overrides like the log directory.",
    tab: "settings",
  },
];

function welcomeIndexFor(tab: Tab, mode: Mode): number {
  if (tab === "jobs") return mode === "automatic" ? 1 : 0;
  if (tab === "review") return 2;
  if (tab === "documents") return 3;
  if (tab === "letters") return 4;
  if (tab === "history") return 6;
  if (tab === "resumes") return 7;
  if (tab === "settings") return 8;
  return 5;
}

/** stdout size with an NaN-proof fallback (Number(undefined) is NaN,
 *  which `??` would happily keep). */
function stdoutSize(): { columns: number; rows: number } {
  const env = (name: string, fallback: number) => {
    const n = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    columns: process.stdout.columns || env("COLUMNS", 80),
    rows: process.stdout.rows || env("LINES", 24),
  };
}

/** The persistent shell: banner, tab row, content region, key-hint bar.
 *  Every band is derived from the live terminal size and re-derived on
 *  resize; nothing is laid out from fixed dimensions. */
export function App({
  root,
  initialTab = "status",
  updateVersion,
  onUpdateInstall,
  onInstallDesktopApp,
}: {
  root: string;
  initialTab?: Tab;
  updateVersion?: string;
  onUpdateInstall?: () => void;
  /** Fired (via SettingsScreen) when the user triggers "Install desktop
   *  app" from Settings: same exit-then-run-on-the-normal-screen handoff
   *  as onUpdateInstall, see cli.tsx's openApp. */
  onInstallDesktopApp?: () => void;
}) {
  const { exit } = useApp();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [mode, setMode] = useState<Mode>("manual");
  const [state, setState] = useState<AplyxState>(() => loadState(root));
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [childInputActive, setChildInputActive] = useState(false);
  const [runInProgress, setRunInProgress] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  // Update prompt: shown once per session when cli.tsx detected a newer
  // upstream VERSION. Dismissed on "no"; "yes" hands off to cli.tsx
  // (which runs src/scripts/install/update.py after the TUI exits the alt screen).
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const showUpdateBox = Boolean(updateVersion) && !updateDismissed;
  // The welcome walkthrough opens every plain `aplyx` launch; jumping
  // straight to a screen (`aplyx review`) skips it.
  const [welcome, setWelcome] = useState(initialTab === "status");
  const [welcomeCursor, setWelcomeCursor] = useState(() => welcomeIndexFor(initialTab, "manual"));
  const [size, setSize] = useState(stdoutSize);
  const { columns, rows } = size;
  const [hour24, setHour24] = useState(() => resolveHour24Clock(root));

  // Settings' Theme / Reduced motion / 24-hour clock fields (Preferences
  // section) apply in-session, not just on next launch; applied here
  // via a lazy useState initializer (not a useEffect) specifically so
  // relaunching never shows the wrong theme, even briefly. A useEffect
  // runs AFTER the first paint/commit, and mutating the shared `theme`
  // object (applyThemeMode's whole mechanism) doesn't itself trigger a
  // re-render; only `setHour24` did, and only when the persisted value
  // actually differed from `hour24`'s own initial useState above, which
  // it usually didn't (that already reads the correct value from the
  // start). So the very first paint always used module-load theme
  // defaults, and unless something UNRELATED happened to re-render the
  // tree shortly after mount, that flash never got corrected: "the
  // theme doesn't show up properly" was really "no re-render ever
  // happened to fix it," not a resolution/persistence bug. A lazy
  // useState initializer runs synchronously as part of the FIRST render
  // itself, before anything paints, so theme/reduced-motion are already
  // correct by the time Banner/SidePanel/etc. render in that same pass:
  // deterministic every launch, not dependent on what else happens to
  // trigger a re-render afterward. refresh() (below) still re-applies
  // both on every tab switch, for in-session edits.
  useState(() => {
    applyThemeMode(resolveThemeMode(root));
    applyReducedMotion(resolveReducedMotion(root));
  });

  useEffect(() => {
    // Debounced for the same reason as altScreen.ts's onResize: a single
    // user resize can fire a burst of 'resize' events (Windows Terminal's
    // maximize/snap animation reports several intermediate sizes), and
    // reacting to every one re-renders the whole shell that many times in
    // a row; visible as flicker, worst in the last-painted rows (hint
    // bar, sidebar). Settling on the final size before re-rendering
    // collapses the burst into one update.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => setSize(stdoutSize()), 80);
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  }, []);

  const refresh = useCallback(() => {
    setState(loadState(root));
    applyThemeMode(resolveThemeMode(root));
    applyReducedMotion(resolveReducedMotion(root));
    setHour24(resolveHour24Clock(root));
    setRefreshNonce((n) => n + 1);
  }, [root]);

  const switchTab = useCallback(
    (next: Tab) => {
      if (runInProgress && next !== "jobs") return;
      setTab(next);
      refresh();
    },
    [refresh, runInProgress],
  );

  const openWelcomeSelection = useCallback(() => {
    const next = WELCOME_OPTIONS[welcomeCursor] ?? WELCOME_OPTIONS[0];
    if (runInProgress && next.tab !== "jobs") return;
    if (next.mode) setMode(next.mode);
    setTab(next.tab);
    setWelcome(false);
    refresh();
  }, [refresh, runInProgress, welcomeCursor]);

  useInput(
    (input, key) => {
      // Help overlay swallows everything; any close-ish key dismisses it.
      if (helpOpen) {
        if (input === "?" || key.escape || input === "q" || key.return) setHelpOpen(false);
        return;
      }
      // Welcome page is a real menu: the first interaction should route
      // the user somewhere useful, not just dismiss the screen.
      if (welcome) {
        if (input === "q") return exit();
        if (input === "?") return setHelpOpen(true);
        if (key.return) return openWelcomeSelection();
        if (key.tab || key.downArrow || input === "j") {
          return setWelcomeCursor((current) => (current + 1) % WELCOME_OPTIONS.length);
        }
        if (key.upArrow || input === "k") {
          return setWelcomeCursor((current) =>
            (current + WELCOME_OPTIONS.length - 1) % WELCOME_OPTIONS.length,
          );
        }
        return;
      }
      if (input === "q") {
        // Quitting mid-run is allowed (the run keeps going in the
        // background) but never on a single accidental keypress.
        if (runInProgress && !confirmQuit) {
          setConfirmQuit(true);
          return;
        }
        return exit();
      }
      setConfirmQuit(false);
      if (input === "?") return setHelpOpen(true);
      // esc backs out of any screen to the welcome menu (never quits, and
      // never mid-run: navigation is locked while an agent run is live).
      // Screens' own esc handling happens while typing, which deactivates
      // this handler via childInputActive.
      if (input === "w" || key.escape) {
        if (key.escape && runInProgress) return;
        setWelcomeCursor(welcomeIndexFor(tab, mode));
        return setWelcome(true);
      }
      if (input === "R") return refresh();
      if (input === "m") {
        if (runInProgress) return;
        setMode((current) => (current === "manual" ? "automatic" : "manual"));
        return;
      }
      if (key.tab || key.rightArrow) {
        const step = key.tab && key.shift ? TABS.length - 1 : 1;
        return switchTab(TABS[(TABS.indexOf(tab) + step) % TABS.length]);
      }
      if (key.leftArrow) {
        return switchTab(TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length]);
      }
      const idx = Number.parseInt(input, 10);
      if (idx >= 1 && idx <= TABS.length) switchTab(TABS[idx - 1]);
    },
    { isActive: Boolean(process.stdin.isTTY) && !childInputActive },
  );

  const unresolved = state.queue.filter((e) => !isResolved(state, e)).length;
  // Cheap fs read, re-checked every render (no caching): same convention
  // pendingConversionCount used to follow before the single-resume model
  // replaced it. Badge is a plain "needs attention" marker now, not a
  // count: there's only ever one resume, so there's nothing left to
  // count once it has real content.
  const resumeForBadge = readMasterResume(root);
  const resumeNeedsAttention = !(resumeForBadge && (resumeForBadge.experience.length > 0 || resumeForBadge.projects.length > 0));
  // Automatic run's gate (AutomaticModeGate): only computed on the Jobs
  // tab in automatic mode, since both checks are real fs/PATH work and
  // every other tab has no use for them. Re-run fresh every render (no
  // caching here or in the helpers themselves), so installing a coding
  // agent or adding a resume while the TUI is open clears the block on
  // the very next render: a tab switch (which already calls refresh())
  // or the m key toggling back and forth is enough, no restart needed.
  const automaticGateActive = tab === "jobs" && mode === "automatic" && !welcome;
  // @resume-tailor reads data/resumes/resume.json now, not the old
  // per-category .md files; a resume with only contact info filled in
  // has nothing to tailor from either, so this checks for at least one
  // real experience or project entry, not just the file's existence.
  const masterResumeForGate = automaticGateActive ? readMasterResume(root) : null;
  const missingResume = automaticGateActive && !(masterResumeForGate && (masterResumeForGate.experience.length > 0 || masterResumeForGate.projects.length > 0));
  const missingHarness = automaticGateActive && !effectiveHarness(root);
  const counts = { applied: 0, needsReview: 0, failed: 0 };
  for (const job of state.applied) {
    if (job.status === "applied") counts.applied += 1;
    if (job.status === "needs_review") counts.needsReview += 1;
    if (job.status === "failed") counts.failed += 1;
  }
  const heartbeat = readHeartbeat(root);
  const lastRun = lastRunLine(root);
  const sessionLog = latestSessionLog(root);

  // Below the supported minimum, show a designed notice instead of a
  // corrupted layout.
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={2} alignItems="center">
        <Text bold color={theme.accent}>
          aplyx
        </Text>
        <Text dimColor>terminal too small</Text>
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <Text dimColor>need at least {MIN_COLUMNS}×{MIN_ROWS}, have {columns}×{rows}</Text>
          <Text dimColor>resize or widen the window, then reopen with `aplyx`</Text>
        </Box>
      </Box>
    );
  }

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // Computed early (moved ahead of showSidebar, below, and the rest of
  // the chrome-row math further down, which reuses it): the update box's
  // own fixed row budget, so sidebar visibility can account for it
  // instead of assuming it never needs to compete for vertical room with
  // the box.
  const updateRows = showUpdateBox ? 7 : 0; // update box margin 1 + box height 6
  // Side panel: shown when the terminal is wide and tall enough; below
  // the threshold it hides and the content takes the full width (clean
  // degradation on narrower/shorter terminals).
  // 72 (not 64): the welcome menu column needs ~44 cols, so the sidebar
  // only appears once the content band keeps at least ~48 cols beside it:
  // below that the two columns collided and wrapped, corrupting the frame
  // on resize.
  // Never on the Jobs tab: its results table wants the full content width
  // (posted/location/fit columns) more than the sidebar's stats do, and
  // the greeting/clock that used to live only in the sidebar now show in
  // the header on every tab (TopStatusBar, below) so nothing is lost.
  // rows >= 18 + updateRows: on a short terminal, showing the update box
  // eats 7 more rows out of the same budget; without accounting for that
  // here, the sidebar kept claiming its full natural content height (see
  // the height/overflow constraint added on its Box below) right up
  // against where the update box needed to start, which is what made the
  // box's top border look "eaten" by the sidebar on shorter terminals.
  const showSidebar = columns >= 72 && rows >= 18 + updateRows && tab !== "jobs";
  const sideOverhead = showSidebar ? SIDE_PANEL_WIDTH + 2 : 0; // panel + gutter
  // On very wide terminals, center a readable content column instead of
  // leaving the right half of the screen empty: the horizontal padding
  // grows so the ~140-col band sits mid-screen. The banner centers itself.
  // The sidebar's overhead is added to the centered band so the content
  // area stays as wide as it was without the sidebar. The band is wider
  // than before (140 vs 110) and the centering threshold higher (160 vs
  // 120) so content fills more of the screen on moderately wide terminals
  // instead of leaving large empty margins.
  const pad = columns > 160 + sideOverhead ? Math.floor((columns - 140 - sideOverhead) / 2) : 1;
  const ruleWidth = Math.max(0, columns - pad * 2);
  // Floor keeps downstream width math sane on the smallest supported sizes.
  const contentCols = Math.max(24, columns - pad * 2 - sideOverhead);

  // Responsive layout math: the shell chrome (banner, mode row, tabs,
  // rule, margins, hint bar) is measured, and what's left is handed to
  // the active screen so lists grow on tall terminals and shrink on
  // short ones instead of assuming a fixed page size.
  const bannerRows = bannerHeight(columns, rows);
  const chromeRows = bannerRows + 7 + updateRows; // mode 1 + tabs 2 + rule 1 + content margin 1 + hints 2
  const contentRows = Math.max(6, rows - chromeRows);

  // The hint bar always reflects what the keyboard will actually do right
  // now: typing captures keys (screens tell us via childInputActive), a
  // live run locks navigation, and everything else gets the standard set.
  // Every chunk is "key description" so KeyHints can color the key caps.
  let tabHints: string;
  if (tab === "jobs") {
    if (mode === "automatic" && (missingResume || missingHarness)) tabHints = "";
    else if (childInputActive) tabHints = mode === "manual" ? SEARCH_EDIT_HINTS : RUN_EDIT_HINTS;
    else if (runInProgress) tabHints = RUN_LIVE_HINTS;
    else tabHints = mode === "manual" ? SEARCH_HINTS : RUN_HINTS;
  } else if (tab === "settings" && childInputActive) {
    tabHints = SETTINGS_SECTION_HINTS;
  } else if (tab === "letters" && childInputActive) {
    tabHints = LETTERS_EDIT_HINTS;
  } else if (tab === "resumes" && childInputActive) {
    tabHints = RESUMES_PROMPT_HINTS;
  } else {
    tabHints = TAB_HINTS[tab];
  }
  const globalHints = childInputActive
    ? "" // the edit hints above are the whole story while typing
    : runInProgress
      // Spelled out because quitting does NOT stop the run: users reached
      // for q expecting it to, then had no way to end the run at all.
      ? "q quit (run keeps going)"
      : "1-8/←→ tabs · esc/w menu · m mode · R reload · ? help · q quit";
  const allHints = [tabHints, globalHints].filter(Boolean).join(" · ");

  // The frame is pinned to exactly the viewport height with overflow
  // clipped: a frame taller than the terminal is unmanageable for Ink
  // (it can't erase what scrolled away), which is what corrupts the
  // screen on resize and clips the banner. Children stack from the top
  // with no flex spacer, so the hint bar still hugs the content; the
  // unused rows sit below it. Screens size themselves from contentRows
  // so they fit instead of being clipped.
  return (
    <Box flexDirection="column" height={tty ? rows : undefined} overflow="hidden">
      <Banner columns={columns} rows={rows} accent={theme.accent} gradient={bannerGradient()} />
      <Box paddingX={pad} justifyContent="space-between">
        <TopStatusBar firstName={displayName(root)} hour24={hour24} />
        <Box>
          <Text dimColor>MODE </Text>
          {mode === "manual" ? (
            <Text bold color={theme.accent}>
              MANUAL
            </Text>
          ) : (
            <AutoSparkleText>AUTO</AutoSparkleText>
          )}
        </Box>
      </Box>
      {/* Tab row */}
      {/* gap is 1, not 2: at 7 tabs a 2-column gap pushed the row past 71
          columns, and a wrapped tab row corrupts the frame below it (same
          class as the earlier popup/source-row overflow bugs). See
          MIN_COLUMNS in theme.ts for the width this row is budgeted. */}
      <Box paddingX={pad} marginTop={1}>
        {TABS.map((t, i) => (
          <Box key={t} marginRight={1}>
            {t === tab && !welcome ? (
              <Text bold color="white">
                {i + 1}{" "}
              </Text>
            ) : (
              <Text dimColor>{i + 1} </Text>
            )}
            {t === tab && !welcome ? (
              <Text bold color={theme.accent}>
                {SELECT_MARKER} {TAB_LABEL[t]}
              </Text>
            ) : (
              <Text dimColor>{TAB_LABEL[t]}</Text>
            )}
            {t === "review" && unresolved > 0 ? (
              <Text color={theme.warn}> ({unresolved})</Text>
            ) : null}
            {t === "resumes" && resumeNeedsAttention ? (
              <Text color={theme.warn}> (!)</Text>
            ) : null}
          </Box>
        ))}
      </Box>
      {/* Header rule: anchors the header band. */}
      <Box paddingX={pad}>
        <Text color={theme.rule}>{"─".repeat(ruleWidth)}</Text>
      </Box>
{/* Content region. The help overlay hides (never unmounts) the active
           screen: unmounting RunScreen mid-run would drop the log tail and
           reset the run lock-out. flexGrow=1 fills the remaining vertical
           space so the hint bar pins to the bottom and the side panel
           stretches to the full content height (its build marker sits at
           the bottom via an internal flex spacer). The sidebar sits on the
           RIGHT with a dedicated left-border separator so the boundary
           between main content and sidebar is unmistakable. */}
      <Box
        paddingX={pad}
        marginTop={1}
        flexDirection="row"
        flexGrow={1}
        overflow="hidden"
      >
        {/* Explicit width (not just flexGrow): nested row layouts inside
            screens have wide min-content and would otherwise push into
            the sidebar; with a fixed band the inner Texts truncate.
            Explicit height, too (added alongside the sidebar's matching
            fix): `overflow="hidden"` alone doesn't clip anything unless
            the box's own layout size is pinned to something; without it,
            a screen whose natural content runs longer than contentRows
            (WelcomeScreen's item list + per-option description text,
            observed live) grew this box past its budget, pushing the
            whole document past `rows`, and whatever didn't fit got
            clipped from wherever the overflow physically landed, which
            could be the update box below, even though it did nothing
            wrong itself. Pinning height here is what actually enforces
            the budget contentRows only computes. */}
        <Box flexDirection="column" width={contentCols} height={contentRows} flexShrink={0} overflow="hidden">
          {welcome ? (
            <WelcomeScreen
              contentRows={contentRows}
              columns={contentCols}
              options={WELCOME_OPTIONS}
              cursor={welcomeCursor}
              counts={counts}
              unresolvedQueue={unresolved}
              registryCount={state.registry.length}
              heartbeat={heartbeat}
              lastRun={lastRun}
            />
          ) : (
            <>
              {helpOpen ? <HelpOverlay contentRows={contentRows} /> : null}
              <Box display={helpOpen ? "none" : "flex"} flexDirection="column">
                {tab === "status" ? (
                  <StatusScreen
                    state={state}
                    lastRun={lastRun}
                    sessionLog={sessionLog}
                    unresolvedQueue={unresolved}
                    heartbeat={heartbeat}
                    embedded
                    contentRows={contentRows}
                    columns={contentCols}
                  />
                ) : tab === "jobs" ? (
                  mode === "manual" ? (
                    <SearchScreen
                      root={root}
                      active={!helpOpen}
                      onInputActiveChange={setChildInputActive}
                      onStateChange={refresh}
                      contentRows={contentRows}
                      columns={contentCols}
                    />
                  ) : missingResume || missingHarness ? (
                    <AutomaticModeGate
                      missingResume={missingResume}
                      missingHarness={missingHarness}
                      contentRows={contentRows}
                    />
                  ) : (
                    <RunScreen
                      root={root}
                      active={!helpOpen}
                      onInputActiveChange={setChildInputActive}
                      onRunningChange={setRunInProgress}
                      contentRows={contentRows}
                    />
                  )
                ) : tab === "review" ? (
                  <ReviewScreen
                    root={root}
                    active={tab === "review" && !helpOpen}
                    refreshNonce={refreshNonce}
                    onStateChange={refresh}
                    contentRows={contentRows}
                    columns={contentCols}
                  />
                ) : tab === "documents" ? (
                  <DocumentsScreen
                    root={root}
                    active={tab === "documents" && !helpOpen}
                    refreshNonce={refreshNonce}
                    contentRows={contentRows}
                    columns={contentCols}
                  />
                ) : tab === "letters" ? (
                  <LettersScreen
                    root={root}
                    active={tab === "letters" && !helpOpen}
                    onInputActiveChange={setChildInputActive}
                    contentRows={contentRows}
                    contentColumns={contentCols}
                    nonce={refreshNonce}
                  />
                ) : tab === "history" ? (
                  <HistoryScreen
                    state={state}
                    active={tab === "history" && !helpOpen}
                    contentRows={contentRows}
                    columns={contentCols}
                  />
                ) : tab === "resumes" ? (
                  <ResumesScreen
                    root={root}
                    active={tab === "resumes" && !helpOpen}
                    onInputActiveChange={setChildInputActive}
                    contentRows={contentRows}
                  />
                ) : (
                  <SettingsScreen
                    root={root}
                    active={tab === "settings" && !helpOpen}
                    onInputActiveChange={setChildInputActive}
                    onSettingsChange={refresh}
                    onInstallDesktopApp={
                      onInstallDesktopApp
                        ? () => {
                            onInstallDesktopApp();
                            exit();
                          }
                        : undefined
                    }
                    contentRows={contentRows}
                    columns={contentCols}
                  />
                )}
              </Box>
            </>
          )}
        </Box>
        {showSidebar ? (
          <Box
            flexDirection="column"
            marginLeft={1}
            width={SIDE_PANEL_WIDTH + 1}
            // height + overflow: without an explicit height, a flex child
            // with no flexGrow of its own renders at its natural content
            // size (SidePanel's ~10 rows) regardless of how much room this
            // row actually has; it never shrank to fit contentRows the
            // way the main content column does. On a short terminal (or
            // any time the update box's own 7-row reservation left less
            // room than the sidebar's natural height), the sidebar just
            // kept rendering its full height anyway, growing into the
            // space the update box needed and making its top border look
            // like it had been overwritten. contentRows already accounts
            // for the update box's reservation (see chromeRows above), so
            // constraining to it here is what actually enforces that
            // budget instead of just computing it.
            height={contentRows}
            flexShrink={0}
            overflow="hidden"
            borderStyle="single"
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            borderColor={theme.rule}
          >
            <SidePanel
              applied={counts.applied}
              pending={unresolved}
              failed={counts.failed}
              seen={state.registry.length}
              heartbeat={heartbeat}
              screen={welcome ? "Menu" : TAB_LABEL[tab]}
              mode={mode}
            />
          </Box>
        ) : null}
      </Box>
      {/* Update prompt: bottom-right band above the hint bar. Shown
          once per session when a newer upstream VERSION was detected at
          launch. Keyboard-first (y/n); see UpdateBox for the mouse note. */}
      {showUpdateBox ? (
        <Box paddingX={pad} marginTop={1} justifyContent="flex-end">
          <UpdateBox
            version={updateVersion!}
            active={!childInputActive}
            columns={columns}
            rows={rows}
            pad={pad}
            onYes={() => {
              onUpdateInstall?.();
              exit();
            }}
            onNo={() => setUpdateDismissed(true)}
          />
        </Box>
      ) : null}
      {/* Hint bar: pinned to the bottom as a status bar. */}
      <Box paddingX={pad} marginTop={1}>
        {confirmQuit ? (
          <Text color={theme.warn}>
            A run is in progress: press q again to quit (the run keeps going in the background), any other key to stay.
          </Text>
        ) : helpOpen ? (
          <KeyHints hints="?/esc/enter close help" />
        ) : welcome ? (
          <KeyHints hints="↑↓/j/k move · enter open · ? full key reference · q quit" />
        ) : (
          <>
            {runInProgress ? <Text color={theme.warn}>● run active: navigation locked  </Text> : null}
            {childInputActive ? <Text color={theme.warn}>✎ typing  </Text> : null}
            <KeyHints hints={allHints} />
          </>
        )}
      </Box>
    </Box>
  );
}
