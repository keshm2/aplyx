/**
 * Best-effort parse of a live run's session-log tail into a 5-slot
 * checklist plus a "currently applying to" marker. Pure string-in,
 * string-out: no fs, no child_process. That's what lets both the TUI
 * (which tails the log itself via node:fs in src/tui/src/run.ts) and the
 * desktop app (which tails it from the Rust side and gets chunks over a
 * Tauri event) share this exact parsing logic instead of ending up with
 * two implementations that quietly drift apart. Used to live only in
 * src/tui/src/ui/RunScreen.tsx; moved here verbatim once the desktop app
 * got its own live-run view.
 */

export type ChecklistKey = "scrape" | "fitgate" | "tailor" | "apply" | "report";
export type SlotState = "done" | "current" | "pending";

interface ChecklistSlotDef {
  key: ChecklistKey;
  label: string;
  caption: string;
  match: RegExp;
}

/**
 * Recognizable phase-name substrings mapped to the 5 checklist slots the
 * running view shows. Matches the marker lines specified in
 * src/agents/bodies/job-scraper.md's "Progress markers" section
 * (`[ ]`/`[•]`/`[✓]` + a phase name), but stays deliberately loose on the
 * text match. This is best-effort cosmetic sugar, not a general
 * log-format parser, so an older or hand-edited agent body just degrades
 * to the generic "running…" indicator instead of showing garbage.
 *
 * Match on verb stems, never the full infinitive. Every marker the agent
 * actually emits is a present participle ("Scraping job boards",
 * "Filtering + fit-gating"), so the original patterns, /scrape/ and
 * /fit.?gate/, could never match their own markers: the participle drops
 * the trailing "e" ("scrap-ing", "fit-gat-ing"). Those two slots sat
 * permanently on "pending", and during the scrape phase (the longest part
 * of a run) nothing matched at all, so the whole checklist collapsed to
 * null and the screen just showed a bare "run in progress…". Verify any
 * new slot against the literal text in the agent body before adding it.
 */
const CHECKLIST_SLOTS: ChecklistSlotDef[] = [
  { key: "scrape", label: "Scrape", caption: "Scraping job boards", match: /scrap|fetch/i },
  {
    key: "fitgate",
    label: "Fit-gate",
    caption: "Filtering + fit-gating",
    match: /fit.?gat|prefilter|role filter/i,
  },
  { key: "tailor", label: "Tailor", caption: "Tailoring resume", match: /tailor/i },
  { key: "apply", label: "Apply", caption: "Applying to jobs", match: /\bapply(ing)?\b/i },
  {
    key: "report",
    label: "Report",
    caption: "Sending report",
    match: /report|summary|discord|cleanup/i,
  },
];

export interface PhaseInfo {
  slots: { label: string; state: SlotState }[];
  currentIndex: number;
  currentKey: ChecklistKey;
  caption: string;
}

/** Strip SGR color codes so the marker regexes match the agent's plain
 *  text regardless of how the harness colorized the line. */
export const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trim();

/** The only lines the progress parsers care about. Retaining just these
 *  (rather than the whole transcript) keeps a full run's progress state
 *  bounded to a handful of lines however long the transcript grows. */
export const MARKER_LINE = /^\[( |•|✓|apply)\]/;

/** Reduce raw output to the cleaned marker lines worth keeping. */
export const markersIn = (raw: string[]) => raw.map(stripAnsi).filter((l) => MARKER_LINE.test(l));

/**
 * Best-effort parse of the session-log tail into the 5-slot checklist.
 * Scans from the newest line backward, tagging each slot with the marker
 * ([ ]/[•]/[✓]) nearest its most recent mention. Never throws — any
 * unrecognized shape (different harness, older format, whatever) just
 * falls through to `null`, and the caller shows a generic "running…"
 * indicator instead of guessing at garbage.
 */
export function parsePhaseChecklist(lines: string[]): PhaseInfo | null {
  try {
    const state: Record<ChecklistKey, SlotState> = {
      scrape: "pending",
      fitgate: "pending",
      tailor: "pending",
      apply: "pending",
      report: "pending",
    };
    const seen = new Set<ChecklistKey>();
    let matched = false;
    for (let i = lines.length - 1; i >= 0 && seen.size < CHECKLIST_SLOTS.length; i--) {
      const raw = lines[i];
      if (!raw) continue;
      const clean = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
      const m = /^\[( |•|✓)\]\s*(.+)$/.exec(clean);
      if (!m) continue;
      const marker = m[1];
      const text = m[2] ?? "";
      for (const slot of CHECKLIST_SLOTS) {
        if (seen.has(slot.key) || !slot.match.test(text)) continue;
        state[slot.key] = marker === "✓" ? "done" : marker === "•" ? "current" : "pending";
        seen.add(slot.key);
        matched = true;
      }
    }
    if (!matched) return null;
    const slots = CHECKLIST_SLOTS.map((s) => ({ label: s.label, state: state[s.key] }));
    let currentIndex = slots.findIndex((s) => s.state === "current");
    if (currentIndex === -1) currentIndex = slots.findIndex((s) => s.state === "pending");
    if (currentIndex === -1) currentIndex = slots.length - 1;
    return {
      slots,
      currentIndex,
      currentKey: CHECKLIST_SLOTS[currentIndex]?.key ?? "apply",
      caption: CHECKLIST_SLOTS[currentIndex]?.caption ?? "Running",
    };
  } catch {
    return null;
  }
}

const APPLY_MARKER = /^\[apply\]\s*(.+?)\s*@\s*(.+)$/;

/**
 * Finds the most recent `[apply] <title> @ <company>` marker (see
 * src/agents/bodies/job-scraper.md's "Progress markers" section) so the
 * running view can show which job is currently being applied to. Scans
 * from the newest line backward and stops at the first match — once a
 * later phase starts, an older apply-marker naturally stops being "the
 * current one" because that phase's own state (from parsePhaseChecklist)
 * takes over the caption instead.
 */
export function parseCurrentApplication(lines: string[]): { title: string; company: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw) continue;
    const clean = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const m = APPLY_MARKER.exec(clean);
    if (m) return { title: m[1] ?? "", company: m[2] ?? "" };
  }
  return null;
}
