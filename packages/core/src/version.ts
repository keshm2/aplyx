/**
 * The aplyx release/build marker — shown faded in both the TUI's side
 * panel footer (app/src/theme.ts re-exports this for app/src/ui/
 * SidePanel.tsx) and the desktop app's Settings screen, so both surfaces
 * always report the same build without two hand-maintained copies
 * drifting apart. Bumped by hand alongside VERSION (repo root) and
 * app/package.json's semver-shaped "version" field on every release —
 * see docs/CHANGELOG.md for the mapping between this and the npm semver
 * string (e.g. "0.9.88a" here, "0.9.88-alpha.0" published to npm).
 */
export const BUILD_MARKER = "0.9.88a";
