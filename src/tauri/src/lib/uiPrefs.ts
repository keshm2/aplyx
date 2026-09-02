import { useEffect, useState } from "react";

/**
 * Appearance preference (mode only), persisted in localStorage and applied
 * as a data attribute on <html> that tokens.css keys off:
 * - "system" leaves the attribute off (the prefers-color-scheme media
 *   query decides); "light"/"dark" set data-theme, which wins over the
 *   media query in both directions.
 * Purely a webview concern; nothing here touches the Python-owned state.
 * There used to be two more axes here — themeFamily (which of six
 * palettes) and font (which of six bundled faces). The app now ships
 * exactly one palette (Moss, tokens.css) and one typeface pairing
 * (Manrope + Inter, base.css), so both pickers were removed rather than
 * left as single-option controls.
 */

export type ThemePref = "system" | "light" | "dark";

const THEME_KEY = "aplyx.theme";

export function loadThemePref(): ThemePref {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function applyUiPrefs(theme: ThemePref = loadThemePref()): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
  // A stale data-font from a build that still had the picker: clear it so
  // an old localStorage value can't pin a font family that no longer has
  // an @font-face rule.
  delete root.dataset["font"];
}

export function useUiPrefs(): {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
} {
  const [theme, setThemeState] = useState<ThemePref>(loadThemePref);

  useEffect(() => {
    applyUiPrefs(theme);
  }, [theme]);

  return {
    theme,
    setTheme(t) {
      localStorage.setItem(THEME_KEY, t);
      setThemeState(t);
    },
  };
}
