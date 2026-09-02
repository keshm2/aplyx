import { useEffect, useState } from "react";
import { PAGES, PRIVACY_LINE } from "@aplyx/core/onboarding/fields.js";
import { readProfileFields, writeProfileFields } from "../../../lib/bridge";
import { FieldInput } from "../../../components/FieldInput";

type FieldValue = string | string[];

/**
 * Self-contained mini-wizard over the 8 onboarding field pages
 * (src/core/src/onboarding/fields.ts): the same schema the TUI's
 * onboarding wizard renders. One outer wizard "step" (per the plan's
 * Welcome/Environment/Agent/Profile/Resumes/Notifications/Extension/Review
 * sequence), with its own Back/Next between the 8 field pages inside it.
 * Every field write-through goes through the LocalAdapter via the Rust
 * bridge (readProfileField/writeProfileField); identical routing to the
 * TUI's OnboardingWizard.tsx (linkedin/github via profileLinks, role
 * keywords/locations via targets arrays, everything else via safe_fields).
 */
export function ProfileStep({ root, onComplete }: { root: string; onComplete: () => void }) {
  const [pageIndex, setPageIndex] = useState(0);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [loaded, setLoaded] = useState(false);

  const page = PAGES[pageIndex];
  // Only select3 fields set `required` today (see fields.ts), always with
  // a "prefer not to answer" option among their three choices, so this
  // blocks leaving the question untouched, never forces an actual
  // disclosure.
  const missingRequired = page.fields.some((f) => f.required && !values[f.id]);

  useEffect(() => {
    let cancelled = false;
    readProfileFields(
      root,
      page.fields.map((f) => f.id),
    )
      .then((values) => {
        if (cancelled) return;
        setValues((prev) => ({ ...prev, ...values }));
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
  }, [pageIndex, root]);

  async function commitPage() {
    const toWrite = Object.fromEntries(page.fields.map((f) => [f.id, values[f.id] ?? ""]));
    await writeProfileFields(root, toWrite);
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
        // key={pageIndex}: forces a fresh mount on every page change, so
        // wizard-step-in's fade+slide-up animation (the same one
        // WizardShell uses for the outer step-to-step transition) plays
        // again each time; without this, the 8 pages inside this
        // self-contained mini-wizard just swapped instantly with no
        // effect at all, unlike every step around it. A single "in"
        // fade rather than WizardShell's full out-then-in: the outer
        // freeze/swap choreography exists to keep outgoing content
        // visible during its own fade so nothing looks like a hard cut,
        // but that machinery would have to duplicate/coordinate with
        // this component's own `loaded` loading-state handling
        // (Next/Back already flip it false before the page advances);
        // not worth the added risk for a lighter-weight sub-navigation.
        <div key={pageIndex} className="wizard-step-in" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {page.fields.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              value={values[field.id] ?? (field.kind === "roles" || field.kind === "levels" || field.kind === "multi-location" || field.kind === "multi-company" ? [] : "")}
              onChange={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
            />
          ))}
        </div>
      )}
      <p className="field-help" style={{ marginTop: "1rem" }}>
        {missingRequired ? "Pick an answer for every question above to continue: \"prefer not to answer\" counts." : PRIVACY_LINE}
      </p>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "1.5rem" }}>
        <button type="button" className="wizard-back" onClick={handleBack} disabled={pageIndex === 0}>
          &larr; {pageIndex === 0 ? "" : PAGES[pageIndex - 1].title}
        </button>
        <button type="button" className="wizard-next" onClick={handleNext} disabled={!loaded || missingRequired}>
          {pageIndex < PAGES.length - 1 ? "Next" : "Continue"}
        </button>
      </div>
    </div>
  );
}
