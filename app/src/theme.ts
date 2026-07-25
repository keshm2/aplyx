import { effectiveEnv } from "@aplyx/core/settings.js";

/**
 * Color roles — defined once, referenced everywhere. The terminal's own
 * foreground/background is the ground; outcome colors (good/warn/danger)
 * are reserved for outcomes and never used decoratively. Ink/chalk
 * degrades hex to 256/16 colors and honors NO_COLOR automatically;
 * meaning never rides on color alone — the glyph map below pairs a
 * symbol with every semantic color so the 16-color / NO_COLOR runs stay
 * legible.
 *
 * `theme` is a mutable object (properties reassigned by applyThemeMode,
 * never the exported binding itself) rather than the frozen `as const` it
 * used to be — the Settings "Theme" field (dark/light, see
 * SettingsScreen.tsx's Environment section) needs every one of the ~25
 * files that already read `theme.accent` etc. to pick up a mode change
 * without themselves becoming aware root-scoped settings even exist.
 * Mutating the same object every consumer already holds a reference to
 * does that with zero call-site changes, at the cost of `theme` no longer
 * being provably immutable — deliberate trade, not an oversight.
 */
// Four named themes rather than a Dark/Light binary — "dark"/"light"
// describe a terminal background, not a color identity, and once there
// was more than one palette per background (Aplyx Default/Ember Dusk
// both dark-tuned; Cloud Surf/Mint Frost both light-tuned) a mode name
// stopped meaning anything on its own. Each still targets ONE assumed
// terminal background (declared per-palette below) — that half of the
// original Dark/Light distinction (avoiding e.g. unreadable named
// "yellow" on white) still matters and is still handled per palette,
// just no longer conflated with the palette's actual color identity.
export type ThemeMode = "aplyx-default" | "cloud-surf" | "ember-dusk" | "mint-frost";

export const THEME_NAMES: Record<ThemeMode, string> = {
  "aplyx-default": "Aplyx Default",
  "cloud-surf": "Cloud Surf",
  "ember-dusk": "Ember Dusk",
  "mint-frost": "Mint Frost",
};

function isThemeMode(value: string): value is ThemeMode {
  return value in THEME_NAMES;
}

interface Palette {
  accent: string;
  rule: string;
  good: string;
  warn: string;
  danger: string;
  /** The color UpdateBox's traveling border highlight (and
   *  sparkleGradient's AUTO-badge/progress-bar wave) blends the accent
   *  color TOWARD, rather than a hardcoded white. A dark-background
   *  palette wants white — a bright pop against both the accent and the
   *  terminal background. A light-background palette wants the reverse:
   *  blending toward white would fade the highlight into an
   *  already-white terminal until it's unreadable, so those palettes
   *  blend toward a deep, near-black shade of their own hue family
   *  instead — still a bright/dark pop, just inverted to suit the
   *  background it's actually tuned for. */
  glow: string;
}

const APLYX_DEFAULT_PALETTE: Palette = {
  accent: "#8B5CF6", // violet — active tab, selection, titles
  rule: "#6D28D9", // dim violet — header/footer rules only
  good: "green",
  warn: "yellow",
  danger: "red",
  glow: "#FFFFFF",
};

// Named ANSI "yellow" in particular is close to unreadable on a white
// background — these are explicit darker hexes tuned for a light
// terminal instead of the dark-terminal-friendly named colors above.
// A light blue → white identity (see BANNER_GRADIENT_CLOUD_SURF below),
// applied everywhere theme.accent/theme.rule already flow (sidebar
// border, tab/option selection, titles) since every consumer already
// reads the shared `theme` object live. good/warn/danger stay their
// outcome colors regardless of accent hue — they carry meaning
// (applied/needs-review/failed), not brand.
const CLOUD_SURF_PALETTE: Palette = {
  accent: "#2563EB",
  rule: "#93C5FD",
  good: "#15803D",
  warn: "#A16207",
  danger: "#B91C1C",
  glow: "#1E3A8A", // deep navy — dark-on-light glow, not white-on-light
};

// Warm counterpart to Aplyx Default — same dark-terminal assumption
// (named ANSI good/warn/danger are fine there, per the dark palette's
// own reasoning above), amber/orange in place of violet.
const EMBER_DUSK_PALETTE: Palette = {
  accent: "#FB923C",
  rule: "#C2410C",
  good: "green",
  warn: "yellow",
  danger: "red",
  glow: "#FFFFFF",
};

// Cool counterpart to Cloud Surf — same light-terminal assumption
// (darker good/warn/danger hexes, per Cloud Surf's own reasoning
// above), teal in place of blue.
const MINT_FROST_PALETTE: Palette = {
  accent: "#0D9488",
  rule: "#5EEAD4",
  good: "#15803D",
  warn: "#A16207",
  danger: "#B91C1C",
  glow: "#134E4A", // deep teal — dark-on-light glow, not white-on-light
};

const PALETTES: Record<ThemeMode, Palette> = {
  "aplyx-default": APLYX_DEFAULT_PALETTE,
  "cloud-surf": CLOUD_SURF_PALETTE,
  "ember-dusk": EMBER_DUSK_PALETTE,
  "mint-frost": MINT_FROST_PALETTE,
};

export const theme: Palette = { ...APLYX_DEFAULT_PALETTE };

let currentThemeMode: ThemeMode = "aplyx-default";

/** Repoints every `theme.*` property at the given theme's palette in
 *  place — called once at launch and again whenever Settings' Theme
 *  field might have changed (App.tsx's refresh(), which already runs on
 *  every tab switch). */
export function applyThemeMode(mode: ThemeMode): void {
  Object.assign(theme, PALETTES[mode]);
  currentThemeMode = mode;
}

/** The mode `applyThemeMode` last set — read by anything that needs to
 *  pick between per-theme wholesale assets (e.g. bannerGradient below)
 *  rather than recoloring individual `theme.*` roles. */
export function currentTheme(): ThemeMode {
  return currentThemeMode;
}

/** Reads the Settings "Theme" field (APLYX_TUI_THEME) the same way
 *  jobs.ts's resolveResultsPerPage reads its own env field — real env
 *  var, then config/env.json, then the default. Back-compat: installs
 *  from before the 4-theme rework stored the old "dark"/"light" values,
 *  which still resolve to their closest match (Aplyx Default/Cloud
 *  Surf) rather than silently falling back to the default and losing
 *  a Light-mode preference someone had actually set. */
export function resolveThemeMode(root: string): ThemeMode {
  const value = effectiveEnv(root, ["APLYX_TUI_THEME"], "aplyx-default").value;
  if (value === "dark") return "aplyx-default";
  if (value === "light") return "cloud-surf";
  return isThemeMode(value) ? value : "aplyx-default";
}

let reducedMotion = false;

/** Whether the Settings "Reduced motion" field is on — checked by
 *  KeyHints.tsx's AutoSparkleText, the one animation this actually wires
 *  into (see that file for why the rest of the app's animations weren't
 *  all converted too). */
export function isReducedMotion(): boolean {
  return reducedMotion;
}

export function applyReducedMotion(value: boolean): void {
  reducedMotion = value;
}

export function resolveReducedMotion(root: string): boolean {
  return effectiveEnv(root, ["APLYX_REDUCED_MOTION"], "0").value === "1";
}

/** Whether the sidebar clock (SidePanel.tsx's TopStatusBar) shows 24-hour
 *  time instead of the 12-hour default. */
export function resolveHour24Clock(root: string): boolean {
  return effectiveEnv(root, ["APLYX_24_HOUR_CLOCK"], "0").value === "1";
}

/** A function, not a frozen `Record` — same reasoning as sparkleGradient:
 *  `theme.good`/`warn`/`danger` are mutated in place by applyThemeMode, so
 *  a plain object built once at module load would keep StatusScreen/
 *  HistoryScreen's outcome colors pinned to the dark palette (defeating
 *  the whole point of Light mode's tuned warn/danger hexes) even after
 *  switching modes. */
export function statusColor(status: string): string | undefined {
  if (status === "applied") return theme.good;
  if (status === "needs_review") return theme.warn;
  if (status === "failed") return theme.danger;
  return undefined;
}

/** Status glyphs — paired with statusColor so meaning survives NO_COLOR. */
export const statusGlyph: Record<string, string> = {
  applied: "✓",
  needs_review: "◐",
  failed: "✗",
};

/** Selection marker — the one place boldness is spent on focus. */
export const SELECT_MARKER = "▸";

/** Hot red for the heavy+ tier — deliberately louder than the plain
 *  `red` outcome color so 22+ caps read as a warning, not a failure. */
export const HEAVY_PLUS_RED = "#FF3B30";

/** Session-cap tiers — the cap picker colors by cost so the difference
 *  between a 3-job test and a 25-job MAX run is visible at a glance.
 *  25 = MAX (the gauge renders rainbow), 22+ = heavy+ (hot red),
 *  17+ = heavy (yellow). */
export interface CapTier {
  name: string;
  color: string;
}
export function capTier(cap: number): CapTier {
  if (cap >= 25) return { name: "MAX", color: theme.danger };
  if (cap >= 22) return { name: "heavy+", color: HEAVY_PLUS_RED };
  if (cap >= 17) return { name: "heavy", color: theme.warn };
  if (cap >= 6) return { name: "standard", color: theme.accent };
  return { name: "light", color: theme.good };
}

/** Same shape as capTier, scaled to the Jobs search "results per page"
 *  setting's 10-75 range — more results per page means more Ashby/Lever/
 *  Greenhouse/Workday calls and a heavier fuzzy-match/render pass, so the
 *  top end reads as a cost warning the same way a 25-job run cap does. */
export function pageSizeTier(size: number): CapTier {
  if (size >= 75) return { name: "MAX", color: theme.danger };
  if (size >= 65) return { name: "heavy+", color: HEAVY_PLUS_RED };
  if (size >= 50) return { name: "heavy", color: theme.warn };
  if (size >= 30) return { name: "standard", color: theme.accent };
  return { name: "light", color: theme.good };
}

/** hsl(hue, 100%, 65%) → #rrggbb — drives the animated MAX-cap warning. */
export function hueColor(hue: number): string {
  const h = ((hue % 360) + 360) % 360;
  const c = 0.7; // chroma at 100% saturation, 65% lightness
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 0.65 - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) =>
    Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** #rrggbb → [r, g, b] (0-255 each) — helper for gradientColor's lerp. */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** phase (any real number) → #rrggbb, smoothly interpolated within the
 *  given gradient (default BANNER_GRADIENT_APLYX_DEFAULT — every real
 *  caller passes its own `stops` explicitly, so this default is never
 *  actually exercised; it's just a safe fallback). Bounces back and
 *  forth across the stops (a triangle wave) instead of wrapping the
 *  last stop straight back to the first — a straight wrap would lerp
 *  maroon (#800020, near-zero green/blue) directly to violet (#A78BFA,
 *  high blue), passing through muddy green/blue-tinted hues on the way.
 *  Ping-ponging means every step is a lerp between two *adjacent*,
 *  intentionally-designed stops, so it can never produce an off-palette
 *  hue — the gradient analog of hueColor's hue wheel, used to drive the
 *  animated AUTO-mode sparkle. */
export function gradientColor(phase: number, stops: readonly string[] = BANNER_GRADIENT_APLYX_DEFAULT): string {
  const n = stops.length;
  if (n === 1) return stops[0]!;
  const period = 2 * (n - 1);
  const x = (((phase % period) + period) % period); // wrap into [0, period)
  const t = x <= n - 1 ? x : period - x; // reflect the second half back — the ping-pong
  const i = Math.min(n - 2, Math.floor(t));
  const frac = t - i;
  const [r1, g1, b1] = hexToRgb(stops[i]!);
  const [r2, g2, b2] = hexToRgb(stops[i + 1]!);
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * frac);
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(lerp(r1, r2))}${hex(lerp(g1, g2))}${hex(lerp(b1, b2))}`;
}

/** ASCII banner — the one loud element. Each theme fades through its own
 *  identity (see the BANNER_GRADIENT_* constants + bannerGradient below)
 *  rather than sharing one gradient recolored. */
export const BANNER_ROWS = [
  " █████╗ ██████╗ ██╗  ██╗   ██╗██╗  ██╗",
  "██╔══██╗██╔══██╗██║  ╚██╗ ██╔╝╚██╗██╔╝",
  "███████║██████╔╝██║   ╚████╔╝  ╚███╔╝ ",
  "██╔══██║██╔═══╝ ██║    ╚██╔╝   ██╔██╗ ",
  "██║  ██║██║     ███████╗██║   ██╔╝ ██╗",
  "╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝   ╚═╝  ╚═╝",
] as const;

export const BANNER_GRADIENT_APLYX_DEFAULT = [
  "#A78BFA", // violet
  "#9265F0",
  "#7C3AED",
  "#7E22CE", // purple
  "#8B1E5B", // plum
  "#800020", // maroon
] as const;

// Cloud Surf's own identity: a light blue → (near-)white fade, matching
// its blue accent above rather than Aplyx Default's violet — a
// deliberate departure from "same hue, different shade" so each theme
// reads as genuinely its own rather than a recolor of one base. The
// bottom stop (blue-100) is close enough to white to visibly fade
// toward the terminal background on a true-white profile — read as the
// intended "to white" effect for decorative ASCII art rather than a
// contrast bug, since (unlike theme.accent's actual UI text) this row
// carries no information a fade-out would obscure.
const BANNER_GRADIENT_CLOUD_SURF = [
  "#1D4ED8", // blue-700
  "#2563EB", // blue-600 — same hex as CLOUD_SURF_PALETTE.accent
  "#3B82F6", // blue-500
  "#60A5FA", // blue-400
  "#93C5FD", // blue-300
  "#DBEAFE", // blue-100 — fades toward white
] as const;

// Ember Dusk: warm amber → deep rust, the dark-background counterpart
// to Cloud Surf's cool fade — light amber at top down through orange to
// a near-black ember at the bottom, mirroring Aplyx Default's
// light-to-dark shape but in a completely different hue family.
const BANNER_GRADIENT_EMBER_DUSK = [
  "#FDBA74", // amber-300
  "#FB923C", // orange-400 — same hex as EMBER_DUSK_PALETTE.accent
  "#F97316", // orange-500
  "#EA580C", // orange-600
  "#C2410C", // orange-700
  "#7C2D12", // orange-900 — deep ember
] as const;

// Mint Frost: teal → (near-)white, the same "fade toward the light
// background" shape as Cloud Surf, one hue family over.
const BANNER_GRADIENT_MINT_FROST = [
  "#0F766E", // teal-700
  "#0D9488", // teal-600 — same hex as MINT_FROST_PALETTE.accent
  "#14B8A6", // teal-500
  "#2DD4BF", // teal-400
  "#5EEAD4", // teal-300
  "#CCFBF1", // teal-100 — fades toward white
] as const;

const BANNER_GRADIENTS: Record<ThemeMode, readonly string[]> = {
  "aplyx-default": BANNER_GRADIENT_APLYX_DEFAULT,
  "cloud-surf": BANNER_GRADIENT_CLOUD_SURF,
  "ember-dusk": BANNER_GRADIENT_EMBER_DUSK,
  "mint-frost": BANNER_GRADIENT_MINT_FROST,
};

/** The current theme's banner gradient — a function, not a constant, for
 *  the same reason sparkleGradient() is: `currentTheme()` can change
 *  after this module first loads (Settings' Theme field, applied live),
 *  so this has to be read fresh by its caller on every render rather
 *  than resolved once. */
export function bannerGradient(): readonly string[] {
  return BANNER_GRADIENTS[currentTheme()];
}

/** Accent → theme.glow — the same two-color blend UpdateBox's traveling
 *  border ring uses (see blend() there), reused here so every "AUTO"
 *  sparkle (AutoSparkleText, GradientProgressBar) reads as one visual
 *  language across the app. gradientColor's ping-pong bounces cleanly
 *  between the two, so this never touches the banner's plum/maroon end
 *  (which read as "too much red" when it was in the sparkle mix). The
 *  static banner keeps its own full per-theme gradient — this is scoped
 *  to animations only.
 *
 *  A function, not a frozen array: `theme.accent`/`theme.glow` are
 *  mutated in place by applyThemeMode (Settings' Theme field), so a
 *  plain `[theme.accent, "#FFFFFF"] as const` evaluated once at module
 *  load would freeze in whichever theme was active at that moment
 *  forever — and hardcoding white specifically would, for a
 *  light-background theme (Cloud Surf, Mint Frost), fade the sparkle
 *  into an already-white terminal until it's unreadable. `theme.glow`
 *  is each palette's own answer to "what should this blend toward,"
 *  already tuned per background (see the Palette interface's own
 *  comment). Called fresh from each consumer's default-param position
 *  on every render instead. */
export function sparkleGradient(): readonly string[] {
  return [theme.accent, theme.glow];
}

/** Which coding-agent CLI a run uses — mirrors the four harnesses
 *  scripts/runtime/run_job_agent.py can invoke (config/harness.json /
 *  APLYX_HARNESS). "auto" means neither an env override nor
 *  config/harness.json name a specific one (the Python side then
 *  auto-detects a CLI on PATH) — there's no single harness to color for,
 *  so it gets its own combined wave instead of guessing one. */
export type HarnessId = "claude" | "opencode" | "codex" | "copilot" | "auto";

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: "Claude Code",
  opencode: "opencode",
  codex: "Codex",
  copilot: "Copilot",
  auto: "Auto (env / harness.json / detect on PATH)",
};

/** One saturated base color per harness, each reused as a run's live
 *  "working" wave (RunScreen's running indicator + progress bar) so the
 *  animation reads as which agent is actually doing the work — Claude
 *  Code's own light-orange "thinking" shimmer, opencode a light maroon,
 *  Codex a lavender, Copilot a darker blue. */
const HARNESS_BASE_COLOR: Record<Exclude<HarnessId, "auto">, string> = {
  claude: "#FF8A3D",
  opencode: "#A64B5A",
  codex: "#B39DDB",
  copilot: "#1F4E8C",
};

/** Each harness's own base blended to a paler tint of the same hue
 *  (rather than SPARKLE_GRADIENT's blend-to-white) so the wave keeps its
 *  color identity all the way through instead of fading toward neutral.
 *  Auto has no single identity to blend toward — its wave cycles through
 *  all four saturated bases directly, a literal "combination of those
 *  colors" rather than a tint of one. */
const HARNESS_PALE_TINT: Record<Exclude<HarnessId, "auto">, string> = {
  claude: "#FFD9B3",
  opencode: "#E8B9C0",
  codex: "#E8DFF7",
  copilot: "#8FB4E0",
};

export function harnessGradient(id: HarnessId): readonly string[] {
  if (id === "auto") {
    return [HARNESS_BASE_COLOR.claude, HARNESS_BASE_COLOR.opencode, HARNESS_BASE_COLOR.codex, HARNESS_BASE_COLOR.copilot];
  }
  return [HARNESS_BASE_COLOR[id], HARNESS_PALE_TINT[id]];
}

/** Slower, smaller-step tuning for every harness-colored wave (RunScreen's
 *  live "running" indicator, Settings' coding-agent option preview) — a
 *  deliberately calmer cadence than the default AUTO-badge sparkle
 *  (AutoSparkleText's own 90ms/0.35 defaults), since a name you're reading
 *  while it's mid-color-cycle is harder to read than a badge you're just
 *  glancing at. */
export const HARNESS_WAVE_TICK_MS = 170;
export const HARNESS_WAVE_STEP = 0.12;

/** Cycling "working" glyph — the terminal-spinner analog of a color
 *  animation, a smoothly rotating braille dot cluster (the same family
 *  of spinner most CLIs, including Claude Code's own "thinking"
 *  indicator, use) — used anywhere text needs to signal live activity.
 *  Deliberately no plain "." frame: a flat period breaks the glyph's
 *  visual weight/alignment against the rounded braille cells around it,
 *  which is what made the old dot-growing-to-a-star cycle read as a
 *  stutter rather than smooth rotation. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export const BANNER_WIDTH = BANNER_ROWS[0].length;

/** Below this size the app shows a "terminal too small" notice. The tab
 *  row is the binding constraint: five tabs plus the Review "(n)" badge need
 *  ~53 cols, and wrapping it corrupts the pinned frame. The banner
 *  collapses earlier. */
// Sized by the tab row, which is the widest fixed element and must never
// wrap (a wrapped row corrupts the frame under it). 7 tabs at a 1-column
// gap = ~65 cols, plus the two "(N)" count badges and horizontal padding =
// ~75 worst case. Raised 54 -> 76 when the Letters tab landed; every past
// tab-count change bumped this the same way (40->44->54).
export const MIN_COLUMNS = 76;
export const MIN_ROWS = 12;

/** Build/release marker shown in the side panel footer. Re-exported from
 *  @aplyx/core so the TUI and the desktop app's Settings screen always
 *  report the same build from one source (see packages/core/src/version.ts). */
export { BUILD_MARKER } from "@aplyx/core/version.js";

/** Side panel width — narrow enough to coexist with content on 64-col+
 *  terminals. The panel hides below that width (see App showSidebar). */
export const SIDE_PANEL_WIDTH = 20;
