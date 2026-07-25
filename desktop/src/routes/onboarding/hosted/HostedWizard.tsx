import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { useAuth } from "../../../lib/AuthContext";
import { getSupabaseClient } from "../../../lib/supabaseClient";
import { WizardShell } from "../../../components/WizardShell";
import { Logo } from "../../../components/Logo";
import { ImportOrFreshStep } from "./ImportOrFreshStep";
import { HostedProfileStep } from "./HostedProfileStep";
import { ResumeUploadStep } from "./ResumeUploadStep";

const STEPS = ["welcome", "import", "profile", "resume", "finish"] as const;
type Step = (typeof STEPS)[number];

/**
 * Hosted onboarding sequence per docs/app-integration-plan.md: Sign in ->
 * import local data or start fresh -> Profile -> Resume upload ->
 * Preferences -> Finish. "Preferences" (role_keywords/preferred_locations/
 * target_companies) is folded into Profile since those are 2 of the same
 * 8 shared field pages (packages/core/src/onboarding/fields.ts) rather
 * than a separate duplicate step.
 */
export function HostedWizard() {
  const { status, session, markOnboardingCompleted } = useAuth();
  const navigate = useNavigate();
  const [client, setClient] = useState<SupabaseClient | undefined>(undefined);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    // A failed client must not strand this screen on "Loading…" — bounce
    // back to /auth, which renders the matching error state.
    getSupabaseClient()
      .then(setClient)
      .catch(() => navigate("/auth"));
  }, [navigate]);

  if (status === "checking" || !client) {
    return (
      <main style={{ padding: "3rem", textAlign: "center" }}>
        <p className="wizard-subtitle">Loading&hellip;</p>
      </main>
    );
  }

  if (status !== "signed-in" || !session) {
    navigate("/auth");
    return null;
  }

  const step: Step = STEPS[stepIndex];
  const userId = session.user.id;

  async function goNext() {
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((i) => i + 1);
      return;
    }
    // Last step ("Finish") — record that this user won't need to see the
    // wizard again on their next sign-in. `client` is always set by the
    // time this is reachable (gated by the !client guard above); re-check
    // narrows it for TS since a closure doesn't inherit that guard's type.
    if (!client) return;
    await new SupabaseAdapter(client, userId).writeOnboardingCompleted(true);
    markOnboardingCompleted();
    navigate("/app");
  }

  function goBack() {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }

  if (step === "profile") {
    return (
      <WizardShell stepIndex={stepIndex} stepCount={STEPS.length} title="Your profile" hideBack>
        <HostedProfileStep client={client} userId={userId} onComplete={goNext} />
      </WizardShell>
    );
  }

  if (step === "welcome") {
    return (
      <WizardShell
        stepIndex={stepIndex}
        stepCount={STEPS.length}
        title="You're signed in"
        onNext={goNext}
        hideBack
      >
        <Logo size={28} withWordmark={false} />
        <p>
          Signed in as <strong>{session.user.email}</strong>. Let&rsquo;s get your profile set up.
        </p>
      </WizardShell>
    );
  }

  if (step === "import") {
    return (
      <WizardShell stepIndex={stepIndex} stepCount={STEPS.length} title="Bring over your data?" onBack={goBack}>
        <ImportOrFreshStep client={client} userId={userId} onDone={goNext} />
      </WizardShell>
    );
  }

  if (step === "resume") {
    return (
      <WizardShell stepIndex={stepIndex} stepCount={STEPS.length} title="Add a resume" onBack={goBack} onNext={goNext}>
        <ResumeUploadStep client={client} userId={userId} />
      </WizardShell>
    );
  }

  return (
    <WizardShell
      stepIndex={stepIndex}
      stepCount={STEPS.length}
      title="You're all set"
      onBack={goBack}
      onNext={goNext}
      nextLabel="Finish"
    >
      <p>Your account is ready. You can change any of this later from Settings.</p>
    </WizardShell>
  );
}
