/**
 * Coding-agent name + logo, shared by onboarding's CodingAgentStep and
 * Settings' "Coding agent" section so both pickers look and behave the
 * same. The label/logo map here duplicates src/core/src/harness.ts's
 * KNOWN set on purpose instead of importing it. That module pulls in
 * Node's fs/path for its config read/write side, and a real (non-type)
 * import into this Vite-bundled frontend would drag those Node-only
 * built-ins into the browser bundle. Same "join" is not exported by
 * "__vite-browser-external" break we already hit once with
 * masterResume.ts/resumeReflow.ts. Keep this file dependency-free.
 */
import "./formFields.css";

export const HARNESS_LABELS: Record<string, string> = {
  opencode: "opencode",
  claude: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
};

const LOGO_PROPS = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** opencode: a terminal-prompt bracket mark. */
function OpencodeLogo() {
  return (
    <svg {...LOGO_PROPS}>
      <path d="m8 8-4 4 4 4" />
      <path d="m16 8 4 4-4 4" />
      <path d="M13 6 11 18" />
    </svg>
  );
}

/** Claude Code: Anthropic's mark is an eight-ray starburst. */
function ClaudeLogo() {
  return (
    <svg {...LOGO_PROPS}>
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
      <path d="m5.6 5.6 4.2 4.2M14.2 14.2l4.2 4.2M18.4 5.6l-4.2 4.2M9.8 14.2l-4.2 4.2" />
    </svg>
  );
}

/** Codex / OpenAI: a simplified six-node interlocking ring. */
function CodexLogo() {
  return (
    <svg {...LOGO_PROPS}>
      <circle cx="12" cy="12" r="2.1" />
      <circle cx="12" cy="5.5" r="1.6" />
      <circle cx="17.6" cy="8.75" r="1.6" />
      <circle cx="17.6" cy="15.25" r="1.6" />
      <circle cx="12" cy="18.5" r="1.6" />
      <circle cx="6.4" cy="15.25" r="1.6" />
      <circle cx="6.4" cy="8.75" r="1.6" />
    </svg>
  );
}

/** GitHub Copilot: a rounded goggle shape. */
function CopilotLogo() {
  return (
    <svg {...LOGO_PROPS}>
      <rect x="2.5" y="9" width="7" height="7" rx="2.5" />
      <rect x="14.5" y="9" width="7" height="7" rx="2.5" />
      <path d="M9.5 11.5h5" />
      <path d="M6 9V7.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2V9" />
    </svg>
  );
}

const LOGOS: Record<string, () => JSX.Element> = {
  opencode: OpencodeLogo,
  claude: ClaudeLogo,
  codex: CodexLogo,
  copilot: CopilotLogo,
};

export function HarnessLogo({ harness }: { harness: string }) {
  const Logo = LOGOS[harness];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "1.75rem",
        height: "1.75rem",
        borderRadius: "var(--radius-sm)",
        background: "var(--surface-raised)",
        color: "var(--text-muted)",
        flexShrink: 0,
      }}
    >
      {Logo ? <Logo /> : harness.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function HarnessPicker({
  options,
  selected,
  onSelect,
  disabled,
}: {
  options: string[];
  selected: string | undefined;
  onSelect: (harness: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="option-list" role="radiogroup" aria-label="Coding agent">
      {options.map((harness) => (
        <button
          key={harness}
          type="button"
          className={`option-card ${selected === harness ? "selected" : ""}`}
          onClick={() => onSelect(harness)}
          role="radio"
          aria-checked={selected === harness}
          disabled={disabled}
          style={{ gap: "var(--space-3)" }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <HarnessLogo harness={harness} />
            <span className="option-card-title">{HARNESS_LABELS[harness] ?? harness}</span>
          </span>
          {selected === harness && <span aria-hidden="true">✓</span>}
        </button>
      ))}
    </div>
  );
}
