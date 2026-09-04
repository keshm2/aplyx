import { useState } from "react";
import "./Avatar.css";

/** "Kesh Muthu" -> "KM", "kesh" -> "KE", falls back to the email's local
 *  part ("kesh.muthu04@…" -> "KM") when no display name is known.
 *  Mirrors src/site/nav-auth.js's initialsFrom exactly, so the website
 *  and the app agree on what a given account's initials are. */
export function initialsFrom(name: string | undefined, email: string | undefined): string {
  const source = (name || "").trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts[0]) return parts[0].slice(0, 2).toUpperCase();
  }
  const local = (email || "").split("@")[0] || "";
  const bits = local.split(/[._-]+/).filter(Boolean);
  if (bits.length >= 2) return (bits[0][0] + bits[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase() || "?";
}

/** Identity avatar: a real profile photo when one exists (Google
 *  sign-in's user_metadata.avatar_url/picture), else initials in a chip —
 *  never a generic placeholder-person icon. Falls back to initials if the
 *  photo URL 404s, is revoked, or is blocked. */
export function Avatar({
  name,
  email,
  avatarUrl,
  size = 32,
}: {
  name?: string;
  email?: string;
  avatarUrl?: string;
  size?: number;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = avatarUrl && !imgFailed;
  return (
    <span
      className="avatar-chip"
      style={{ "--avatar-size": `${size}px` } as React.CSSProperties}
      title={name || email || undefined}
    >
      {showImg ? (
        <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setImgFailed(true)} />
      ) : (
        <span className="avatar-chip-initials">{initialsFrom(name, email)}</span>
      )}
    </span>
  );
}
