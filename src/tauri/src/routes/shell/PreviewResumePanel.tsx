import { useState } from "react";
import type { MasterResume } from "@aplyx/core/masterResume.js";
import { previewTailoredResume, type PreviewTailoredResumeResult } from "../../lib/bridge";

/**
 * "Preview against a job description": shows what @resume-tailor
 * (including the new humanizer skill pass, src/agents/skills/humanizer/
 * SKILL.md) would actually produce for a given title + JD, without
 * applying anywhere. Runs against `resume` as it currently stands in the
 * editor above (including unsaved edits, same as Export PDF); nothing
 * here is saved, nothing here touches a real application.
 */
export function PreviewResumePanel({ root, resume }: { root: string; resume: MasterResume }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [jdText, setJdText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreviewTailoredResumeResult | undefined>(undefined);

  const canPreview = title.trim().length > 0 && jdText.trim().length > 0 && !busy;

  const runPreview = async () => {
    if (!canPreview) return;
    setBusy(true);
    setResult(undefined);
    try {
      const r = await previewTailoredResume(root, title.trim(), company.trim(), jdText.trim(), resume);
      setResult(r);
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="resume-section">
      <div className="resume-import-header">
        <div>
          <h2 style={{ fontSize: "var(--text-lg)" }}>Preview against a job description</h2>
          <p className="field-help">
            See what tailoring + humanizing would produce for a specific role, nothing is saved or applied. Runs
            through your configured coding-agent harness, same as a real application; can take a couple of minutes.
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", marginTop: "var(--space-3)" }}>
          <div className="resume-grid-2">
            <div className="field">
              <label className="field-label">Job title</label>
              <input
                type="text"
                value={title}
                placeholder="e.g. Backend Software Engineer Intern"
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
            </div>
            <div className="field">
              <label className="field-label">Company (optional)</label>
              <input
                type="text"
                value={company}
                placeholder="e.g. Acme Corp"
                onChange={(e) => setCompany(e.currentTarget.value)}
              />
            </div>
          </div>

          <div className="field">
            <label className="field-label">Job description</label>
            <textarea
              rows={8}
              value={jdText}
              placeholder="Paste the full job description text here"
              onChange={(e) => setJdText(e.currentTarget.value)}
            />
          </div>

          <div className="detail-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={!canPreview} onClick={() => void runPreview()}>
              {busy ? "Tailoring + humanizing…" : "Generate preview"}
            </button>
          </div>

          {result && !result.ok ? (
            <div className="message-banner message-banner-error">{result.error}</div>
          ) : null}

          {result?.ok ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <div className="resume-grid-3" style={{ alignItems: "start" }}>
                <div className="field">
                  <label className="field-label">Tailoring emphasis</label>
                  <p>{result.resume_used || "N/A"}</p>
                </div>
                <div className="field">
                  <label className="field-label">ATS score</label>
                  <p>{typeof result.ats_score === "number" ? `${result.ats_score}/100` : "N/A"}</p>
                </div>
                <div className="field">
                  <label className="field-label">Missing keywords</label>
                  <p>{result.missing_keywords && result.missing_keywords.length > 0 ? result.missing_keywords.join(", ") : "None"}</p>
                </div>
              </div>

              <div className="field">
                <label className="field-label">Tailored + humanized bullets</label>
                <pre className="resume-import-text">
                  {(result.tailored_bullets ?? []).map((b: string) => `- ${b}`).join("\n") || "(no bullets returned)"}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
