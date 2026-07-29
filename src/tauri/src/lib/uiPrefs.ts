import { useEffect, useState } from "react";

/**
 * Appearance preferences (mode + theme family + UI font), persisted in
 * localStorage and applied as data attributes on <html> that tokens.css
 * keys off:
 * - theme: "system" leaves the attribute off (the prefers-color-scheme
 *   media query decides); "light"/"dark" set data-theme, which wins over
 *   the media query in both directions.
 * - themeFamily: which palette (data-theme-family) — independent of
 *   mode; every family defines its own light/dark pair (tokens.css).
 * - font: "system" (default stack) or one of the bundled variable faces
 *   (see base.css @font-face and this file's FONT_LABELS).
 * Purely a webview concern — nothing here touches the Python-owned state.
 */

export type ThemePref = "system" | "light" | "dark";
export type ThemeFamily = "cobalt" | "sage" | "legacy" | "graphite" | "ember";
export type FontPref = "system" | "geist" | "inter" | "plex" | "atkinson";

const THEME_KEY = "aplyx.theme";
const THEME_FAMILY_KEY = "aplyx.themeFamily";
const FONT_KEY = "aplyx.font";

const THEME_FAMILIES: ThemeFamily[] = ["cobalt", "sage", "legacy", "graphite", "ember"];
const FONTS: FontPref[] = ["system", "geist", "inter", "plex", "atkinson"];

export const THEME_FAMILY_LABELS: Record<ThemeFamily, string> = {
  cobalt: "Calm Cobalt",
  sage: "Sage Slate",
  legacy: "Aplyx Classic",
  graphite: "Graphite Cyan",
  ember: "Ember Glow",
};

export const FONT_LABELS: Record<FontPref, string> = {
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

export function loadThemeFamily(): ThemeFamily {
  const raw = localStorage.getItem(THEME_FAMILY_KEY);
  return (THEME_FAMILIES as string[]).includes(raw ?? "") ? (raw as ThemeFamily) : "cobalt";
}

export function loadFontPref(): FontPref {
  const raw = localStorage.getItem(FONT_KEY);
  return (FONTS as string[]).includes(raw ?? "") ? (raw as FontPref) : "system";
}

export function applyUiPrefs(
  theme: ThemePref = loadThemePref(),
  font: FontPref = loadFontPref(),
  themeFamily: ThemeFamily = loadThemeFamily(),
): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
  root.dataset["themeFamily"] = themeFamily;
  if (font === "system") delete root.dataset["font"];
  else root.dataset["font"] = font;
}

export function useUiPrefs(): {
  theme: ThemePref;
  themeFamily: ThemeFamily;
  font: FontPref;
  setTheme: (t: ThemePref) => void;
  setThemeFamily: (f: ThemeFamily) => void;
  setFont: (f: FontPref) => void;
} {
  const [theme, setThemeState] = useState<ThemePref>(loadThemePref);
  const [themeFamily, setThemeFamilyState] = useState<ThemeFamily>(loadThemeFamily);
  const [font, setFontState] = useState<FontPref>(loadFontPref);

  useEffect(() => {
    applyUiPrefs(theme, font, themeFamily);
  }, [theme, font, themeFamily]);

  return {
    theme,
    themeFamily,
    font,
    setTheme(t) {
      localStorage.setItem(THEME_KEY, t);
      setThemeState(t);
    },
    setThemeFamily(f) {
      localStorage.setItem(THEME_FAMILY_KEY, f);
      setThemeFamilyState(f);
    },
    setFont(f) {
      localStorage.setItem(FONT_KEY, f);
      setFontState(f);
    },
  };
}
