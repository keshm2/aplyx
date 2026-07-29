import { useEffect, useState } from "react";
import { BUILD_MARKER } from "@aplyx/core/version.js";

/**
 * The desktop app has no self-update mechanism of its own — unlike the
 * TUI/core (`aplyx update`), which pulls fresh source into the checkout
 * that `findRoot()` points at, the desktop app's own binary and its
 * bundled `core/bridge.js` resource are baked in at *build* time
 * (src/tauri/src-tauri/tauri.conf.json's `bundle.resources`) and never
 * touched again after install. `aplyx update` — even when it runs and
 * succeeds — cannot reach either one. Reported live: a Windows sign-in
 * crash fixed in source stayed broken for anyone who "updated" and kept
 * using the desktop app, because nothing ever told them the desktop app
 * itself was the thing out of date, let alone how to fix it short of
 * manually uninstalling and reinstalling.
 *
 * This checks BUILD_MARKER (imported directly from @aplyx/core, so it's
 * always this exact binary's own version — no IPC, no marker file that
 * could go stale) against the same public VERSION file the TUI's
 * launch-time update probe already uses. A plain fetch(), not a bridge
 * call: this needs no local install at all, so it works even before
 * findRoot() has resolved anything.
 */
const VERSION_URL = "https://raw.githubusercontent.com/keshm2/aplyx/main/VERSION";
const RELEASES_URL = "https://github.com/keshm2/aplyx/releases/latest";

export interface DesktopUpdateStatus {
  checking: boolean;
  current: string;
  latest: string | undefined;
  /** True only once `latest` is known and differs from `current`. */
  updateAvailable: boolean;
  /** Where "get the update" should send the user — the GitHub Releases
   *  page for the matching build, which carries the installer for every
   *  OS this app ships for. Re-running install_desktop.sh/.ps1 (also
   *  linked from here) does the same download+install non-interactively. */
  releaseUrl: string;
}

export function useDesktopUpdateStatus(): DesktopUpdateStatus {
  const [checking, setChecking] = useState(true);
  const [latest, setLatest] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(VERSION_URL, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return;
        const remote = (await res.text()).trim();
        if (!cancelled && remote) setLatest(remote);
      } catch {
        // Fail open — same spirit as the TUI's own fetchRemoteVersion:
        // a dead network just means "can't say," never an error state.
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    checking,
    current: BUILD_MARKER,
    latest,
    updateAvailable: Boolean(latest) && latest !== BUILD_MARKER,
    releaseUrl: RELEASES_URL,
  };
}
