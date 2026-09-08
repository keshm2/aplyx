import { useEffect, useState } from "react";
import { getSchedulerStatus, type SchedulerStatus } from "./bridge";
import type { StateSource } from "./useAplyxState";

/**
 * Local 30-min scheduler status, polled every 60s while a local install is
 * connected. Shared by Home's own SchedulerStatusCard and the Sidebar's
 * Activity group, both of which need the same heartbeat.
 */
export function useSchedulerStatus(source: StateSource, root: string | undefined): SchedulerStatus | undefined {
  const [status, setStatus] = useState<SchedulerStatus | undefined>(undefined);

  useEffect(() => {
    if (source !== "local" || !root) return;
    let cancelled = false;
    const fetchStatus = () =>
      getSchedulerStatus(root)
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          // A bridge failure just leaves the previous status on screen.
        });
    void fetchStatus();
    const id = window.setInterval(fetchStatus, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [source, root]);

  return status;
}
