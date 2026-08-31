import { useEffect, useState } from "react";

/**
 * Appearance preferences (mode + UI font), persisted in localStorage and
 * applied as data attributes on <html> that tokens.css keys off:
 * - theme: "system" leaves the attribute off (the prefers-color-scheme
 *   media query decides); "light"/"dark" set data-theme, which wins over
 *   the media query in both directions.
 * - font: "manrope" (default pairing: Manrope display + Inter body,
 *   matching Supabase's own pairing) or one of the other bundled variable
 *   faces, or "system" to opt back into the OS's native UI font (see
 *   base.css @font-face and this file's FONT_LABELS).
 * Purely a webview concern; nothing here touches the Python-owned state.
 * There used to be a third axis (themeFamily, which of six palettes) but
 * the app now ships exactly one palette (Moss, tokens.css), so that axis
 * was removed rather than left as a single-option picker.
 */

export type ThemePref = "system" | "light" | "dark";
export type FontPref = "manrope" | "system" | "geist" | "inter" | "plex" | "atkinson";

const THEME_KEY = "aplyx.theme";
const FONT_KEY = "aplyx.font";

const FONTS: FontPref[] = ["manrope", "system", "geist", "inter", "plex", "atkinson"];

export const FONT_LABELS: Record<FontPref, string> = {
  manrope: "Manrope",
  system: "System",
  geist: "Geist",
  inter: "Inter",
  plex: "IBM Plex",
  atkinson: "Atkinson Hyperlegible",
};

export function loadThemePref(): ThemePref {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function loadFontPref(): FontPref {
  const raw = localStorage.getItem(FONT_KEY);
  return (FONTS as string[]).includes(raw ?? "") ? (raw as FontPref) : "manrope";
}

export function applyUiPrefs(theme: ThemePref = loadThemePref(), font: FontPref = loadFontPref()): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
  // "manrope" is the default, so it's the one relying on attribute absence
  // (tokens.css's bare :root); "system" moved to an explicit
  // [data-font="system"] rule instead.
  if (font === "manrope") delete root.dataset["font"];
  else root.dataset["font"] = font;
}

export function useUiPrefs(): {
  theme: ThemePref;
  font: FontPref;
  setTheme: (t: ThemePref) => void;
  setFont: (f: FontPref) => void;
} {
  const [theme, setThemeState] = useState<ThemePref>(loadThemePref);
  const [font, setFontState] = useState<FontPref>(loadFontPref);

  useEffect(() => {
    applyUiPrefs(theme, font);
  }, [theme, font]);

  return {
    theme,
    font,
    setTheme(t) {
      localStorage.setItem(THEME_KEY, t);
      setThemeState(t);
    },
    setFont(f) {
      localStorage.setItem(FONT_KEY, f);
      setFontState(f);
    },
  };
}
