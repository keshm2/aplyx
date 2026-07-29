import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { findRoot, readOnboardingCompleted } from "../lib/bridge";
import { Logo } from "../components/Logo";
import "./EntryScreen.css";

export function EntryScreen() {
  const navigate = useNavigate();
  const { status, onboardingCompleted } = useAuth();
  const [checkingLocal, setCheckingLocal] = useState(false);

  // Supabase keeps a signed-in session across app relaunches
  // (persistSession: true) — a returning user shouldn't have to click
  // "Sign in" again just to reach the app they were already in. Wait for
  // onboardingCompleted to resolve so a signup that never finished the
  // wizard resumes it instead of skipping ahead to an empty dashboard.
  useEffect(() => {
    if (status !== "signed-in" || onboardingCompleted === undefined) return;
    navigate(onboardingCompleted ? "/app" : "/onboarding/hosted", { replace: true });
  }, [status, onboardingCompleted, navigate]);

  async function handleRunLocally() {
    setCheckingLocal(true);
    try {
      const root = await findRoot();
      const completed = await readOnboardingCompleted(root);
      navigate(completed ? "/app" : "/onboarding/local");
    } catch {
      // No local install found (or the check failed) — the wizard's own
      // root-detection step already handles that case with a clear message.
      navigate("/onboarding/local");
    } finally {
      setCheckingLocal(false);
    }
  }

  // A persisted session resolving, or already resolved and about to
  // redirect via the effect above — render nothing rather than flashing
  // the chooser cards first.
  if (status === "checking" || status === "signed-in") {
    return (
      <main className="entry">
        <div className="entry-content">
          <Logo size={40} />
        </div>
      </main>
    );
  }

  return (
    <main className="entry">
      <div className="entry-content">
        <Logo size={40} />

        <div className="entry-hero">
          <h1>Your job search, applied to.</h1>
          <p className="entry-subhead">
            aplyx searches job boards, tailors your resume, and applies on your behalf —
            with every decision reviewable before it goes out.
          </p>
        </div>

        <div className="entry-cards">
          <button className="entry-card" onClick={handleRunLocally} disabled={checkingLocal}>
            <span className="entry-card-eyebrow">No account needed</span>
            <h2>Run locally</h2>
            <p>Your data stays on this machine. Nothing leaves your computer.</p>
            <span className="entry-card-cta">{checkingLocal ? "Checking…" : "Get started →"}</span>
          </button>

          <button className="entry-card" onClick={() => navigate("/auth")}>
            <span className="entry-card-eyebrow">Sync across devices</span>
            <h2>Sign in</h2>
            <p>Email and password, or continue with Google. Your history follows you.</p>
            <span className="entry-card-cta">Sign in &rarr;</span>
          </button>
        </div>

        <p className="entry-footnote">
          Local-first by default — your resume and personal details never have to leave this
          device. You can always start locally and connect an account later.
        </p>
      </div>
    </main>
  );
}
