import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import "../../../components/formFields.css";

/** One résumé per hosted account, in Supabase Storage under
 *  `resumes/<userId>/`. This step is idempotent: on mount it looks for an
 *  already-uploaded résumé (from a previous run, or from the website
 *  setup) and shows it instead of prompting for a fresh upload — so
 *  stepping back and forward through the wizard, or having done setup
 *  online first, never reads as "nothing uploaded" or a second setup. A
 *  replacement with a different filename prunes the old object so there's
 *  never more than one. */
export function ResumeUploadStep({ client, userId }: { client: SupabaseClient; userId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [preexisting, setPreexisting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  async function listExisting(): Promise<string[]> {
    const { data, error: listError } = await client.storage.from("resumes").list(userId);
    if (listError) throw listError;
    return (data ?? [])
      .filter((e) => e.name && !e.name.startsWith("."))
      .sort((a, b) => new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime())
      .map((e) => e.name);
  }

  useEffect(() => {
    let cancelled = false;
    listExisting()
      .then((names) => {
        if (cancelled) return;
        if (names[0]) {
          setFileName(names[0]);
          setPreexisting(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId]);

  async function handleFile(file: File) {
    setError(undefined);
    setUploading(true);
    try {
      const { error: uploadError } = await client.storage
        .from("resumes")
        .upload(`${userId}/${file.name}`, file, { upsert: true });
      if (uploadError) {
        setError(uploadError.message);
        return;
      }
      // Keep exactly one résumé: drop any other objects left from an
      // earlier upload under a different name.
      try {
        const stale = (await listExisting()).filter((n) => n !== file.name);
        if (stale.length > 0) {
          await client.storage.from("resumes").remove(stale.map((n) => `${userId}/${n}`));
        }
      } catch {
        // best effort — a stray extra object isn't worth failing the step
      }
      setFileName(file.name);
      setPreexisting(false);
    } finally {
      setUploading(false);
    }
  }

  const buttonLabel = uploading
    ? "Uploading…"
    : checking
      ? "Checking…"
      : fileName
        ? `Replace ${fileName}`
        : "Choose a PDF…";

  return (
    <div>
      <p>
        Upload a résumé so it&rsquo;s available wherever you sign in. PDFs work best; you can add
        more or replace it any time.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) void handleFile(file);
          e.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        className="wizard-next"
        onClick={() => inputRef.current?.click()}
        disabled={uploading || checking}
      >
        {buttonLabel}
      </button>
      {fileName && !uploading && (
        <p className="field-help" style={{ marginTop: "0.5rem", color: "var(--good, var(--accent))" }}>
          {preexisting
            ? `${fileName} is already on your account — replace it, or just continue.`
            : `Uploaded ${fileName}.`}
        </p>
      )}
      {error && (
        <p className="field-help" style={{ color: "var(--danger)", marginTop: "0.5rem" }}>
          {error}
        </p>
      )}
      <p className="field-help" style={{ marginTop: "0.75rem" }}>
        You can skip this and add a résumé later from Settings.
      </p>
    </div>
  );
}
