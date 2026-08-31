/**
 * ATS family registry, the single source of truth for the four
 * application-tracking-system families aplyx's apply pipeline supports
 * (greenhouse, lever, ashbyhq, workday). The extension's own
 * `src/extension/src/ats.ts` holds the browser-DOM-specific selector
 * logic for the same four families; this module holds the higher-level
 * family metadata (account model, pacing, URL detection) that both the
 * local apply loop and a future hosted auto-apply worker consume
 * framework-agnostically, without importing the extension's DOM code.
 *
 * Design decisions (docs/hosted-auto-apply-plan.md, AGENTS.md
 * "Board-specific fetch method"):
 * - guest/no-account flows use the applicant's real email.
 * - account-required flows use a managed mail.aplyx.app alias
 *   (see managed_aliases migration + applicantPackage.ts).
 * - workday is account-required and uses a managed alias so account
 *   verification / OTP handling can be resumed safely.
 *
 * Pacing is per-family with per-action random variance. This exists
 * solely for stability and rate-limit hygiene (avoiding 429s and
 * overloading employer career pages), NOT to evade bot detection:
 * CAPTCHA evasion is a permanent red line (docs/hosted-auto-apply-plan.md
 * "Ground rule"). The variance is small and documented as such.
 */

export type AtsFamily = "greenhouse" | "lever" | "ashbyhq" | "workday";

export const ATS_FAMILIES: readonly AtsFamily[] = ["greenhouse", "lever", "ashbyhq", "workday"];

/** Whether the family lets a guest apply with just an email/name, or
 *  requires creating a candidate account on the ATS itself. Drives
 *  alias selection in applicantPackage.ts: account-required flows use a
 *  managed mail.aplyx.app alias so employer replies route back through
 *  aplyx's inbox; guest flows use the applicant's real email directly. */
export function requiresAccount(family: AtsFamily): boolean {
  switch (family) {
    case "greenhouse":
    case "lever":
    case "ashbyhq":
      return false;
    case "workday":
      return true;
  }
}

/** Whether the family is restricted to review/prep-only flows. The current
 *  implementation target keeps all four families submit-capable, with
 *  confirm-before-submit still available as a rollout gate. */
export function isReviewOnly(family: AtsFamily): boolean {
  return false;
}

/** Detect the ATS family from a job/board URL hostname. Mirrors
 *  src/extension/src/ats.ts's detectAts so the core can resolve a family
 *  from a URL without importing the extension's DOM code. Returns null
 *  for an unrecognized host: the caller routes an unrecognized family
 *  to needs_review, never guesses. */
export function detectFamily(hostname: string): AtsFamily | null {
  const host = hostname.toLowerCase();
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") return "greenhouse";
  if (host === "jobs.lever.co") return "lever";
  if (host === "jobs.ashbyhq.com") return "ashbyhq";
  if (host.endsWith(".myworkdayjobs.com")) return "workday";
  return null;
}

/** Derive the normalized `application_accounts.tenant_key` /
 *  `verification_sessions.tenant_key` value for a job posting URL. A
 *  single ATS family can host many unrelated employer tenants (many
 *  companies all run on Workday), so the family alone is never enough
 *  to key an account or a verification session: two companies on the
 *  same ATS must never share or collide on the same
 *  (user, family, tenant_key) identity (docs/ats-account-credentials-plan.md
 *  "Purpose"). This is the single place that derivation happens so
 *  account creation/reuse (Package 3) and any future verification-session
 *  writer key on the exact same value.
 *
 *  Only meaningful for account-required families: returns null for a
 *  guest family (nothing to dedupe an account against) and for a URL
 *  this function can't confidently parse. The caller treats null the
 *  same way detectFamily's null is treated: route to needs_review,
 *  never guess a tenant key. */
export function tenantKeyFor(family: AtsFamily, url: string): string | null {
  if (!requiresAccount(family)) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  // Workday tenants are one-per-subdomain (e.g. acme.wd1.myworkdayjobs.com,
  // acme.wd5.myworkdayjobs.com): the full hostname is already the
  // narrowest stable identifier available without employer-specific
  // path-parsing assumptions, so it's used as-is rather than trying to
  // strip the shard segment.
  if (family === "workday" && hostname.endsWith(".myworkdayjobs.com")) return hostname;
  return null;
}

/** Action types the pacing config keys on. Coarse by design: the
 *  execution step (src/extension/src/ats.ts's bounded form-filler) is
 *  the only consumer, and it only needs "how long to pause before this
 *  class of action", not a per-DOM-event delay. */
export type PacingAction = "navigate" | "type" | "click" | "submit";

export interface PacingConfig {
  /** Base delay in milliseconds for the action. */
  readonly baseMs: number;
  /** Half-range of the random variance in milliseconds. The actual
   *  delay is baseMs ± varianceMs (uniform), so varianceMs is the
   *  maximum deviation either direction. Small by design: this is
   *  rate-limit/stability pacing, not human-mimicry. */
  readonly varianceMs: number;
}

/** Per-family pacing. The numbers are conservative defaults chosen for
 *  stability (avoid tripping a board's rate limiter when filling a
 *  multi-field form in sequence), not tuned against any detection
 *  system. Adjust per-family only with real failure data; see
 *  docs/hosted-auto-apply-plan.md "Open questions for the operator"
 *  (circuit-breaker threshold and per-batch timeout sizing). */
const PACING: Record<AtsFamily, Record<PacingAction, PacingConfig>> = {
  greenhouse: {
    navigate: { baseMs: 800, varianceMs: 200 },
    type: { baseMs: 120, varianceMs: 40 },
    click: { baseMs: 200, varianceMs: 60 },
    submit: { baseMs: 1000, varianceMs: 300 },
  },
  lever: {
    navigate: { baseMs: 700, varianceMs: 200 },
    type: { baseMs: 110, varianceMs: 40 },
    click: { baseMs: 180, varianceMs: 60 },
    submit: { baseMs: 900, varianceMs: 300 },
  },
  ashbyhq: {
    navigate: { baseMs: 800, varianceMs: 200 },
    type: { baseMs: 120, varianceMs: 40 },
    click: { baseMs: 200, varianceMs: 60 },
    submit: { baseMs: 1000, varianceMs: 300 },
  },
  workday: {
    navigate: { baseMs: 1000, varianceMs: 300 },
    type: { baseMs: 150, varianceMs: 50 },
    click: { baseMs: 250, varianceMs: 80 },
    submit: { baseMs: 1200, varianceMs: 400 },
  },
};

export function pacingFor(family: AtsFamily, action: PacingAction): PacingConfig {
  return PACING[family][action];
}

/** Resolve a concrete delay (base ± uniform variance) for an action.
 *  Pure function of the family + action + a 0..1 random source, so a
 *  test can pass a deterministic rng and get reproducible delays. */
export function resolveDelayMs(
  family: AtsFamily,
  action: PacingAction,
  random: () => number = Math.random,
): number {
  const { baseMs, varianceMs } = pacingFor(family, action);
  const offset = (random() * 2 - 1) * varianceMs;
  return Math.max(0, Math.round(baseMs + offset));
}

export interface AtsFamilyInfo {
  family: AtsFamily;
  requiresAccount: boolean;
  reviewOnly: boolean;
  pacing: Record<PacingAction, PacingConfig>;
}

/** Full metadata for a family, convenience for the UI/adapter that
 *  wants the whole record rather than three separate calls. */
export function familyInfo(family: AtsFamily): AtsFamilyInfo {
  return {
    family,
    requiresAccount: requiresAccount(family),
    reviewOnly: isReviewOnly(family),
    pacing: PACING[family],
  };
}
