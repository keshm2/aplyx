import { useUiPrefs, type ThemePref } from "../../../lib/uiPrefs";
import "../../../components/formFields.css";

// Same option set as Settings → Preferences → Appearance
// (src/tauri/src/routes/shell/SettingsPreferencesTab.tsx); one definition
// would be cleaner, but onboarding and Settings render it in different
// layouts (a wizard step vs. a settings section) and duplicating one
// short array beats threading a shared component through two very
// different shells for this little content.
const THEME_OPTIONS: { value: ThemePref; label: string; detail: string }[] = [
  { value: "system", label: "System", detail: "Follow the OS appearance" },
  { value: "light", label: "Light", detail: "Always light" },
  { value: "dark", label: "Dark", detail: "Always dark" },
];

/** Sets the appearance mode live as the user picks, via the same
 *  useUiPrefs() hook Settings uses: the instant the mode changes here,
 *  tokens.css's [data-theme] attribute updates on <html>, so every wizard
 *  page after this one (and this one itself) already reflects the choice. */
export function PreferencesStep() {
  const { theme, setTheme } = useUiPrefs();

  return (
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
  );
}
