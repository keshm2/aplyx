import { lazy, Suspense, useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { TopBar } from "../../components/TopBar";
import { NavHomeIcon, NavRunIcon, NavJobsIcon, NavReviewIcon, NavDocumentsIcon, NavStatusIcon, NavResumesIcon, NavProfileIcon } from "../../components/Icons";
import { useAplyxState } from "../../lib/useAplyxState";
import { isResolved } from "@aplyx/core/stateDerive.js";
import { readEnvOverride } from "../../lib/bridge";
import { applyReducedMotionAttr } from "../../lib/reducedMotion";
import "./AppShell.css";

// Same route-level code-splitting reasoning as App.tsx: a user visiting
// Home shouldn't have to wait on Jobs/Review/Status/Resumes/Settings
// (each with their own bridge calls, sort/filter logic, etc.) being
// parsed too. Each tab's screen is its own chunk now, fetched on first
// visit rather than all six upfront.
const HomeScreen = lazy(() => import("./HomeScreen").then((m) => ({ default: m.HomeScreen })));
const SettingsShell = lazy(() => import("./SettingsShell").then((m) => ({ default: m.SettingsShell })));
const SettingsAccountTab = lazy(() => import("./SettingsAccountTab").then((m) => ({ default: m.SettingsAccountTab })));
const SettingsPreferencesTab = lazy(() => import("./SettingsPreferencesTab").then((m) => ({ default: m.SettingsPreferencesTab })));
const ProfileScreen = lazy(() => import("./ProfileScreen").then((m) => ({ default: m.ProfileScreen })));
const JobsScreen = lazy(() => import("./JobsScreen").then((m) => ({ default: m.JobsScreen })));
const ReviewScreen = lazy(() => import("./ReviewScreen").then((m) => ({ default: m.ReviewScreen })));
const DocumentsScreen = lazy(() => import("./DocumentsScreen").then((m) => ({ default: m.DocumentsScreen })));
// Was HistoryScreen: renamed to match the nav (Home is the "recent
// activity" dashboard; this is the full per-job status list, every
// applied job with its outcome badge, see the operator's 2026-08-10
// clarification). Same component, same data (state.applied), just named
// for what it actually is instead of "History".
const StatusScreen = lazy(() => import("./StatusScreen").then((m) => ({ default: m.StatusScreen })));
const ResumesScreen = lazy(() => import("./ResumesScreen").then((m) => ({ default: m.ResumesScreen })));
const RunScreen = lazy(() => import("./RunScreen").then((m) => ({ default: m.RunScreen })));
// ATS account credentials (docs/ats-account-credentials-plan.md Package
// 6), its own tab inside Settings (SettingsShell.tsx), reached the same
// way as Settings itself: the gear icon rather than a NAV entry, since
// this is hosted-only and credential-specific, not a daily-use tab.
const AccountCenterScreen = lazy(() => import("./AccountCenterScreen").then((m) => ({ default: m.AccountCenterScreen })));

// Settings used to be a nav entry here too; it's the gear icon in TopBar
// now instead (next to the bell), so the /app/settings route stays wired
// up below but isn't listed as a nav destination anymore. Consumed by
// TopBar's NavMenu (the dropdown that replaced the old persistent sidebar
// rail) rather than rendered directly here.
const NAV = [
  { to: "/app", label: "Home", end: true, Icon: NavHomeIcon },
  { to: "/app/run", label: "Run", Icon: NavRunIcon },
  { to: "/app/jobs", label: "Jobs", Icon: NavJobsIcon },
  { to: "/app/review", label: "Review queue", Icon: NavReviewIcon },
  { to: "/app/documents", label: "Documents", Icon: NavDocumentsIcon },
  { to: "/app/status", label: "Application statuses", Icon: NavStatusIcon },
  { to: "/app/resumes", label: "Resumes", Icon: NavResumesIcon },
  { to: "/app/profile", label: "Profile", Icon: NavProfileIcon },
];

// Route chunks are lazy (see the imports above) so a fresh launch only
// pays for Home's JS, not all six screens', but that meant the FIRST
// visit to any other tab hit Suspense's fallback while the chunk
// downloaded, and by the time it resolved, the outer shell-route-in
// transition below (220ms) had often already finished, so the real
// content just popped in with no animation of its own, one of the
// "sometimes the transition doesn't work" cases. Prefetching every
// chunk shortly after the shell itself mounts (idle, off the critical
// path, never blocking Home's own first paint) means by the time a user
// actually clicks a tab, the chunk is already warm almost every time.
const PREFETCH = [
  () => import("./RunScreen"),
  () => import("./JobsScreen"),
  () => import("./ReviewScreen"),
  () => import("./DocumentsScreen"),
  () => import("./StatusScreen"),
  () => import("./ResumesScreen"),
  () => import("./SettingsShell"),
  () => import("./SettingsAccountTab"),
  () => import("./SettingsPreferencesTab"),
  () => import("./ProfileScreen"),
  () => import("./AccountCenterScreen"),
];

export function AppShell() {
  const location = useLocation();
  const [displayedLocation, setDisplayedLocation] = useState(location);
  const [transition, setTransition] = useState<"idle" | "out" | "in">("idle");
  // Live count on the "Review queue" nav item: the dropdown otherwise
  // never reflects anything changing on its own, and this is the one
  // number HomeScreen's own nextAction already treats as the most
  // time-sensitive thing in the app (an unreviewed application waiting on
  // a manual decision). useAplyxState already polls every 60s for exactly
  // this reason (background scheduler activity while the window is open),
  // so this rides that existing refresh rather than adding a second one.
  const { state, root } = useAplyxState();
  // Not state?.queue.length: the queue array is append-only and never
  // shrinks on its own (AGENTS.md), so a raw length counts entries that
  // were already applied/dismissed/failed after being queued. isResolved
  // is the same filter ReviewScreen's own pending-count already applies;
  // this badge needs to agree with it or the nav menu and the actual queue
  // list would disagree about how many items are still pending.
  const queueCount = state ? state.queue.filter((e) => !isResolved(state, e)).length : 0;

  // Applies whatever was last saved in Settings. Settings' own toggle
  // applies the attribute directly the instant it's flipped too (see
  // reducedMotion.ts), so this effect only has to cover app boot and
  // switching local installs, not live updates while Settings is open.
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    readEnvOverride(root, "APLYX_REDUCED_MOTION", { fallback: "0" })
      .then((v) => {
        if (!cancelled) applyReducedMotionAttr(v === "1");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [root]);

  useEffect(() => {
    const idle = window.setTimeout(() => {
      for (const load of PREFETCH) void load();
    }, 300);
    return () => window.clearTimeout(idle);
  }, []);

  useEffect(() => {
    if (location.pathname === displayedLocation.pathname) return;
    setTransition("out");
    const timer = window.setTimeout(() => {
      setDisplayedLocation(location);
      setTransition("in");
    }, 120);
    return () => window.clearTimeout(timer);
  }, [displayedLocation.pathname, location]);

  // Safety net: onAnimationEnd (below) is the normal way "in" returns to
  // "idle", but if that event is ever missed (element unmounts mid-
  // animation, a webview quirk, whatever), transition would stay "in"
  // forever, harmless visually (the animation's fill-mode holds the
  // settled end state regardless), but it means the *next* navigation's
  // "out" still fires correctly (setTransition("out") always runs
  // unconditionally) so this is mostly defensive, not a fix for a
  // visible bug on its own. Cheap enough to keep as a backstop.
  useEffect(() => {
    if (transition !== "in") return;
    const timer = window.setTimeout(() => setTransition("idle"), 260);
    return () => window.clearTimeout(timer);
  }, [transition]);

  return (
    <div className="shell">
      <main className="shell-main">
        <TopBar navItems={NAV} queueBadge={{ to: "/app/review", count: queueCount }} />
        <div
          className={`shell-route-frame${transition === "out" ? " shell-route-out" : transition === "in" ? " shell-route-in" : ""}`}
          onAnimationEnd={(e) => {
            // animationend bubbles from any descendant's own CSS
            // animation, not just this element's: without this check,
            // an unrelated inner animation finishing (a stat card fading
            // in, a loading spinner, anything) could fire this and end
            // the route transition early, or race a *later* transition
            // if it bubbles after the state has already moved on. Only
            // react to this element's own shell-route-in finishing.
            if (e.target !== e.currentTarget) return;
            if (transition === "in") setTransition("idle");
          }}
        >
          <Suspense fallback={<div className="shell-route-fallback" />}>
            <Routes location={displayedLocation}>
              <Route index element={<HomeScreen />} />
              <Route path="run" element={<RunScreen />} />
              <Route path="jobs" element={<JobsScreen />} />
              <Route path="review" element={<ReviewScreen />} />
              <Route path="documents" element={<DocumentsScreen />} />
              <Route path="status" element={<StatusScreen />} />
              <Route path="resumes" element={<ResumesScreen />} />
              <Route path="profile" element={<ProfileScreen />} />
              <Route path="settings" element={<SettingsShell />}>
                <Route index element={<SettingsAccountTab />} />
                <Route path="preferences" element={<SettingsPreferencesTab />} />
                <Route path="accounts" element={<AccountCenterScreen />} />
              </Route>
            </Routes>
          </Suspense>
        </div>
      </main>
    </div>
  );
}
