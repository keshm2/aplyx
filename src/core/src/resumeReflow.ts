/**
 * Split out of masterResume.ts on purpose: this file must stay free of any
 * Node-only import (fs, child_process, platform.js's subprocess helpers).
 * The desktop app's ResumesScreen calls reflowExtractedResumeText directly
 * as a plain value (not `import type`), so unlike masterResume.ts's other
 * consumers (which only ever import its types, fully erased by tsc, or go
 * through the Rust/bridge IPC layer for anything that touches disk or a
 * subprocess), this one really does end up in the browser/webview bundle.
 * Confirmed live: pulling this logic in via masterResume.ts broke Vite's
 * production build outright ("join" is not exported by
 * "__vite-browser-external"), because that file's top-level
 * `import { py, execFileWithStdin } from "./platform.js"` (needed only by
 * the Node-side exportResumePdf) came along with it.
 */

const SECTION_PATTERNS: Array<{ re: RegExp; key: "education" | "experience" | "projects" | "skills" | "certifications"; canonical: string }> = [
  { re: /^education\b/i, key: "education", canonical: "Education" },
  { re: /^(work\s+)?experience\b/i, key: "experience", canonical: "Experience" },
  { re: /^projects?\b/i, key: "projects", canonical: "Projects" },
  { re: /^(technical\s+)?skills\b/i, key: "skills", canonical: "Technical Skills" },
  { re: /^(certifications?|awards?)\b/i, key: "certifications", canonical: "Certifications & Awards" },
];

const MONTH_RE = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-zA-Z]*\\.?";
const DATE_TOKEN_RE = `(?:${MONTH_RE}\\.?\\s*\\d{4}|\\d{4}|Present|Current)`;
// A month+year that starts immediately after a lowercase letter with no
// space: the single most common raw-PDF-extraction artifact for a
// job/degree date: two adjacent text runs ("...Intern" and "June 2025")
// that were positioned close together on the page merge into one string
// with the separating space simply gone ("InternJune 2025").
const SMASHED_DATE_START_RE = new RegExp(`([a-z])(${MONTH_RE}\\.?\\s*\\d{4})`, "i");
const DATE_RANGE_SUFFIX_RE = new RegExp(`^(.*\\S)\\s+(${DATE_TOKEN_RE}\\s*(?:–|—|-|to)\\s*${DATE_TOKEN_RE})\\s*$`, "i");

function matchSectionHeader(line: string): { key: (typeof SECTION_PATTERNS)[number]["key"]; canonical: string } | null {
  const bare = line.replace(/^#{1,3}\s*/, "").trim();
  for (const pattern of SECTION_PATTERNS) {
    if (pattern.re.test(bare)) return pattern;
  }
  return null;
}

/** Splits "Title-textDATE – DATE" (with or without the space pypdf often
 *  drops before the date) into { title, dates }, or null if this line
 *  doesn't end in a real date range: used to find where one experience
 *  entry ends and the next begins in text with no blank-line separators
 *  between entries (the common case for pypdf-extracted text). */
function splitTitleAndDateRange(line: string): { title: string; dates: string } | null {
  const fixed = line.replace(SMASHED_DATE_START_RE, "$1 $2");
  const m = fixed.match(DATE_RANGE_SUFFIX_RE);
  if (!m) return null;
  let title = m[1]!.trim();
  let dates = m[2]!.trim();
  // DATE_TOKEN_RE also accepts a bare 4-digit year, so greedy backtracking
  // on the title group finds its shortest valid date suffix first: for
  // "...Intern June 2025 – Present" that's just "2025 – Present", leaving
  // "June" stuck on the title. Reclaim a trailing month word off the title
  // back onto the front of the date range when this happens.
  const trailingMonth = title.match(new RegExp(`\\s(${MONTH_RE})$`, "i"));
  if (trailingMonth) {
    title = title.slice(0, title.length - trailingMonth[0]!.length).trim();
    dates = `${trailingMonth[1]} ${dates}`;
  }
  return { title, dates };
}

/** Best-effort reformat of raw, unstructured text (typically straight out
 *  of convert_resume.py's pypdf extraction, "text extraction only,
 *  formatting is not preserved") into the flat skeleton importFromMarkdown
 *  actually parses. Real motivation, not hypothetical: a real resume's
 *  extracted text has no `#`/`##`/`###` markers, "•" instead of "- "
 *  bullets, and a job's title/date/company frequently arrive as
 *  "Software Development Engineer InternJune 2025 – Present" on one line
 *  and "KredosAI Issaquah, WA" on the next, with no blank line anywhere
 *  to mark where one entry ends and the next begins, none of which
 *  importFromMarkdown's line-based rules recognize, so before this fix
 *  the only things that ever actually imported from a freshly-converted
 *  PDF were whatever happened to already look like the skeleton (usually
 *  nothing, reported live as "only my name and basic details import,
 *  never any bullets/jobs/skills").
 *
 *  Deliberately narrow about what it's confident enough to restructure:
 *  section names, bullets, and experience/project entry boundaries (the
 *  bulk of what was silently getting dropped). Education is left as
 *  plain passthrough text rather than guessed at: this sample resume's
 *  degree line has no clean delimiter to split degree/GPA/dates on, and
 *  a wrong guess there is worse than an honest gap the user can fill in
 *  by hand in the (now-editable) preview box. Idempotent on text that
 *  already matches the skeleton: an already-correct "### Title -
 *  Company" + dates + "- bullet" block passes through byte-for-byte
 *  unchanged, so running this on one of the hand-written
 *  data/resumes/base_resume_*.md files is a no-op, not a regression. */
export function reflowExtractedResumeText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];

  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === "" || lines[i]!.trim().startsWith("<!--"))) i++;

  if (i < lines.length) {
    const nameLine = lines[i]!.trim();
    out.push(nameLine.startsWith("#") ? nameLine : `# ${nameLine}`);
    i++;
  }
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i < lines.length && /@|linkedin\.com|github\.com/i.test(lines[i]!)) {
    out.push(lines[i]!.trim());
    i++;
  }

  type Section = "" | "education" | "experience" | "projects" | "skills" | "certifications";
  let section: Section = "";
  let pendingExp: { title: string; dates: string; company?: string } | null = null;
  let passthroughNext = false;

  const flushPendingExp = () => {
    if (!pendingExp) return;
    out.push(`### ${pendingExp.title} - ${pendingExp.company ?? "(unknown, fill in the company/location)"}`);
    out.push(pendingExp.dates);
    pendingExp = null;
  };

  for (; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) continue;

    const sectionMatch = matchSectionHeader(trimmed);
    if (sectionMatch) {
      flushPendingExp();
      section = sectionMatch.key;
      passthroughNext = false;
      out.push(`## ${sectionMatch.canonical}`);
      continue;
    }

    // Bullets: "•" (raw extraction) and already-correct "- " both
    // normalize to "- ": checked before any section-specific logic so
    // an already-well-formed bullet is never mistaken for a title/date
    // or a skills line.
    const bulletMatch = trimmed.match(/^(?:[••]|-)\s*(.+)$/);
    if (bulletMatch) {
      if (section === "experience") flushPendingExp();
      passthroughNext = false;
      out.push(`- ${bulletMatch[1]!.trim()}`);
      continue;
    }

    // pypdf sometimes wraps a bullet's own text onto a second line with
    // no marker (e.g. "...refreshed daily via cron" / "jobs"): a
    // lowercase-starting line right after a bullet is that wrapped
    // continuation, not a new title/entry; merge it back in rather than
    // letting downstream code mistake it for e.g. a new project.
    const lastLine = out[out.length - 1];
    if (lastLine && lastLine.startsWith("- ") && /^[a-z]/.test(trimmed)) {
      out[out.length - 1] = `${lastLine} ${trimmed}`;
      continue;
    }

    if (section === "experience") {
      if (trimmed.startsWith("###")) {
        // Already a well-formed header (e.g. re-reflowing text the user
        // already hand-edited into shape), pass through as-is, and the
        // line right after a real header is its dates line, same rule.
        flushPendingExp();
        out.push(trimmed);
        passthroughNext = true;
        continue;
      }
      if (passthroughNext) {
        out.push(trimmed);
        passthroughNext = false;
        continue;
      }
      const dateSplit = splitTitleAndDateRange(trimmed);
      if (dateSplit) {
        flushPendingExp();
        pendingExp = { title: dateSplit.title, dates: dateSplit.dates };
        continue;
      }
      if (pendingExp && !pendingExp.company) {
        pendingExp.company = trimmed;
        continue;
      }
      // A sub-line with no date range and no open entry waiting on a
      // company (e.g. a sub-project name between a job's company line
      // and its bullets): importFromMarkdown has no slot for this
      // either; dropping it here matches what it would already do.
      continue;
    }

    if (section === "projects") {
      if (trimmed.startsWith("###")) {
        out.push(trimmed);
        continue;
      }
      // Real extraction often appends a "|tech, stack, list" to the
      // project name with no field for it downstream: keep the name,
      // drop the rest, rather than gluing it onto MasterResumeProject.name.
      out.push(`### ${trimmed.split("|")[0]!.trim()}`);
      continue;
    }

    if (section === "skills") {
      const skillMatch = trimmed.match(/^([A-Za-z0-9 /&]+):\s*(.+)$/);
      if (skillMatch) {
        out.push(`- **${skillMatch[1]!.trim()}**: ${skillMatch[2]!.trim()}`);
        continue;
      }
      out.push(trimmed);
      continue;
    }

    // Education, certifications, and anything before the first section
    // header: passthrough unchanged. importFromMarkdown will pick up
    // whatever it already recognizes (e.g. an already-bolded school
    // line) and skip the rest, same as before this function existed,
    // deliberately not guessing here.
    out.push(trimmed);
  }
  flushPendingExp();

  return out.join("\n");
}
