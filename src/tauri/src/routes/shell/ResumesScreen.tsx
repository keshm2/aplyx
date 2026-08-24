import { useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type {
  MasterResume,
  MasterResumeContact,
  MasterResumeEducation,
  MasterResumeExperience,
  MasterResumeProject,
  MasterResumeSkillGroup,
} from "@aplyx/core/masterResume.js";
import { reflowExtractedResumeText } from "@aplyx/core/masterResume.js";
import type { ResumeFile } from "@aplyx/core/resumes.js";
import {
  findRoot,
  getMasterResume,
  setMasterResume,
  readResumeMarkdown,
  importMasterResumeFromMarkdown,
  importResumeFile,
  exportResumePdf,
  listResumeDetails,
  convertResume,
  openResumesFolder,
} from "../../lib/bridge";
import { BulletListEditor } from "../../components/BulletListEditor";
import { PreviewResumePanel } from "./PreviewResumePanel";
import { Modal } from "../../components/Modal";
import "../../components/formFields.css";
import "../../components/dataList.css";
import "./ResumesScreen.css";

/** One generic resume the operator maintains here — aplyx tailors a copy
 *  of it per application rather than picking among several pre-written
 *  category files (the old model). Contact prefills from safe_fields;
 *  everything else starts empty and grows through this editor, or via
 *  "Import from an existing resume" if base_resume_*.md/.pdf files are
 *  already sitting in data/resumes/ from the old system. */
export function ResumesScreen() {
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [resume, setResume] = useState<MasterResume | undefined>(undefined);
  const [savedResume, setSavedResume] = useState<MasterResume | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastExported, setLastExported] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);

  const [importCandidates, setImportCandidates] = useState<ResumeFile[]>([]);
  const [importBusy, setImportBusy] = useState<string | undefined>(undefined);
  const [importPreview, setImportPreview] = useState<{ stem: string; text: string } | undefined>(undefined);
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [overwriteConfirm, setOverwriteConfirm] = useState<{ selected: string; stem: string } | undefined>(undefined);

  useEffect(() => {
    findRoot()
      .then(async (r) => {
        setRoot(r);
        const { resume: loadedResume, isNew } = await getMasterResume(r);
        setResume(loadedResume);
        setSavedResume(loadedResume);
        if (isNew) {
          const files = (await listResumeDetails(r)).filter((f) => f.hasMarkdown || f.hasPdf);
          setImportCandidates(files);
          setShowImportPanel(files.length > 0);
        }
      })
      .catch(() => {
        // No local install connected — the screen below already handles
        // `root` staying undefined with its own message.
      })
      .finally(() => setLoaded(true));
  }, []);

  const dirty = useMemo(() => JSON.stringify(resume) !== JSON.stringify(savedResume), [resume, savedResume]);

  const save = async () => {
    if (!root || !resume) return;
    setSaving(true);
    setMessage(undefined);
    try {
      await setMasterResume(root, resume);
      setSavedResume(resume);
      setMessage({ text: "Saved." });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setSaving(false);
    }
  };

  const exportPdf = async () => {
    if (!root || !resume) return;
    setExporting(true);
    setMessage(undefined);
    setLastExported(false);
    try {
      const result = await exportResumePdf(root, resume);
      if (!result.ok) {
        setMessage({ text: `Export failed: ${result.error}`, error: true });
        return;
      }
      const notesText = result.notes && result.notes.length > 0
        ? ` (${result.notes.length} bullet${result.notes.length === 1 ? "" : "s"}/entries shortened to fit one page — export only, your saved resume is unchanged)`
        : "";
      setMessage({ text: `Exported to data/resumes/resume.pdf.${notesText}` });
      setLastExported(true);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setExporting(false);
    }
  };

  const startImportPreview = async (file: ResumeFile) => {
    if (!root) return;
    setImportBusy(file.stem);
    setMessage(undefined);
    try {
      if (!file.hasMarkdown) {
        const result = await convertResume(root, file.stem);
        if (!result.ok) {
          setMessage({ text: `Could not read ${file.stem}.pdf: ${result.error}`, error: true });
          return;
        }
      }
      const text = await readResumeMarkdown(root, file.stem);
      if (!text) {
        setMessage({ text: `${file.stem} has no readable text.`, error: true });
        return;
      }
      setImportPreview({ stem: file.stem, text: reflowExtractedResumeText(text) });
    } finally {
      setImportBusy(undefined);
    }
  };

  const applyImport = async () => {
    if (!root || !importPreview) return;
    const imported = await importMasterResumeFromMarkdown(root, importPreview.text);
    setResume(imported);
    setImportPreview(undefined);
    setShowImportPanel(false);
    setMessage({ text: `Imported from ${importPreview.stem} — review everything below, then Save.` });
  };

  // Picks a new PDF from anywhere on disk and previews it through the
  // same import flow as the legacy-file panel above — a permanent
  // action, unlike the onboarding wizard's "Choose a PDF…" step (which
  // this reuses the same importResumeFile bridge call as), so updating
  // to a newer resume doesn't require starting over from scratch.
  // Reuses the existing preview-then-confirm step rather than replacing
  // anything immediately, so a bad pick can't silently clobber a saved
  // resume.
  //
  // A pick whose derived stem already exists on disk doesn't proceed
  // straight to conversion — convert_resume.py refuses to overwrite an
  // existing .md without --force, which used to surface as an opaque
  // "already exists" error and no preview at all (a real reported bug:
  // re-uploading the same filename silently did nothing). Now it's a
  // real warn-then-confirm step instead, before anything on disk changes.
  const uploadNewResume = async () => {
    if (!root) return;
    setMessage(undefined);
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Resume (PDF)", extensions: ["pdf"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    const filename = selected.split(/[/\\]/).pop() ?? "resume.pdf";
    const stem = filename.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "_") || "resume";
    const existing = await listResumeDetails(root);
    const collision = existing.find((f) => f.stem === stem && (f.hasPdf || f.hasMarkdown));
    if (collision) {
      setOverwriteConfirm({ selected, stem });
      return;
    }
    await runResumeUpload(selected, stem, false);
  };

  const runResumeUpload = async (selected: string, stem: string, force: boolean) => {
    if (!root) return;
    setImportBusy(stem);
    try {
      await importResumeFile(root, selected, stem);
      const result = await convertResume(root, stem, "", force);
      if (!result.ok) {
        setMessage({ text: `Could not read ${stem}.pdf: ${result.error}`, error: true });
        return;
      }
      const text = await readResumeMarkdown(root, stem);
      if (!text) {
        setMessage({ text: `${stem} has no readable text.`, error: true });
        return;
      }
      setImportPreview({ stem, text: reflowExtractedResumeText(text) });
      setShowImportPanel(true);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setImportBusy(undefined);
    }
  };

  if (loaded && !root) {
    return (
      <div style={{ maxWidth: "44rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Resume</h1>
        <p className="field-help">
          This editor needs a local install (Settings) to parse and tailor your resume field by field. Without one,
          you can still upload or replace the resume file itself from the Resume section in Settings.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "52rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div className="resume-topbar">
        <div>
          <h1 style={{ fontSize: "var(--text-3xl)", marginBottom: "var(--space-2)" }}>Resume</h1>
          <p style={{ color: "var(--text-muted)" }}>
            One resume aplyx tailors per job — add your jobs, projects, and skills once here.
          </p>
        </div>
        {resume ? (
          <div className="resume-topbar-actions">
            {dirty ? <span className="field-help">Unsaved changes</span> : null}
            <button type="button" className="btn btn-sm" disabled={importBusy !== undefined} onClick={() => void uploadNewResume()}>
              {importBusy !== undefined ? "Reading…" : "Upload new resume"}
            </button>
            <button type="button" className="btn btn-sm" disabled={exporting} onClick={() => void exportPdf()}>
              {exporting ? "Exporting…" : "Export PDF"}
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
      </div>

      {message ? (
        <div className={message.error ? "message-banner message-banner-error" : "message-banner"}>
          {message.text}
          {lastExported && root ? (
            <button type="button" className="btn btn-sm" style={{ marginLeft: "var(--space-3)" }} onClick={() => void openResumesFolder(root)}>
              Open folder
            </button>
          ) : null}
        </div>
      ) : null}

      {!loaded || !resume ? (
        <p className="field-help">Loading&hellip;</p>
      ) : (
        <>
          {importCandidates.length > 0 || importPreview ? (
            <section className="resume-section">
              <div className="resume-import-header">
                <h2 style={{ fontSize: "var(--text-lg)" }}>Import from an existing resume</h2>
                {importCandidates.length > 0 ? (
                  <button type="button" className="btn btn-sm" onClick={() => setShowImportPanel((v) => !v)}>
                    {showImportPanel ? "Hide" : "Show"}
                  </button>
                ) : null}
              </div>
              {showImportPanel || importPreview ? (
                importPreview ? (
                  <div className="resume-import-preview">
                    <p className="field-help">
                      Extracted and auto-reformatted from <strong>{importPreview.stem}</strong> — PDF text extraction
                      doesn't preserve headings or bullet styling, so this is a best-effort cleanup, not the original
                      layout. Edit it directly below (section headers as <code>## Name</code>, entries as{" "}
                      <code>### Title — Company, Location</code> with bullets as <code>- text</code>) before using it
                      as a starting point — this replaces everything currently in the editor below.
                    </p>
                    <textarea
                      className="resume-import-text resume-import-textarea"
                      value={importPreview.text}
                      onChange={(e) => setImportPreview({ stem: importPreview.stem, text: e.target.value })}
                      rows={22}
                      spellCheck={false}
                    />
                    <div className="detail-actions">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void applyImport()}>
                        Use as starting point
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => setImportPreview(undefined)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="resume-import-list">
                    <p className="field-help">
                      Found existing resume files from the old category system — pick one to pull its content into this
                      editor as a starting draft.
                    </p>
                    {importCandidates.map((f) => (
                      <button
                        key={f.stem}
                        type="button"
                        className="option-card"
                        disabled={importBusy === f.stem}
                        onClick={() => void startImportPreview(f)}
                      >
                        <span className="option-card-title">{f.category ?? f.stem}</span>
                        <span className="option-card-detail">{importBusy === f.stem ? "Reading…" : f.stem}</span>
                      </button>
                    ))}
                  </div>
                )
              ) : null}
            </section>
          ) : null}

          <ContactSection contact={resume.contact} onChange={(contact) => setResume({ ...resume, contact })} />
          <EducationSection education={resume.education} onChange={(education) => setResume({ ...resume, education })} />
          <ExperienceSection experience={resume.experience} onChange={(experience) => setResume({ ...resume, experience })} />
          <ProjectsSection projects={resume.projects} onChange={(projects) => setResume({ ...resume, projects })} />
          <SkillsSection skills={resume.skills} onChange={(skills) => setResume({ ...resume, skills })} />
          <CertificationsSection
            certifications={resume.certifications}
            onChange={(certifications) => setResume({ ...resume, certifications })}
          />

          {root ? <PreviewResumePanel root={root} resume={resume} /> : null}
        </>
      )}

      <Modal
        open={overwriteConfirm !== undefined}
        onClose={() => setOverwriteConfirm(undefined)}
        title="Replace existing resume file?"
      >
        <p className="field-help">
          A resume named <strong>{overwriteConfirm?.stem}</strong> already exists in data/resumes/. Uploading this
          file will overwrite it — the old PDF and its extracted text are replaced, not kept alongside it.
        </p>
        <div className="detail-actions" style={{ marginTop: "var(--space-3)" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (!overwriteConfirm) return;
              const { selected, stem } = overwriteConfirm;
              setOverwriteConfirm(undefined);
              void runResumeUpload(selected, stem, true);
            }}
          >
            Overwrite
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setOverwriteConfirm(undefined)}>
            Cancel
          </button>
        </div>
      </Modal>
    </div>
  );
}

function ContactSection({ contact, onChange }: { contact: MasterResumeContact; onChange: (c: MasterResumeContact) => void }) {
  const field = (key: keyof MasterResumeContact, label: string, placeholder?: string) => (
    <div className="field">
      <label className="field-label">{label}</label>
      <input
        type="text"
        value={contact[key]}
        placeholder={placeholder}
        onChange={(e) => onChange({ ...contact, [key]: e.currentTarget.value })}
      />
    </div>
  );

  return (
    <section className="resume-section">
      <h2 style={{ fontSize: "var(--text-lg)" }}>Contact</h2>
      <div className="resume-grid-2">
        {field("name", "Name")}
        {field("email", "Email")}
        {field("phone", "Phone")}
        {field("location", "Location", "City, ST")}
        {field("linkedin_url", "LinkedIn", "linkedin.com/in/…")}
        {field("github_url", "GitHub", "github.com/…")}
      </div>
    </section>
  );
}

function EducationSection({
  education,
  onChange,
}: {
  education: MasterResumeEducation[];
  onChange: (education: MasterResumeEducation[]) => void;
}) {
  const update = (id: string, patch: Partial<MasterResumeEducation>) =>
    onChange(education.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const remove = (id: string) => onChange(education.filter((e) => e.id !== id));
  const add = () =>
    onChange([...education, { id: crypto.randomUUID(), school: "", degree: "", location: "", dates: "", details: [] }]);

  return (
    <section className="resume-section">
      <h2 style={{ fontSize: "var(--text-lg)" }}>Education</h2>
      <div className="resume-entry-list">
        {education.map((edu) => (
          <div key={edu.id} className="resume-entry-card">
            <div className="resume-entry-card-header">
              <input
                className="resume-entry-title-input"
                placeholder="School"
                value={edu.school}
                onChange={(e) => update(edu.id, { school: e.currentTarget.value })}
              />
              <button type="button" className="resume-entry-delete" aria-label="Delete education entry" onClick={() => remove(edu.id)}>
                ×
              </button>
            </div>
            <div className="resume-grid-3">
              <input placeholder="Degree" value={edu.degree} onChange={(e) => update(edu.id, { degree: e.currentTarget.value })} />
              <input placeholder="Location" value={edu.location} onChange={(e) => update(edu.id, { location: e.currentTarget.value })} />
              <input placeholder="Dates" value={edu.dates} onChange={(e) => update(edu.id, { dates: e.currentTarget.value })} />
            </div>
            <textarea
              className="resume-entry-details"
              placeholder="Extra details, one per line — e.g. Relevant Coursework: …"
              rows={2}
              value={edu.details.join("\n")}
              onChange={(e) => update(edu.id, { details: e.currentTarget.value.split("\n") })}
            />
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={add}>
          + Add education
        </button>
      </div>
    </section>
  );
}

function ExperienceSection({
  experience,
  onChange,
}: {
  experience: MasterResumeExperience[];
  onChange: (experience: MasterResumeExperience[]) => void;
}) {
  const update = (id: string, patch: Partial<MasterResumeExperience>) =>
    onChange(experience.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const remove = (id: string) => onChange(experience.filter((e) => e.id !== id));
  const add = () =>
    onChange([
      ...experience,
      { id: crypto.randomUUID(), title: "", company: "", location: "", dates: "", bullets: [] },
    ]);

  return (
    <section className="resume-section">
      <h2 style={{ fontSize: "var(--text-lg)" }}>Experience</h2>
      <div className="resume-entry-list">
        {experience.map((exp) => (
          <div key={exp.id} className="resume-entry-card">
            <div className="resume-entry-card-header">
              <input
                className="resume-entry-title-input"
                placeholder="Job title"
                value={exp.title}
                onChange={(e) => update(exp.id, { title: e.currentTarget.value })}
              />
              <button type="button" className="resume-entry-delete" aria-label="Delete experience entry" onClick={() => remove(exp.id)}>
                ×
              </button>
            </div>
            <div className="resume-grid-3">
              <input placeholder="Company" value={exp.company} onChange={(e) => update(exp.id, { company: e.currentTarget.value })} />
              <input placeholder="Location" value={exp.location} onChange={(e) => update(exp.id, { location: e.currentTarget.value })} />
              <input placeholder="Dates" value={exp.dates} onChange={(e) => update(exp.id, { dates: e.currentTarget.value })} />
            </div>
            <BulletListEditor bullets={exp.bullets} onChange={(bullets) => update(exp.id, { bullets })} />
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={add}>
          + Add job
        </button>
      </div>
    </section>
  );
}

function ProjectsSection({
  projects,
  onChange,
}: {
  projects: MasterResumeProject[];
  onChange: (projects: MasterResumeProject[]) => void;
}) {
  const update = (id: string, patch: Partial<MasterResumeProject>) =>
    onChange(projects.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id: string) => onChange(projects.filter((p) => p.id !== id));
  const add = () => onChange([...projects, { id: crypto.randomUUID(), name: "", dates: "", bullets: [] }]);

  return (
    <section className="resume-section">
      <h2 style={{ fontSize: "var(--text-lg)" }}>Projects</h2>
      <div className="resume-entry-list">
        {projects.map((proj) => (
          <div key={proj.id} className="resume-entry-card">
            <div className="resume-entry-card-header">
              <input
                className="resume-entry-title-input"
                placeholder="Project name"
                value={proj.name}
                onChange={(e) => update(proj.id, { name: e.currentTarget.value })}
              />
              <button type="button" className="resume-entry-delete" aria-label="Delete project" onClick={() => remove(proj.id)}>
                ×
              </button>
            </div>
            <input
              placeholder="Dates (e.g. 2026 – Present)"
              value={proj.dates}
              onChange={(e) => update(proj.id, { dates: e.currentTarget.value })}
            />
            <BulletListEditor bullets={proj.bullets} onChange={(bullets) => update(proj.id, { bullets })} />
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={add}>
          + Add project
        </button>
      </div>
    </section>
  );
}

function SkillsSection({
  skills,
  onChange,
}: {
  skills: MasterResumeSkillGroup[];
  onChange: (skills: MasterResumeSkillGroup[]) => void;
}) {
  const update = (id: string, patch: Partial<MasterResumeSkillGroup>) =>
    onChange(skills.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const remove = (id: string) => onChange(skills.filter((s) => s.id !== id));
  const add = () => onChange([...skills, { id: crypto.randomUUID(), category: "", items: [] }]);

  return (
    <section className="resume-section">
      <h2 style={{ fontSize: "var(--text-lg)" }}>Skills</h2>
      <div className="resume-entry-list">
        {skills.map((group) => (
          <div key={group.id} className="resume-entry-card">
            <div className="resume-entry-card-header">
              <input
                className="resume-entry-title-input"
                placeholder="Category (e.g. Languages)"
                value={group.category}
                onChange={(e) => update(group.id, { category: e.currentTarget.value })}
              />
              <button type="button" className="resume-entry-delete" aria-label="Delete skill category" onClick={() => remove(group.id)}>
                ×
              </button>
            </div>
            <input
              placeholder="Comma-separated skills"
              value={group.items.join(", ")}
              onChange={(e) =>
                update(group.id, {
                  items: e.currentTarget.value.split(",").map((s) => s.trim()).filter(Boolean),
                })
              }
            />
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={add}>
          + Add skill category
        </button>
      </div>
    </section>
  );
}

function CertificationsSection({
  certifications,
  onChange,
}: {
  certifications: string[];
  onChange: (certifications: string[]) => void;
}) {
  const update = (index: number, text: string) => onChange(certifications.map((c, i) => (i === index ? text : c)));
  const remove = (index: number) => onChange(certifications.filter((_, i) => i !== index));
  const add = () => onChange([...certifications, ""]);

  return (
    <section className="resume-section">
      <h2 style={{ fontSize: "var(--text-lg)" }}>Certifications &amp; awards</h2>
      <div className="resume-entry-list">
        {certifications.map((cert, i) => (
          <div key={i} className="resume-cert-row">
            <input
              value={cert}
              placeholder="e.g. Cisco Certified Network Associate (CCNA)"
              onChange={(e) => update(i, e.currentTarget.value)}
            />
            <button type="button" className="resume-entry-delete" aria-label="Delete certification" onClick={() => remove(i)}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={add}>
          + Add certification
        </button>
      </div>
    </section>
  );
}
