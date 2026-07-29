// Per-ATS detection, job extraction, and form-field mapping.
//
// Selector discipline (same as the phase 7 rule): prefer stable,
// reusable CSS / ARIA / data-automation hooks over markup positions.
// ATS markup drifts — keep every per-ATS fixup in this one module so
// selector maintenance stays a reviewable, single-file change.
import { AtsName, ExtractedJob } from "./shared.js";

const JD_TEXT_CAP = 20_000;

export function detectAts(hostname: string): AtsName | null {
  if (hostname === "boards.greenhouse.io" || hostname === "job-boards.greenhouse.io") return "greenhouse";
  if (hostname === "jobs.lever.co") return "lever";
  if (hostname === "jobs.ashbyhq.com") return "ashbyhq";
  if (hostname.endsWith(".myworkdayjobs.com")) return "workday";
  return null;
}

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function firstMatch(doc: Document, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el && text(el)) return el;
  }
  return null;
}

/** Company slug from the board URL path (greenhouse/lever/ashby host the
 *  company as the first path segment; workday encodes it in the tenant
 *  subdomain). */
function companyFrom(ats: AtsName, url: URL, doc: Document): string {
  if (ats === "workday") return url.hostname.split(".")[0] ?? "";
  const segment = url.pathname.split("/").filter(Boolean)[0] ?? "";
  const meta = doc.querySelector('meta[property="og:site_name"]');
  return segment || (meta?.getAttribute("content") ?? "");
}

const TITLE_SELECTORS: Record<AtsName, string[]> = {
  greenhouse: ["h1.app-title", ".job__title h1", "h1.section-header", "h1"],
  lever: [".posting-headline h2", ".posting-header h2", "h1", "h2"],
  ashbyhq: ["h1[class*='title']", "h1"],
  workday: ["h1[data-automation-id='jobPostingHeader']", "h2[data-automation-id='jobPostingHeader']", "h1"],
};

const JD_SELECTORS: Record<AtsName, string[]> = {
  greenhouse: ["#content", ".job__description", "#app_body", "main"],
  lever: ["[data-qa='job-description']", ".posting-page .section-wrapper", ".content", "main"],
  ashbyhq: ["[class*='descriptionText']", "[class*='description']", "main"],
  workday: ["[data-automation-id='jobPostingDescription']", "main"],
};

const LOCATION_SELECTORS: Record<AtsName, string[]> = {
  greenhouse: [".location", ".job__location", "[class*='location']"],
  lever: [".posting-categories .location", ".posting-category.location", "[class*='location']"],
  ashbyhq: ["[class*='location']"],
  workday: ["[data-automation-id='locations']", "[data-automation-id='location']"],
};

/** Pull {title, company, jd_text, location} off the current posting page.
 *  Returns null when the page has no recognizable posting (e.g. a board
 *  index page). */
export function extractJob(ats: AtsName, doc: Document, url: URL): ExtractedJob | null {
  const title = text(firstMatch(doc, TITLE_SELECTORS[ats]));
  if (!title) return null;
  const jdEl = firstMatch(doc, JD_SELECTORS[ats]);
  const jd = (jdEl?.textContent ?? doc.body?.innerText ?? "").trim().slice(0, JD_TEXT_CAP);
  return {
    source: ats,
    company: companyFrom(ats, url, doc),
    title,
    url: url.origin + url.pathname,
    location: text(firstMatch(doc, LOCATION_SELECTORS[ats])) || undefined,
    jd_text: jd || undefined,
  };
}

// ---------------------------------------------------------------------------
// Form-field mapping

/** A fillable form control resolved to a safe_fields key. `full_name` is a
 *  client-side pseudo-key composed from first_name + last_name (Lever uses
 *  a single "Full name" input). */
export type FieldKey =
  | "first_name"
  | "last_name"
  | "email"
  | "phone"
  | "linkedin_url"
  | "github_url"
  | "graduation_date"
  | "gpa"
  | "authorized_to_work"
  | "require_sponsorship"
  | "citizenship_status"
  | "currently_enrolled"
  | "full_name";

/** Ordered — the first matching pattern wins, so put the most specific
 *  patterns (e.g. workday data-automation ids) before generic words. */
const FIELD_PATTERNS: Array<[FieldKey, RegExp]> = [
  ["first_name", /legalNameSection_firstName|first[\s_-]*name|given[\s_-]*name/i],
  ["last_name", /legalNameSection_lastName|last[\s_-]*name|family[\s_-]*name|surname/i],
  ["full_name", /^(your\s*)?(full\s*)?name$|candidate[\s_-]*name|_systemfield_name/i],
  ["email", /e-?mail|_systemfield_email/i],
  ["phone", /phone|mobile/i],
  ["linkedin_url", /linked\s*-?in/i],
  ["github_url", /git\s*hub/i],
  ["graduation_date", /graduat/i],
  ["gpa", /\bgpa\b|grade\s*point/i],
  ["require_sponsorship", /sponsorship|sponsor\s*(a|an|my)?\s*(visa|employment)/i],
  ["authorized_to_work", /authoriz|legally\s+(able|permitted)\s+to\s+work|work\s+authorization|eligib\w*\s+to\s+work/i],
  ["citizenship_status", /citizen/i],
  ["currently_enrolled", /currently\s+enrolled|enrolled\s+(at|in)/i],
];

/** Everything we can use to identify what a control is asking for —
 *  one descriptor part per source (label, aria, placeholder, name, …). */
export function fieldDescriptor(el: HTMLElement, doc: Document): string[] {
  const parts: string[] = [];
  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) parts.push(text(label));
  }
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) parts.push(text(wrappingLabel));
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const refId of labelledBy.split(/\s+/)) {
      parts.push(text(doc.getElementById(refId)));
    }
  }
  for (const attr of ["aria-label", "placeholder", "name", "id", "autocomplete", "data-automation-id"]) {
    const value = el.getAttribute(attr);
    if (value) parts.push(value);
  }
  // Normalize: labels carry required markers (✱ / *) and punctuation that
  // would break the anchored patterns below.
  return parts
    .map((part) => part.toLowerCase().replace(/[^a-z0-9\s_\[\]/-]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function matchField(descriptorParts: string[]): FieldKey | null {
  // A control that already matched by input type doesn't reach here;
  // patterns run in specificity order, tested per descriptor part so
  // anchored patterns (e.g. the bare "name" full-name field on Lever)
  // see one source at a time.
  for (const [key, pattern] of FIELD_PATTERNS) {
    if (descriptorParts.some((part) => pattern.test(part))) return key;
  }
  return null;
}

/** Type-based shortcuts that beat text matching. */
export function matchByType(el: HTMLElement): FieldKey | null {
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (type === "email") return "email";
  if (type === "tel") return "phone";
  const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (autocomplete === "given-name") return "first_name";
  if (autocomplete === "family-name") return "last_name";
  if (autocomplete === "name") return "full_name";
  if (autocomplete === "email") return "email";
  if (autocomplete === "tel") return "phone";
  return null;
}
