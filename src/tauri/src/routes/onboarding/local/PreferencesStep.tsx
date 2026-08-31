import { useUiPrefs, FONT_LABELS, type FontPref, type ThemePref } from "../../../lib/uiPrefs";
import "../../../components/formFields.css";

// Same two option sets as Settings → Preferences → Appearance
// (src/tauri/src/routes/shell/SettingsPreferencesTab.tsx); one definition
// would be cleaner, but onboarding and
// Settings render them in different layouts (a wizard step vs. a settings
// section) and duplicating two short arrays beats threading a shared
// component through two very different shells for this little content.
const THEME_OPTIONS: { value: ThemePref; label: string; detail: string }[] = [
  { value: "system", label: "System", detail: "Follow the OS appearance" },
  { value: "light", label: "Light", detail: "Always light" },
  { value: "dark", label: "Dark", detail: "Always dark" },
];

const FONT_OPTIONS: { value: FontPref; detail: string }[] = [
  { value: "system", detail: "Your OS's native UI font" },
  { value: "geist", detail: "Bundled Geist + Geist Mono: modern, technical-product feel" },
  { value: "inter", detail: "Bundled Inter: strong for dense, tabular product UI" },
  { value: "plex", detail: "Bundled IBM Plex Sans + Plex Mono: enterprise, analytical tone" },
  { value: "atkinson", detail: "Bundled Atkinson Hyperlegible Next: accessibility- and readability-first" },
];

/** Sets appearance prefs live as the user picks, via the same useUiPrefs()
 *  hook Settings uses: the instant the mode/font changes here, tokens.css's
 *  [data-theme]/[data-font] attributes update on <html>, so every wizard
 *  page after this one (and this one itself) already reflects the choice.
 *  Nothing else needed to keep "the rest of onboarding matches" true. */
export function PreferencesStep() {
  const { theme, font, setTheme, setFont } = useUiPrefs();

  return (
    <>
      <div className="field">
        <span className="field-label">Mode</span>
        <div className="yesno-toggle" role="group" aria-label="Mode">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={theme === opt.value ? "selected" : ""}
              title={opt.detail}
              onClick={() => setTheme(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="field-help">System follows your OS and switches automatically; Light/Dark pin it.</p>
      </div>

      <div className="field">
        <span className="field-label">Font</span>
        <div className="yesno-toggle" role="group" aria-label="Font">
          {FONT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={font === opt.value ? "selected" : ""}
              title={opt.detail}
              onClick={() => setFont(opt.value)}
            >
              {FONT_LABELS[opt.value]}
            </button>
          ))}
        </div>
        <p className="field-help">
          {FONT_OPTIONS.find((o) => o.value === font)?.detail} Bundled fonts apply to the
          whole interface: no download, works offline.
        </p>
      </div>
    </>
  );
}
