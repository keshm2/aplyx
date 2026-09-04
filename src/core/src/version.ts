/**
 * The aplyx release/build marker, shown faded in both the TUI's side
 * panel footer (src/tui/src/theme.ts re-exports this for src/tui/src/ui/
 * SidePanel.tsx) and the desktop app's Settings screen, so both surfaces
 * always report the same build without two hand-maintained copies
 * drifting apart. Bumped by hand alongside VERSION (repo root) and
 * src/tui/package.json's semver-shaped "version" field on every release:
 * see docs/CHANGELOG.md for the mapping between this and the npm semver
 * string (e.g. "0.9.945a" here, "0.9.945-alpha.0" published to npm).
 */
export const BUILD_MARKER = "1.0.8b";
