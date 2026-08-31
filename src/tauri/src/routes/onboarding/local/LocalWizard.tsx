import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { WizardShell } from "../../../components/WizardShell";
import { findRoot, ensureTargetsFile, writeOnboardingCompleted, writeHarness, setLocalRoot } from "../../../lib/bridge";
import { IntroSplash } from "./IntroSplash";
import { PreferencesStep } from "./PreferencesStep";
import { EnvironmentStep } from "./EnvironmentStep";
import { CodingAgentStep } from "./CodingAgentStep";
import { ProfileStep } from "./ProfileStep";
import { ResumesStep } from "./ResumesStep";
import { NotificationsStep } from "./NotificationsStep";
import { ExtensionStep } from "./ExtensionStep";
import { ReviewStep } from "./ReviewStep";

// Three narrative beats (auto-advancing, no chrome; see IntroSplash) are
// interleaved with the real, interactive steps: a welcome, then a preamble
// into appearance preferences, then a preamble into the profile questions.
// Splashes don't count toward the progress dots and Back skips over them
// (REAL_STEPS / isSplash below); they're pacing, not steps to track.
const REAL_STEPS = [
  "preferences",
  "environment",
  "agent",
  "profile",
  "resumes",
  "notifications",
  "extension",
  "review",
] as const;
type RealStep = (typeof REAL_STEPS)[number];

const STEPS = [
  "intro-welcome",
  "intro-preferences",
  "preferences",
  "environment",
  "agent",
  "intro-profile",
  "profile",
  "resumes",
  "notifications",
  "extension",
  "review",
] as const;
type Step = (typeof STEPS)[number];

function isSplash(step: Step): boolean {
  return step === "intro-welcome" || step === "intro-preferences" || step === "intro-profile";
}

const TITLES: Record<RealStep, string> = {
  preferences: "Appearance",
  environment: "Environment check",
  agent: "Coding agent",
  profile: "Your profile",
  resumes: "Resumes",
  notifications: "Notifications",
  extension: "Browser extension",
  review: "Review & finish",
};

const SUBTITLES: Partial<Record<RealStep, string>> = {
  preferences: "Pick a look and feel. You can always change this later in Settings.",
};

export function LocalWizard() {
  const navigate = useNavigate();
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [rootError, setRootError] = useState<string | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [harness, setHarness] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  useEffect(() => {
    findRoot()
      .then(async (r) => {
        setRoot(r);
        await ensureTargetsFile(r);
      })
      .catch((err) => setRootError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function browseForRoot() {
    setBrowsing(true);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select your aplyx checkout folder",
      });
      if (typeof selected !== "string") return; // cancelled
      const resolved = await setLocalRoot(selected);
      setRoot(resolved);
      setRootError(undefined);
      await ensureTargetsFile(resolved);
    } catch (err) {
      setRootError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrowsing(false);
    }
  }

  if (rootError) {
    return (
      <main style={{ padding: "3rem", maxWidth: "32rem", margin: "0 auto" }}>
        <h1>Couldn&rsquo;t find a local aplyx installation</h1>
        <p className="wizard-subtitle">{rootError}</p>
        <p className="field-help">
          A Finder- or Dock-launched app has no way to know where your aplyx checkout lives on
          disk. Point it at the folder yourself (the one containing <code>AGENTS.md</code> and{" "}
          <code>src/scripts/</code>).
        </p>
        <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
          <button className="wizard-back" onClick={() => void browseForRoot()} disabled={browsing}>
            {browsing ? "Choosing…" : "Browse for my aplyx folder…"}
          </button>
          <button className="wizard-back" onClick={() => navigate("/")}>
            &larr; Back
          </button>
        </div>
      </main>
    );
  }

  if (!root) {
    return (
      <main style={{ padding: "3rem", textAlign: "center" }}>
        <p className="wizard-subtitle">Looking for your local aplyx installation&hellip;</p>
      </main>
    );
  }

  const step = STEPS[stepIndex];

  async function finish() {
    try {
      await writeOnboardingCompleted(root!, true);
    } catch (err) {
      // Fail open: this only controls whether the wizard auto-launches
      // again on the next start; worth logging, not worth stranding the
      // user on this screen over (they're leaving it either way, so
      // there's nowhere left to show an error message once we navigate).
      console.error("failed to mark onboarding completed", err);
    }
    navigate("/app");
  }

  async function goNext() {
    if (step === "agent" && harness) {
      // Cleared right before the attempt, not unconditionally on every
      // goNext() call: "agent" is immediately followed by the
      // "intro-profile" splash (no WizardShell, nowhere to show an error),
      // whose OWN auto-advance also calls goNext(); clearing here
      // unconditionally would wipe this message out before the user ever
      // reaches a real step again. Splash-driven calls (step !== "agent")
      // simply skip this whole block and leave any pending message alone.
      setActionError(undefined);
      try {
        await writeHarness(root!, harness);
      } catch (err) {
        // Fail open here too: a coding agent can always be (re)selected
        // later in Settings, so a save failure shouldn't be able to strand
        // the user on this step with no way forward. Surface it and keep
        // going rather than silently swallowing it (the previous bug).
        setActionError(
          `Couldn't save your coding-agent choice (${err instanceof Error ? err.message : String(err)}), ` +
            "continuing anyway; you can set this later in Settings.",
        );
      }
    }
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((i) => i + 1);
    } else {
      await finish();
    }
  }

  function goBack() {
    setActionError(undefined);
    let i = stepIndex - 1;
    while (i >= 0 && isSplash(STEPS[i])) i--;
    if (i < 0) navigate("/");
    else setStepIndex(i);
  }

  if (step === "intro-welcome") {
    return <IntroSplash key={step} heading="Welcome to Aplyx." delayMs={1800} onAdvance={goNext} />;
  }
  if (step === "intro-preferences") {
    return (
      <IntroSplash
        key={step}
        heading="Let's set up your preferences for your app."
        caption="Don't worry, these can be changed later."
        delayMs={2200}
        onAdvance={goNext}
      />
    );
  }
  if (step === "intro-profile") {
    return (
      <IntroSplash
        key={step}
        heading="Now, let's get to know more about you."
        caption="Every step saves as you go. It's safe to close and come back anytime."
        delayMs={2200}
        onAdvance={goNext}
      />
    );
  }

  const realIndex = REAL_STEPS.indexOf(step as RealStep);

  // ProfileStep manages its own internal 8-page navigation and calls
  // onComplete() when done, so it renders without the shared footer;
  // still offers Skip setup, since profile is the longest stretch of the
  // wizard and the one most worth an early exit from.
  if (step === "profile") {
    return (
      <WizardShell
        stepIndex={realIndex}
        stepCount={REAL_STEPS.length}
        title={TITLES.profile}
        error={actionError}
        hideBack
        onSkip={finish}
      >
        <ProfileStep root={root} onComplete={goNext} />
      </WizardShell>
    );
  }

  return (
    <WizardShell
      stepIndex={realIndex}
      stepCount={REAL_STEPS.length}
      title={TITLES[step as RealStep]}
      subtitle={SUBTITLES[step as RealStep]}
      error={actionError}
      onBack={goBack}
      onNext={goNext}
      nextLabel={step === "review" ? "Finish" : "Continue"}
      // Omitted on "review": its Continue is already "Finish", so a
      // separate Skip setup button there would just duplicate it.
      onSkip={step === "review" ? undefined : finish}
    >
      {step === "preferences" && <PreferencesStep />}
      {step === "environment" && <EnvironmentStep root={root} />}
      {step === "agent" && <CodingAgentStep selected={harness} onSelect={setHarness} />}
      {step === "resumes" && <ResumesStep root={root} />}
      {step === "notifications" && <NotificationsStep root={root} />}
      {step === "extension" && <ExtensionStep root={root} />}
      {step === "review" && <ReviewStep />}
    </WizardShell>
  );
}
