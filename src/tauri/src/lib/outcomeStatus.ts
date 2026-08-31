/** Shared between StatusScreen and HomeScreen's tracking widgets: one
 *  place for these two maps so a new outcome_status value (see migration
 *  0021/0007) only needs updating once, not once per screen. */
export const OUTCOME_BADGE: Record<string, string> = {
  applied: "status-badge-good",
  oa_sent: "status-badge-info",
  oa_completed: "status-badge-info",
  interview_requested: "status-badge-special",
  offer: "status-badge-good",
  rejected: "status-badge-danger",
  withdrawn: "status-badge-muted",
};

export const OUTCOME_LABEL: Record<string, string> = {
  applied: "Applied",
  oa_sent: "OA sent",
  oa_completed: "OA completed",
  interview_requested: "Interview requested",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** dataList.css's .status-dot-* variants mirror .status-badge-* 1:1 by
 *  name: a list row (dense, many at once) wants the dot register, not
 *  the filled-pill one a single emphasized status (a detail sheet header)
 *  still uses. Converts an OUTCOME_BADGE lookup instead of keeping a
 *  second map that could drift out of sync with it. */
export function outcomeDotClass(outcomeStatus: string | undefined): string {
  const badgeClass = OUTCOME_BADGE[outcomeStatus ?? "applied"] ?? "status-badge-muted";
  return badgeClass.replace("status-badge-", "status-dot-");
}
