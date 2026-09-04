import { useEffect, useRef } from "react";

/**
 * Recovers a "waiting for the OAuth callback" button that would otherwise
 * stay disabled forever.
 *
 * The mail-connect flow opens the provider's consent screen in the system
 * browser and then waits for an `aplyx://mail-callback` deep link. That
 * link never fires when the user closes the consent window, cancels,
 * fails the login, or isn't an approved tester on an app still in Google's
 * "Testing" publishing mode — leaving the button stuck on "Opening
 * consent…". The only reset today is navigating away and back.
 *
 * This watches for the app window regaining focus while `busy` (the user
 * came back from the browser) and, as a backstop, a hard timeout. On
 * either, it re-checks the real connection state: if it actually
 * connected in the meantime, `onConnected()` runs; otherwise `onGiveUp()`
 * runs so the caller can re-enable the button and show "try again".
 *
 * Callbacks are read through refs, so callers don't need to memoize them;
 * the effect only re-subscribes when `busy` flips.
 */
export function useOauthBusyRecovery(opts: {
  busy: boolean;
  /** Resolves true when the connection is actually established now. */
  recheck: () => Promise<boolean>;
  onConnected: () => void;
  onGiveUp: () => void;
  /** Hard cap before giving up even without a focus event. Default 3 min. */
  timeoutMs?: number;
}): void {
  const cbs = useRef(opts);
  cbs.current = opts;

  const { busy } = opts;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  useEffect(() => {
    if (!busy) return;

    const startedAt = Date.now();
    let cancelled = false;
    let verifying = false;

    async function verify(graceMs: number) {
      if (verifying || cancelled) return;
      verifying = true;
      // A just-fired deep-link callback and a focus event can race; give
      // the callback a beat to win before we treat this as "didn't work".
      if (graceMs > 0) await new Promise((r) => setTimeout(r, graceMs));
      if (cancelled) {
        verifying = false;
        return;
      }
      try {
        const connected = await cbs.current.recheck();
        if (cancelled) return;
        if (connected) cbs.current.onConnected();
        else cbs.current.onGiveUp();
      } catch {
        if (!cancelled) cbs.current.onGiveUp();
      } finally {
        verifying = false;
      }
    }

    function onFocus() {
      // Ignore the immediate focus churn from opening the browser; only
      // act once enough time has passed to have actually visited consent.
      if (Date.now() - startedAt > 1200) void verify(1500);
    }

    window.addEventListener("focus", onFocus);
    const timer = window.setTimeout(() => void verify(0), timeoutMs);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(timer);
    };
  }, [busy, timeoutMs]);
}
