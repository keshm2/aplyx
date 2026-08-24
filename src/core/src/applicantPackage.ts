/**
 * Applicant package — the assembled inputs an apply run submits with.
 * This is the bridge between the master resume (source of truth) and
 * the live form-fill: it carries the master resume, the tailored
 * resume artifact (when one was produced), the cover letter (when
 * used), the contact email/alias to use, and a snapshot of the
 * safe_fields the form-fill will draw from.
 *
 * Design decisions (AGENTS.md, docs/hosted-auto-apply-plan.md):
 * - **One editable master resume is the source of truth.** The master
 *   resume (src/core/src/masterResume.ts) is what the operator edits;
 *   tailoring produces an artifact (tailored bullets / a tailored
 *   resume PDF) derived from it, never a second editable document.
 * - **Tailored resume artifact is uploaded when available.** When
 *   @resume-tailor produced a tailored resume (PreviewTailoredResumeResult
 *   / the tailored_bullets on AppliedJob), that artifact is what gets
 *   uploaded to the form's resume field — not the raw master. When no
 *   tailored artifact exists (a pre-tailoring needs_review, or a
 *   guest apply with no tailoring pass), the master resume PDF is the
 *   fallback.
 * - **Guest flows use the applicant's real email; account-required
 *   flows use a managed mail.aplyx.app alias.** atsRegistry.ts's
 *   requiresAccount() drives which email lands in the package: a
 *   managed alias (managed_aliases migration) for account-required
 *   families, the safe_fields email for guest families. The alias
 *   keeps employer replies flowing through aplyx's inbox
 *   (inbound_emails migration) instead of the applicant's personal
 *   inbox, so outcome tracking works without the user forwarding mail.
 */

import type { AtsFamily } from "./atsRegistry.js";
import { requiresAccount } from "./atsRegistry.js";
import type { MasterResume } from "./masterResume.js";

/** The email address the form-fill will type into the email field.
 *  Either the applicant's real email (guest flow) or a managed alias
 *  at mail.aplyx.app (account-required flow). The alias_id is present
 *  only for the managed-alias case, so the UI/worker can correlate
 *  inbound replies back to this apply run. */
export interface ApplicantEmail {
  /** The email address to type into the form. */
  address: string;
  /** True when this is a managed mail.aplyx.app alias, false when it's
   *  the applicant's real email from safe_fields. */
  managed: boolean;
  /** The managed_aliases row id, present only when managed=true. */
  aliasId?: string;
}

/** A tailored resume artifact produced by @resume-tailor for a specific
 *  posting. This is derived from the master resume (never a second
 *  editable document) and is what gets uploaded to the form's resume
 *  field when available. The master resume PDF is the fallback when
 *  no tailored artifact exists. */
export interface TailoredResumeArtifact {
  /** The tailored resume document (selected/reordered bullets from the
   *  master, per masterResume.ts's MasterResume shape). */
  resume: MasterResume;
  /** @resume-tailor's short label for this application's tailoring
   *  emphasis (e.g. "backend + infra focus") — carried through to
   *  AppliedJob.resume_used. */
  label: string;
  /** ATS keywords resume-tailor flagged as missing from the tailored
   *  resume — review context, not a blocker. Mirrors
   *  AppliedJob.missing_keywords. */
  missingKeywords?: string[];
  /** The tailored bullets, when the tailoring pass produced a
   *  bullet-level artifact (mirrors AppliedJob.tailored_bullets). */
  bullets?: string[];
  /** The tailored cover letter body, when one was produced (mirrors
   *  AppliedJob.cover_letter). */
  coverLetter?: string;
  /** The ats_score from the tailoring pass (mirrors AppliedJob.ats_score). */
  atsScore?: number;
}

/** Which existing/created ATS account (application_accounts, migration
 *  0027/0028) this package's account-required flow is tied to. Carries
 *  only the account id and its current lifecycle status — never a
 *  username or password; those live only in Vault and are fetched
 *  just-in-time by the runtime that actually needs to type them into a
 *  form (reveal_own_account_credential / resolve_application_account_
 *  credential_token), never threaded through this package. */
export interface ApplicationAccountRef {
  accountId: string;
  status: string;
}

export interface ApplicantPackage {
  /** The family this package was assembled for — drives whether the
   *  email is a managed alias or the real email. */
  family: AtsFamily;
  /** The master resume (source of truth). Always present — even when a
   *  tailored artifact exists, the master is what the operator edits
   *  and what a re-tailor derives from. */
  masterResume: MasterResume;
  /** The tailored artifact, when @resume-tailor produced one. When
   *  absent, the form-fill uploads the master resume PDF directly. */
  tailored?: TailoredResumeArtifact;
  /** The email address to use for this application. */
  email: ApplicantEmail;
  /** The ATS account this package's account-required flow is tied to,
   *  once the caller has created-or-reused one (SupabaseAdapter's
   *  createOrReuseApplicationAccount). Undefined for guest families,
   *  and may still be undefined for an account-required family whose
   *  account hasn't been created yet at assembly time — creating the
   *  account is a separate step from assembling the package, and
   *  assembling the package never creates one implicitly. */
  applicationAccount?: ApplicationAccountRef;
  /** A snapshot of the safe_fields values the form-fill will draw
   *  from, keyed by the safe_fields key (first_name, phone, …).
   *  Snapshotted at assembly time so a mid-run config edit doesn't
   *  change what gets typed into a half-filled form — same
   *  read-then-act discipline as the local Phase 3 protocol. */
  safeFields: Record<string, string>;
  /** Whether a cover letter is being submitted with this package.
   *  Mirrors AppliedJob.cover_letter_used. */
  coverLetterUsed: boolean;
  /** ISO timestamp of assembly. */
  assembledAt: string;
}

export interface ApplicantPackageInput {
  family: AtsFamily;
  masterResume: MasterResume;
  tailored?: TailoredResumeArtifact;
  /** The applicant's real email from safe_fields — used directly for
   *  guest flows. */
  realEmail: string;
  /** A managed alias to use for account-required flows, when one has
   *  been claimed (managed_aliases migration). When undefined and the
   *  family requires an account, the run cannot proceed — the caller
   *  routes to needs_review ("no managed alias available for
   *  account-required family <family>"). */
  managedAlias?: { address: string; aliasId: string };
  /** The account-required flow's ATS account, when the caller has
   *  already created or reused one for this (user, family, tenant).
   *  Optional — see ApplicantPackage.applicationAccount. */
  applicationAccount?: ApplicationAccountRef;
  safeFields: Record<string, string>;
  coverLetterUsed?: boolean;
}

/** Assemble a package from its inputs. Resolves the email per the
 *  family's account model: managed alias for account-required, real
 *  email for guest. Throws when an account-required family has no
 *  managed alias — the caller surfaces this as a needs_review, never
 *  silently falls back to the real email (which would break the
 *  managed-alias inbox-tracking path for that application). */
export function assembleApplicantPackage(input: ApplicantPackageInput): ApplicantPackage {
  const needsAccount = requiresAccount(input.family);
  const email: ApplicantEmail = needsAccount
    ? input.managedAlias
      ? { address: input.managedAlias.address, managed: true, aliasId: input.managedAlias.aliasId }
      : throwNoAlias(input.family)
    : { address: input.realEmail, managed: false };

  return {
    family: input.family,
    masterResume: input.masterResume,
    tailored: input.tailored,
    email,
    applicationAccount: needsAccount ? input.applicationAccount : undefined,
    safeFields: input.safeFields,
    coverLetterUsed: input.coverLetterUsed ?? Boolean(input.tailored?.coverLetter),
    assembledAt: new Date().toISOString(),
  };
}

function throwNoAlias(family: AtsFamily): ApplicantEmail {
  throw new Error(
    `no managed alias available for account-required family "${family}"; ` +
      `claim a managed alias before assembling the package, or route to needs_review`,
  );
}

/** The resume document to upload to the form: the tailored artifact
 *  when one exists, else the master resume. Encodes the "tailored
 *  artifact is uploaded when available" decision in one place so the
 *  form-fill step and the UI's package preview agree. */
export function resumeToUpload(pkg: ApplicantPackage): MasterResume {
  return pkg.tailored?.resume ?? pkg.masterResume;
}
