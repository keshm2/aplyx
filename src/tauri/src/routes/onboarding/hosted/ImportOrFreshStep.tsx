import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { FIELD_IDS } from "@aplyx/core/onboarding/fields.js";
import { hasLocalInstall, findRoot, readProfileField, readOnboardingCompleted } from "../../../lib/bridge";
import "../../../components/formFields.css";

export function ImportOrFreshStep({
  client,
  userId,
  onDone,
}: {
  client: SupabaseClient;
  userId: string;
  onDone: () => void;
}) {
  const [hasLocal, setHasLocal] = useState<boolean | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    hasLocalInstall().then(setHasLocal);
  }, []);

  async function handleImport() {
    setImporting(true);
    setError(undefined);
    try {
      const root = await findRoot();
      const adapter = new SupabaseAdapter(client, userId);
      for (const id of FIELD_IDS) {
        const value = await readProfileField(root, id);
        await adapter.writeProfileField(id, value);
      }
      await readOnboardingCompleted(root);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  if (hasLocal === undefined) {
    return <p className="field-help">Checking for a local aplyx installation on this machine&hellip;</p>;
  }

  return (
    <div className="option-list">
      {hasLocal && (
        <button type="button" className="option-card" onClick={handleImport} disabled={importing}>
          <div>
            <div className="option-card-title">{importing ? "Importing…" : "Import from this machine"}</div>
            <div className="option-card-detail">
              Bring over your profile from the local aplyx install found here.
            </div>
          </div>
        </button>
      )}
        <button type="button" className="option-card" onClick={() => onDone()}>
        <div>
          <div className="option-card-title">Start fresh</div>
          <div className="option-card-detail">Fill in your profile from scratch.</div>
        </div>
      </button>
      {error && <p className="field-help">Import failed: {error} — you can also start fresh.</p>}
    </div>
  );
}
