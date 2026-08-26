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
  onImportHosted,
}: {
  client: SupabaseClient;
  userId: string;
  onDone: () => void;
  /** Called instead of onDone when the user picks "Import your existing
   *  account details" — the caller's job is to skip straight past the
   *  profile-entry step entirely (not just advance one step like onDone
   *  does), since there's nothing left to fill in. */
  onImportHosted: () => void;
}) {
  const [hasLocal, setHasLocal] = useState<boolean | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Whether this account already has real profile data — from a previous
  // device, or from filling in the free web dashboard's profile form
  // before ever installing anything. Checked via first_name/last_name as
  // the identity signal, same "empty string means no row/no value yet"
  // contract SupabaseAdapter.readProfileField already guarantees.
  const [hasHostedProfile, setHasHostedProfile] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    hasLocalInstall().then(setHasLocal);
    const adapter = new SupabaseAdapter(client, userId);
    Promise.all([adapter.readProfileField("first_name"), adapter.readProfileField("last_name")])
      .then(([firstName, lastName]) => setHasHostedProfile(Boolean(String(firstName).trim() && String(lastName).trim())))
      .catch(() => setHasHostedProfile(false));
  }, [client, userId]);

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

  if (hasLocal === undefined || hasHostedProfile === undefined) {
    return <p className="field-help">Checking for a local install or an existing account&hellip;</p>;
  }

  return (
    <div className="option-list">
      {hasHostedProfile && (
        <button type="button" className="option-card" onClick={onImportHosted}>
          <div>
            <div className="option-card-title">Import your existing account details</div>
            <div className="option-card-detail">
              This account already has a profile saved &mdash; from another device, or from the web dashboard. Skip
              straight past setup and use it as-is.
            </div>
          </div>
        </button>
      )}
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
          <div className="option-card-title">{hasHostedProfile ? "Go through setup" : "Start fresh"}</div>
          <div className="option-card-detail">
            {hasHostedProfile ? "Review and edit your profile page by page." : "Fill in your profile from scratch."}
          </div>
        </div>
      </button>
      {error && <p className="field-help">Import failed: {error} — you can also start fresh.</p>}
    </div>
  );
}
