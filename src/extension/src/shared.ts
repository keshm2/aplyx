// Message contracts between the content script / options page and the
// background service worker. The service worker is the only component
// that holds the bridge token and talks to the localhost bridge.

export type AtsName = "greenhouse" | "lever" | "ashbyhq" | "workday";

export interface ExtractedJob {
  source: AtsName;
  company: string;
  title: string;
  url: string;
  location?: string;
  jd_text?: string;
}

export interface FitResponse {
  ok: boolean;
  error?: string;
  job_id?: string;
  job_key?: string;
  fit_status?: "candidate" | "needs_review" | "skipped_unfit";
  fit_score?: number;
  reasoning?: string;
  can_apply?: boolean;
  can_apply_detail?: string;
}

export interface FieldsResponse {
  ok: boolean;
  error?: string;
  fields?: Record<string, string>;
}

export interface OutcomeResponse {
  ok: boolean;
  error?: string;
  recorded?: boolean;
  reason?: string;
  status?: string;
  tracker_sync?: string;
}

export interface HealthResponse {
  ok: boolean;
  error?: string;
  service?: string;
  version?: string;
}

export type BridgeMessage =
  | { type: "health" }
  | { type: "fit"; job: ExtractedJob }
  | { type: "fields"; keys: string[] }
  | { type: "outcome"; job: ExtractedJob; status: "applied" | "needs_review" };

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8377";
