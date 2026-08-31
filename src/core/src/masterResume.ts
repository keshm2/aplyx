import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readSafeField } from "./settings.js";
import { py, execFileWithStdin } from "./platform.js";

/**
 * The single generic resume the operator maintains and aplyx tailors per
 * job (Phase 1 of the resume-system redesign; see the plan). Every list
 * entry and every bullet carries a stable `id` so a later tailoring pass
 * can select/reorder/reference specific bullets without ambiguity,
 * something the old flat `tailored_bullets: string[]` on AppliedJob never
 * had. Read/write/import are pure fs/JSON, no Python needed; mirrors
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
  // info, work history); don't rely on ambient umask.
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
 *  sections: `### Title - Company, Location` sub-headers with a date
 *  line and `- bullet` lines under Experience, `### Name ... (dates)`
 *  under Projects (dates trail in parens, bullets start immediately, no
 *  separate date line). No LLM call; this structure is regular enough
 *  for plain line-based rules; unrecognized lines are skipped rather than
 *  thrown on, since the 5 source files vary slightly (e.g. only some have
 *  a "Relevant Coursework" line). `base` supplies contact defaults (from
 *  initialMasterResume, i.e. safe_fields) for anything the markdown
 *  itself doesn't clearly state. */
/** Deterministic parser for the flat-Markdown skeleton every
 *  data/resumes/base_resume_*.md file already follows (confirmed
 *  consistent across all 5 by direct read): `# Name` header, a
 *  pipe-separated contact line, then `## Education` / `## Experience` /
 *  `## Projects` / `## Technical Skills` / `## Certifications & Awards`
 *  sections: `### Title - Company, Location` sub-headers with a date
 *  line and `- bullet` lines under Experience, `### Name ... (dates)`
 *  under Projects (dates trail in parens, bullets start immediately, no
 *  separate date line). No LLM call; this structure is regular enough
 *  for plain line-based rules; unrecognized lines are skipped rather than
 *  thrown on, since the 5 source files vary slightly (e.g. only some have
 *  a "Relevant Coursework" line). `base` supplies contact defaults (from
 *  initialMasterResume, i.e. safe_fields) for anything the markdown
 *  itself doesn't clearly state. Text straight out of `convert_resume.py`
 *  should go through `reflowExtractedResumeText` (resumeReflow.ts) first;
 *  raw PDF extraction doesn't match this skeleton at all on its own. */
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
  /** What the one-page-fit shrink ladder had to cut, if anything; empty
   *  when the resume fit at full size. Purely informational; nothing here
   *  is ever written back to resume.json. */
  notes?: string[];
  error?: string;
}

const resumePdfPath = (root: string) => path.join(root, "data", "resumes", "resume.pdf");

/** Renders `resume` to a guaranteed one-page PDF via the deterministic
 *  render engine (src/scripts/state/render_resume_pdf.py, using Playwright's
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
    // line to stdout before a nonzero exit; execFileWithStdin's reject
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
 * Preview what `@resume-tailor` (including the humanizer skill pass:
 * src/agents/skills/humanizer/SKILL.md) would produce for a job
 * title/JD, via src/scripts/runtime/preview_resume.py, a direct
 * Anthropic API call, same pattern as generate_interest_letter.py.
 * Requires ANTHROPIC_API_KEY (or src/config/anthropic_key.json) to be
 * configured; the script's own {ok:false, error} surfaces clearly when
 * it isn't. Read-only: never touches data/resumes/resume.json or any
 * other state; this has no connection to a real application.
 *
 * `resume` is passed in explicitly (via --payload-stdin) rather than
 * having the script re-read data/resumes/resume.json itself, same
 * reasoning as exportResumePdf: the caller may have unsaved edits in the
 * Resumes editor, and the preview should reflect what's on screen, not
 * stale disk state.
 *
 * Routes through whatever coding-agent harness this install already has
 * configured (src/config/harness.json) rather than calling a model
 * provider's API directly; no separate API key needed, and the output
 * reflects what the real apply pipeline's tailoring step would actually
 * produce. A full tailor+humanize pass through a real agent harness is
 * empirically slower than a direct API call (observed 90-200s); the
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
