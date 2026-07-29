import { useEffect, useState } from "react";
import { PAGES } from "@aplyx/core/onboarding/fields.js";
import { findRoot, hasLocalInstall, readProfileFields, writeProfileFields } from "../../lib/bridge";
import { FieldInput } from "../../components/FieldInput";
import "../../components/formFields.css";

type FieldValue = string | string[];

function emptyValueFor(kind: string): FieldValue {
  return kind === "roles" || kind === "multi-location" || kind === "multi-company" ? [] : "";
}

/** Every field editable during onboarding (src/core/src/onboarding/fields.ts),
 *  re-surfaced here as a plain settings page grouped into the same 8 sections —
 *  so changing a preference later never means re-running the whole setup wizard. */
export function ProfileScreen() {
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<number | undefined>(undefined);
  const [savedAt, setSavedAt] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    hasLocalInstall()
      .then(async (has) => {
        if (!has) return;
        const r = await findRoot();
        setRoot(r);
        const allFields = PAGES.flatMap((p) => p.fields);
        const values = await readProfileFields(
          r,
          allFields.map((f) => f.id),
        );
        setValues(values);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoaded(true));
  }, []);

  function setField(id: string, value: FieldValue) {
    setValues((prev) => ({ ...prev, [id]: value }));
  }

  async function savePage(pageIndex: number) {
    if (!root) return;
    setSaving(pageIndex);
    setError(undefined);
    try {
      const page = PAGES[pageIndex];
      const toWrite = Object.fromEntries(page.fields.map((f) => [f.id, values[f.id] ?? emptyValueFor(f.kind)]));
      await writeProfileFields(root, toWrite);
      setSavedAt((prev) => ({ ...prev, [pageIndex]: true }));
      window.setTimeout(() => setSavedAt((prev) => ({ ...prev, [pageIndex]: false })), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(undefined);
    }
  }

  if (loaded && !root) {
    return (
      <div style={{ maxWidth: "34rem", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Profile</h1>
        <p className="field-help">
          Connect a local install in Settings first — profile fields live in your local aplyx checkout.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "34rem", display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div>
        <h1 style={{ fontSize: "var(--text-3xl)", marginBottom: "var(--space-2)" }}>Profile</h1>
        <p style={{ color: "var(--text-muted)" }}>
          Everything you set up during onboarding, editable here — nothing requires redoing setup.
        </p>
      </div>

      {error ? <div className="message-banner message-banner-error">{error}</div> : null}

      {!loaded ? (
        <p className="field-help">Loading&hellip;</p>
      ) : (
        PAGES.map((page, pageIndex) => (
          <section key={page.title}>
            <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>{page.title}</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              {page.fields.map((field) => (
                <FieldInput
                  key={field.id}
                  field={field}
                  value={values[field.id] ?? emptyValueFor(field.kind)}
                  onChange={(v) => setField(field.id, v)}
                />
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={saving === pageIndex}
                onClick={() => void savePage(pageIndex)}
              >
                {saving === pageIndex ? "Saving…" : "Save"}
              </button>
              {savedAt[pageIndex] ? <span className="field-help">Saved.</span> : null}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
