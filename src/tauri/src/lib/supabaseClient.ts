import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SUPABASE_CONFIG } from "@aplyx/core/supabaseConfig.js";
import { findRoot, readSupabaseConfig } from "./bridge";

let cachedClient: SupabaseClient | undefined;

/**
 * Lazily creates the Supabase client, preferring a local src/config/
 * supabase.json override (read via the Rust bridge; self-hosters can
 * point hosted mode at their own backend this way) and falling back to
 * aplyx's own baked-in hosted-auth project (DEFAULT_SUPABASE_CONFIG)
 * otherwise. Critically, that fallback does NOT require findRoot() to
 * succeed: "Sign in" is offered as an alternative to "Run locally" on
 * the entry screen, not a feature of it, so a user who never set up (or
 * lost) a local checkout must still be able to use it: findRoot()
 * failing here used to propagate as "Sign-in couldn't start," blocking
 * hosted mode for a reason that has nothing to do with hosted mode. Only
 * a successfully created client is cached; a config change is re-picked
 * up on the next call, so dropping in src/config/supabase.json doesn't
 * require an app restart.
 */
export async function getSupabaseClient(): Promise<SupabaseClient> {
  if (cachedClient) return cachedClient;
  let config = DEFAULT_SUPABASE_CONFIG;
  try {
    const root = await findRoot();
    config = await readSupabaseConfig(root);
  } catch {
    // No local checkout (or the bridge failed); fine, hosted mode
    // doesn't need one. Proceed with the baked-in default.
  }
  cachedClient = createClient(config.url, config.anonKey, {
    // flowType "pkce" is required: AuthContext finishes both the
    // email-confirmation and Google OAuth callbacks with
    // exchangeCodeForSession(), which only exists in the PKCE flow: the
    // default implicit flow puts tokens in a URL fragment instead of
    // issuing a ?code=, so the aplyx:// deep-link callback could never
    // complete a session under it.
    auth: { persistSession: true, autoRefreshToken: true, flowType: "pkce" },
  });
  return cachedClient;
}
