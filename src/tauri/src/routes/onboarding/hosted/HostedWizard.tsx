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
import { EmailTrackingStep } from "./EmailTrackingStep";
import { CandidateEmailStep } from "./CandidateEmailStep";
import { HostedReadinessStep } from "./HostedReadinessStep";

const STEPS = ["welcome", "import", "profile", "candidate_email", "resume", "inbox", "readiness"] as const;
type Step = (typeof STEPS)[number];

/**
 * Hosted onboarding sequence per docs/app-integration-plan.md: Sign in ->
   * import local data or start fresh -> Profile -> Candidate email -> Resume
   * upload -> Inbox connection -> Readiness. "Preferences" (role_keywords/
 * preferred_locations/target_companies) is folded into Profile since
 * those are 2 of the same 8 shared field pages
 * (src/core/src/onboarding/fields.ts) rather than a separate duplicate
 * step. Inbox status tracking is hosted-only (docs/website.md's pricing
 * page already lists it as a Pro-tier feature) — local installs have no
 * equivalent step at all.
 */
export function HostedWizard() {
  const { status, session, markOnboardingCompleted } = useAuth();
  const navigate = useNavigate();
  const [client, setClient] = useState<SupabaseClient | undefined>(undefined);
  const [stepIndex, setStepIndex] = useState(0);
  const [wizardError, setWizardError] = useState<string | undefined>(undefined);

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

  async function finish() {
    // `client` is always set by the time this is reachable (gated by the
    // !client guard above); re-check narrows it for TS since a closure
    // doesn't inherit that guard's type.
    if (!client) return;
    await new SupabaseAdapter(client, userId).writeOnboardingCompleted(true);
    markOnboardingCompleted();
    navigate("/app");
  }

  async function goNext() {
    if (!client) return;
    setWizardError(undefined);
    if (STEPS[stepIndex] === "resume" || STEPS[stepIndex] === "inbox" || STEPS[stepIndex] === "readiness") {
      const readiness = await new SupabaseAdapter(client, userId).readHostedReadiness();
      if (STEPS[stepIndex] === "resume" && !readiness.resumeUploaded) {
        setWizardError("Upload a resume before continuing.");
        return;
      }
      if (STEPS[stepIndex] === "inbox" && !readiness.inboxConnected) {
        setWizardError("Hosted plans require a connected inbox before setup can finish.");
        return;
      }
      if (STEPS[stepIndex] === "readiness" && !(readiness.hasCandidateEmail && readiness.resumeUploaded && readiness.inboxConnected)) {
        setWizardError("Complete the required setup items before finishing hosted onboarding.");
        return;
      }
    }
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((i) => i + 1);
      return;
    }
    await finish();
  }

  async function goNextFromImport() {
    await goNext();
  }

  function goBack() {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }

  // ResumeUploadStep tells the user they can skip and add a resume later
  // from Settings, but goNext's readiness gate for "resume" always blocked
  // that — there was no way to actually leave this step without uploading.
  // This bypasses just that gate; readiness (the wizard's last step) still
  // requires a resume before hosted setup can finish, matching
  // HostedReadinessStep's own checklist.
  function skipResume() {
    setWizardError(undefined);
    setStepIndex((i) => i + 1);
  }

  if (step === "profile") {
    return (
      <WizardShell stepIndex={stepIndex} stepCount={STEPS.length} title="Your profile" hideBack error={wizardError}>
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
        error={wizardError}
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
      <WizardShell stepIndex={stepIndex} stepCount={STEPS.length} title="Bring over your data?" onBack={goBack} error={wizardError}>
        <ImportOrFreshStep client={client} userId={userId} onDone={goNextFromImport} />
      </WizardShell>
    );
  }

  if (step === "candidate_email") {
    return (
      <WizardShell stepIndex={stepIndex} stepCount={STEPS.length} title="Confirm your candidate email" onBack={goBack} error={wizardError}>
        <CandidateEmailStep client={client} userId={userId} fallbackEmail={session.user.email ?? ""} onComplete={goNext} />
      </WizardShell>
    );
  }

  if (step === "resume") {
    return (
      <WizardShell
        stepIndex={stepIndex}
        stepCount={STEPS.length}
        title="Add a resume"
        onBack={goBack}
        onNext={goNext}
        onSkip={skipResume}
        skipLabel="Skip for now"
        error={wizardError}
      >
        <ResumeUploadStep client={client} userId={userId} />
      </WizardShell>
    );
  }

  if (step === "inbox") {
    return (
      <WizardShell
        stepIndex={stepIndex}
        stepCount={STEPS.length}
        title="Connect your inbox"
        onBack={goBack}
        error={wizardError}
      >
        <EmailTrackingStep client={client} userId={userId} onComplete={goNext} />
      </WizardShell>
    );
  }

  if (step === "readiness") {
    return (
      <WizardShell
        stepIndex={stepIndex}
        stepCount={STEPS.length}
        title="Hosted setup check"
        onBack={goBack}
        error={wizardError}
      >
        <HostedReadinessStep client={client} userId={userId} onComplete={finish} />
      </WizardShell>
    );
  }

  return (
    <WizardShell stepIndex={stepIndex} stepCount={STEPS.length} title="Hosted setup" error={wizardError}>
      <p>Preparing hosted setup…</p>
    </WizardShell>
  );
}
