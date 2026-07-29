import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Whether the desktop app has been installed via install_desktop.sh /
 * install_desktop.ps1 (either the prebuilt-download path or the
 * build-from-source fallback — both write this marker on success). Read
 * by the TUI's Settings screen so it can offer "Install desktop app" only
 * when it isn't already there, and show an already-installed state
 * instead of a dead re-offer otherwise.
 *
 * This is a marker written by the installer scripts, not a live
 * filesystem probe for `/Applications/aplyx.app` et al. — the actual
 * install location varies by OS and by which package format Linux ended
 * up using (apt/dnf/AppImage), so a single marker the installer itself
 * writes is far simpler and more reliable than guessing every possible
 * real location across three platforms. It can go stale if the app is
 * uninstalled by hand outside `aplyx uninstall` — an accepted trade-off,
 * matching how `~/.aplyx/root`'s pin already works the same way.
 */
export function desktopInstalledMarkerFile(): string {
  return path.join(os.homedir(), ".aplyx", "desktop_installed");
}

/** The aplyx VERSION string that was current when the desktop app was
 *  last (re)installed, or undefined if the marker isn't present. */
export function desktopInstalledVersion(): string | undefined {
  try {
    const raw = fs.readFileSync(desktopInstalledMarkerFile(), "utf8").trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export function isDesktopAppInstalled(): boolean {
  return desktopInstalledVersion() !== undefined;
}
