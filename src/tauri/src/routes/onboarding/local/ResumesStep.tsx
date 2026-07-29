import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listResumes, importResumeFile, convertResume } from "../../../lib/bridge";
import "../../../components/formFields.css";

export function ResumesStep({ root }: { root: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function refresh() {
    setFiles(await listResumes(root));
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

  return (
    <div>
      <p>
        Add at least one base resume — aplyx tailors a copy of it per application. PDFs work
        best; you can add more (per role type) any time from Resumes in Settings.
      </p>
      {files.length > 0 && (
        <ul style={{ margin: "1rem 0", paddingLeft: "1.25rem" }}>
          {files.map((f) => (
            <li key={f} className="check-detail">
              {f}
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
          You can skip this and add resumes later — aplyx won&rsquo;t apply anywhere without one.
        </p>
      )}
    </div>
  );
}
