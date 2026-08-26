/**
 * Applies the in-app "Reduced motion" setting (Settings, backed by
 * APLYX_REDUCED_MOTION in src/config/env.json, same mechanism as the
 * TUI's own setting) as a `data-reduced-motion="1"` attribute on <html>.
 * Every CSS file with an OS-level `@media (prefers-reduced-motion: reduce)`
 * block has a companion `:root[data-reduced-motion="1"]` rule mirroring
 * it exactly (tokens.css, motion.css, and the component stylesheets), so
 * flipping this one attribute reaches every animation the app already
 * knows how to calm down. Nothing new to maintain per component.
 */
export function applyReducedMotionAttr(enabled: boolean): void {
  if (enabled) document.documentElement.dataset.reducedMotion = "1";
  else delete document.documentElement.dataset.reducedMotion;
}
