import { useCallback, useEffect, useState } from "react";
import type { AplyxState } from "@aplyx/core/state.js";
import { SupabaseAdapter } from "@aplyx/core/adapters/supabase.js";
import { useAuth } from "./AuthContext";
import { getSupabaseClient } from "./supabaseClient";
import { findRoot, loadLocalState } from "./bridge";

export type StateSource = "local" | "hosted" | "none";

export interface AplyxStateHandle {
  state: AplyxState | undefined;
  loaded: boolean;
  /** Which source `state` came from: "local" and "hosted" screens branch
   *  their mutation actions on this (local goes through the Rust/bridge IPC,
   *  hosted goes through SupabaseAdapter directly); "none" means neither a
   *  local install nor a hosted session is available. */
  source: StateSource;
  /** Set only when source === "local": for the handful of local-only
   *  actions (reopening a pre-filled application, live job search) that
   *  have no hosted equivalent and still need the root path directly. */
  root: string | undefined;
  /** Hosted mutations need a live client + userId; undefined unless
   *  source === "hosted". Screens pass this straight to a new
   *  SupabaseAdapter rather than each re-deriving it. */
  hosted: { client: Awaited<ReturnType<typeof getSupabaseClient>>; userId: string } | undefined;
  refresh: () => Promise<void>;
}

/**
 * Shared "which state source is this session using" resolution: a local
 * install wins when found (same precedent as HomeScreen's original
 * nextAction logic: local data always drove the dashboard when present),
 * a signed-in hosted session is the fallback when no local install exists,
 * and "none" covers a signed-out session with no local install either.
 * Every pipeline-state screen (Home/Review/Status/Documents) used to
 * duplicate its own copy of "try findRoot, catch, setState(undefined)";
 * this is that logic in exactly one place, now hosted-aware too.
 */
export function useAplyxState(): AplyxStateHandle {
  const { status, session } = useAuth();
  const [state, setState] = useState<AplyxState | undefined>(undefined);
  const [source, setSource] = useState<StateSource>("none");
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [hosted, setHosted] = useState<AplyxStateHandle["hosted"]>(undefined);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await findRoot();
      setRoot(r);
      setHosted(undefined);
      setSource("local");
      setState((await loadLocalState(r)) as AplyxState);
      return;
    } catch {
      setRoot(undefined);
    }
    if (status === "signed-in" && session) {
      try {
        const client = await getSupabaseClient();
        const adapter = new SupabaseAdapter(client, session.user.id);
        const hostedState = await adapter.loadState();
        setHosted({ client, userId: session.user.id });
        setSource("hosted");
        setState(hostedState);
        return;
      } catch {
        // Falls through to "none" below: a hosted fetch failure reads the
        // same as "nothing to show" rather than a hard error screen, same
        // tolerance the local path already had for a missing install.
      }
    }
    setHosted(undefined);
    setSource("none");
    setState(undefined);
  }, [status, session]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    refresh().finally(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Local state lives in plain files on disk (data/applied_jobs.json etc.)
  // that the background scheduler writes to independently of this window;
  // without a poll, an application the scheduler submits while the app is
  // open would never show up (Home's stat cards, the recommended-jobs
  // exclude list) until something else happened to trigger a refresh
  // (an auth change, a remount). A 60s interval is cheap: this is a
  // handful of small local JSON reads, not real work, and frequent enough
  // that "applied while I was looking at Home" feels live rather than
  // stale for a whole 30-min scheduler cycle.
  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return { state, loaded, source, root, hosted, refresh };
}
