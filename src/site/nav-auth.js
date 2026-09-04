/* aplyx.app: site-wide "signed in" nav state. Runs on every page (not
 * just account.html) so a signed-in visitor never sees a "Sign in" link
 * pointing at a page that would just show them their own dashboard
 * anyway. Same auth project as account.js/AuthContext.tsx: checking a
 * session here doesn't create one; it only reads whatever's already
 * there (a page load with no session is the normal, cheap case for
 * every anonymous visitor to the marketing site).
 *
 * Deliberately its own module, not folded into site.js: site.js is a
 * plain non-module script included on every page; this needs `import`
 * for the Supabase client, so it stays isolated the same way
 * account.js already is. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AUTH_CONFIG = {
  url: "https://aedejjesqcbndphkldfs.supabase.co",
  anonKey: "sb_publishable_d3pJdWv70x7tYbDEWoGkFw_HCUpS1_i",
};

/* --- Identity avatar: a Google profile photo when one exists, else
 * initials in a chip (never the generic person-outline icon every AI-
 * generated auth UI ships). Shared between the site-wide nav link here
 * and account.js's dashboard sidebar, so "who am I signed in as" reads
 * the same way everywhere on the site. */

/** "Kesh Muthu" -> "KM", "kesh" -> "KE", falls back to the email's local
 *  part ("kesh.muthu04@…" -> "KM") when no display name is known yet. */
export function initialsFrom(name, email) {
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

/** Google OAuth populates both of these on user_metadata; other
 *  providers (email/password) populate neither, which is the normal
 *  case a caller falls back to profile-table names for. */
export function displayNameFromMetadata(metadata) {
  return (metadata && (metadata.full_name || metadata.name)) || "";
}
export function avatarUrlFromMetadata(metadata) {
  return (metadata && (metadata.avatar_url || metadata.picture)) || "";
}

/** Builds the avatar node: an <img> for a real profile photo (falling
 *  back to initials if it 404s, is revoked, or is blocked), otherwise
 *  straight to an initials chip. `size` in px, defaults to the CSS's own
 *  sizing when omitted (nav vs. dashboard-sidebar need different sizes). */
export function buildAvatarNode({ name, email, avatarUrl, size } = {}) {
  const wrap = document.createElement("span");
  wrap.className = "avatar-chip";
  if (size) wrap.style.setProperty("--avatar-size", `${size}px`);

  function showInitials() {
    wrap.replaceChildren();
    wrap.classList.add("avatar-chip-initials");
    wrap.textContent = initialsFrom(name, email);
  }

  if (avatarUrl) {
    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = showInitials;
    wrap.appendChild(img);
  } else {
    showInitials();
  }
  return wrap;
}

// Cached per user id so a page with several signed-in nav links (there's
// normally just one) or a later onAuthStateChange re-fire doesn't repeat
// the profiles lookup; cleared implicitly by just keying on the new id.
let cachedName;

/** The nav avatar has no access to account.js's already-loaded profile
 *  state (this module runs standalone on every page), so when there's no
 *  Google display name it does its own minimal, RLS-scoped lookup of the
 *  three name fields. Never blocks showing *an* avatar: falls back to
 *  initials-from-email immediately, then swaps in the real name shortly
 *  after if the lookup succeeds. */
async function resolveDisplayName(session) {
  const metaName = displayNameFromMetadata(session.user.user_metadata);
  if (metaName) return metaName;
  if (cachedName && cachedName.userId === session.user.id) return cachedName.name;
  try {
    const { data } = await supabase
      .from("profiles")
      .select("preferred_name, first_name, last_name")
      .eq("user_id", session.user.id)
      .maybeSingle();
    const name = (data && (data.preferred_name || [data.first_name, data.last_name].filter(Boolean).join(" "))) || "";
    cachedName = { userId: session.user.id, name };
    return name;
  } catch {
    return "";
  }
}

function showSignedInNav(session) {
  const email = session.user.email;
  const avatarUrl = avatarUrlFromMetadata(session.user.user_metadata);
  const metaName = displayNameFromMetadata(session.user.user_metadata);

  function render(name) {
    document.querySelectorAll(".nav-link-account").forEach((link) => {
      link.classList.add("nav-avatar-link");
      link.setAttribute("aria-label", name || email ? `Account: signed in as ${name || email}` : "Account");
      link.title = name || email || "";
      link.replaceChildren(buildAvatarNode({ name, email, avatarUrl }));
    });
  }

  render(metaName); // immediate, correct for every Google sign-in
  if (!metaName) {
    // Email/password accounts: the initials-from-email render above is
    // already correct output, this just upgrades to the real name once
    // the (cheap, cached) profiles lookup resolves.
    resolveDisplayName(session).then((name) => {
      if (name) render(name);
    });
  }
}

function showSignedOutNav() {
  document.querySelectorAll(".nav-link-account").forEach((link) => {
    link.classList.remove("nav-avatar-link");
    link.removeAttribute("aria-label");
    link.title = "";
    link.textContent = "Sign in";
  });
}

// Exported so account.js can reuse this exact instance instead of
// creating a second GoTrueClient against the same storage key: two
// independent clients for one session produces exactly the "Multiple
// GoTrueClient instances" warning Supabase logs (confirmed live on
// account.html, where both scripts run), and real risk of the two
// disagreeing on auth state, not just log noise. ES modules are
// singleton-cached per URL, so this module's top-level code (including
// this createClient call) only ever runs once regardless of how many
// pages import it or include it via a <script type="module"> tag.
export const supabase = createClient(AUTH_CONFIG.url, AUTH_CONFIG.anonKey);

supabase.auth.getSession().then(({ data }) => {
  if (data.session) showSignedInNav(data.session);
});

supabase.auth.onAuthStateChange((_event, session) => {
  // Fires on every page, including account.html; account.js listens to
  // the same shared client and handles its own auth-panel/dashboard-panel
  // swap independently, but never touches .nav-link-account itself, so
  // this is the only thing that reverts the nav avatar there too. (An
  // earlier version skipped account.html here on the assumption account.js
  // already covered it; it didn't, which left the avatar showing after
  // sign-out until something else re-triggered a check.)
  if (session) {
    showSignedInNav(session);
  } else {
    showSignedOutNav();
  }
});
