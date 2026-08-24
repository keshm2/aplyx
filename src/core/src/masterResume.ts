import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readSafeField } from "./settings.js";
import { py, execFileWithStdin } from "./platform.js";

/**
 * The single generic resume the operator maintains and aplyx tailors per
 * job (Phase 1 of the resume-system redesign — see the plan). Every list
 * entry and every bullet carries a stable `id` so a later tailoring pass
 * can select/reorder/reference specific bullets without ambiguity —
 * something the old flat `tailored_bullets: string[]` on AppliedJob never
 * had. Read/write/import are pure fs/JSON, no Python needed — mirrors
 * settings.ts's readJson/writeJson pattern exactly, including the same PII
 * file-permission discipline. The one exception is exportResumePdf below,
 * which does need a Python subprocess (Playwright + pypdf, Phase 2).
 */

export interface MasterResumeBullet {
  id: string;
  text: string;
}

export interface MasterResumeEducation {
  id: string;
  school: string;
  degree: string;
  location: string;
  dates: string;
  /** Extra freeform lines under an entry (e.g. "Relevant Coursework: ..."). */
  details: string[];
}

export interface MasterResumeExperience {
  id: string;
  title: string;
  company: string;
  location: string;
  dates: string;
  bullets: MasterResumeBullet[];
}

export interface MasterResumeProject {
  id: string;
  name: string;
  dates: string;
  bullets: MasterResumeBullet[];
}

export interface MasterResumeSkillGroup {
  id: string;
  category: string;
  items: string[];
}

export interface MasterResumeContact {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin_url: string;
  github_url: string;
}

export interface MasterResume {
  version: 1;
  contact: MasterResumeContact;
  education: MasterResumeEducation[];
  experience: MasterResumeExperience[];
  projects: MasterResumeProject[];
  skills: MasterResumeSkillGroup[];
  certifications: string[];
  updated_at: string;
}

const resumePath = (root: string) => path.join(root, "data", "resumes", "resume.json");

export function readMasterResume(root: string): MasterResume | null {
  try {
    const raw = fs.readFileSync(resumePath(root), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MasterResume) : null;
  } catch {
    return null;
  }
}

export function writeMasterResume(root: string, doc: MasterResume): void {
  const file = resumePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const toWrite: MasterResume = { ...doc, version: 1, updated_at: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
  // data/resumes/*.md,*.pdf carry the same PII discipline (name, contact
  // info, work history) — don't rely on ambient umask.
  fs.chmodSync(file, 0o600);
}

/** A brand-new resume, contact fields prefilled from safe_fields (already
 *  collected during onboarding) so the operator never re-types what
 *  aplyx already knows. */
export function initialMasterResume(root: string): MasterResume {
  const firstName = readSafeField(root, "first_name");
  const lastName = readSafeField(root, "last_name");
  return {
    version: 1,
    contact: {
      name: [firstName, lastName].filter(Boolean).join(" "),
      email: readSafeField(root, "email"),
      phone: readSafeField(root, "phone"),
      location: readSafeField(root, "location"),
      linkedin_url: readSafeField(root, "linkedin_url"),
      github_url: readSafeField(root, "github_url"),
    },
    education: [],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
    updated_at: new Date().toISOString(),
  };
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Deterministic parser for the flat-Markdown skeleton every
 *  data/resumes/base_resume_*.md file already follows (confirmed
 *  consistent across all 5 by direct read): `# Name` header, a
 *  pipe-separated contact line, then `## Education` / `## Experience` /
 *  `## Projects` / `## Technical Skills` / `## Certifications & Awards`
 *  sections — `### Title — Company, Location` sub-headers with a date
 *  line and `- bullet` lines under Experience, `### Name ... (dates)`
 *  under Projects (dates trail in parens, bullets start immediately, no
 *  separate date line). No LLM call — this structure is regular enough
 *  for plain line-based rules; unrecognized lines are skipped rather than
 *  thrown on, since the 5 source files vary slightly (e.g. only some have
 *  a "Relevant Coursework" line). `base` supplies contact defaults (from
 *  initialMasterResume, i.e. safe_fields) for anything the markdown
 *  itself doesn't clearly state. */
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
// space — the single most common raw-PDF-extraction artifact for a
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
 *  doesn't end in a real date range — used to find where one experience
 *  entry ends and the next begins in text with no blank-line separators
 *  between entries (the common case for pypdf-extracted text). */
function splitTitleAndDateRange(line: string): { title: string; dates: string } | null {
  const fixed = line.replace(SMASHED_DATE_START_RE, "$1 $2");
  const m = fixed.match(DATE_RANGE_SUFFIX_RE);
  if (!m) return null;
  let title = m[1]!.trim();
  let dates = m[2]!.trim();
  // DATE_TOKEN_RE also accepts a bare 4-digit year, so greedy backtracking
  // on the title group finds its shortest valid date suffix first — for
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
 *  of convert_resume.py's pypdf extraction — "text extraction only,
 *  formatting is not preserved") into the flat skeleton importFromMarkdown
 *  actually parses. Real motivation, not hypothetical: a real resume's
 *  extracted text has no `#`/`##`/`###` markers, "•" instead of "- "
 *  bullets, and a job's title/date/company frequently arrive as
 *  "Software Development Engineer InternJune 2025 – Present" on one line
 *  and "KredosAI Issaquah, WA" on the next, with no blank line anywhere
 *  to mark where one entry ends and the next begins — none of which
 *  importFromMarkdown's line-based rules recognize, so before this fix
 *  the only things that ever actually imported from a freshly-converted
 *  PDF were whatever happened to already look like the skeleton (usually
 *  nothing — reported live as "only my name and basic details import,
 *  never any bullets/jobs/skills").
 *
 *  Deliberately narrow about what it's confident enough to restructure:
 *  section names, bullets, and experience/project entry boundaries (the
 *  bulk of what was silently getting dropped). Education is left as
 *  plain passthrough text rather than guessed at — this sample resume's
 *  degree line has no clean delimiter to split degree/GPA/dates on, and
 *  a wrong guess there is worse than an honest gap the user can fill in
 *  by hand in the (now-editable) preview box. Idempotent on text that
 *  already matches the skeleton — an already-correct "### Title —
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
    out.push(`### ${pendingExp.title} — ${pendingExp.company ?? "(unknown — fill in the company/location)"}`);
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
    // normalize to "- " — checked before any section-specific logic so
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
    // no marker (e.g. "...refreshed daily via cron" / "jobs") — a
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
        // already hand-edited into shape) — pass through as-is, and the
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
      // and its bullets) — importFromMarkdown has no slot for this
      // either; dropping it here matches what it would already do.
      continue;
    }

    if (section === "projects") {
      if (trimmed.startsWith("###")) {
        out.push(trimmed);
        continue;
      }
      // Real extraction often appends a "|tech, stack, list" to the
      // project name with no field for it downstream — keep the name,
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
    // line) and skip the rest — same as before this function existed,
    // deliberately not guessing here.
    out.push(trimmed);
  }
  flushPendingExp();

  return out.join("\n");
}

export function importFromMarkdown(mdText: string, base: MasterResume): MasterResume {
  const lines = mdText.split(/\r?\n/);
  const doc: MasterResume = {
    ...base,
    contact: { ...base.contact },
    education: [],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
  };

  let i = 0;
  if (lines[0]?.startsWith("# ")) {
    const name = lines[0].slice(2).trim();
    if (name) doc.contact.name = name;
    i = 1;
  }
  const contactLine = lines[i];
  if (contactLine?.includes("|") && !contactLine.trim().startsWith("#")) {
    for (const part of contactLine.split("|").map((p) => p.trim())) {
      if (!part) continue;
      if (part.includes("@")) doc.contact.email = doc.contact.email || part;
      else if (/linkedin\.com/i.test(part)) doc.contact.linkedin_url = doc.contact.linkedin_url || part;
      else if (/github\.com/i.test(part)) doc.contact.github_url = doc.contact.github_url || part;
      else if (/\d/.test(part)) doc.contact.phone = doc.contact.phone || part;
    }
    i++;
  }

  type Section = "" | "education" | "experience" | "projects" | "skills" | "certifications";
  let section: Section = "";
  let currentEdu: MasterResumeEducation | null = null;
  let currentExp: MasterResumeExperience | null = null;
  let currentProj: MasterResumeProject | null = null;

  for (; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) continue;

    const sectionMatch = trimmed.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      const title = sectionMatch[1]!.toLowerCase();
      if (title.includes("education")) section = "education";
      else if (title.includes("experience")) section = "experience";
      else if (title.includes("project")) section = "projects";
      else if (title.includes("skill")) section = "skills";
      else if (title.includes("certification") || title.includes("award")) section = "certifications";
      else section = "";
      currentEdu = null;
      currentExp = null;
      currentProj = null;
      continue;
    }

    if (section === "education") {
      const schoolMatch = trimmed.match(/^\*\*(.+?)\*\*\s*(?:—|–|-)\s*(.+)$/);
      if (schoolMatch) {
        currentEdu = {
          id: newId("edu"),
          school: schoolMatch[1]!.trim(),
          degree: "",
          location: schoolMatch[2]!.trim(),
          dates: "",
          details: [],
        };
        doc.education.push(currentEdu);
        continue;
      }
      if (currentEdu && !currentEdu.degree && trimmed.includes("|")) {
        // "B.S. Informatics, Minor in Data Science | GPA: 3.75/4.00 | Sep 2023 – Jun 2027"
        const parts = trimmed.split("|").map((p) => p.trim());
        currentEdu.degree = parts[0] ?? "";
        currentEdu.dates = parts[parts.length - 1] ?? "";
        if (parts.length > 2) currentEdu.details.push(...parts.slice(1, -1));
        continue;
      }
      if (currentEdu) currentEdu.details.push(trimmed);
      continue;
    }

    if (section === "experience") {
      const headerMatch = trimmed.match(/^###\s+(.+?)\s*(?:—|–|-)\s*(.+)$/);
      if (headerMatch) {
        const rest = headerMatch[2]!.trim();
        const commaIdx = rest.indexOf(",");
        currentExp = {
          id: newId("exp"),
          title: headerMatch[1]!.trim(),
          company: commaIdx === -1 ? rest : rest.slice(0, commaIdx).trim(),
          location: commaIdx === -1 ? "" : rest.slice(commaIdx + 1).trim(),
          dates: "",
          bullets: [],
        };
        doc.experience.push(currentExp);
        continue;
      }
      if (currentExp) {
        const bulletMatch = trimmed.match(/^-\s+(.+)$/);
        if (bulletMatch) currentExp.bullets.push({ id: newId("b"), text: bulletMatch[1]!.trim() });
        else if (!currentExp.dates) currentExp.dates = trimmed;
      }
      continue;
    }

    if (section === "projects") {
      const headerMatch = trimmed.match(/^###\s+(.+)$/);
      if (headerMatch) {
        let name = headerMatch[1]!.trim();
        let dates = "";
        const datesMatch = name.match(/^(.*)\(([^()]+)\)\s*$/);
        if (datesMatch) {
          name = datesMatch[1]!.trim();
          dates = datesMatch[2]!.trim();
        }
        currentProj = { id: newId("proj"), name, dates, bullets: [] };
        doc.projects.push(currentProj);
        continue;
      }
      if (currentProj) {
        const bulletMatch = trimmed.match(/^-\s+(.+)$/);
        if (bulletMatch) currentProj.bullets.push({ id: newId("b"), text: bulletMatch[1]!.trim() });
      }
      continue;
    }

    if (section === "skills") {
      const skillMatch = trimmed.match(/^-\s+\*\*(.+?)\*\*:?\s*(.+)$/);
      if (skillMatch) {
        doc.skills.push({
          id: newId("skill"),
          category: skillMatch[1]!.trim().replace(/:$/, ""),
          items: skillMatch[2]!.split(",").map((s) => s.trim()).filter(Boolean),
        });
      }
      continue;
    }

    if (section === "certifications") {
      const bulletMatch = trimmed.match(/^-\s+(.+)$/);
      if (bulletMatch) doc.certifications.push(bulletMatch[1]!.trim());
      continue;
    }
  }

  return doc;
}

export interface ExportResumePdfResult {
  ok: boolean;
  path?: string;
  pages?: number;
  /** What the one-page-fit shrink ladder had to cut, if anything — empty
   *  when the resume fit at full size. Purely informational; nothing here
   *  is ever written back to resume.json. */
  notes?: string[];
  error?: string;
}

const resumePdfPath = (root: string) => path.join(root, "data", "resumes", "resume.pdf");

/** Renders `resume` to a guaranteed one-page PDF via the deterministic
 *  render engine (src/scripts/state/render_resume_pdf.py — Playwright's
 *  real Chrome + pypdf page-count verification). Read-only with respect to
 *  resume.json: this never mutates or saves the resume, purely a rendering
 *  artifact written to data/resumes/resume.pdf. */
export async function exportResumePdf(root: string, resume: MasterResume): Promise<ExportResumePdfResult> {
  const outputPath = resumePdfPath(root);
  const p = py(["src/scripts/state/render_resume_pdf.py", outputPath]);
  try {
    const { stdout } = await execFileWithStdin(p.cmd, p.args, JSON.stringify(resume), {
      cwd: root,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30_000,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as ExportResumePdfResult;
  } catch (err) {
    // render_resume_pdf.py always prints a structured {ok:false,error}
    // line to stdout before a nonzero exit — execFileWithStdin's reject
    // still carries that stdout, so surface the real message instead of
    // a generic "Command failed" from the rejected error itself.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) {
      try {
        return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as ExportResumePdfResult;
      } catch {
        /* fall through */
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface PreviewTailoredResumeResult {
  ok: boolean;
  company?: string;
  title?: string;
  resume_used?: string;
  ats_score?: number;
  missing_keywords?: string[];
  tailored_bullets?: string[];
  tailored_resume?: MasterResume;
  error?: string;
}

/**
 * Preview what `@resume-tailor` (including the humanizer skill pass —
 * src/agents/skills/humanizer/SKILL.md) would produce for a job
 * title/JD, via src/scripts/runtime/preview_resume.py — a direct
 * Anthropic API call, same pattern as generate_interest_letter.py.
 * Requires ANTHROPIC_API_KEY (or src/config/anthropic_key.json) to be
 * configured; the script's own {ok:false, error} surfaces clearly when
 * it isn't. Read-only: never touches data/resumes/resume.json or any
 * other state — this has no connection to a real application.
 *
 * `resume` is passed in explicitly (via --payload-stdin) rather than
 * having the script re-read data/resumes/resume.json itself — same
 * reasoning as exportResumePdf: the caller may have unsaved edits in the
 * Resumes editor, and the preview should reflect what's on screen, not
 * stale disk state.
 *
 * Routes through whatever coding-agent harness this install already has
 * configured (src/config/harness.json) rather than calling a model
 * provider's API directly — no separate API key needed, and the output
 * reflects what the real apply pipeline's tailoring step would actually
 * produce. A full tailor+humanize pass through a real agent harness is
 * empirically slower than a direct API call (observed 90-200s) — the
 * timeout here (300s) stays comfortably above preview_resume.py's own
 * internal HARNESS_TIMEOUT_S (280s) so that script's own clean
 * {ok:false, error} has room to fire first, instead of Node's own
 * timeout killing the process and losing that message.
 */
export async function previewTailoredResume(
  root: string, title: string, company: string, jdText: string, resume: MasterResume,
): Promise<PreviewTailoredResumeResult> {
  const p = py(["src/scripts/runtime/preview_resume.py", "--title", title, "--company", company, "--payload-stdin"]);
  const stdinPayload = JSON.stringify({ master_resume: resume, jd_text: jdText });
  try {
    const { stdout } = await execFileWithStdin(p.cmd, p.args, stdinPayload, {
      cwd: root,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 300_000,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as PreviewTailoredResumeResult;
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) {
      try {
        return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as PreviewTailoredResumeResult;
      } catch {
        /* fall through */
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
