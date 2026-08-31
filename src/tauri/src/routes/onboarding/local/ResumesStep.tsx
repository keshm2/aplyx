import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { ResumeFile } from "@aplyx/core/resumes.js";
import { listResumeDetails, importResumeFile, convertResume, setResumeDescription } from "../../../lib/bridge";
import "../../../components/formFields.css";

/** Descriptions are keyed by stem, saved on blur (or Enter) via
 *  setResumeDescription: a plain, best-effort "what roles does this
 *  target" label. Most useful right here: a freshly-imported PDF's stem
 *  comes straight from its original filename (sanitized), so uploading
 *  two generically-named resumes ("resume.pdf", "resume (1).pdf") gives
 *  resolve_resume.py nothing to go on by name alone; see
 *  src/scripts/state/resolve_resume.py's own docstring for how it uses
 *  this description once resume-tailor.md asks it to resolve a category. */
export function ResumesStep({ root }: { root: string }) {
  const [files, setFiles] = useState<ResumeFile[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  async function refresh() {
    const details = await listResumeDetails(root);
    setFiles(details);
    setDrafts((prev) => {
      const next = { ...prev };
      for (const f of details) if (!(f.stem in next)) next[f.stem] = f.description ?? "";
      return next;
    });
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  async function handleImport() {
    setError(undefined);
    const selected = await open({
      multiple: false,
      filters: [{ name: "Resume (PDF)", extensions: ["pdf"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    const filename = selected.split(/[/\\]/).pop() ?? "resume.pdf";
    const stem = filename.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "_") || "general";
    setImporting(true);
    try {
      await importResumeFile(root, selected, stem);
      const result = await convertResume(root, stem);
      if (!result.ok) setError(result.error ?? "Import succeeded, but text extraction failed.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function saveDescription(stem: string) {
    const description = (drafts[stem] ?? "").trim();
    if (description === (files.find((f) => f.stem === stem)?.description ?? "")) return;
    await setResumeDescription(root, stem, description);
    await refresh();
  }

  return (
    <div>
      <p>
        Add at least one base resume. aplyx tailors a copy of it per application. PDFs work
        best; you can add more (per role type) any time from Resumes in Settings.
      </p>
      {files.length > 0 && (
        <ul style={{ margin: "1rem 0", paddingLeft: 0, listStyle: "none" }}>
          {files.map((f) => (
            <li key={f.stem} className="check-detail" style={{ marginBottom: "0.6rem" }}>
              <div>{f.stem}</div>
              <input
                type="text"
                value={drafts[f.stem] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.stem]: e.target.value }))}
                onBlur={() => void saveDescription(f.stem)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveDescription(f.stem);
                }}
                placeholder='What roles is this for? Optional, e.g. "backend + cloud infra roles"'
                style={{ marginTop: "0.25rem", width: "100%" }}
              />
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="wizard-next" onClick={handleImport} disabled={importing}>
        {importing ? "Importing…" : "Choose a PDF…"}
      </button>
      {error && (
        <p className="field-help" style={{ color: "var(--danger)", marginTop: "0.5rem" }}>
          {error}
        </p>
      )}
      {files.length === 0 && (
        <p className="field-help" style={{ marginTop: "0.75rem" }}>
          You can skip this and add resumes later, but aplyx won&rsquo;t apply anywhere without one.
        </p>
      )}
    </div>
  );
}
