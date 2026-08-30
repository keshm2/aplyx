import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { tenantKeyFor } from "@aplyx/core/atsRegistry.js";
import { importWorkdayCredential, readWorkdayCredential, saveWorkdayCredential } from "./bridge";

/** Resolves a raw Workday URL/host into the canonical tenant key
 *  (atsRegistry's own hostname normalization) the same way
 *  AccountCenterScreen's manual "Connect an ATS account" form does. */
export function normalizedWorkdayTenant(rawHost: string): string {
  const candidate = rawHost.trim().includes("://") ? rawHost.trim() : `https://${rawHost.trim()}`;
  const url = new URL(candidate);
  const tenant = tenantKeyFor("workday", url.toString());
  if (!tenant) throw new Error("Workday tenant must be a hostname ending in .myworkdayjobs.com");
  return tenant;
}

/** Pushes a Workday credential into the signed-in user's online ATS
 *  account vault (Supabase), same write path AccountCenterScreen's
 *  manual "Save to online vault"/"Import from this device" already use
 *  (create-or-reuse the account row, then rotate its secret so an
 *  explicit save always updates the stored value rather than silently
 *  keeping an old one). Also refreshes this device's own OS-keychain
 *  cache so the local Workday runtime picks up the same value. */
export async function pushWorkdayCredentialToVault(
  client: SupabaseClient,
  userId: string,
  tenantKey: string,
  companyName: string,
  username: string,
  password: string,
): Promise<void> {
  const trimmedCompany = companyName.trim();
  const trimmedUsername = username.trim();
  if (!trimmedCompany) throw new Error("Company name is required.");
  if (!trimmedUsername || !trimmedUsername.includes("@")) throw new Error("Workday account email is invalid.");
  if (!password || password.includes("\n") || password.includes("\r")) throw new Error("Workday password must be non-empty and single-line.");
  const adapter = new SupabaseAdapter(client, userId);
  const { accountId } = await adapter.createOrReuseApplicationAccount({
    family: "workday",
    tenantKey,
    companyName: trimmedCompany,
    username: trimmedUsername,
    password,
  });
  await adapter.rotateApplicationAccountSecret(accountId, trimmedUsername, password);
  // The Vault write above is the durable, important one — a failure to
  // also refresh this device's local keychain cache shouldn't be able to
  // make an otherwise-successful save look like it failed.
  try {
    await saveWorkdayCredential(tenantKey, trimmedUsername, password);
  } catch {
    // best-effort — see comment above
  }
}

/**
 * Best-effort auto-sync run right after a local Workday continuation
 * attempt: if the runtime just generated a brand-new account password
 * (only true the first time an account is created — see
 * approve_submit_workday.py's _save_local_password), pull it out of its
 * local sidecar/keychain cache and push it into the online vault
 * automatically, so a freshly-created Workday account shows up in ATS
 * Accounts without the user having to separately open Settings and
 * re-type what aplyx already generated.
 *
 * Deliberately silent on the common case (nothing new to sync — the
 * account already existed, or account creation never got that far):
 * importWorkdayCredential throws "no existing local Workday credential
 * was found" whenever there's no fresh sidecar, which is the normal
 * outcome for the vast majority of continuation attempts. Any other
 * failure is swallowed too — this is a convenience on top of the
 * already-working manual sync in AccountCenterScreen, never a step
 * that should be able to fail a Workday continuation the user is
 * actively watching.
 */
export async function autoSyncWorkdayCredentialAfterRun(
  client: SupabaseClient,
  userId: string,
  root: string,
  rawHost: string,
  companyName: string,
  accountEmail: string,
): Promise<void> {
  const email = accountEmail.trim();
  if (!email) return;
  let tenantKey: string;
  try {
    tenantKey = normalizedWorkdayTenant(rawHost);
  } catch {
    return; // not a recognizable Workday URL — nothing to sync
  }
  try {
    // Sidecar lookup is keyed by hash(email + host) — see
    // approve_submit_workday.py's _account_key. Throws "no existing
    // local Workday credential was found" whenever there's nothing
    // fresh, which is the normal outcome for the vast majority of
    // continuation attempts (an already-existing account, or one that
    // never reached account creation this run) — that case is expected,
    // not an error worth surfacing.
    await importWorkdayCredential(root, tenantKey, email);
  } catch {
    return;
  }
  try {
    const { password } = await readWorkdayCredential(tenantKey, email);
    await pushWorkdayCredentialToVault(client, userId, tenantKey, companyName, email, password);
  } catch {
    // The credential made it into this device's OS keychain either way
    // (importWorkdayCredential already succeeded above) — a vault push
    // failure here just means the next visit to Settings' "Sync to this
    // device"/manual save still has real local data to work from; it
    // never strands the credential nowhere.
  }
}
