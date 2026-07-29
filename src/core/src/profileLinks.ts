import { readSafeField, writeSafeField } from "./settings.js";

/**
 * LinkedIn/GitHub username normalization shared by the Settings screen and
 * the onboarding wizard. Reads prefer the new `<kind>_username` safe_field
 * but fall back to extracting from the legacy `<kind>_url` field, so a
 * config that only has the legacy key keeps working with zero migration.
 * Writes only ever touch `<kind>_username` — the legacy key is never
 * written or deleted by new code.
 */

type ProfileKind = "linkedin" | "github";

const HOST_PREFIX: Record<ProfileKind, RegExp> = {
  linkedin: /^linkedin\.com\/in\//i,
  github: /^github\.com\//i,
};

export function extractUsername(kind: ProfileKind, raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  value = value.replace(/^https?:\/\//i, "");
  value = value.replace(/^www\./i, "");
  value = value.replace(HOST_PREFIX[kind], "");
  value = value.split(/[?#]/)[0];
  value = value.replace(/\/+$/, "");
  return value;
}

export function deriveFullUrl(kind: ProfileKind, username: string): string {
  if (!username) return "";
  return kind === "linkedin" ? `https://linkedin.com/in/${username}` : `https://github.com/${username}`;
}

export function readProfileUsername(root: string, kind: ProfileKind): string {
  const username = readSafeField(root, `${kind}_username`);
  if (username) return username;
  return extractUsername(kind, readSafeField(root, `${kind}_url`));
}

export function writeProfileUsername(root: string, kind: ProfileKind, username: string): void {
  writeSafeField(root, `${kind}_username`, extractUsername(kind, username));
}
