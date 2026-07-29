import { useEffect, useState } from "react";
import type { ResumeFile } from "@aplyx/core/resumes.js";
import { findRoot, listResumeDetails, openResumesFolder, convertResume } from "../../lib/bridge";
import "../../components/formFields.css";
import "../../components/dataList.css";

export function ResumesScreen() {
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [files, setFiles] = useState<ResumeFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [converting, setConverting] = useState<string | undefined>(undefined);
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(undefined);

  const refresh = async (r: string) => {
    setFiles(await listResumeDetails(r));
  };

  useEffect(() => {
    findRoot()
      .then(async (r) => {
        setRoot(r);
        await refresh(r);
      })
      .catch(() => setFiles([]))
      .finally(() => setLoaded(true));
  }, []);

  // Land on the first resume rather than a blank detail pane.
  useEffect(() => {
    if (files.length > 0 && !files.some((f) => f.stem === selected)) setSelected(files[0]!.stem);
  }, [files, selected]);

  const selectedFile = files.find((f) => f.stem === selected);
  const pendingCount = files.filter((f) => f.needsConversion).length;

  const openFolder = async () => {
    if (!root) return;
    try {
      await openResumesFolder(root);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };

  const startConvert = (stem: string) => {
    setConverting(stem);
    setDescription("");
    setMessage(undefined);
  };

  const runConvert = async () => {
    if (!root || !converting) return;
    const stem = converting;
    setConverting(undefined);
    setMessage({ text: `Converting ${stem}.pdf…` });
    const result = await convertResume(root, stem, description.trim());
    if (result.ok) {
      setMessage({ text: `Converted — wrote ${stem}.md.` });
    } else {
      setMessage({ text: `Conversion failed: ${result.error}`, error: true });
    }
    await refresh(root);
  };

  const rowStatus = (f: ResumeFile): { className: string; text: string } => {
    if (f.hasMarkdown) {
      return { className: "status-badge-good", text: f.description ? `Ready — "${f.description}"` : "Ready" };
    }
    if (f.needsConversion) return { className: "status-badge-warn", text: "PDF found — needs conversion" };
    return { className: "status-badge-muted", text: "Not added yet" };
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div>
        <h1 style={{ fontSize: "var(--text-3xl)", marginBottom: "var(--space-2)" }}>Resumes</h1>
        <div className="data-toolbar">
          <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            {pendingCount > 0 ? `${pendingCount} need${pendingCount === 1 ? "s" : ""} conversion` : "data/resumes/"}
          </span>
          <div className="data-toolbar-spacer" />
          <button type="button" className="btn btn-sm" onClick={() => void openFolder()}>
            Open folder
          </button>
        </div>
      </div>

      {message ? (
        <div className={message.error ? "message-banner message-banner-error" : "message-banner"}>{message.text}</div>
      ) : null}

      <div className="data-screen">
        <div className="data-list-col">
          {!loaded ? (
            <div className="data-empty">Loading…</div>
          ) : files.length === 0 ? (
            <div className="data-empty">No resumes found — add a PDF to data/resumes/ to get started.</div>
          ) : (
            <div className="data-list">
              {files.map((f) => {
                const status = rowStatus(f);
                return (
                  <button
                    key={f.stem}
                    type="button"
                    className={f.stem === selected ? "data-row selected" : "data-row"}
                    onClick={() => {
                      setSelected(f.stem);
                      if (converting && converting !== f.stem) setConverting(undefined);
                    }}
                  >
                    <div className="data-row-main">
                      <span className="data-row-title">{f.category ?? f.stem}</span>
                      <span className="data-row-sub">{f.stem}</span>
                    </div>
                    <span className={`status-badge ${status.className}`}>{status.text}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedFile ? (
          <div className="detail-col">
            <div className="detail-title">{selectedFile.category ?? selectedFile.stem}</div>
            <div className="detail-row">
              <span className="detail-row-label">File</span>
              <span className="detail-row-value">{selectedFile.stem}</span>
            </div>
            <div className="detail-row">
              <span className="detail-row-label">Status</span>
              <span className={`status-badge ${rowStatus(selectedFile).className}`} style={{ alignSelf: "flex-start" }}>
                {rowStatus(selectedFile).text}
              </span>
            </div>
            <hr className="detail-rule" />

            {converting === selectedFile.stem ? (
              <>
                <p className="field-help">
                  What's this resume for? Optional — helps tell arbitrarily-named resumes apart later.
                </p>
                <div className="field">
                  <input
                    type="text"
                    autoFocus
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g. Backend-focused"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void runConvert();
                      if (e.key === "Escape") setConverting(undefined);
                    }}
                  />
                </div>
                <div className="detail-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void runConvert()}>
                    Convert
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setConverting(undefined)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="detail-actions">
                {selectedFile.needsConversion ? (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => startConvert(selectedFile.stem)}>
                    Convert to markdown
                  </button>
                ) : selectedFile.hasMarkdown ? (
                  <button type="button" className="btn btn-sm" onClick={() => startConvert(selectedFile.stem)}>
                    Re-convert
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {root ? <p className="field-help">Folder: {root}/data/resumes</p> : null}
    </div>
  );
}
