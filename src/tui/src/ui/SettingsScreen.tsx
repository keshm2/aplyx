import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { statusGlyph, theme, harnessGradient, pageSizeTier, HARNESS_WAVE_TICK_MS, HARNESS_WAVE_STEP, THEME_NAMES, type HarnessId, type ThemeMode } from "../theme.js";
import { DEFAULT_PAGE_SIZE, MIN_PAGE_SIZE, MAX_PAGE_SIZE, DEFAULT_RESULTS_PER_PAGE } from "../jobs.js";
import {
  effectiveEnv,
  readDiscordEnabled,
  readDiscordRoute,
  readEnvOverride,
  readSafeField,
  readTargetsArrayList,
  writeDiscordEnabled,
  writeDiscordRoute,
  writeEnvOverride,
  writeSafeField,
  writeTargetsArrayList,
  writeTargetsBool,
} from "@aplyx/core/settings.js";
import { readProfileUsername, writeProfileUsername } from "@aplyx/core/profileLinks.js";
import { openPath } from "@aplyx/core/helpers.js";
import { resumesDir } from "../resumes.js";
import { detectHarnessOnPath } from "../harness.js";
import { isDesktopAppInstalled, desktopInstalledVersion } from "@aplyx/core/desktopApp.js";
import { readCommittedCompanyDisplays, writeCommittedCompanyDisplays } from "@aplyx/core/companyTargets.js";
import { loadCompanyDirectory, companyWeight, type CompanyEntry } from "@aplyx/core/data/companyDirectory.js";
import { US_CITIES } from "@aplyx/core/data/usCities.js";
import { ROLE_CATEGORIES } from "@aplyx/core/data/roleCategories.js";
import { LEVEL_CATEGORIES } from "@aplyx/core/data/levelCategories.js";
import { SEASON_CATEGORIES } from "@aplyx/core/data/seasonCategories.js";
import { selectedCategoryIds, keywordsForSelectedCategories, type KeywordCategory } from "../categorySelection.js";
import { filterSuggestions } from "./autocomplete.js";
import { MultiEntryAutocomplete } from "./MultiEntryAutocomplete.js";
import { AutoSparkleText, RainbowText } from "./KeyHints.js";
import { wrapPadded, wrapText } from "./wrapText.js";
import {
  InlineTextInput,
  deleteBackward,
  insertAtCursor,
  moveCursorLeft,
  moveCursorRight,
} from "./TextInput.js";

/**
 * Settings tab: view and edit the config that drives aplyx:
 * personal info (src/config/targets.json safe_fields), Discord webhooks
 * (src/config/discord_config.json), and persisted APLYX_* environment
 * overrides (src/config/env.json, exported by the runner; a real env var
 * always wins).
 *
 * Every interactive list (section list, field list, choice menus,
 * checklists, search suggestions) uses the same `[x]`/`[ ]` bracket
 * convention: `[✓]` in submenus marks an actual SELECTED value (a
 * saved single-select choice, a checked category, an already-added
 * search result), never just cursor position (that's the separate `>`
 * arrow). Field-list rows show ONLY the label (no inline value dump),
 * so the list never overflows into packed, unreadable comma-separated
 * text; a field's current value is only ever shown INSIDE its own edit
 * popup, not as a standing summary line.
 *
 * Every edit opens as a bordered "popup" beneath the (dimmed, so the
 * popup reads as the thing in front) field list. Ink has no real
 * floating/z-index layer to draw a true overlay on, so this is the
 * closest approximation: a visually distinct, boldly-bordered panel
 * that appears to rise from the row you opened, not just more content
 * appended at the bottom of the screen.
 *
 * Checklist/choice/search submenus write through to disk on every
 * toggle: pressing enter/space on an option takes effect immediately
 * (same instant-effect feel as the Discord "Enabled" toggle), so there
 * is nothing left to commit when you leave; Escape's only job in those
 * three is to close the popup. The plain single-value text editor
 * (personal info, Discord webhook URLs, env overrides) is the one
 * exception: Enter still saves it and Escape still discards an
 * in-progress edit, unchanged from before.
 */

interface CategoryOption extends KeywordCategory {
  label: string;
  hint?: string;
  setsAllowExperienced?: boolean;
}

interface Field {
  key: string;
  label: string;
  explain: string;
  kind:
    | "personal"
    | "discord-route"
    | "discord-enabled"
    | "env"
    | "targets-array"
    | "personal-link"
    | "company-autocomplete"
    | "location-autocomplete"
    | "checklist"
    /** Fires a side effect on Enter instead of editing a value (e.g. open
     *  the resumes folder in the OS file manager). Has no stored value, so
     *  it renders without one. */
    | "action";
  /** Default shown for env fields when neither env nor config set it. */
  fallback?: string;
  /** Older env-var names for this field, still honored when reading the
   *  effective value (checked in order, after `key`); carries settings
   *  forward across a rebrand without silently dropping what's already set. */
  legacyKeys?: string[];
  /** Present on an "env" field to edit it as a fixed choice menu (arrow
   *  up/down + enter to select) instead of freeform text, e.g.
   *  yes/no for auto-update, or the coding-agent list for
   *  APLYX_HARNESS. `harness`, when set, renders that option's label
   *  in its harness wave color (see theme.ts's harnessGradient), the
   *  same effect a live run driven by that harness uses, so picking
   *  one previews it. */
  options?: { label: string; value: string; harness?: HarnessId }[];
  /** Present on a "checklist" field: a fixed set of checkbox categories
   *  (see src/tui/src/data/{role,level,season}Categories.ts). Checking one
   *  writes its whole keyword bundle into the array at `key`. */
  categories?: CategoryOption[];
  /** Still shown and navigable, but Enter is a no-op and the row renders
   *  dimmed, for a field with no working edit path yet (Workday has no
   *  company-slug API the way Ashby/Lever/Greenhouse do). */
  disabled?: string;
}

interface Section {
  name: string;
  description: string;
  fields: Field[];
}

const SECTIONS: Section[] = [
  {
    name: "Personal info",
    description:
      "Your safe_fields (the only values ever typed into application forms) plus how the TUI addresses you. Stored in src/config/targets.json (gitignored, local only).",
    fields: [
      { kind: "personal", key: "preferred_name", label: "Preferred name", explain: "How the TUI greets you in the sidebar. Leave empty to fall back to your first name." },
      { kind: "personal", key: "first_name", label: "First name", explain: "Legal first name typed into application forms." },
      { kind: "personal", key: "last_name", label: "Last name", explain: "Legal last name typed into application forms." },
      { kind: "personal", key: "email", label: "Email", explain: "Contact email used on applications." },
      { kind: "personal", key: "phone", label: "Phone", explain: "Contact phone number used on applications." },
      { kind: "personal-link", key: "linkedin_username", label: "LinkedIn username", explain: "LinkedIn username only (e.g. jane-doe-123); aplyx builds the full profile URL for you." },
      { kind: "personal-link", key: "github_username", label: "GitHub username", explain: "GitHub username only (e.g. jane-doe); aplyx builds the full profile URL for you." },
      { kind: "personal", key: "location", label: "Location", explain: "Home city/state (e.g. Seattle, WA) used on applications." },
      { kind: "personal", key: "zip_code", label: "Zip code", explain: "Home zip code used on applications." },
      { kind: "personal", key: "address_line1", label: "Address line 1", explain: "Street address used on applications." },
      { kind: "personal", key: "address_line2", label: "Address line 2", explain: "Apartment/unit (optional), used on applications." },
      { kind: "personal", key: "gender", label: "Gender", explain: "Optional EEO demographic question many applications ask. Leave empty to decline; aplyx never invents an answer for a field you left blank." },
      { kind: "personal", key: "ethnicity", label: "Ethnicity", explain: "Optional EEO demographic question some applications ask." },
      { kind: "personal", key: "hispanic_or_latino", label: "Hispanic/Latino", explain: "Optional EEO demographic question some applications ask." },
      { kind: "personal", key: "date_of_birth", label: "Date of birth", explain: "Only used where an application form explicitly requires it." },
      {
        kind: "personal",
        key: "veteran_status",
        label: "Veteran status",
        explain:
          'EEO demographic question many applications ask; onboarding requires an answer. Type "not_veteran", "veteran", or "decline"; aplyx never invents an answer.',
      },
      {
        kind: "personal",
        key: "disability_status",
        label: "Disability status",
        explain:
          'EEO demographic question many applications ask; onboarding requires an answer. Type "no", "yes", or "decline"; aplyx never invents an answer.',
      },
      { kind: "personal", key: "graduation_date", label: "Graduation", explain: "Graduation date (Month Year); forms and the fit gate both use it." },
    ],
  },
  {
    name: "Company targets",
    description:
      "Which roles, levels, seasons, locations, and companies aplyx searches for. Stored in src/config/targets.json (gitignored, local only). Roles/levels/seasons open a checkbox submenu; locations/companies open a search submenu.",
    fields: [
      {
        kind: "checklist",
        key: "role_keywords",
        label: "Roles",
        explain: "Which kinds of roles aplyx searches for: check every category that applies.",
        categories: ROLE_CATEGORIES,
      },
      {
        kind: "checklist",
        key: "level_keywords",
        label: "Levels",
        explain:
          "Which experience levels aplyx searches for. \"Full time\" also relaxes the fit gate's 3+ years hard-reject so senior/experienced postings are no longer automatically skipped; it does not affect how intern/new-grad/entry-level postings are found.",
        categories: LEVEL_CATEGORIES,
      },
      {
        kind: "checklist",
        key: "season_keywords",
        label: "Seasons",
        explain: "Which internship/co-op seasons aplyx searches for: check every one that applies.",
        categories: SEASON_CATEGORIES,
      },
      { kind: "location-autocomplete", key: "preferred_locations", label: "Preferred locations", explain: "Locations to prioritize, e.g. Remote, Seattle, WA. Search by name; already-added ones show a ✓." },
      { kind: "company-autocomplete", key: "target_companies", label: "Target companies", explain: "Companies aplyx watches for new postings: search by name (the same autofill used during setup); aplyx figures out whether it's tracked via Ashby, Lever, or Greenhouse and stores the right identifier for you. Already-added companies show a ✓." },
      {
        kind: "targets-array",
        key: "workday_tenants",
        label: "Workday tenants",
        explain: "Workday tenant identifiers to scrape and apply through the local browser runtime. Editing here isn't supported yet: Workday has no company-search API like Ashby/Lever/Greenhouse; edit src/config/targets.json by hand for now.",
        disabled: "not editable here yet: edit src/config/targets.json by hand",
      },
    ],
  },
  {
    name: "Resumes",
    description:
      "Where aplyx reads your resume PDFs from. Drop files into the folder, then convert them to markdown from the Resumes tab.",
    fields: [
      {
        kind: "action",
        key: "open_resumes_folder",
        label: "Open resumes folder",
        explain:
          "Opens the resumes folder in Finder / File Explorer / your Linux file manager so you can drag resume PDFs straight in; no need to find the path yourself. The folder is created if it doesn't exist yet.",
      },
    ],
  },
  {
    name: "Desktop app",
    description:
      "aplyx also has an early-preview desktop app (Tauri) alongside this TUI: same local data, same config, just a graphical shell. Optional; skipping it during setup doesn't block anything here.",
    fields: [
      {
        kind: "action",
        key: "install_desktop_app",
        label: "Install desktop app",
        explain:
          "Leaves the TUI and hands off to src/scripts/install/install_desktop.sh (or the .ps1 equivalent on Windows) on the normal screen: it has its own prompts (prefers a prebuilt download; falls back to building from source, which needs Rust). Returns you to a fresh aplyx launch when it's done. Already installed? This row shows a checkmark instead and Enter does nothing; reinstall any time by re-running that script directly.",
      },
    ],
  },
  {
    name: "Discord webhooks",
    description:
      "Optional status updates. Each Discord webhook is bound to ONE channel; separate channels need separate links. Stored in src/config/discord_config.json.",
    fields: [
      { kind: "discord-enabled", key: "enabled", label: "Enabled", explain: "Master switch: enter toggles it. Off: outcomes stay local (state files + TUI) and no webhook is ever called." },
      { kind: "discord-route", key: "success", label: "success", explain: "Webhook URL for successful applications. Required when Discord is enabled." },
      { kind: "discord-route", key: "needs_review", label: "needs_review", explain: "Webhook URL for jobs that need your manual review. Required when enabled." },
      { kind: "discord-route", key: "failed", label: "failed", explain: "Webhook URL for failed application attempts. Required when enabled." },
      { kind: "discord-route", key: "summary", label: "summary", explain: "Webhook URL for the end-of-batch summary. Optional: empty falls back to the success webhook." },
    ],
  },
  {
    name: "Preferences",
    description:
      "Persisted APLYX_* overrides, saved to src/config/env.json and exported by every run. A variable set in your real shell environment always wins. Empty a value to return to the default.",
    fields: [
      { kind: "env", key: "APLYX_LOG_DIR", legacyKeys: ["FLUX_LOG_DIR"], label: "Log directory", explain: "Where run/session logs and the heartbeat are stored. Relative paths resolve inside the project. (Agent fetch-scratch stays in the project's logs/tmp.)", fallback: "logs" },
      {
        kind: "env",
        key: "APLYX_DEBUG_LOGGING",
        legacyKeys: ["FLUX_DEBUG_LOGGING"],
        label: "Debug logging",
        explain: "Writes an extra logs/debug.log with internal run details (resolved env vars, harness selection, the exact command argv, session-cap resolution, duration) for troubleshooting a specific run. Separate from (and never disables) the always-on session log RunScreen's live tail and Status' \"last run\" both read from. Off by default; only worth turning on while actually debugging something, since it does add noise to logs/.",
        fallback: "0",
        options: [
          { label: "No", value: "0" },
          { label: "Yes", value: "1" },
        ],
      },
      { kind: "env", key: "APLYX_SESSION_CAP", legacyKeys: ["FLUX_SESSION_CAP", "ARES_SESSION_CAP"], label: "Session cap", explain: "Default applications-per-run cap, 1-25. Runs may lower it; 25 is the hard ceiling.", fallback: "25" },
      { kind: "env", key: "APLYX_JOBS_PER_PAGE", legacyKeys: ["FLUX_JOBS_PER_PAGE"], label: "Max search results", explain: `How many total results the manual Jobs search keeps per search, ${MIN_PAGE_SIZE}-${MAX_PAGE_SIZE}. Separate from "Results per page" below, which just controls how many of these are shown on screen at once.`, fallback: String(DEFAULT_PAGE_SIZE) },
      { kind: "env", key: "APLYX_RESULTS_PER_PAGE", label: "Results per page", explain: `How many results the Jobs screen shows per page: ↑/PgUp and ↓/PgDn move within a page, [ and ] move between pages. Default ${DEFAULT_RESULTS_PER_PAGE}.`, fallback: String(DEFAULT_RESULTS_PER_PAGE) },
      { kind: "env", key: "APLYX_KEEP_SESSION_LOGS", legacyKeys: ["FLUX_KEEP_SESSION_LOGS", "ARES_KEEP_SESSION_LOGS"], label: "Keep logs", explain: "How many session logs to keep before the oldest are pruned.", fallback: "30" },
      { kind: "env", key: "APLYX_LOCK_MAX_AGE_MIN", legacyKeys: ["FLUX_LOCK_MAX_AGE_MIN", "ARES_LOCK_MAX_AGE_MIN"], label: "Lock max age", explain: "Minutes before a hung run's lock is force-reclaimed by the next scheduled tick.", fallback: "60" },
      {
        kind: "env",
        key: "APLYX_AUTO_UPDATE",
        legacyKeys: ["FLUX_AUTO_UPDATE", "ARES_AUTO_UPDATE"],
        label: "Auto-update",
        explain: "Yes = self-update from GitHub main on every run/launch; No = never update automatically.",
        fallback: "1",
        options: [
          { label: "Yes", value: "1" },
          { label: "No", value: "0" },
        ],
      },
      {
        kind: "env",
        key: "APLYX_HARNESS",
        legacyKeys: ["FLUX_HARNESS", "ARES_HARNESS"],
        label: "Coding agent",
        explain: "Which coding agent runs the apply loop. Auto defers to src/config/harness.json, then whichever CLI is found on PATH. A live run's wave/spinner color always matches this choice.",
        fallback: "",
        options: [
          { label: "Auto (env / harness.json / detect)", value: "", harness: "auto" },
          { label: "Claude Code", value: "claude", harness: "claude" },
          { label: "opencode", value: "opencode", harness: "opencode" },
          { label: "Codex", value: "codex", harness: "codex" },
          { label: "Copilot", value: "copilot", harness: "copilot" },
        ],
      },
      {
        kind: "env",
        key: "APLYX_TUI_THEME",
        label: "Theme",
        explain: "Recolors aplyx's own accent/status text and the ASCII banner only: Aplyx Default, Ember Dusk, and Volt Noir are tuned for a dark terminal background; Cloud Surf and Mint Frost swap in darker accent/status colors tuned to stay readable if YOUR terminal's background is already light (named ANSI yellow in particular is hard to read on white). This does NOT change your terminal's background color itself: that's controlled by your terminal app's own color scheme/profile setting, outside aplyx. Takes effect immediately, no restart needed.",
        fallback: "aplyx-default",
        options: (Object.entries(THEME_NAMES) as [ThemeMode, string][]).map(([value, label]) => ({ label, value })),
      },
      {
        kind: "env",
        key: "APLYX_24_HOUR_CLOCK",
        label: "24-hour clock",
        explain: "Switches the sidebar clock from 12-hour (2:30 PM) to 24-hour (14:30) time.",
        fallback: "0",
        options: [
          { label: "No (12-hour)", value: "0" },
          { label: "Yes (24-hour)", value: "1" },
        ],
      },
      {
        kind: "env",
        key: "APLYX_REDUCED_MOTION",
        label: "Reduced motion",
        explain: "Turns off the AUTO-badge sparkle and other cycling color animations, leaving a plain static color instead. The spinner glyph itself still shows during a live run either way; only the color cycling stops.",
        fallback: "0",
        options: [
          { label: "No", value: "0" },
          { label: "Yes", value: "1" },
        ],
      },
    ],
  },
];

function currentValue(root: string, field: Field, directory?: CompanyEntry[]): { value: string; note: string } {
  switch (field.kind) {
    // An action has no stored value: the row is a button, so the value
    // column shows where it will take you rather than "(not set)".
    case "action":
      return { value: field.key === "open_resumes_folder" ? resumesDir(root) : "", note: "" };
    case "personal": {
      const v = readSafeField(root, field.key);
      return { value: v || "(not set)", note: "" };
    }
    case "personal-link": {
      const kind = field.key === "linkedin_username" ? "linkedin" : "github";
      const v = readProfileUsername(root, kind);
      return { value: v || "(not set)", note: "" };
    }
    case "targets-array":
    case "location-autocomplete":
    case "checklist": {
      const v = readTargetsArrayList(root, field.key).join(", ");
      return { value: v || "(not set)", note: "" };
    }
    case "company-autocomplete": {
      const displays = readCommittedCompanyDisplays(root, directory ?? loadCompanyDirectory(root));
      return { value: displays.length > 0 ? displays.join(", ") : "(not set)", note: "" };
    }
    case "discord-enabled":
      return { value: readDiscordEnabled(root) ? "yes" : "no", note: "" };
    case "discord-route": {
      const v = readDiscordRoute(root, field.key);
      return { value: v || "(not set)", note: "" };
    }
    case "env": {
      const eff = effectiveEnv(root, [field.key, ...(field.legacyKeys ?? [])], field.fallback ?? "");
      if (field.options) {
        const match = field.options.find((o) => o.value === eff.value);
        return { value: match ? optionLabel(field, match) : eff.value || "(not set)", note: eff.origin };
      }
      return { value: eff.value || "(not set)", note: eff.origin };
    }
  }
}

/**
 * Display label for a fixed-choice option. Everything renders as authored
 * except the Coding agent's "Auto" row, which names the agent it actually
 * resolves to right now: a bare "Auto" told the user nothing about which
 * of the four would drive the run, which was the whole question they were
 * asking the row. Resolved live (a few stat calls) so installing an agent
 * is reflected without restarting the TUI.
 */
function optionLabel(field: Field, option: { label: string; value: string }): string {
  if (field.key !== "APLYX_HARNESS" || option.value !== "") return option.label;
  const detected = detectHarnessOnPath();
  if (!detected) return "Auto (no coding agent found on PATH)";
  const name = field.options?.find((o) => o.value === detected)?.label ?? detected;
  return `Auto (detected and using ${name})`;
}

/** Plain single-value text fields (personal info, Discord webhook URLs,
 *  env overrides without a fixed choice list), the one kind that keeps
 *  Enter-saves/Escape-discards, distinct from every other kind's
 *  write-on-toggle/escape-just-closes model. */
function clampPageSize(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, n));
}

function isPlainTextField(field: Field): boolean {
  return field.kind === "personal" || field.kind === "personal-link" || field.kind === "discord-route" || (field.kind === "env" && !field.options);
}

/** Bracket-checkbox row, shared by the section list and the field list:
 *  `[x]`/`[ ]` here means "this is where the cursor is," not a
 *  persisted selection (neither list has one). Personal info's fields
 *  pass `value` to show it inline (short single-token values: name,
 *  email, phone, read fine on one line); Company targets' checklist/
 *  search fields never pass it, since their values are long
 *  comma-separated lists that were the original clutter complaint. */
function NavRow({
  label,
  focused,
  dim,
  value,
}: {
  label: string;
  focused: boolean;
  dim?: boolean;
  value?: string;
}) {
  const color = dim ? undefined : focused ? theme.accent : undefined;
  const bold = focused && !dim;
  const prefix = (
    <Text color={color} bold={bold} dimColor={dim} wrap="truncate-end">
      {focused ? "> " : "  "}[{focused ? "x" : " "}] {label}
    </Text>
  );
  if (value === undefined) return prefix;
  // Values (names, emails, phone numbers) are short single tokens: right-
  // aligning them to the row's edge via a flex spacer reads as a clean
  // aligned column instead of ragged left-packed text.
  return (
    <Box>
      {prefix}
      <Box flexGrow={1} />
      <Text color={color} bold={bold} dimColor={dim} wrap="truncate-end">
        {value}
      </Text>
    </Box>
  );
}

/** Bracket-checkbox row for a submenu option: `[✓]` marks a real
 *  selected/added value (theme.good), independent of the `>` focus
 *  arrow. `preview`, when given, renders the label via that node instead
 *  of plain text (the harness-wave name preview). */
function OptionRow({
  label,
  focused,
  checked,
  hint,
  preview,
}: {
  label: string;
  focused: boolean;
  checked: boolean;
  hint?: string;
  preview?: React.ReactNode;
}) {
  return (
    <Text wrap="truncate-end">
      <Text color={focused ? theme.accent : undefined} bold={focused}>
        {focused ? "> " : "  "}[
      </Text>
      <Text color={checked ? theme.good : undefined}>{checked ? statusGlyph.applied : " "}</Text>
      <Text color={focused ? theme.accent : undefined} bold={focused}>
        {"] "}
      </Text>
      {preview ?? (
        <Text color={focused ? theme.accent : undefined} bold={focused}>
          {label}
          {hint ? ` (${hint})` : ""}
        </Text>
      )}
    </Text>
  );
}

export function SettingsScreen({
  root,
  active,
  onInputActiveChange,
  onSettingsChange,
  onInstallDesktopApp,
  contentRows = 20,
  columns = 76,
}: {
  root: string;
  active: boolean;
  onInputActiveChange: (active: boolean) => void;
  /** Fired after any write so the shell (sidebar name, etc.) refreshes. */
  onSettingsChange?: () => void;
  /** Fired when the user triggers "Install desktop app": App.tsx wraps
   *  this with Ink's exit() so the installer's own interactive prompts
   *  run on the normal screen after the TUI leaves the alt screen, the
   *  same handoff the update-install flow already uses (see cli.tsx's
   *  openApp). Not shown/wired at all once the app is already installed. */
  onInstallDesktopApp?: () => void;
  contentRows?: number;
  columns?: number;
}) {
  const [sectionCursor, setSectionCursor] = useState(0);
  const [inSection, setInSection] = useState(false);
  const [fieldCursor, setFieldCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editCursor, setEditCursor] = useState(0);
  // "targets-array" fields (workday_tenants, currently the only one left
  // since role/level/season moved to "checklist") can hold many entries: editing
  // as one comma-joined line overflows the terminal width with no way to
  // see the cursor. Instead editItems holds the parsed list; editValue/
  // editCursor become the small "add one item" box. Also doubles as the
  // live-mirrors-disk item list for company/location search.
  const [editItems, setEditItems] = useState<string[]>([]);
  // "company-autocomplete"/"location-autocomplete" mirror the onboarding
  // wizard's suggestion-driven fields: editSuggestionIndex is the
  // wizard's suggestionIndex, editHint is its entryHint.
  const [editSuggestionIndex, setEditSuggestionIndex] = useState(0);
  // Choice fields (Auto-update, Coding agent) and checklist fields
  // (Roles, Levels, Seasons) both edit via a fixed, arrow-navigable
  // list: optionCursor indexes field.options OR field.categories,
  // whichever is active (the two are never both set on the same field).
  const [optionCursor, setOptionCursor] = useState(0);
  // Checklist fields' live checked-category set: kept in sync with disk
  // on every toggle (see saveChecklist), not a deferred/uncommitted draft.
  const [editSelected, setEditSelected] = useState<Set<string>>(new Set());
  const [editHint, setEditHint] = useState("");
  const [message, setMessage] = useState("");
  const [nonce, setNonce] = useState(0); // re-read files after writes
  // Scrolling window over the checklist's categories: same
  // cursor-follows-window pattern ReviewScreen/HistoryScreen already use
  // for their lists. Without this, a checklist with more categories than
  // fit on screen (Roles has 12) could render past contentRows: Ink
  // clips a frame taller than the terminal rather than scrolling it, so
  // the highlighted/just-toggled row could end up invisible; easy to
  // mistake for "the toggle didn't do anything."
  const categoryOffsetRef = useRef(0);

  // Cheap fs read, re-checked fresh every render (no caching), so
  // installing the desktop app from this very screen, or by hand outside
  // aplyx entirely, is reflected the moment this screen next renders.
  const desktopInstalled = isDesktopAppInstalled();
  const section = SECTIONS[sectionCursor];
  // fieldCursor is only ever meant to index the CURRENTLY OPEN section, but
  // it's state that outlives leaving that section (Esc back to the section
  // list, then moving sectionCursor to a shorter section), so it can point
  // past the new section's field array. Clamping here, rather than only
  // resetting on entry/exit, means `field` can never be undefined no matter
  // which order state updates land in: the crash this guards against
  // ("Cannot read properties of undefined (reading 'kind')") took the whole
  // TUI down with it, since Ink has no error boundary around this screen.
  const safeFieldCursor = Math.max(0, Math.min(fieldCursor, section.fields.length - 1));
  const field = section.fields[safeFieldCursor];
  const usesSuggestions = field.kind === "company-autocomplete" || field.kind === "location-autocomplete";

  // Rows left for the popup's actual option/suggestion list once its
  // fixed chrome (breadcrumb, "▲", border, title, query/count line,
  // message) is accounted for, a generous fixed estimate rather than a
  // pixel-perfect measurement, floored so even a tiny terminal always
  // shows at least a few rows instead of none.
  const visibleRows = Math.max(3, contentRows - 10);

  const categories = field.kind === "checklist" ? field.categories ?? [] : [];
  // Keep optionCursor inside the visible window as it moves. Computed
  // during render (via a ref, not useState+useEffect): an effect reacting
  // to optionCursor only adjusts the offset AFTER the commit that already
  // moved it, so there's a real intermediate frame (actually painted to
  // the terminal) where the just-toggled/highlighted row has scrolled
  // out of the still-stale window. Deriving offset synchronously here
  // means the window rendered this pass is already correct (same fix as
  // ReviewScreen's and MultiEntryAutocomplete's identical pattern).
  if (field.kind !== "checklist") categoryOffsetRef.current = 0;
  const categoryMaxOffset = Math.max(0, categories.length - visibleRows);
  let categoryOffset = Math.min(categoryOffsetRef.current, categoryMaxOffset);
  if (field.kind === "checklist" && categories.length > visibleRows) {
    if (optionCursor < categoryOffset) categoryOffset = optionCursor;
    else if (optionCursor >= categoryOffset + visibleRows) categoryOffset = optionCursor - visibleRows + 1;
  } else {
    categoryOffset = 0;
  }
  categoryOffsetRef.current = categoryOffset;

  // Same vetted+discovered directory the onboarding wizard reads from:
  // recomputed only on root/nonce change (not every keystroke) so typing
  // doesn't re-read the slug files on every render.
  const directory = useMemo(() => loadCompanyDirectory(root), [root, nonce]);
  // Full (unsliced) match list: MultiEntryAutocomplete scrolls its own
  // maxVisible-tall window over it, so a long "already added" set or a
  // broad search isn't hard-cut at whatever fits on screen; up/down
  // reaches every entry. Typing-mode search is still capped (30) purely
  // to bound the fuzzy-match compute/render cost, not for display space.
  const SEARCH_CAP = 30;
  // Blank query: show ONLY what's already added (each still toggleable
  // via Enter) instead of an arbitrary pool slice: an empty search box
  // browsing random unrelated cities/companies was confusing. Typing
  // resumes the normal fuzzy search over the full pool.
  const isBlankQuery = editValue.trim().length === 0;
  const suggestions: string[] = !editing
    ? []
    : field.kind === "location-autocomplete"
      ? isBlankQuery
        ? editItems
        : filterSuggestions(editValue, US_CITIES, SEARCH_CAP)
      : field.kind === "company-autocomplete"
        ? isBlankQuery
          ? editItems
          : filterSuggestions(editValue, directory, SEARCH_CAP, (e) => e.display, companyWeight).map((e) => e.display)
        : [];

  // The truly-saved value for a single-select "options" field (as opposed
  // to optionCursor, which just tracks where the arrow keys currently are).
  // This is what the ✓ marks, so hovering a different choice never
  // looks like it's already picked. Once Enter writes a new choice, this
  // recomputes on the next render and the ✓ jumps to it immediately.
  //
  // Theme specifically maps the old "dark"/"light" values (from before
  // the 4-theme rework) to their closest new slug here too: otherwise
  // an install that set Light and never touched this field again would
  // show nothing checked in the popup, even though resolveThemeMode's
  // own matching back-compat mapping (theme.ts) already applies Cloud
  // Surf correctly. Picking any option here writes the new slug and
  // self-heals the stored value going forward.
  const rawOptionValue =
    field.options && field.kind === "env" ? effectiveEnv(root, [field.key, ...(field.legacyKeys ?? [])], field.fallback ?? "").value : "";
  const currentOptionValue =
    field.key === "APLYX_TUI_THEME" && rawOptionValue === "dark"
      ? "aplyx-default"
      : field.key === "APLYX_TUI_THEME" && rawOptionValue === "light"
        ? "cloud-surf"
        : rawOptionValue;

  // Inside a section (or editing) this screen owns the keyboard: esc
  // backs out one level instead of jumping to the welcome menu.
  const captures = active && (inSection || editing);
  useEffect(() => {
    onInputActiveChange(captures);
    return () => onInputActiveChange(false);
  }, [captures, onInputActiveChange]);

  const save = (value: string) => {
    try {
      if (field.kind === "personal") writeSafeField(root, field.key, value);
      else if (field.kind === "personal-link")
        writeProfileUsername(root, field.key === "linkedin_username" ? "linkedin" : "github", value);
      else if (field.kind === "discord-route") writeDiscordRoute(root, field.key, value);
      else if (field.kind === "env" && field.key === "APLYX_JOBS_PER_PAGE") {
        writeEnvOverride(root, field.key, value.trim() ? String(clampPageSize(value)) : "");
      } else if (field.kind === "env") writeEnvOverride(root, field.key, value);
      setMessage(`Saved ${field.label}.`);
      onSettingsChange?.();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setNonce((n) => n + 1);
  };

  // List-valued fields (targets-array, location/company-autocomplete) save
  // the parsed string[] directly: never comma-join-then-split, which
  // silently corrupts any entry that itself contains a comma (e.g.
  // "Seattle, WA" round-tripped through join(", ")+split(",") becomes two
  // separate entries, "Seattle" and "WA"). Called on every toggle now
  // (write-through), not just once when the popup closes.
  const saveList = (items: string[]) => {
    try {
      if (field.kind === "targets-array" || field.kind === "location-autocomplete")
        writeTargetsArrayList(root, field.key, items);
      else if (field.kind === "company-autocomplete") writeCommittedCompanyDisplays(root, items, directory);
      setMessage(`Saved ${field.label}.`);
      onSettingsChange?.();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setNonce((n) => n + 1);
  };

  // Checklist fields write the union of every checked category's keyword
  // bundle. A category with `setsAllowExperienced` (only Levels' "Full
  // time") ALSO flips targets.json's top-level allow_experienced_roles:
  // the flag evaluate_job_fit.py actually reads to relax its two
  // experience-based hard rejects (no set of keywords alone can do that;
  // see levelCategories.ts). Unchecking it clears the flag back to false,
  // restoring the default intern/new-grad-only fit-gate behavior exactly.
  // Called on every toggle (write-through), not batched until close.
  const saveChecklist = (categories: CategoryOption[], selected: Set<string>) => {
    try {
      writeTargetsArrayList(root, field.key, keywordsForSelectedCategories(categories, selected));
      const flagCategory = categories.find((c) => c.setsAllowExperienced);
      if (flagCategory) writeTargetsBool(root, "allow_experienced_roles", selected.has(flagCategory.id));
      setMessage(`Saved ${field.label}.`);
      onSettingsChange?.();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setNonce((n) => n + 1);
  };

  useInput(
    (input, key) => {
      if (editing && field.kind === "checklist") {
        const categories = field.categories ?? [];
        if (key.escape) {
          setEditing(false);
          return;
        }
        if (key.return || input === " ") {
          const cat = categories[optionCursor];
          if (cat) {
            const next = new Set(editSelected);
            if (next.has(cat.id)) next.delete(cat.id);
            else next.add(cat.id);
            setEditSelected(next);
            saveChecklist(categories, next);
          }
          return;
        }
        if (key.upArrow || input === "k") {
          setOptionCursor((i) => Math.max(0, i - 1));
        } else if (key.downArrow || input === "j") {
          setOptionCursor((i) => Math.min(categories.length - 1, i + 1));
        }
        return;
      }
      if (editing && field.options) {
        const options = field.options;
        if (key.escape) {
          setEditing(false);
          return;
        }
        if (key.return) {
          save(options[optionCursor]?.value ?? "");
          return;
        }
        if (key.upArrow || input === "k") {
          setOptionCursor((i) => Math.max(0, i - 1));
        } else if (key.downArrow || input === "j") {
          setOptionCursor((i) => Math.min(options.length - 1, i + 1));
        }
        return;
      }
      if (editing && usesSuggestions) {
        if (key.escape) {
          setEditing(false);
          return;
        }
        if (key.return) {
          // Deliberately do NOT clear editValue/editCursor/editSuggestionIndex
          // after a toggle: keeping the typed query and suggestion list
          // intact lets the same city/company be toggled back on/off with
          // another Enter, no retyping. Only typing or backspace changes
          // what's shown (see those branches below).
          let chosen: string | undefined;
          if (field.kind === "company-autocomplete") {
            chosen = suggestions[editSuggestionIndex];
            if (!chosen) {
              if (!isBlankQuery) setEditHint("No matching vetted company. Pick one from the list below.");
              return;
            }
          } else {
            const typed = editValue.trim();
            chosen = suggestions[editSuggestionIndex] ?? (typed || undefined);
            if (!chosen) return;
          }
          const next = editItems.includes(chosen) ? editItems.filter((i) => i !== chosen) : [...editItems, chosen];
          setEditItems(next);
          saveList(next);
          setEditHint("");
          // Blank-query browsing shows editItems itself: a toggle there
          // can shrink the list out from under the current index.
          if (isBlankQuery) setEditSuggestionIndex((i) => Math.max(0, Math.min(i, next.length - 1)));
          return;
        }
        if (key.upArrow) {
          setEditSuggestionIndex((i) => Math.max(0, i - 1));
        } else if (key.downArrow) {
          setEditSuggestionIndex((i) => Math.min(Math.max(0, suggestions.length - 1), i + 1));
        } else if (key.leftArrow) {
          setEditCursor(moveCursorLeft({ value: editValue, cursor: editCursor }).cursor);
        } else if (key.rightArrow) {
          setEditCursor(moveCursorRight({ value: editValue, cursor: editCursor }).cursor);
        } else if (key.backspace || key.delete) {
          // No-op on an empty box: it used to also delete an
          // already-added entry, which read as data loss from an
          // innocuous keystroke.
          if (editValue !== "") {
            const next = deleteBackward({ value: editValue, cursor: editCursor });
            setEditValue(next.value);
            setEditCursor(next.cursor);
            setEditSuggestionIndex(0);
            setEditHint("");
          }
        } else if (!key.ctrl && !key.meta && input && !/\p{C}/u.test(input)) {
          const next = insertAtCursor({ value: editValue, cursor: editCursor }, input);
          setEditValue(next.value);
          setEditCursor(next.cursor);
          setEditSuggestionIndex(0);
          setEditHint("");
        }
        return;
      }
      if (editing) {
        // Remaining kinds: targets-array (workday_tenants, currently
        // unreachable, disabled) and every plain single-value text field
        // (personal/personal-link/discord-route/env). Only these two keep
        // Enter-saves/Escape-discards: every other kind above now
        // writes through on each toggle and only closes on Escape.
        const isTargetsArray = field.kind === "targets-array";
        if (key.return) {
          if (isTargetsArray) {
            const trimmed = editValue.trim();
            if (trimmed) {
              setEditItems((items) => [...items, trimmed]);
              setEditValue("");
              setEditCursor(0);
            } else {
              setEditing(false);
              saveList(editItems);
            }
          } else {
            setEditing(false);
            save(editValue.trim());
          }
        } else if (key.escape) {
          setEditing(false);
          setMessage("Edit cancelled. Value unchanged.");
        } else if (key.leftArrow) {
          setEditCursor(moveCursorLeft({ value: editValue, cursor: editCursor }).cursor);
        } else if (key.rightArrow) {
          setEditCursor(moveCursorRight({ value: editValue, cursor: editCursor }).cursor);
        } else if (key.backspace || key.delete) {
          if (isTargetsArray && editValue === "") {
            setEditItems((items) => items.slice(0, -1));
          } else {
            const next = deleteBackward({ value: editValue, cursor: editCursor });
            setEditValue(next.value);
            setEditCursor(next.cursor);
          }
        } else if (!key.ctrl && !key.meta && input && !/\p{C}/u.test(input)) {
          const next = insertAtCursor({ value: editValue, cursor: editCursor }, input);
          setEditValue(next.value);
          setEditCursor(next.cursor);
        }
        return;
      }
      if (inSection) {
        if (key.escape) {
          setInSection(false);
          setFieldCursor(0);
          setMessage("");
          return;
        }
        if (key.upArrow || input === "k") return setFieldCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || input === "j")
          return setFieldCursor((c) => Math.min(section.fields.length - 1, c + 1));
        if (key.return || input === "e") {
          if (field.disabled) {
            setMessage(field.disabled);
            return;
          }
          if (field.kind === "action" && field.key === "open_resumes_folder") {
            // openPath creates the directory first, so a fresh install with
            // no resumes yet still opens cleanly rather than erroring.
            try {
              openPath(resumesDir(root));
              setMessage(`Opened ${resumesDir(root)}: drag your resume PDFs in, then use the Resumes tab to convert them.`);
            } catch (err) {
              setMessage(`Could not open the resumes folder: ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
          }
          if (field.kind === "action" && field.key === "install_desktop_app") {
            if (desktopInstalled) {
              setMessage("Desktop app is already installed. Nothing to do here. Reinstall any time by re-running src/scripts/install/install_desktop.sh (or the .ps1 equivalent on Windows) directly.");
              return;
            }
            onInstallDesktopApp?.();
            return;
          }
          if (field.kind === "discord-enabled") {
            const next = !readDiscordEnabled(root);
            writeDiscordEnabled(root, next);
            setMessage(`Discord reporting ${next ? "enabled" : "disabled"}.`);
            setNonce((n) => n + 1);
            onSettingsChange?.();
            return;
          }
          if (field.kind === "checklist") {
            setEditSelected(selectedCategoryIds(field.categories ?? [], readTargetsArrayList(root, field.key)));
            setOptionCursor(0);
            setEditing(true);
            setMessage("");
            return;
          }
          if (field.options) {
            const effectiveValue = field.kind === "env" ? effectiveEnv(root, [field.key, ...(field.legacyKeys ?? [])], field.fallback ?? "").value : "";
            const idx = field.options.findIndex((o) => o.value === effectiveValue);
            setOptionCursor(idx >= 0 ? idx : 0);
            setEditing(true);
            setMessage("");
            return;
          }
          if (field.kind === "targets-array" || field.kind === "location-autocomplete") {
            setEditItems(readTargetsArrayList(root, field.key));
            setEditValue("");
            setEditCursor(0);
            setEditSuggestionIndex(0);
            setEditHint("");
            setEditing(true);
            setMessage("");
            return;
          }
          if (field.kind === "company-autocomplete") {
            setEditItems(readCommittedCompanyDisplays(root, directory));
            setEditValue("");
            setEditCursor(0);
            setEditSuggestionIndex(0);
            setEditHint("");
            setEditing(true);
            setMessage("");
            return;
          }
          // Plain single-value text field: always starts blank; the
          // current value is shown for reference inside the popup, not
          // pre-filled into the box.
          setEditValue("");
          setEditCursor(0);
          setEditing(true);
          setMessage("");
        }
        return;
      }
      // Section menu: plain navigation; esc here is App's (welcome menu).
      if (key.upArrow || input === "k")
        return setSectionCursor((c) => (c + SECTIONS.length - 1) % SECTIONS.length);
      if (key.downArrow || input === "j" || key.tab)
        return setSectionCursor((c) => (c + 1) % SECTIONS.length);
      if (key.return) {
        setInSection(true);
        setFieldCursor(0);
        setMessage("");
      }
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );

  void nonce; // reads below re-run every render; nonce forces one after writes

  if (!inSection) {
    const selected = SECTIONS[sectionCursor];
    return (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          Settings <Text dimColor>view current values, then change them</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          {SECTIONS.map((s, i) => (
            <NavRow key={s.name} label={s.name} focused={i === sectionCursor} />
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>About</Text>
          <Text wrap="wrap">{selected.description}</Text>
        </Box>
        {message ? (
          <Box marginTop={1}>
            <Text dimColor>{message}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  const detail = currentValue(root, field, directory);
  // Fixed-height explain block: fields in a section have wildly different
  // help-text lengths, so sizing it to only the CURRENT field would
  // reflow the popup/message area below on every up/down press while
  // browsing a section's field list. Reserve the tallest this section
  // needs instead: scoped to the section, not every field ever, so
  // switching sections is still free to resize.
  const explainWidth = Math.max(20, columns - 2);
  const explainMaxLines = Math.max(1, ...section.fields.map((f) => wrapText(f.explain, explainWidth).length));
  const explainLines = wrapPadded(field.explain, explainWidth, explainMaxLines);
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Settings <Text dimColor>· {section.name}</Text>
      </Text>
      {editing ? (
        // Collapsed to a one-line breadcrumb while editing: the full
        // field list plus an up-to-12-row checklist or 8-row suggestion
        // popup easily exceeds a normal terminal's height, and Ink clips
        // (rather than scrolls) a frame taller than the terminal: the
        // breadcrumb frees up exactly the rows the popup needs to never
        // hit that ceiling, and doubles as the "popup is the thing in
        // front now" cue from before.
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {section.name} › {field.label}
          </Text>
        </Box>
      ) : (
        <>
          <Box marginTop={1} flexDirection="column">
            {section.fields.map((f, i) => {
              const isDesktopInstallRow = f.kind === "action" && f.key === "install_desktop_app";
              const showInstalledNote = isDesktopInstallRow && desktopInstalled;
              return (
                <React.Fragment key={f.key}>
                  <NavRow
                    label={f.label}
                    focused={i === safeFieldCursor}
                    dim={Boolean(f.disabled) || showInstalledNote}
                    value={f.kind === "personal" || f.kind === "personal-link" ? currentValue(root, f, directory).value : undefined}
                  />
                  {showInstalledNote ? (
                    <Box paddingLeft={4}>
                      <Text color={theme.good}>
                        ✓ app is already installed{desktopInstalledVersion() ? ` (v${desktopInstalledVersion()})` : ""}
                      </Text>
                    </Box>
                  ) : null}
                </React.Fragment>
              );
            })}
          </Box>
          <Box marginTop={1} flexDirection="column">
            {explainLines.map((line, i) => (
              <Text key={i} wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        </>
      )}

      {editing ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.accent}>▲</Text>
          <Box flexDirection="column" borderStyle="double" borderColor={theme.accent} paddingX={1}>
            <Text bold color={theme.accent}>
              {field.label}
            </Text>

            {field.kind === "checklist"
              ? (() => {
                  const windowed = categories
                    .map((cat, i) => ({ cat, i }))
                    .slice(categoryOffset, categoryOffset + visibleRows);
                  // Both indicator rows are reserved whenever the list can
                  // scroll at all (blank when that edge isn't reached yet):
                  // otherwise scrolling from an edge into the middle of the
                  // list grows the popup by a row, then shrinks it back on
                  // reaching the far edge.
                  const scrollable = categories.length > visibleRows;
                  return (
                    <>
                      {scrollable ? (
                        categoryOffset > 0 ? <Text dimColor>↑ {categoryOffset} more</Text> : <Text> </Text>
                      ) : null}
                      {windowed.map(({ cat, i }) => (
                        <OptionRow
                          key={cat.id}
                          label={cat.label}
                          hint={cat.hint}
                          focused={i === optionCursor}
                          checked={editSelected.has(cat.id)}
                        />
                      ))}
                      {scrollable ? (
                        categoryOffset + visibleRows < categories.length ? (
                          <Text dimColor>↓ {categories.length - categoryOffset - visibleRows} more</Text>
                        ) : (
                          <Text> </Text>
                        )
                      ) : null}
                    </>
                  );
                })()
              : field.options
                ? field.options.map((o, i) => (
                    <OptionRow
                      key={o.value}
                      label={optionLabel(field, o)}
                      focused={i === optionCursor}
                      checked={o.value === currentOptionValue}
                      preview={
                        o.harness && i === optionCursor ? (
                          <AutoSparkleText gradient={harnessGradient(o.harness)} tickMs={HARNESS_WAVE_TICK_MS} offsetStep={HARNESS_WAVE_STEP}>
                            {optionLabel(field, o)}
                          </AutoSparkleText>
                        ) : undefined
                      }
                    />
                  ))
                : field.kind === "targets-array"
                  ? (
                    <>
                      <Text dimColor wrap="wrap">
                        Items ({editItems.length}): {editItems.length > 0 ? editItems.join(" · ") : "(none yet)"}
                      </Text>
                      <Box marginTop={1}>
                        <Text color={theme.accent}>add </Text>
                        <InlineTextInput
                          value={editValue}
                          cursor={editCursor}
                          active
                          placeholder="type an item · enter adds · enter (empty) saves · backspace (empty) removes last · esc cancels"
                          wrap="truncate-end"
                        />
                      </Box>
                    </>
                  )
                  : usesSuggestions
                    ? (
                      <MultiEntryAutocomplete
                        label={field.label}
                        query={editValue}
                        cursor={editCursor}
                        focused={true}
                        suggestions={suggestions}
                        suggestionIndex={editSuggestionIndex}
                        addedItems={editItems}
                        warning={editHint || undefined}
                        bordered={false}
                        showLabel={false}
                        maxVisible={visibleRows}
                        placeholder={
                          field.kind === "location-autocomplete"
                            ? "type a city · enter toggles highlighted · esc closes"
                            : "type a company · enter toggles highlighted match · esc closes"
                        }
                      />
                    )
                    : isPlainTextField(field)
                      ? (
                        <>
                          <Text dimColor wrap="wrap">
                            current: {detail.value}
                            {detail.note && detail.note !== "default" ? `  (${detail.note})` : ""}
                          </Text>
                          <Box marginTop={1}>
                            <Text color={theme.accent}>new value: </Text>
                            <InlineTextInput
                              value={editValue}
                              cursor={editCursor}
                              active
                              placeholder="(empty clears the value)"
                              wrap="truncate-end"
                            />
                          </Box>
                          {field.key === "APLYX_JOBS_PER_PAGE" && editValue.trim()
                            ? (() => {
                                const parsed = Number.parseInt(editValue, 10);
                                const preview = Number.isFinite(parsed) ? Math.min(MAX_PAGE_SIZE, parsed) : null;
                                if (preview === null) return null;
                                const tier = pageSizeTier(preview);
                                const atMax = preview >= MAX_PAGE_SIZE;
                                return (
                                  <Box marginTop={1} flexDirection="column">
                                    <Text>
                                      <Text dimColor>tier: </Text>
                                      {atMax ? (
                                        <RainbowText>{`${tier.name} (${preview})`}</RainbowText>
                                      ) : (
                                        <Text bold color={tier.color}>{tier.name} ({preview})</Text>
                                      )}
                                    </Text>
                                    {atMax ? (
                                      <RainbowText>{`⚠ MAX: ${MAX_PAGE_SIZE} results per page will slow down your search`}</RainbowText>
                                    ) : null}
                                  </Box>
                                );
                              })()
                            : null}
                        </>
                      )
                      : null}
          </Box>
        </Box>
      ) : null}

      {message ? (
        <Box marginTop={1}>
          <Text color={message.startsWith("Save failed") ? theme.danger : undefined} dimColor={!message.startsWith("Save failed")}>
            {statusGlyph.applied} {message}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const SETTINGS_HINTS = "↑↓ section · enter open";
export const SETTINGS_SECTION_HINTS = "↑↓ field · enter edit/toggle · esc back";
export const SETTINGS_EDIT_HINTS = "type · enter save · esc cancel · backspace erase";
