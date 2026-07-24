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

// Three narrative beats (auto-advancing, no chrome — see IntroSplash) are
// interleaved with the real, interactive steps: a welcome, then a preamble
// into appearance preferences, then a preamble into the profile questions.
// Splashes don't count toward the progress dots and Back skips over them
// (REAL_STEPS / isSplash below) — they're pacing, not steps to track.
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
  preferences: "Pick a look and feel — you can always change this later in Settings.",
};

export function LocalWizard() {
  const navigate = useNavigate();
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [rootError, setRootError] = useState<string | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [harness, setHarness] = useState<string | undefined>(undefined);

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
          disk — point it at the folder yourself (the one containing <code>AGENTS.md</code> and{" "}
          <code>scripts/</code>).
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
    await writeOnboardingCompleted(root!, true);
    navigate("/app");
  }

  async function goNext() {
    if (step === "agent" && harness) await writeHarness(root!, harness);
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((i) => i + 1);
    } else {
      await finish();
    }
  }

  function goBack() {
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
        caption="Every step saves as you go — it's safe to close and come back anytime."
        delayMs={2200}
        onAdvance={goNext}
      />
    );
  }

  const realIndex = REAL_STEPS.indexOf(step as RealStep);

  // ProfileStep manages its own internal 8-page navigation and calls
  // onComplete() when done, so it renders without the shared footer.
  if (step === "profile") {
    return (
      <WizardShell stepIndex={realIndex} stepCount={REAL_STEPS.length} title={TITLES.profile} hideBack>
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
      onBack={goBack}
      onNext={goNext}
      nextLabel={step === "review" ? "Finish" : "Continue"}
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
