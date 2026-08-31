/**
 * Short, user-facing "what's new" bullets (2-4 per release, plain
 * language, no internals), distinct from docs/RELEASE.md's deep-dive
 * write-ups (root cause, verification, file-level detail) and
 * docs/CHANGELOG.md's index of those. This is what actually shows up as
 * a "General" notification in the desktop app when it launches on a
 * build it hasn't shown the notification for yet (src/tauri/src/lib/
 * notifications.ts compares BUILD_MARKER against each entry's `version`
 * and the reader's own locally-stored "seen" set; nothing here decides
 * read/unread itself).
 *
 * Add one entry per release, newest first, when cutting a new version:
 * `version` must match src/core/src/version.ts's BUILD_MARKER
 * exactly for that release, or the notification never fires.
 */
export interface ChangelogNotification {
  version: string;
  date: string;
  bullets: string[];
}

export const CHANGELOG_NOTIFICATIONS: ChangelogNotification[] = [
  {
    version: "0.9.945a",
    date: "2026-07-25",
    bullets: [
      "Fixed the desktop app's Windows sign-in crash and slow, flashing page transitions.",
      "The desktop app now actually updates itself, including from scheduled background runs, not just manual updates.",
      "Online sign-in now works out of the box for everyone, not just this machine.",
      "Added the Ember Glow theme (Settings → Appearance).",
    ],
  },
];
