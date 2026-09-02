import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getCurrent as getCurrentDeepLink, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { getSupabaseClient } from "./supabaseClient";

type AuthStatus = "checking" | "error" | "signed-out" | "signed-in";

/**
 * Custom URL scheme this app registers (src/tauri/src-tauri/tauri.conf.json
 * "plugins.deep-link.desktop.schemes"). Both the email-confirmation link
 * and the Google OAuth redirect point here instead of Supabase's default
 * `http://localhost:3000`: a desktop app isn't a website sitting at that
 * URL to receive the click, so without this every confirmation link was a
 * dead end (2026-07-16, caught in manual testing). The OS routes a click
 * on an `aplyx://...` link to this running app; onOpenUrl below catches
 * it and finishes the sign-in.
 *
 * Caveat: macOS only recognizes a custom URL scheme once the app has been
 * built as a real .app bundle and launched at least once from
 * /Applications; `tauri-plugin-deep-link` cannot register the scheme at
 * runtime for a bare `cargo run`/`tauri dev` binary on macOS. Test this
 * with `npm run tauri build` (or `-- --debug`), not `tauri dev`.
 *
 * Must also be added to the Supabase project's Authentication → URL
 * Configuration → Redirect URLs allow-list, or Supabase will reject the
 * redirect.
 */
const AUTH_CALLBACK_URL = "aplyx://auth-callback";

interface AuthContextValue {
  status: AuthStatus;
  /** Set when status is "error": what actually went wrong during setup. */
  statusError: string | undefined;
  session: Session | undefined;
  /** Whether the signed-in user has finished the hosted onboarding wizard
   *  before; undefined while unknown (still resolving, or not signed in).
   *  EntryScreen/AuthScreen wait for this before deciding whether a
   *  sign-in lands on the dashboard or the wizard. */
  onboardingCompleted: boolean | undefined;
  /** Optimistically marks onboarding complete in context state right after
   *  the hosted wizard's finish step persists it, so nothing re-consults a
   *  stale `false` before the next auth-state change would naturally
   *  refresh it. */
  markOnboardingCompleted: () => void;
  /** Re-runs the client/session check after a status of "error". */
  retry: () => void;
  signInWithPassword: (email: string, password: string) => Promise<{ error?: string }>;
  signUpWithPassword: (
    email: string,
    password: string,
  ) => Promise<{ error?: string; alreadyRegistered?: boolean }>;
  /** Re-sends the signup confirmation email for an unconfirmed account. */
  resendConfirmation: (email: string) => Promise<{ error?: string }>;
  signInWithGoogle: () => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | undefined>(undefined);
  const [client, setClient] = useState<SupabaseClient | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    setStatus("checking");
    setStatusError(undefined);

    // Applies a Supabase session (or its absence) to status/session/
    // onboardingCompleted together; called both for the initial
    // getSession() resolve and every subsequent onAuthStateChange event
    // (interactive sign-in, sign-out, the deep-link PKCE exchange), so
    // there is one place that decides "is this user done with the hosted
    // wizard" instead of three copies drifting apart.
    async function applySession(c: SupabaseClient, next: Session | null) {
      if (cancelled) return;
      setSession(next ?? undefined);
      setStatus(next ? "signed-in" : "signed-out");
      if (!next) {
        setOnboardingCompleted(undefined);
        return;
      }
      setOnboardingCompleted(undefined);
      try {
        const completed = await new SupabaseAdapter(c, next.user.id).readOnboardingCompleted();
        if (!cancelled) setOnboardingCompleted(completed);
      } catch (err) {
        // This used to be swallowed silently, leaving onboardingCompleted
        // stuck at undefined forever: AuthScreen/EntryScreen's own
        // "navigate once it resolves" effects never fire, status stays
        // "signed-in", and the sign-in form just... sits there with no
        // feedback at all, indistinguishable from "did nothing," which is
        // exactly what got reported ("sign in just takes me back to the
        // entry screen": the form never advances, so the only way forward
        // looks like clicking back). Surfacing it as a real error means a
        // stuck sign-in is now visible and retryable instead of a silent
        // dead end, and, critically, the actual cause (RLS, network, a
        // schema mismatch) shows up in statusError instead of vanishing.
        if (!cancelled) {
          setStatusError(errorMessage(err));
          setStatus("error");
        }
      }
    }

    // Every await here must resolve to a status; a rejection that leaves
    // status at "checking" strands the auth screen on its loading state
    // forever (the original symptom: bridge spawn failed in the installed
    // .app and the rejection was silently dropped).
    getSupabaseClient()
      .then(async (c) => {
        if (cancelled) return;
        setClient(c);
        const { data } = await c.auth.getSession();
        if (cancelled) return;
        await applySession(c, data.session);
        const { data: sub } = c.auth.onAuthStateChange((_event, next) => {
          applySession(c, next);
        });
        unsubscribe = () => sub.subscription.unsubscribe();
      })
      .catch((err) => {
        if (cancelled) return;
        setStatusError(errorMessage(err));
        setStatus("error");
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [attempt]);

  // Catches the OS routing an aplyx://auth-callback click back to this
  // app (from either the email-confirmation link or the system-browser
  // Google OAuth redirect) and completes the session via the PKCE code
  // in the URL. Registered once client exists; harmless if it never fires.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    async function completeFromCallbackUrls(urls: string[]) {
      const url = urls.find((u) => u.startsWith(AUTH_CALLBACK_URL));
      if (!url) return;
      // exchangeCodeForSession wants the bare PKCE auth code, not the full
      // callback URL: it's sent as-is to Supabase's token endpoint, so
      // passing the whole "aplyx://auth-callback?code=..." string here
      // silently fails the exchange (invalid code) with no visible error,
      // leaving status stuck on "signed-out" after a real, successful
      // Google/email confirmation.
      const code = new URL(url).searchParams.get("code");
      if (!code) return;
      const { error } = await client!.auth.exchangeCodeForSession(code);
      if (error && !cancelled) {
        setStatusError(errorMessage(error));
        setStatus("error");
      }
    }

    // Cold start: on Windows/Linux the OAuth redirect can launch the app
    // fresh (user closed it during the browser round trip) with the
    // callback URL as the sole CLI arg. onOpenUrl below only covers the
    // already-running case, so check the startup args too.
    getCurrentDeepLink()
      .then((urls) => {
        if (!cancelled && urls) void completeFromCallbackUrls(urls);
      })
      .catch(() => {});

    const unlisten = onOpenUrl((urls) => {
      void completeFromCallbackUrls(urls);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      statusError,
      session,
      onboardingCompleted,
      markOnboardingCompleted() {
        setOnboardingCompleted(true);
      },
      retry() {
        setAttempt((n) => n + 1);
      },
      async signInWithPassword(email, password) {
        try {
          const c = await getSupabaseClient();
          const { error } = await c.auth.signInWithPassword({ email, password });
          return { error: error?.message };
        } catch (err) {
          return { error: errorMessage(err) };
        }
      },
      async signUpWithPassword(email, password) {
        try {
          const c = await getSupabaseClient();
          const { data, error } = await c.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: AUTH_CALLBACK_URL },
          });
          if (error) return { error: error.message };
          // Supabase obfuscates "this email already has an account" as a
          // fake success with an empty identities array, and does NOT
          // resend the confirmation email. Without surfacing this, every
          // retry after a lost first email looks like it worked while
          // nothing ever arrives.
          if (data.user && (data.user.identities?.length ?? 0) === 0) {
            return { alreadyRegistered: true };
          }
          return {};
        } catch (err) {
          return { error: errorMessage(err) };
        }
      },
      async resendConfirmation(email) {
        try {
          const c = await getSupabaseClient();
          const { error } = await c.auth.resend({
            type: "signup",
            email,
            options: { emailRedirectTo: AUTH_CALLBACK_URL },
          });
          return { error: error?.message };
        } catch (err) {
          return { error: errorMessage(err) };
        }
      },
      async signInWithGoogle() {
        try {
          const c = await getSupabaseClient();
          // skipBrowserRedirect: the webview must not navigate itself; Google
          // blocks OAuth from embedded webviews. Open the auth URL in the
          // user's real system browser instead; it redirects back to
          // AUTH_CALLBACK_URL on completion, which the OS routes to onOpenUrl
          // above.
          const { data, error } = await c.auth.signInWithOAuth({
            provider: "google",
            options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
          });
          if (error) return { error: error.message };
          if (data.url) await openUrl(data.url);
          return {};
        } catch (err) {
          return { error: errorMessage(err) };
        }
      },
      async signOut() {
        const c = await getSupabaseClient().catch(() => undefined);
        await c?.auth.signOut();
      },
    }),
    [status, statusError, session, onboardingCompleted],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
