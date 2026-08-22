import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAdapter, type HostedReadiness } from "@aplyx/core/adapters/supabase.js";
import "../../../components/formFields.css";

function Row({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="check-row">
      <span className={`check-icon ${ok ? "check-icon-ok" : "check-icon-pending"}`}>{ok ? "✓" : "–"}</span>
      <div style={{ flex: 1 }}>
        <div className="check-label">{label}</div>
        <div className="check-detail">{detail}</div>
      </div>
    </div>
  );
}

export function HostedReadinessStep({
  client,
  userId,
  onComplete,
}: {
  client: SupabaseClient;
  userId: string;
  onComplete: () => void;
}) {
  const [readiness, setReadiness] = useState<HostedReadiness | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    new SupabaseAdapter(client, userId).readHostedReadiness()
      .then((value) => { if (!cancelled) setReadiness(value); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [client, userId]);

  const ready = Boolean(readiness?.hasCandidateEmail && readiness?.resumeUploaded && readiness?.inboxConnected);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <p>Before hosted automation is enabled, confirm the required setup below.</p>
      <Row ok={Boolean(readiness?.hasCandidateEmail)} label="Candidate email" detail={readiness?.candidateEmail || "Choose the real email employers should use to contact you."} />
      <Row ok={Boolean(readiness?.resumeUploaded)} label="Resume" detail={readiness?.resumeUploaded ? "A hosted resume is uploaded and ready." : "Upload your master resume before finishing hosted setup."} />
      <Row ok={Boolean(readiness?.inboxConnected)} label="Inbox connection" detail={readiness?.inboxConnected ? `Connected via ${readiness?.inboxProvider}.` : "Hosted plans require inbox access for gated ATS verification."} />
      {error && <p className="field-help" style={{ color: "var(--danger)" }}>{error}</p>}
      <button type="button" className="wizard-next" disabled={!ready} onClick={onComplete}>
        Finish hosted setup
      </button>
      {!ready && <p className="field-help">Finish the required steps above to complete hosted setup.</p>}
    </div>
  );
}
