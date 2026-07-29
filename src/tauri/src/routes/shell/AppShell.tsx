import { lazy, Suspense, useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Logo } from "../../components/Logo";
import { TopBar } from "../../components/TopBar";
import "./AppShell.css";

// Same route-level code-splitting reasoning as App.tsx: a user visiting
// Home shouldn't have to wait on Jobs/Review/History/Resumes/Settings
// (each with their own bridge calls, sort/filter logic, etc.) being
// parsed too. Each tab's screen is its own chunk now, fetched on first
// visit rather than all six upfront.
const HomeScreen = lazy(() => import("./HomeScreen").then((m) => ({ default: m.HomeScreen })));
const SettingsScreen = lazy(() => import("./SettingsScreen").then((m) => ({ default: m.SettingsScreen })));
const ProfileScreen = lazy(() => import("./ProfileScreen").then((m) => ({ default: m.ProfileScreen })));
const JobsScreen = lazy(() => import("./JobsScreen").then((m) => ({ default: m.JobsScreen })));
const ReviewScreen = lazy(() => import("./ReviewScreen").then((m) => ({ default: m.ReviewScreen })));
const DocumentsScreen = lazy(() => import("./DocumentsScreen").then((m) => ({ default: m.DocumentsScreen })));
const HistoryScreen = lazy(() => import("./HistoryScreen").then((m) => ({ default: m.HistoryScreen })));
const ResumesScreen = lazy(() => import("./ResumesScreen").then((m) => ({ default: m.ResumesScreen })));

// Settings used to be a nav entry here too — it's the gear icon in TopBar
// now instead (next to the bell), so the /app/settings route stays wired
// up below but isn't listed as a sidebar destination anymore.
const NAV = [
  { to: "/app", label: "Home", end: true },
  { to: "/app/jobs", label: "Jobs" },
  { to: "/app/review", label: "Review queue" },
  { to: "/app/documents", label: "Documents" },
  { to: "/app/history", label: "History" },
  { to: "/app/resumes", label: "Resumes" },
  { to: "/app/profile", label: "Profile" },
];

// Route chunks are lazy (see the imports above) so a fresh launch only
// pays for Home's JS, not all six screens' — but that meant the FIRST
// visit to any other tab hit Suspense's fallback while the chunk
// downloaded, and by the time it resolved, the outer shell-route-in
// transition below (220ms) had often already finished, so the real
// content just popped in with no animation of its own — one of the
// "sometimes the transition doesn't work" cases. Prefetching every
// chunk shortly after the shell itself mounts (idle, off the critical
// path, never blocking Home's own first paint) means by the time a user
// actually clicks a tab, the chunk is already warm almost every time.
const PREFETCH = [
  () => import("./JobsScreen"),
  () => import("./ReviewScreen"),
  () => import("./DocumentsScreen"),
  () => import("./HistoryScreen"),
  () => import("./ResumesScreen"),
  () => import("./SettingsScreen"),
  () => import("./ProfileScreen"),
];

export function AppShell() {
  const location = useLocation();
  const [displayedLocation, setDisplayedLocation] = useState(location);
  const [transition, setTransition] = useState<"idle" | "out" | "in">("idle");

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
  // forever — harmless visually (the animation's fill-mode holds the
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
      <aside className="shell-sidebar">
        <div className="shell-brand">
          <Logo size={26} />
        </div>
        <nav className="shell-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "shell-nav-item shell-nav-item-active" : "shell-nav-item")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="shell-main">
        <TopBar />
        <div
          className={`shell-route-frame${transition === "out" ? " shell-route-out" : transition === "in" ? " shell-route-in" : ""}`}
          onAnimationEnd={(e) => {
            // animationend bubbles from any descendant's own CSS
            // animation, not just this element's — without this check,
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
              <Route path="jobs" element={<JobsScreen />} />
              <Route path="review" element={<ReviewScreen />} />
              <Route path="documents" element={<DocumentsScreen />} />
              <Route path="history" element={<HistoryScreen />} />
              <Route path="resumes" element={<ResumesScreen />} />
              <Route path="profile" element={<ProfileScreen />} />
              <Route path="settings" element={<SettingsScreen />} />
            </Routes>
          </Suspense>
        </div>
      </main>
    </div>
  );
}
