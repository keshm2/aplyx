import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PAGES } from "@aplyx/core/onboarding/fields.js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { readProfileFields, writeProfileFields } from "../../lib/bridge";
import { useAplyxState } from "../../lib/useAplyxState";
import { FieldInput } from "../../components/FieldInput";
import "../../components/formFields.css";
import "./ProfileScreen.css";

type FieldValue = string | string[];

function emptyValueFor(kind: string): FieldValue {
  return kind === "roles" || kind === "multi-location" || kind === "multi-company" ? [] : "";
}

/** Every field editable during onboarding (src/core/src/onboarding/fields.ts),
 *  re-surfaced here as a plain settings page grouped into the same 8 sections,
 *  so changing a preference later never means re-running the whole setup wizard. */
export function ProfileScreen() {
  // Local install wins; a hosted sign-in is the fallback so a user who set
  // their profile up on aplyx.app sees and edits the same fields here
  // instead of the old "connect a local install first" dead end.
  const { source, root, hosted, loaded: sourceLoaded } = useAplyxState();
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<number | undefined>(undefined);
  const [savedAt, setSavedAt] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);
  const navRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | undefined>(undefined);

  // Measures the active nav button's real position/height (section titles
  // wrap to different line counts, e.g. "What are you looking for?", so a
  // fixed row-height calc would drift) and slides a highlight behind it,
  // instead of each button's own background instantly swapping on click.
  useLayoutEffect(() => {
    function measure() {
      const el = navRefs.current[activeIndex];
      if (el) setIndicator({ top: el.offsetTop, height: el.offsetHeight });
    }
    measure();
    // Section titles wrap differently at narrower widths (the nav itself
    // switches to a wrapped horizontal row below 640px), so a resize can
    // change the active button's real position without activeIndex
    // changing at all.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // `loaded` too: the nav (and its ref-bearing buttons) doesn't exist
    // in the DOM until loading finishes, so the very first measurement
    // has to wait for that flip rather than only re-running on activeIndex.
  }, [activeIndex, loaded]);

  const allFieldIds = PAGES.flatMap((p) => p.fields).map((f) => f.id);

  useEffect(() => {
    if (!sourceLoaded) return;
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        if (source === "local" && root) {
          const v = await readProfileFields(root, allFieldIds);
          if (!cancelled) setValues(v);
        } else if (source === "hosted" && hosted) {
          const v = await new SupabaseAdapter(hosted.client, hosted.userId).readProfileFields(allFieldIds);
          if (!cancelled) setValues(v as Record<string, FieldValue>);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceLoaded, source, root, hosted]);

  function setField(id: string, value: FieldValue) {
    setValues((prev) => ({ ...prev, [id]: value }));
  }

  async function savePage(pageIndex: number) {
    const page = PAGES[pageIndex];
    const toWrite = Object.fromEntries(page.fields.map((f) => [f.id, values[f.id] ?? emptyValueFor(f.kind)]));
    setSaving(pageIndex);
    setError(undefined);
    try {
      if (source === "local" && root) {
        await writeProfileFields(root, toWrite);
      } else if (source === "hosted" && hosted) {
        await new SupabaseAdapter(hosted.client, hosted.userId).writeProfileFields(toWrite);
      } else {
        return;
      }
      setSavedAt((prev) => ({ ...prev, [pageIndex]: true }));
      window.setTimeout(() => setSavedAt((prev) => ({ ...prev, [pageIndex]: false })), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(undefined);
    }
  }

  if (loaded && source === "none") {
    return (
      <div style={{ maxWidth: "42rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Profile</h1>
        <p className="field-help">
          Sign in, or connect a local install in Settings, to edit your profile. Signed in, these
          fields are the same ones you filled in on aplyx.app.
        </p>
      </div>
    );
  }

  const activePage = PAGES[activeIndex];

  return (
    <div style={{ maxWidth: "58rem", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div>
        <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-1)" }}>Profile</h1>
        <p style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
          {source === "hosted"
            ? "Your hosted profile, synced with aplyx.app. Edits here show up there and in any other aplyx install signed into this account."
            : "Everything you set up during onboarding, editable here. Nothing requires redoing setup."}
        </p>
      </div>

      {error ? <div className="message-banner message-banner-error">{error}</div> : null}

      {!loaded ? (
        <p className="field-help">Loading&hellip;</p>
      ) : (
        <div className="profile-layout">
          <nav className="profile-nav" aria-label="Profile sections">
            {indicator && (
              <span
                className="profile-nav-indicator"
                aria-hidden="true"
                style={{ transform: `translateY(${indicator.top}px)`, height: `${indicator.height}px` }}
              />
            )}
            {PAGES.map((page, pageIndex) => (
              <button
                key={page.title}
                ref={(el) => {
                  navRefs.current[pageIndex] = el;
                }}
                type="button"
                className={pageIndex === activeIndex ? "profile-nav-item profile-nav-item-active" : "profile-nav-item"}
                onClick={() => setActiveIndex(pageIndex)}
              >
                {page.title}
                {savedAt[pageIndex] && <span className="profile-nav-saved" aria-hidden="true">✓</span>}
              </button>
            ))}
          </nav>

          <section className="settings-section profile-panel aplyx-fade-in" key={activePage.title}>
            <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-3)" }}>{activePage.title}</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              {activePage.fields.map((field) => (
                <FieldInput
                  key={field.id}
                  field={field}
                  value={values[field.id] ?? emptyValueFor(field.kind)}
                  onChange={(v) => setField(field.id, v)}
                  homeCity={String(values.location ?? "")}
                />
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={saving === activeIndex}
                onClick={() => void savePage(activeIndex)}
              >
                {saving === activeIndex ? "Saving…" : "Save"}
              </button>
              {savedAt[activeIndex] ? <span className="field-help">Saved.</span> : null}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
