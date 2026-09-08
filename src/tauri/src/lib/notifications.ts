import { useEffect, useMemo, useState } from "react";
import { CHANGELOG_NOTIFICATIONS } from "@aplyx/core/changelogNotifications.js";
import type { AplyxState } from "@aplyx/core/state.js";
import { findRoot, hasLocalInstall, loadLocalState, verifyIntegrity, type IntegrityResult } from "./bridge";

/**
 * The notification bell's two tabs. "General" is app-level news (release
 * changelogs); "Jobs" is every job alert/application/status report, the
 * outcomes already recorded in the local install's own state, not a
 * separate write path of their own. There is deliberately no third data
 * source or server round-trip: everything here is derived from data the
 * app already has (CHANGELOG_NOTIFICATIONS, baked in at build time; the
 * local install's applied-jobs list, already fetched for Home) plus a
 * small localStorage-backed "read" set: no new backend surface.
 */
export type NotificationTab = "general" | "jobs";
export type NotificationSeverity = "critical" | "warn" | "good" | "info";

export interface NotificationItem {
  id: string;
  tab: NotificationTab;
  severity: NotificationSeverity;
  title: string;
  detail?: string[];
  timestamp: number;
}

const READ_KEY = "aplyx.notifications.read";

function loadReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveReadIds(ids: Set<string>): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...ids]));
  } catch {
    // best-effort: worst case, everything reads as unread again next launch
  }
}

function buildGeneralNotifications(): NotificationItem[] {
  return CHANGELOG_NOTIFICATIONS.map((entry) => ({
    id: `changelog:${entry.version}`,
    tab: "general",
    severity: "info",
    title: `aplyx ${entry.version}`,
    detail: entry.bullets,
    timestamp: Date.parse(`${entry.date}T00:00:00Z`) || 0,
  }));
}

/** One critical notification when verify_integrity.py reports a tampered
 *  local build (a modified enforcement file, a re-enabled hosted-only
 *  agent). Local-derived, same as the rest — no server round-trip; the
 *  account-side record is synced separately by integritySync.ts. */
function buildIntegrityNotifications(result: IntegrityResult | undefined): NotificationItem[] {
  if (!result || result.ok || result.violations.length === 0) return [];
  return [{
    id: "integrity:violation",
    tab: "general",
    severity: "critical",
    title: "This aplyx install has been modified",
    detail: [
      "Files that enforce the daily application limit or a paid-only feature no longer match the release.",
      ...result.violations.slice(0, 5).map((v) => `${v.kind}: ${v.path}`),
      "Reinstall to restore a clean build. While this stands, the account can't be used for hosted runs.",
    ],
    timestamp: Date.now(),
  }];
}

/** Caps at the most recent 25 outcomes: this is a notification feed, not
 *  a full status browser (the Status tab already exists for that). */
function buildJobNotifications(local: AplyxState | undefined): NotificationItem[] {
  if (!local) return [];
  return local.applied
    .slice()
    .sort((a, b) => (Date.parse(b.date_applied) || 0) - (Date.parse(a.date_applied) || 0))
    .slice(0, 25)
    .map((job) => {
      const severity: NotificationSeverity =
        job.status === "failed" ? "critical" : job.status === "needs_review" ? "warn" : "good";
      const title =
        job.status === "applied"
          ? `Applied: ${job.title}`
          : job.status === "needs_review"
            ? `Needs review: ${job.title}`
            : `Application failed: ${job.title}`;
      return {
        id: `job:${job.job_id}:${job.status}`,
        tab: "jobs",
        severity,
        title,
        detail: [job.company],
        timestamp: Date.parse(job.date_applied) || 0,
      };
    });
}

/** `refreshKey`: pass something that changes on navigation (e.g. the
 *  router location) so a newly-applied job shows up without requiring a
 *  full app restart, without needing a polling timer. */
export function useNotifications(refreshKey: unknown): {
  items: NotificationItem[];
  isRead: (id: string) => boolean;
  markRead: (id: string) => void;
  markAllRead: (tab?: NotificationTab) => void;
  unreadCount: (tab?: NotificationTab) => number;
} {
  const [local, setLocal] = useState<AplyxState | undefined>(undefined);
  const [integrity, setIntegrity] = useState<IntegrityResult | undefined>(undefined);
  const [readIds, setReadIds] = useState<Set<string>>(() => loadReadIds());

  useEffect(() => {
    let cancelled = false;
    hasLocalInstall()
      .then(async (has) => {
        if (!has || cancelled) return;
        const root = await findRoot();
        const state = (await loadLocalState(root)) as AplyxState | null;
        if (!cancelled) setLocal(state ?? undefined);
        const iv = await verifyIntegrity(root).catch(() => undefined);
        if (!cancelled) setIntegrity(iv);
      })
      .catch(() => {
        /* no local install / bridge unavailable: General tab still works */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const items = useMemo(() => {
    return [
      ...buildIntegrityNotifications(integrity),
      ...buildGeneralNotifications(),
      ...buildJobNotifications(local),
    ].sort((a, b) => b.timestamp - a.timestamp);
  }, [local, integrity]);

  function markRead(id: string) {
    setReadIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      saveReadIds(next);
      return next;
    });
  }

  function markAllRead(tab?: NotificationTab) {
    setReadIds((prev) => {
      const next = new Set(prev);
      for (const item of items) {
        if (!tab || item.tab === tab) next.add(item.id);
      }
      saveReadIds(next);
      return next;
    });
  }

  function unreadCount(tab?: NotificationTab): number {
    let n = 0;
    for (const item of items) {
      if ((!tab || item.tab === tab) && !readIds.has(item.id)) n++;
    }
    return n;
  }

  return { items, isRead: (id) => readIds.has(id), markRead, markAllRead, unreadCount };
}
