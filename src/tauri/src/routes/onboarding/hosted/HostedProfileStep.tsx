import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { PAGES, PRIVACY_LINE } from "@aplyx/core/onboarding/fields.js";
import { FieldInput } from "../../../components/FieldInput";

type FieldValue = string | string[];

/**
 * Hosted-mode counterpart of the local wizard's ProfileStep: same shared
 * field schema (src/core/src/onboarding/fields.ts), but reads/writes
 * through SupabaseAdapter instead of LocalAdapter. SupabaseAdapter has no
 * node:fs/child_process dependency (pure @supabase/supabase-js calls), so
 * it runs directly in the webview; no Rust bridge needed for hosted
 * writes, only for local-mode ones. Profile PII lands in the `profiles`
 * table per the operator's 2026-07-16 decision to sync it for signed-in
 * users (see src/core/src/onboarding/profile.ts).
 */
export function HostedProfileStep({
  client,
  userId,
  onComplete,
}: {
  client: SupabaseClient;
  userId: string;
  onComplete: () => void;
}) {
  const [adapter] = useState(() => new SupabaseAdapter(client, userId));
  const [pageIndex, setPageIndex] = useState(0);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [loaded, setLoaded] = useState(false);

  const page = PAGES[pageIndex];

  useEffect(() => {
    let cancelled = false;
    Promise.all(page.fields.map(async (f) => [f.id, await adapter.readProfileField(f.id)] as const))
      .then((entries) => {
        if (cancelled) return;
        setValues((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      })
      // A failed prefill must not strand the page on its loading state:
      // the fields just start empty and the write path reports its own
      // errors.
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex]);

  async function commitPage() {
    await Promise.all(page.fields.map((f) => adapter.writeProfileField(f.id, values[f.id] ?? "")));
  }

  async function handleNext() {
    await commitPage();
    if (pageIndex < PAGES.length - 1) {
      setLoaded(false);
      setPageIndex((i) => i + 1);
    } else {
      onComplete();
    }
  }

  async function handleBack() {
    if (pageIndex === 0) return;
    await commitPage();
    setLoaded(false);
    setPageIndex((i) => i - 1);
  }

  return (
    <div>
      <div className="wizard-subtitle" style={{ marginBottom: "1rem" }}>
        {page.title} &middot; {pageIndex + 1} of {PAGES.length}
      </div>
      {!loaded ? (
        <p className="field-help">Loading&hellip;</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {page.fields.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              value={
                values[field.id] ??
                (field.kind === "roles" || field.kind === "multi-location" || field.kind === "multi-company" ? [] : "")
              }
              onChange={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
              homeCity={String(values.location ?? "")}
            />
          ))}
        </div>
      )}
      <p className="field-help" style={{ marginTop: "1rem" }}>
        {PRIVACY_LINE}
      </p>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "1.5rem" }}>
        <button type="button" className="wizard-back" onClick={handleBack} disabled={pageIndex === 0}>
          &larr; {pageIndex === 0 ? "" : PAGES[pageIndex - 1].title}
        </button>
        <button type="button" className="wizard-next" onClick={handleNext} disabled={!loaded}>
          {pageIndex < PAGES.length - 1 ? "Next" : "Continue"}
        </button>
      </div>
    </div>
  );
}
