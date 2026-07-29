import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/AuthContext";
import { Logo } from "../../components/Logo";
import "./AuthScreen.css";

type Mode = "sign-in" | "sign-up";

export function AuthScreen() {
  const {
    status,
    statusError,
    onboardingCompleted,
    retry,
    signInWithPassword,
    signUpWithPassword,
    resendConfirmation,
    signInWithGoogle,
  } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [checkEmailNotice, setCheckEmailNotice] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  // Single place that decides where a completed sign-in lands: the
  // aplyx:// deep-link callback (email confirmation, Google OAuth) and a
  // password sign-in both just flip `status`/`onboardingCompleted` and let
  // this effect route — a returning user goes straight to the dashboard
  // instead of repeating the wizard every time; a first-time signup still
  // gets it. Waits for onboardingCompleted to resolve rather than guessing.
  useEffect(() => {
    if (status !== "signed-in" || onboardingCompleted === undefined) return;
    navigate(onboardingCompleted ? "/app" : "/onboarding/hosted", { replace: true });
  }, [status, onboardingCompleted, navigate]);

  if (status === "checking") {
    return (
      <main className="auth">
        <div className="auth-card">
          <p className="auth-status-line">Checking sign-in availability&hellip;</p>
        </div>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="auth">
        <div className="auth-card">
          <Logo size={32} />
          <h1>Sign-in couldn&rsquo;t start</h1>
          <p className="auth-status-line">
            Something went wrong while checking this machine&rsquo;s hosted-mode setup:
          </p>
          {statusError && <p className="auth-error">{statusError}</p>}
          <button className="auth-submit" onClick={retry}>
            Try again
          </button>
          <button className="auth-secondary" onClick={() => navigate("/onboarding/local")}>
            Run locally instead
          </button>
        </div>
      </main>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSubmitting(true);
    if (mode === "sign-up") {
      const result = await signUpWithPassword(email, password);
      setSubmitting(false);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.alreadyRegistered) {
        setError(
          "An account with this email already exists but hasn't been confirmed — no new email was sent. Use the resend option below, or sign in if you've already confirmed.",
        );
        setCheckEmailNotice(true);
        return;
      }
      setCheckEmailNotice(true);
      return;
    }
    const result = await signInWithPassword(email, password);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // No explicit navigate here — the effect above takes over once status
    // flips to "signed-in" and onboardingCompleted resolves.
  }

  async function handleResend() {
    setResendState("sending");
    const result = await resendConfirmation(email);
    if (result.error) {
      setError(result.error);
      setResendState("idle");
      return;
    }
    setError(undefined);
    setResendState("sent");
  }

  async function handleGoogle() {
    setError(undefined);
    const result = await signInWithGoogle();
    if (result.error) setError(result.error);
    // A successful call opens the system browser for Google's consent
    // screen; there is no local navigation to perform here —
    // AuthContext's deep-link listener exchanges the aplyx://
    // auth-callback code and onAuthStateChange flips status once the
    // user finishes in the browser and the OS routes the redirect back.
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <Logo size={32} />

        <div className="auth-tabs" role="tablist" aria-label="Sign in or create an account">
          <button
            role="tab"
            aria-selected={mode === "sign-in"}
            className={mode === "sign-in" ? "auth-tab auth-tab-active" : "auth-tab"}
            onClick={() => {
              setMode("sign-in");
              setError(undefined);
            }}
          >
            Sign in
          </button>
          <button
            role="tab"
            aria-selected={mode === "sign-up"}
            className={mode === "sign-up" ? "auth-tab auth-tab-active" : "auth-tab"}
            onClick={() => {
              setMode("sign-up");
              setError(undefined);
            }}
          >
            Create account
          </button>
        </div>

        {checkEmailNotice ? (
          <>
            <p className="auth-status-line">
              Check <strong>{email}</strong> for a confirmation link to finish creating your
              account. It can take a couple of minutes and may land in your spam folder.
            </p>
            {error && <p className="auth-error">{error}</p>}
            <button
              type="button"
              className="auth-secondary"
              onClick={handleResend}
              disabled={resendState !== "idle"}
            >
              {resendState === "sending"
                ? "Resending…"
                : resendState === "sent"
                  ? "Sent — check your inbox"
                  : "Resend confirmation email"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="auth-google" onClick={handleGoogle}>
              <span className="auth-google-mark" aria-hidden="true">
                G
              </span>
              Continue with Google
            </button>

            <div className="auth-divider">
              <span>or</span>
            </div>

            <form className="auth-form" onSubmit={handleSubmit}>
              <label className="auth-field">
                <span>Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                />
              </label>
              <label className="auth-field">
                <span>Password</span>
                <input
                  type="password"
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                />
              </label>

              {error && <p className="auth-error">{error}</p>}

              <button type="submit" className="auth-submit" disabled={submitting}>
                {submitting ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Create account"}
              </button>
            </form>
          </>
        )}

        <button className="auth-back" onClick={() => navigate("/")}>
          &larr; Back
        </button>
      </div>
    </main>
  );
}
