import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import fs from "node:fs";
import path from "node:path";
import { listResumeFiles, resumesDir, type ResumeFile } from "../resumes.js";
import { convertResumePdf, openPath, helperError, syncGraduationFromResume } from "@aplyx/core/helpers.js";
import {
  readMasterResume,
  writeMasterResume,
  initialMasterResume,
  importFromMarkdown,
  exportResumePdf,
  type MasterResume,
  type MasterResumeContact,
  type MasterResumeEducation,
  type MasterResumeExperience,
  type MasterResumeProject,
  type MasterResumeSkillGroup,
} from "@aplyx/core/masterResume.js";
import { theme } from "../theme.js";
import { InlineTextInput, deleteBackward, insertAtCursor, moveCursorLeft, moveCursorRight } from "./TextInput.js";

/**
 * Resumes screen: the operator's single generic resume
 * (data/resumes/resume.json; see src/core/src/masterResume.ts), edited
 * directly here: same file the desktop app's Resume screen edits, and
 * the same one @resume-tailor reads per application. No category system
 * (that's retired; see src/agents/bodies/resume-tailor.md).
 *
 * masterResume.ts's read/write/import are pure fs, so (unlike the
 * desktop app's webview, which has to go through a Rust/Node bridge)
 * this screen calls them directly, same process, no IPC (same pattern
 * SettingsScreen.tsx already uses for settings.ts/profileLinks.ts).
 * Every edit writes through immediately, matching this TUI's existing
 * write-on-commit convention (no separate dirty-state/Save button, unlike
 * the desktop app's web-form model).
 *
 * Navigation is a plain nested drill-down, one level added at a time:
 * sections → (entry list for Education/Experience/Projects/Skills, or
 * the field list for Contact, or the flat item list for Certifications)
 * → entry detail (its own fields, plus a Bullets/Details/Items row for
 * whichever nested list that entry kind has) → that nested list. Every
 * list (entries, bullets, details, items, certifications) shares the
 * same four actions: `a` add, `x` delete, `[`/`]` reorder, enter to
 * edit/drill in: the closest 3-4-level analog SettingsScreen.tsx's own
 * section→field two-level pattern has in this codebase, extended for a
 * genuinely nested document instead of a flat field list.
 */

type SectionKey = "contact" | "education" | "experience" | "projects" | "skills" | "certifications" | "import" | "export";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "contact", label: "Contact" },
  { key: "education", label: "Education" },
  { key: "experience", label: "Experience" },
  { key: "projects", label: "Projects" },
  { key: "skills", label: "Skills" },
  { key: "certifications", label: "Certifications & awards" },
  { key: "import", label: "Import from an existing resume" },
  { key: "export", label: "Export PDF" },
];

type ContactFieldKey = "name" | "email" | "phone" | "location" | "linkedin_url" | "github_url";
const CONTACT_FIELDS: { key: ContactFieldKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "location", label: "Location" },
  { key: "linkedin_url", label: "LinkedIn" },
  { key: "github_url", label: "GitHub" },
];

type EntrySection = "education" | "experience" | "projects" | "skills";

/** What the inline text-edit popup is currently bound to: the save
 *  handler switches on this to know exactly where the committed value
 *  goes. */
type EditContext =
  | { kind: "contact"; field: ContactFieldKey }
  | { kind: "education-field"; entryIdx: number; field: "school" | "degree" | "location" | "dates" }
  | { kind: "experience-field"; entryIdx: number; field: "title" | "company" | "location" | "dates" }
  | { kind: "project-field"; entryIdx: number; field: "name" | "dates" }
  | { kind: "skill-category"; entryIdx: number }
  | { kind: "bullet"; section: "experience" | "projects"; entryIdx: number; bulletIdx: number | "new" }
  | { kind: "string-list-item"; itemIdx: number | "new" };

/** Where the shared string-list sub-view (add/edit/delete/reorder one-
 *  line strings) is currently pointed: Education's free-text details,
 *  a Skills entry's items, and top-level Certifications all reuse the
 *  exact same interaction, just against a different array. */
type StringListContext = { kind: "education-details"; entryIdx: number } | { kind: "skill-items"; entryIdx: number } | { kind: "certifications" };

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function emptyEducation(): MasterResumeEducation {
  return { id: newId("edu"), school: "", degree: "", location: "", dates: "", details: [] };
}
function emptyExperience(): MasterResumeExperience {
  return { id: newId("exp"), title: "", company: "", location: "", dates: "", bullets: [] };
}
function emptyProject(): MasterResumeProject {
  return { id: newId("proj"), name: "", dates: "", bullets: [] };
}
function emptySkillGroup(): MasterResumeSkillGroup {
  return { id: newId("skill"), category: "", items: [] };
}

function swap<T>(arr: T[], i: number, j: number): T[] {
  const next = [...arr];
  const a = next[i]!;
  const b = next[j]!;
  next[i] = b;
  next[j] = a;
  return next;
}

export function ResumesScreen({
  root,
  active,
  onInputActiveChange,
  contentRows = 20,
}: {
  root: string;
  active: boolean;
  onInputActiveChange: (active: boolean) => void;
  contentRows?: number;
}) {
  const [resume, setResume] = useState<MasterResume | null>(null);
  const [sectionCursor, setSectionCursor] = useState(0);
  const [inSection, setInSection] = useState(false);
  // Cursor within whatever list the current section shows at its top
  // level: Contact's field list, an entry-list (education/experience/
  // projects/skills), Certifications' flat item list, or Import's
  // candidate list.
  const [rowCursor, setRowCursor] = useState(0);
  // Drilled into one entry of an entry-list section.
  const [entryIndex, setEntryIndex] = useState<number | null>(null);
  const [detailCursor, setDetailCursor] = useState(0);
  // Drilled into an experience/project entry's bullet list.
  const [inBullets, setInBullets] = useState(false);
  const [bulletCursor, setBulletCursor] = useState(0);
  // Drilled into the shared string-list sub-view (details/items/certs).
  const [stringListCtx, setStringListCtx] = useState<StringListContext | null>(null);
  const [stringListCursor, setStringListCursor] = useState(0);
  // The inline text-edit popup, shared by every editable value on screen.
  const [editing, setEditing] = useState(false);
  const [editCtx, setEditCtx] = useState<EditContext | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editCursor, setEditCursor] = useState(0);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  // Import flow.
  const [importCandidates, setImportCandidates] = useState<ResumeFile[]>([]);
  const [importPreview, setImportPreview] = useState<{ stem: string; text: string } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  // Export flow.
  const [exporting, setExporting] = useState(false);
  // Shared scroll-window offset for whichever single list is on screen:
  // only one list is ever visible at once, so one ref suffices (same
  // cursor-follows-window technique SettingsScreen.tsx's checklist popup
  // uses; Ink clips rather than scrolls a frame taller than the terminal).
  const listOffsetRef = useRef(0);

  useEffect(() => {
    setResume(readMasterResume(root) ?? initialMasterResume(root));
  }, [root]);

  const section = SECTIONS[sectionCursor]!;

  const commit = (next: MasterResume) => {
    const educationChanged =
      JSON.stringify(next.education ?? []) !== JSON.stringify(resume?.education ?? []);
    writeMasterResume(root, next);
    setResume(next);
    // The resume is the source of truth for the graduation date; when the
    // education section changed, re-derive it and keep
    // safe_fields.graduation_date (fit gate + form-fill) in step.
    if (educationChanged) {
      const g = syncGraduationFromResume(root);
      if (g.updated) setMessage(g.note);
      else if (g.confidence === "low") setMessage(`Saved. ${g.note}`);
    }
  };

  // Any popup/list-editing state active anywhere means this screen owns
  // the keyboard; otherwise free-typed text would also hit App's global
  // tab-switch/quit handler.
  const captures = active && (inSection || editing);
  useEffect(() => {
    onInputActiveChange(captures);
    return () => onInputActiveChange(false);
  }, [captures, onInputActiveChange]);

  if (!resume) {
    return (
      <Box>
        <Text dimColor>Loading…</Text>
      </Box>
    );
  }

  // ---- Generic string-list helpers (Education details / Skills items / Certifications) ----

  const getStringList = (ctx: StringListContext): string[] => {
    if (ctx.kind === "education-details") return resume.education[ctx.entryIdx]?.details ?? [];
    if (ctx.kind === "skill-items") return resume.skills[ctx.entryIdx]?.items ?? [];
    return resume.certifications;
  };

  const setStringList = (ctx: StringListContext, items: string[]) => {
    if (ctx.kind === "education-details") {
      const education = resume.education.map((e, i) => (i === ctx.entryIdx ? { ...e, details: items } : e));
      commit({ ...resume, education });
    } else if (ctx.kind === "skill-items") {
      const skills = resume.skills.map((s, i) => (i === ctx.entryIdx ? { ...s, items } : s));
      commit({ ...resume, skills });
    } else {
      commit({ ...resume, certifications: items });
    }
  };

  // ---- Entry-list helpers (Education/Experience/Projects/Skills) ----

  const entrySectionKey = section.key as EntrySection;
  const entries: Array<MasterResumeEducation | MasterResumeExperience | MasterResumeProject | MasterResumeSkillGroup> =
    entrySectionKey === "education" ? resume.education
    : entrySectionKey === "experience" ? resume.experience
    : entrySectionKey === "projects" ? resume.projects
    : entrySectionKey === "skills" ? resume.skills
    : [];

  const setEntries = (next: typeof entries) => {
    if (entrySectionKey === "education") commit({ ...resume, education: next as MasterResumeEducation[] });
    else if (entrySectionKey === "experience") commit({ ...resume, experience: next as MasterResumeExperience[] });
    else if (entrySectionKey === "projects") commit({ ...resume, projects: next as MasterResumeProject[] });
    else if (entrySectionKey === "skills") commit({ ...resume, skills: next as MasterResumeSkillGroup[] });
  };

  const entryLabel = (e: (typeof entries)[number]): string => {
    if (entrySectionKey === "education") {
      const ed = e as MasterResumeEducation;
      return `${ed.school || "(untitled school)"}: ${ed.degree || "no degree set"}`;
    }
    if (entrySectionKey === "experience") {
      const ex = e as MasterResumeExperience;
      return `${ex.title || "(untitled role)"}: ${ex.company || "no company"}`;
    }
    if (entrySectionKey === "projects") {
      const p = e as MasterResumeProject;
      return p.name || "(untitled project)";
    }
    const s = e as MasterResumeSkillGroup;
    return `${s.category || "(untitled category)"} (${s.items.length} item${s.items.length === 1 ? "" : "s"})`;
  };

  const isBulletSection = entrySectionKey === "experience" || entrySectionKey === "projects";

  const startEdit = (ctx: EditContext, value: string) => {
    setEditCtx(ctx);
    setEditValue(value);
    setEditCursor(value.length);
    setEditing(true);
    setMessage("");
  };

  const saveEdit = () => {
    if (!editCtx) return;
    const value = editValue.trim();
    if (editCtx.kind === "contact") {
      commit({ ...resume, contact: { ...resume.contact, [editCtx.field]: value } as MasterResumeContact });
    } else if (editCtx.kind === "education-field") {
      const education = resume.education.map((e, i) => (i === editCtx.entryIdx ? { ...e, [editCtx.field]: value } : e));
      commit({ ...resume, education });
    } else if (editCtx.kind === "experience-field") {
      const experience = resume.experience.map((e, i) => (i === editCtx.entryIdx ? { ...e, [editCtx.field]: value } : e));
      commit({ ...resume, experience });
    } else if (editCtx.kind === "project-field") {
      const projects = resume.projects.map((p, i) => (i === editCtx.entryIdx ? { ...p, [editCtx.field]: value } : p));
      commit({ ...resume, projects });
    } else if (editCtx.kind === "skill-category") {
      const skills = resume.skills.map((s, i) => (i === editCtx.entryIdx ? { ...s, category: value } : s));
      commit({ ...resume, skills });
    } else if (editCtx.kind === "bullet") {
      if (!value) {
        setEditing(false);
        setMessage("Empty bullet discarded.");
        return;
      }
      const key = editCtx.section;
      const list = key === "experience" ? resume.experience : resume.projects;
      const entryIdx = editCtx.entryIdx;
      const entry = list[entryIdx];
      if (entry) {
        const bullets =
          editCtx.bulletIdx === "new"
            ? [...entry.bullets, { id: newId("b"), text: value }]
            : entry.bullets.map((b, i) => (i === editCtx.bulletIdx ? { ...b, text: value } : b));
        const nextEntry = { ...entry, bullets };
        const nextList = list.map((e, i) => (i === entryIdx ? nextEntry : e));
        commit(key === "experience" ? { ...resume, experience: nextList as MasterResumeExperience[] } : { ...resume, projects: nextList as MasterResumeProject[] });
        if (editCtx.bulletIdx === "new") setBulletCursor(bullets.length - 1);
      }
    } else if (editCtx.kind === "string-list-item" && stringListCtx) {
      if (!value) {
        setEditing(false);
        setMessage("Empty item discarded.");
        return;
      }
      const current = getStringList(stringListCtx);
      const next = editCtx.itemIdx === "new" ? [...current, value] : current.map((v, i) => (i === editCtx.itemIdx ? value : v));
      setStringList(stringListCtx, next);
      if (editCtx.itemIdx === "new") setStringListCursor(next.length - 1);
    }
    setEditing(false);
    setMessage("Saved.");
  };

  // ---- Import flow ----

  const enterImportSection = () => {
    setImportCandidates(listResumeFiles(root).filter((f) => f.hasMarkdown || f.hasPdf));
    setImportPreview(null);
    setRowCursor(0);
  };

  const startImportPreview = (file: ResumeFile) => {
    setImportBusy(true);
    setMessage("");
    try {
      if (!file.hasMarkdown) {
        const result = convertResumePdf(root, file.stem);
        if (!result.ok) {
          setMessage(`Could not read ${file.stem}.pdf: ${result.error}`);
          setMessageIsError(true);
          return;
        }
      }
      const mdPath = path.join(resumesDir(root), `${file.stem}.md`);
      const text = fs.readFileSync(mdPath, "utf8");
      setImportPreview({ stem: file.stem, text });
    } catch (err) {
      setMessage(`Could not read ${file.stem}: ${helperError(err)}`);
      setMessageIsError(true);
    } finally {
      setImportBusy(false);
    }
  };

  const applyImport = () => {
    if (!importPreview) return;
    const imported = importFromMarkdown(importPreview.text, resume);
    commit(imported);
    setImportPreview(null);
    setInSection(false);
    setMessage(`Imported from ${importPreview.stem}: review every section, then edit anything that needs fixing.`);
    setMessageIsError(false);
  };

  // ---- Export flow ----

  const runExport = async () => {
    setExporting(true);
    setMessage("Rendering PDF…");
    setMessageIsError(false);
    try {
      const result = await exportResumePdf(root, resume);
      if (!result.ok) {
        setMessage(`Export failed: ${result.error}`);
        setMessageIsError(true);
        return;
      }
      const notes = result.notes && result.notes.length > 0 ? ` (${result.notes.length} bullet(s)/entries shortened to fit one page; export only, your saved resume is unchanged)` : "";
      setMessage(`Exported to data/resumes/resume.pdf.${notes}`);
      setMessageIsError(false);
    } catch (err) {
      setMessage(`Export failed: ${helperError(err)}`);
      setMessageIsError(true);
    } finally {
      setExporting(false);
    }
  };

  // ---- Keyboard ----

  useInput(
    (input, key) => {
      if (editing) {
        if (key.return) {
          saveEdit();
        } else if (key.escape) {
          setEditing(false);
          setMessage("Edit cancelled: value unchanged.");
          setMessageIsError(false);
        } else if (key.leftArrow) {
          setEditCursor(moveCursorLeft({ value: editValue, cursor: editCursor }).cursor);
        } else if (key.rightArrow) {
          setEditCursor(moveCursorRight({ value: editValue, cursor: editCursor }).cursor);
        } else if (key.backspace || key.delete) {
          const next = deleteBackward({ value: editValue, cursor: editCursor });
          setEditValue(next.value);
          setEditCursor(next.cursor);
        } else if (!key.ctrl && !key.meta && input && !/\p{C}/u.test(input)) {
          const next = insertAtCursor({ value: editValue, cursor: editCursor }, input);
          setEditValue(next.value);
          setEditCursor(next.cursor);
        }
        return;
      }

      if (!inSection) {
        // Section menu.
        if (key.upArrow || input === "k") return setSectionCursor((c) => (c + SECTIONS.length - 1) % SECTIONS.length);
        if (key.downArrow || input === "j" || key.tab) return setSectionCursor((c) => (c + 1) % SECTIONS.length);
        if (key.return) {
          if (section.key === "export") {
            if (!exporting) void runExport();
            return;
          }
          if (section.key === "import") enterImportSection();
          setRowCursor(0);
          setEntryIndex(null);
          setInBullets(false);
          // Certifications is a flat list with no entry-detail level of
          // its own: it goes straight into the shared string-list
          // sub-view rather than sitting one level above it like the
          // other entry-list sections do.
          setStringListCtx(section.key === "certifications" ? { kind: "certifications" } : null);
          setStringListCursor(0);
          setMessage("");
          listOffsetRef.current = 0;
          setInSection(true);
        }
        return;
      }

      // ---- Import section ----
      if (section.key === "import") {
        if (importPreview) {
          if (key.escape) {
            setImportPreview(null);
            return;
          }
          if (input === "i" || key.return) {
            applyImport();
          }
          return;
        }
        if (key.escape) {
          setInSection(false);
          return;
        }
        if (key.upArrow || input === "k") return setRowCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || input === "j") return setRowCursor((c) => Math.min(importCandidates.length - 1, c + 1));
        if (input === "o") {
          try {
            openPath(resumesDir(root));
            setMessage(`Opened ${resumesDir(root)}: drag a resume PDF in, then press r to refresh this list.`);
            setMessageIsError(false);
          } catch (err) {
            setMessage(`Could not open the folder: ${helperError(err)}`);
            setMessageIsError(true);
          }
          return;
        }
        if (input === "r") {
          enterImportSection();
          return;
        }
        if (key.return && !importBusy) {
          const file = importCandidates[rowCursor];
          if (file) startImportPreview(file);
        }
        return;
      }

      // ---- Contact section ----
      if (section.key === "contact") {
        if (key.escape) {
          setInSection(false);
          return;
        }
        if (key.upArrow || input === "k") return setRowCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || input === "j") return setRowCursor((c) => Math.min(CONTACT_FIELDS.length - 1, c + 1));
        if (key.return) {
          const f = CONTACT_FIELDS[rowCursor]!;
          startEdit({ kind: "contact", field: f.key }, resume.contact[f.key]);
        }
        return;
      }

      // ---- String-list sub-view (Education details / Skills items / Certifications) ----
      if (stringListCtx) {
        const items = getStringList(stringListCtx);
        if (key.escape) {
          setStringListCtx(null);
          // Certifications has no entry-detail level above the string-list
          // (unlike education-details/skill-items, which back out to the
          // entry they belong to); escaping here means leaving the
          // section entirely, straight back to the section menu.
          if (stringListCtx.kind === "certifications") setInSection(false);
          return;
        }
        if (key.upArrow || input === "k") return setStringListCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || input === "j") return setStringListCursor((c) => Math.min(Math.max(0, items.length - 1), c + 1));
        if (input === "a") return startEdit({ kind: "string-list-item", itemIdx: "new" }, "");
        if (input === "x" && items.length > 0) {
          const next = items.filter((_, i) => i !== stringListCursor);
          setStringList(stringListCtx, next);
          setStringListCursor((c) => Math.min(c, Math.max(0, next.length - 1)));
          return;
        }
        if (input === "[" && stringListCursor > 0) {
          setStringList(stringListCtx, swap(items, stringListCursor, stringListCursor - 1));
          setStringListCursor((c) => c - 1);
          return;
        }
        if (input === "]" && stringListCursor < items.length - 1) {
          setStringList(stringListCtx, swap(items, stringListCursor, stringListCursor + 1));
          setStringListCursor((c) => c + 1);
          return;
        }
        if (key.return && items[stringListCursor] !== undefined) {
          startEdit({ kind: "string-list-item", itemIdx: stringListCursor }, items[stringListCursor]!);
        }
        return;
      }

      // ---- Bullets sub-view (Experience/Projects entry) ----
      if (inBullets && entryIndex !== null && isBulletSection) {
        const list = entrySectionKey === "experience" ? resume.experience : resume.projects;
        const entry = list[entryIndex];
        const bullets = entry?.bullets ?? [];
        if (key.escape) {
          setInBullets(false);
          return;
        }
        if (key.upArrow || input === "k") return setBulletCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || input === "j") return setBulletCursor((c) => Math.min(Math.max(0, bullets.length - 1), c + 1));
        if (input === "a")
          return startEdit({ kind: "bullet", section: entrySectionKey, entryIdx: entryIndex, bulletIdx: "new" }, "");
        if (input === "x" && bullets.length > 0) {
          const nextBullets = bullets.filter((_, i) => i !== bulletCursor);
          const nextEntry = { ...entry!, bullets: nextBullets };
          const nextList = list.map((e, i) => (i === entryIndex ? nextEntry : e));
          commit(
            entrySectionKey === "experience"
              ? { ...resume, experience: nextList as MasterResumeExperience[] }
              : { ...resume, projects: nextList as MasterResumeProject[] },
          );
          setBulletCursor((c) => Math.min(c, Math.max(0, nextBullets.length - 1)));
          return;
        }
        if (input === "[" && bulletCursor > 0) {
          const nextBullets = swap(bullets, bulletCursor, bulletCursor - 1);
          const nextEntry = { ...entry!, bullets: nextBullets };
          const nextList = list.map((e, i) => (i === entryIndex ? nextEntry : e));
          commit(
            entrySectionKey === "experience"
              ? { ...resume, experience: nextList as MasterResumeExperience[] }
              : { ...resume, projects: nextList as MasterResumeProject[] },
          );
          setBulletCursor((c) => c - 1);
          return;
        }
        if (input === "]" && bulletCursor < bullets.length - 1) {
          const nextBullets = swap(bullets, bulletCursor, bulletCursor + 1);
          const nextEntry = { ...entry!, bullets: nextBullets };
          const nextList = list.map((e, i) => (i === entryIndex ? nextEntry : e));
          commit(
            entrySectionKey === "experience"
              ? { ...resume, experience: nextList as MasterResumeExperience[] }
              : { ...resume, projects: nextList as MasterResumeProject[] },
          );
          setBulletCursor((c) => c + 1);
          return;
        }
        if (key.return && bullets[bulletCursor] !== undefined) {
          startEdit({ kind: "bullet", section: entrySectionKey, entryIdx: entryIndex, bulletIdx: bulletCursor }, bullets[bulletCursor]!.text);
        }
        return;
      }

      // ---- Entry detail (Education/Experience/Projects/Skills entry) ----
      if (entryIndex !== null) {
        const entry = entries[entryIndex];
        if (!entry) {
          setEntryIndex(null);
          return;
        }
        const fieldRows =
          entrySectionKey === "education"
            ? (["school", "degree", "location", "dates", "details"] as const)
            : entrySectionKey === "experience"
              ? (["title", "company", "location", "dates", "bullets"] as const)
              : entrySectionKey === "projects"
                ? (["name", "dates", "bullets"] as const)
                : (["category", "items"] as const);
        if (key.escape) {
          setEntryIndex(null);
          return;
        }
        if (key.upArrow || input === "k") return setDetailCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || input === "j") return setDetailCursor((c) => Math.min(fieldRows.length - 1, c + 1));
        if (key.return) {
          const rowKey = fieldRows[detailCursor];
          if (rowKey === "bullets") {
            setInBullets(true);
            setBulletCursor(0);
            return;
          }
          if (rowKey === "details") {
            setStringListCtx({ kind: "education-details", entryIdx: entryIndex });
            setStringListCursor(0);
            return;
          }
          if (rowKey === "items") {
            setStringListCtx({ kind: "skill-items", entryIdx: entryIndex });
            setStringListCursor(0);
            return;
          }
          if (entrySectionKey === "education") {
            const ed = entry as MasterResumeEducation;
            startEdit({ kind: "education-field", entryIdx: entryIndex, field: rowKey as "school" | "degree" | "location" | "dates" }, ed[rowKey as "school" | "degree" | "location" | "dates"]);
          } else if (entrySectionKey === "experience") {
            const ex = entry as MasterResumeExperience;
            startEdit({ kind: "experience-field", entryIdx: entryIndex, field: rowKey as "title" | "company" | "location" | "dates" }, ex[rowKey as "title" | "company" | "location" | "dates"]);
          } else if (entrySectionKey === "projects") {
            const p = entry as MasterResumeProject;
            startEdit({ kind: "project-field", entryIdx: entryIndex, field: rowKey as "name" | "dates" }, p[rowKey as "name" | "dates"]);
          } else {
            const s = entry as MasterResumeSkillGroup;
            startEdit({ kind: "skill-category", entryIdx: entryIndex }, s.category);
          }
        }
        return;
      }

      // ---- Entry list (Education/Experience/Projects/Skills) ----
      if (key.escape) {
        setInSection(false);
        return;
      }
      if (key.upArrow || input === "k") return setRowCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === "j") return setRowCursor((c) => Math.min(Math.max(0, entries.length - 1), c + 1));
      if (input === "a") {
        const blank =
          entrySectionKey === "education" ? emptyEducation()
          : entrySectionKey === "experience" ? emptyExperience()
          : entrySectionKey === "projects" ? emptyProject()
          : emptySkillGroup();
        const next = [...entries, blank];
        setEntries(next);
        setRowCursor(next.length - 1);
        setEntryIndex(next.length - 1);
        setDetailCursor(0);
        return;
      }
      if (input === "x" && entries.length > 0) {
        const next = entries.filter((_, i) => i !== rowCursor);
        setEntries(next);
        setRowCursor((c) => Math.min(c, Math.max(0, next.length - 1)));
        return;
      }
      if (input === "[" && rowCursor > 0) {
        setEntries(swap(entries, rowCursor, rowCursor - 1));
        setRowCursor((c) => c - 1);
        return;
      }
      if (input === "]" && rowCursor < entries.length - 1) {
        setEntries(swap(entries, rowCursor, rowCursor + 1));
        setRowCursor((c) => c + 1);
        return;
      }
      if (key.return && entries[rowCursor]) {
        setEntryIndex(rowCursor);
        setDetailCursor(0);
      }
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );

  // ---- Render ----

  const visibleRows = Math.max(3, contentRows - 10);
  const windowed = <T,>(items: T[], cursor: number): { items: T[]; offset: number; start: number } => {
    const maxOffset = Math.max(0, items.length - visibleRows);
    let offset = Math.min(listOffsetRef.current, maxOffset);
    if (items.length > visibleRows) {
      if (cursor < offset) offset = cursor;
      else if (cursor >= offset + visibleRows) offset = cursor - visibleRows + 1;
    } else {
      offset = 0;
    }
    listOffsetRef.current = offset;
    return { items: items.slice(offset, offset + visibleRows), offset, start: offset };
  };

  function Row({ label, focused, dim }: { label: string; focused: boolean; dim?: boolean }) {
    return (
      <Text color={dim ? undefined : focused ? theme.accent : undefined} bold={focused && !dim} dimColor={dim} wrap="truncate-end">
        {focused ? "> " : "  "}[{focused ? "x" : " "}] {label}
      </Text>
    );
  }

  function ScrollHints({ start, count, total }: { start: number; count: number; total: number }) {
    if (total <= count) return null;
    return (
      <>
        {start > 0 ? <Text dimColor>↑ {start} more</Text> : null}
        {start + count < total ? <Text dimColor>↓ {total - start - count} more</Text> : null}
      </>
    );
  }

  const EditPopup = editing ? (
    <Box marginTop={1} flexDirection="column">
      <Text color={theme.accent}>▲</Text>
      <Box flexDirection="column" borderStyle="double" borderColor={theme.accent} paddingX={1}>
        <InlineTextInput value={editValue} cursor={editCursor} active placeholder="(type here)" wrap="wrap" />
      </Box>
    </Box>
  ) : null;

  const MessageLine = message ? (
    <Box marginTop={1}>
      <Text color={messageIsError ? theme.danger : undefined} dimColor={!messageIsError}>
        {message}
      </Text>
    </Box>
  ) : null;

  // Section menu.
  if (!inSection) {
    return (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          Resume <Text dimColor>data/resumes/resume.json</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          {SECTIONS.map((s, i) => (
            <Row key={s.key} label={s.label} focused={i === sectionCursor} />
          ))}
        </Box>
        {MessageLine}
      </Box>
    );
  }

  // Import section.
  if (section.key === "import") {
    if (importPreview) {
      const lines = importPreview.text.split(/\r?\n/).slice(0, visibleRows);
      return (
        <Box flexDirection="column">
          <Text bold color={theme.accent}>
            Resume <Text dimColor>· Import · {importPreview.stem}</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor wrap="wrap">
              Using this replaces everything currently in your resume: review below, then press i to confirm.
            </Text>
            {lines.map((l, i) => (
              <Text key={i} dimColor wrap="truncate-end">
                {l || " "}
              </Text>
            ))}
          </Box>
          {MessageLine}
        </Box>
      );
    }
    const win = windowed(importCandidates, rowCursor);
    return (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          Resume <Text dimColor>· Import from an existing resume</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          {importCandidates.length === 0 ? (
            <Text dimColor wrap="wrap">
              No old resume files found in data/resumes/ to import from.
            </Text>
          ) : (
            <>
              <ScrollHints start={win.start} count={win.items.length} total={importCandidates.length} />
              {win.items.map((f, i) => (
                <Row key={f.stem} label={`${f.category ?? f.stem}${importBusy && win.start + i === rowCursor ? " (reading…)" : ""}`} focused={win.start + i === rowCursor} />
              ))}
            </>
          )}
        </Box>
        {MessageLine}
      </Box>
    );
  }

  // Contact section.
  if (section.key === "contact") {
    return (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          Resume <Text dimColor>· Contact</Text>
        </Text>
        {editing ? (
          <Text dimColor>Contact › {CONTACT_FIELDS[rowCursor]!.label}</Text>
        ) : (
          <Box marginTop={1} flexDirection="column">
            {CONTACT_FIELDS.map((f, i) => (
              <Box key={f.key}>
                <Row label={f.label} focused={i === rowCursor} />
                <Box flexGrow={1} />
                <Text dimColor wrap="truncate-end">
                  {resume.contact[f.key] || "(not set)"}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {EditPopup}
        {MessageLine}
      </Box>
    );
  }

  // String-list sub-view.
  if (stringListCtx) {
    const items = getStringList(stringListCtx);
    const win = windowed(items, stringListCursor);
    const title = stringListCtx.kind === "certifications" ? "Certifications & awards" : stringListCtx.kind === "skill-items" ? "Items" : "Details";
    return (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          Resume <Text dimColor>· {section.label} › {title}</Text>
        </Text>
        {editing ? (
          <Text dimColor>{title} › {editCtx?.kind === "string-list-item" && editCtx.itemIdx === "new" ? "new" : "edit"}</Text>
        ) : (
          <Box marginTop={1} flexDirection="column">
            {items.length === 0 ? <Text dimColor>Nothing yet: press a to add one.</Text> : null}
            <ScrollHints start={win.start} count={win.items.length} total={items.length} />
            {win.items.map((v, i) => (
              <Row key={win.start + i} label={v} focused={win.start + i === stringListCursor} />
            ))}
          </Box>
        )}
        {EditPopup}
        {MessageLine}
      </Box>
    );
  }

  // Bullets sub-view.
  if (inBullets && entryIndex !== null && isBulletSection) {
    const list = entrySectionKey === "experience" ? resume.experience : resume.projects;
    const entry = list[entryIndex];
    const bullets = entry?.bullets ?? [];
    const win = windowed(bullets, bulletCursor);
    return (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          Resume <Text dimColor>· {section.label} {entry ? `› ${entryLabel(entry)} ` : ""}› Bullets</Text>
        </Text>
        {editing ? (
          <Text dimColor>Bullets › {editCtx?.kind === "bullet" && editCtx.bulletIdx === "new" ? "new" : "edit"}</Text>
        ) : (
          <Box marginTop={1} flexDirection="column">
            {bullets.length === 0 ? <Text dimColor>No bullets yet: press a to add one.</Text> : null}
            <ScrollHints start={win.start} count={win.items.length} total={bullets.length} />
            {win.items.map((b, i) => (
              <Row key={b.id} label={b.text || "(empty)"} focused={win.start + i === bulletCursor} />
            ))}
          </Box>
        )}
        {EditPopup}
        {MessageLine}
      </Box>
    );
  }

  // Entry detail.
  if (entryIndex !== null) {
    const entry = entries[entryIndex];
    if (entry) {
      const rows: { key: string; label: string; value?: string }[] =
        entrySectionKey === "education"
          ? (() => {
              const ed = entry as MasterResumeEducation;
              return [
                { key: "school", label: "School", value: ed.school },
                { key: "degree", label: "Degree", value: ed.degree },
                { key: "location", label: "Location", value: ed.location },
                { key: "dates", label: "Dates", value: ed.dates },
                { key: "details", label: `Details (${ed.details.length})` },
              ];
            })()
          : entrySectionKey === "experience"
            ? (() => {
                const ex = entry as MasterResumeExperience;
                return [
                  { key: "title", label: "Title", value: ex.title },
                  { key: "company", label: "Company", value: ex.company },
                  { key: "location", label: "Location", value: ex.location },
                  { key: "dates", label: "Dates", value: ex.dates },
                  { key: "bullets", label: `Bullets (${ex.bullets.length})` },
                ];
              })()
            : entrySectionKey === "projects"
              ? (() => {
                  const p = entry as MasterResumeProject;
                  return [
                    { key: "name", label: "Name", value: p.name },
                    { key: "dates", label: "Dates", value: p.dates },
                    { key: "bullets", label: `Bullets (${p.bullets.length})` },
                  ];
                })()
              : (() => {
                  const s = entry as MasterResumeSkillGroup;
                  return [
                    { key: "category", label: "Category", value: s.category },
                    { key: "items", label: `Items (${s.items.length})` },
                  ];
                })();
      return (
        <Box flexDirection="column">
          <Text bold color={theme.accent}>
            Resume <Text dimColor>· {section.label} › {entryLabel(entry)}</Text>
          </Text>
          {editing ? (
            <Text dimColor>{entryLabel(entry)} › {rows[detailCursor]?.label}</Text>
          ) : (
            <Box marginTop={1} flexDirection="column">
              {rows.map((r, i) => (
                <Box key={r.key}>
                  <Row label={r.label} focused={i === detailCursor} />
                  {r.value !== undefined ? (
                    <>
                      <Box flexGrow={1} />
                      <Text dimColor wrap="truncate-end">
                        {r.value || "(not set)"}
                      </Text>
                    </>
                  ) : null}
                </Box>
              ))}
            </Box>
          )}
          {EditPopup}
          {MessageLine}
        </Box>
      );
    }
  }

  // Entry list.
  const win = windowed(entries, rowCursor);
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Resume <Text dimColor>· {section.label}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {entries.length === 0 ? <Text dimColor>Nothing yet: press a to add one.</Text> : null}
        <ScrollHints start={win.start} count={win.items.length} total={entries.length} />
        {win.items.map((e, i) => (
          <Row key={e.id} label={entryLabel(e)} focused={win.start + i === rowCursor} />
        ))}
      </Box>
      {MessageLine}
    </Box>
  );
}

export const RESUMES_HINTS = "↑↓ move · enter open · esc back";
export const RESUMES_PROMPT_HINTS = "↑↓ move · enter edit/open · a add · x delete · [ ] reorder · esc back";
