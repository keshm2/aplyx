import { useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import "../../../components/formFields.css";

export function ResumeUploadStep({ client, userId }: { client: SupabaseClient; userId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleFile(file: File) {
    setError(undefined);
    setUploading(true);
    const { error: uploadError } = await client.storage
      .from("resumes")
      .upload(`${userId}/${file.name}`, file, { upsert: true });
    setUploading(false);
    if (uploadError) {
      setError(uploadError.message);
      return;
    }
    setFileName(file.name);
  }

  return (
    <div>
      <p>
        Upload a resume so it&rsquo;s available wherever you sign in. PDFs work best; you can add
        more or replace it any time.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) handleFile(file);
        }}
      />
      <button type="button" className="wizard-next" onClick={() => inputRef.current?.click()} disabled={uploading}>
        {uploading ? "Uploading…" : fileName ? `Replace ${fileName}` : "Choose a PDF…"}
      </button>
      {fileName && !uploading && <p className="field-help" style={{ marginTop: "0.5rem" }}>Uploaded {fileName}.</p>}
      {error && (
        <p className="field-help" style={{ color: "var(--danger)", marginTop: "0.5rem" }}>
          {error}
        </p>
      )}
      <p className="field-help" style={{ marginTop: "0.75rem" }}>
        You can skip this and add a resume later from Settings.
      </p>
    </div>
  );
}
