/* aplyx.app — site-wide "signed in" nav state. Runs on every page (not
 * just account.html) so a signed-in visitor never sees a "Sign in" link
 * pointing at a page that would just show them their own dashboard
 * anyway. Same auth project as account.js/AuthContext.tsx — checking a
 * session here doesn't create one; it only reads whatever's already
 * there (a page load with no session is the normal, cheap case for
 * every anonymous visitor to the marketing site).
 *
 * Deliberately its own module, not folded into site.js — site.js is a
 * plain non-module script included on every page; this needs `import`
 * for the Supabase client, so it stays isolated the same way
 * account.js already is. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AUTH_CONFIG = {
  url: "https://aedejjesqcbndphkldfs.supabase.co",
  anonKey: "sb_publishable_d3pJdWv70x7tYbDEWoGkFw_HCUpS1_i",
};

const SVG_NS = "http://www.w3.org/2000/svg";

function buildAvatarIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const head = document.createElementNS(SVG_NS, "circle");
  head.setAttribute("cx", "12");
  head.setAttribute("cy", "8");
  head.setAttribute("r", "4");

  const shoulders = document.createElementNS(SVG_NS, "path");
  shoulders.setAttribute("d", "M4 20c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5");

  svg.append(head, shoulders);
  return svg;
}

function showSignedInNav(email) {
  document.querySelectorAll(".nav-link-account").forEach((link) => {
    link.classList.add("nav-avatar-link");
    link.setAttribute("aria-label", email ? `Account — signed in as ${email}` : "Account");
    link.title = email ?? "";
    link.replaceChildren();
    const avatar = document.createElement("span");
    avatar.className = "nav-avatar";
    avatar.appendChild(buildAvatarIcon());
    link.appendChild(avatar);
  });
}

// Exported so account.js can reuse this exact instance instead of
// creating a second GoTrueClient against the same storage key — two
// independent clients for one session produces exactly the "Multiple
// GoTrueClient instances" warning Supabase logs (confirmed live on
// account.html, where both scripts run), and real risk of the two
// disagreeing on auth state, not just log noise. ES modules are
// singleton-cached per URL, so this module's top-level code (including
// this createClient call) only ever runs once regardless of how many
// pages import it or include it via a <script type="module"> tag.
export const supabase = createClient(AUTH_CONFIG.url, AUTH_CONFIG.anonKey);

supabase.auth.getSession().then(({ data }) => {
  if (data.session) showSignedInNav(data.session.user.email);
});

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) {
    showSignedInNav(session.user.email);
  } else {
    // Signed out in another tab — only revert pages that aren't
    // account.html itself, which already owns its own signed-out view
    // via account.js and would otherwise fight this for the same element.
    if (!document.getElementById("auth-panel")) {
      document.querySelectorAll(".nav-link-account").forEach((link) => {
        link.classList.remove("nav-avatar-link");
        link.removeAttribute("aria-label");
        link.title = "";
        link.textContent = "Sign in";
      });
    }
  }
});
