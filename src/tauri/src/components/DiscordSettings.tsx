import { useEffect, useState } from "react";
import { readDiscordConfig, writeDiscordConfig, type DiscordConfig } from "../lib/bridge";
import "./formFields.css";

const ROUTES: { key: keyof Omit<DiscordConfig, "enabled">; label: string }[] = [
  { key: "success", label: "Applied" },
  { key: "needs_review", label: "Needs review" },
  { key: "failed", label: "Failed" },
  { key: "summary", label: "Run summary" },
];

/** Discord webhook config editor — shared by onboarding's NotificationsStep
 *  (first-time setup) and Settings (edit any time after). Both read/write
 *  the same src/config/discord_config.json via the same bridge calls, so
 *  either surface immediately reflects a change made in the other. */
export function DiscordSettings({ root }: { root: string }) {
  const [config, setConfig] = useState<DiscordConfig | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    readDiscordConfig(root)
      .then(setConfig)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [root]);

  async function save(next: DiscordConfig) {
    setConfig(next);
    await writeDiscordConfig(root, next);
  }

  if (loadError) {
    return (
      <p className="field-help" style={{ color: "var(--danger)" }}>
        Couldn&rsquo;t read the Discord settings ({loadError}).
      </p>
    );
  }
  if (!config) return <p className="field-help">Loading&hellip;</p>;

  return (
    <div>
      <div className="check-row" style={{ marginBottom: config.enabled ? "1rem" : 0 }}>
        <span className={`check-icon ${config.enabled ? "check-icon-ok" : "check-icon-pending"}`}>
          {config.enabled ? "✓" : "–"}
        </span>
        <div style={{ flex: 1 }}>
          <div className="check-label">Discord notifications</div>
          <div className="check-detail">Optional — get pinged as aplyx applies, or skip this.</div>
        </div>
        <button
          type="button"
          className="settings-action-btn"
          onClick={() => void save({ ...config, enabled: !config.enabled })}
        >
          {config.enabled ? "Disable" : "Enable"}
        </button>
      </div>

      {config.enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {ROUTES.map(({ key, label }) => (
            <div className="field" key={key}>
              <label className="field-label" htmlFor={`discord-${key}`}>
                {label} webhook URL
              </label>
              <input
                id={`discord-${key}`}
                type="url"
                placeholder="https://discord.com/api/webhooks/…"
                value={config[key]}
                onChange={(e) => setConfig({ ...config, [key]: e.currentTarget.value })}
                onBlur={() => void save(config)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
