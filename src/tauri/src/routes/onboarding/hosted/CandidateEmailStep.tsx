import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import "../../../components/formFields.css";

export function CandidateEmailStep({
  client,
  userId,
  fallbackEmail,
  onComplete,
}: {
  client: SupabaseClient;
  userId: string;
  fallbackEmail: string;
  onComplete: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    new SupabaseAdapter(client, userId)
      .readCandidateEmail()
      .then((email) => {
        if (!cancelled) setValue(email || fallbackEmail);
      })
      .catch(() => {
        if (!cancelled) setValue(fallbackEmail);
      });
    return () => { cancelled = true; };
  }, [client, userId, fallbackEmail]);

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      await new SupabaseAdapter(client, userId).writeCandidateEmail(value);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <p>
        This is the email employers and gated ATS systems like Workday will use to contact you.
        aplyx will only watch this inbox during verification windows for hosted application flows.
      </p>
      <div className="field">
        <label className="field-label" htmlFor="candidate-email">Candidate email</label>
        <input
          id="candidate-email"
          type="email"
          placeholder="you@example.com"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
        <p className="field-help">Use the real inbox you want employers to keep using after the application is submitted.</p>
      </div>
      {error && <p className="field-help" style={{ color: "var(--danger)" }}>{error}</p>}
      <button type="button" className="wizard-next" disabled={saving || !value.trim()} onClick={() => void save()}>
        {saving ? "Saving…" : "Continue"}
      </button>
    </div>
  );
}
