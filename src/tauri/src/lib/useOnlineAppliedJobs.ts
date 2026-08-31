import { useEffect, useState } from "react";
import type { AppliedJob } from "@aplyx/core/state.js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { useAuth } from "./AuthContext";
import { getSupabaseClient } from "./supabaseClient";

/**
 * The hosted-account applied_jobs list, independent of useAplyxState's
 * `source` (which prefers a local install whenever one's connected, see
 * that hook's own comment). Application-statuses tracking and Home's
 * "tracking" widgets both need this same hosted-specific list regardless
 * of what useAplyxState happens to be showing elsewhere, so this is that
 * fetch in one place instead of two independent copies drifting apart.
 * Polled every 60s so an outcome email-tracking-worker detects in the
 * background shows up without a manual refresh.
 */
export function useOnlineAppliedJobs(): { onlineJobs: AppliedJob[]; onlineLoaded: boolean; refreshOnlineJobs: () => Promise<void> } {
  const { status: authStatus, session } = useAuth();
  const [onlineJobs, setOnlineJobs] = useState<AppliedJob[]>([]);
  const [onlineLoaded, setOnlineLoaded] = useState(false);

  async function refreshOnlineJobs() {
    if (!session) {
      setOnlineJobs([]);
      setOnlineLoaded(true);
      return;
    }
    try {
      const client = await getSupabaseClient();
      const hostedState = await new SupabaseAdapter(client, session.user.id).loadState();
      setOnlineJobs(hostedState?.applied ?? []);
    } catch {
      // Best-effort: a fetch failure just leaves the last-known list.
    } finally {
      setOnlineLoaded(true);
    }
  }

  useEffect(() => {
    void refreshOnlineJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, session]);

  useEffect(() => {
    if (authStatus !== "signed-in") return;
    const id = window.setInterval(() => void refreshOnlineJobs(), 60_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, session]);

  return { onlineJobs, onlineLoaded, refreshOnlineJobs };
}
