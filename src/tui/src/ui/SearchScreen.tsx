import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { openUrl } from "@aplyx/core/helpers.js";
import {
  checkJobFit,
  errorMessage,
  resolveResultsPerPage,
  saveJobForReview,
  searchJobs,
  type FitResult,
  type JobSource,
  type SearchJob,
  type SourceResult,
} from "../jobs.js";
import { SELECT_MARKER, statusGlyph, theme } from "../theme.js";
import { DetailPane, PaneRow, PaneRule, paneLayout } from "./Pane.js";
import {
  InlineTextInput,
  deleteBackward,
  insertAtCursor,
  moveCursorLeft,
  moveCursorRight,
} from "./TextInput.js";

const SOURCE_LABEL: Record<JobSource, string> = {
  ashbyhq: "Ashby",
  lever: "Lever",
  greenhouse: "Greenhouse",
  smartrecruiters: "SmartRecruiters",
  amazon: "Amazon",
  oracle: "Oracle",
  workday: "Workday",
};
const SOURCES: JobSource[] = ["ashbyhq", "lever", "greenhouse", "smartrecruiters", "amazon", "oracle", "workday"];

type Action = "idle" | "searching" | "fitting" | "saving";

/** "23h ago" while posted today, "4d ago" through 5 days, then a plain
 *  month/day — matches how stale a posting reads: fresh postings want
 *  precision, week-plus-old ones just need a calendar reference. No year
 *  here (short/table form) — results are now capped to the last 6 months
 *  (see searchJobs' withinSixMonths), so month/day alone can't be
 *  confused across a year boundary the way it could with unbounded
 *  results; the full year still shows in the extended detail view below. */
function formatPosted(iso?: string): string {
  if (!iso) return "–";
  const posted = new Date(iso).getTime();
  if (Number.isNaN(posted)) return "–";
  const diffMs = Date.now() - posted;
  if (diffMs < 0) return "–";
  const hours = diffMs / 3_600_000;
  if (hours < 24) return `${Math.max(1, Math.floor(hours))}h ago`;
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 5) return `${days}d ago`;
  return new Date(posted).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" });
}

/** Absolute "date posted" for the detail/stacked info panel — always a
 *  full calendar date including the year (never "Xh/Xd ago", and never
 *  the year-less short form the table column uses) — the extended view
 *  is where the exact date belongs. */
function formatPostedFull(iso?: string): string {
  if (!iso) return "not listed";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "not listed";
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

function fitGlyph(status: FitResult["fit_status"]): string {
  if (status === "candidate") return statusGlyph.applied;
  if (status === "needs_review") return statusGlyph.needs_review;
  return statusGlyph.failed;
}

function fitColor(status: FitResult["fit_status"]): string {
  if (status === "candidate") return theme.good;
  if (status === "needs_review") return theme.warn;
  return theme.danger;
}

/** One fixed-width cell in the results table — every cell truncates
 *  independently so a long title can never bleed into the posted/
 *  location/fit columns after it. `hit` applies the same inverse
 *  highlight to every cell of the selected row, so the highlight reads
 *  as one continuous bar despite being built from several Text nodes. */
function Col({
  width,
  children,
  hit,
  dim,
  color,
}: {
  width: number;
  children: React.ReactNode;
  hit: boolean;
  dim?: boolean;
  color?: string;
}) {
  return (
    <Box width={width} flexShrink={0}>
      <Text color={hit ? theme.accent : color} inverse={hit} dimColor={dim && !hit} wrap="truncate-end">
        {children}
      </Text>
    </Box>
  );
}

export function SearchScreen({
  root,
  active,
  onInputActiveChange,
  onStateChange,
  contentRows,
  columns = 0,
}: {
  root: string;
  active: boolean;
  onInputActiveChange: (active: boolean) => void;
  onStateChange: () => void;
  /** Rows the shell hands this screen — the list grows/shrinks with it. */
  contentRows: number;
  /** Columns of the content band — a detail pane opens when it fits. */
  columns?: number;
}) {
  const [query, setQuery] = useState("");
  const [queryCursor, setQueryCursor] = useState(0);
  // Browse mode first: switching to this tab must never steal the
  // keyboard — typing starts only when the user presses /.
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<Action>("idle");
  const [jobs, setJobs] = useState<SearchJob[]>([]);
  // Discrete pages (default 25/page, Settings > Preferences > "Results
  // per page") over the already-fetched, already-sorted `jobs` array —
  // no re-fetch per page. Re-read when the tab becomes active again so
  // a change made on the Settings tab takes effect on return here,
  // without needing a full re-search. Distinct from `visible`/`offset`
  // below, which is the terminal-height-based scroll *within* one page
  // (a 25-item page can still be taller than the terminal).
  const [resultsPerPage, setResultsPerPage] = useState(() => resolveResultsPerPage(root));
  const [currentPage, setCurrentPage] = useState(0);
  useEffect(() => {
    if (active) setResultsPerPage(resolveResultsPerPage(root));
  }, [active, root]);
  const [sources, setSources] = useState<Partial<Record<JobSource, SourceResult>>>({});
  const [enabledSources, setEnabledSources] = useState<Record<JobSource, boolean>>({
    ashbyhq: true,
    lever: true,
    greenhouse: true,
    smartrecruiters: true,
    amazon: true,
    oracle: true,
    workday: true,
  });
  const [sourceFocused, setSourceFocused] = useState(false);
  const [sourceCursor, setSourceCursor] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState("Press / and type a title query, then enter to search the live boards.");
  const [fits, setFits] = useState<Record<string, FitResult>>({});
  // "loading." -> "loading.." -> "loading..." -> "loading." while a
  // search is in flight, replacing the static "Fetching X sources…"
  // message so a slow/borderline search still reads as alive, not stuck.
  const [loadingDots, setLoadingDots] = useState(1);
  useEffect(() => {
    if (action !== "searching") {
      setLoadingDots(1);
      return;
    }
    const interval = setInterval(() => setLoadingDots((d) => (d % 3) + 1), 400);
    return () => clearInterval(interval);
  }, [action]);
  // With the detail pane the list only shares rows with the query,
  // sources, and message lines; stacked (narrow) keeps room for the
  // inline selection details below the list.
  const pane = paneLayout(columns);
  const visible = Math.max(3, Math.min(30, contentRows - (pane.show ? 4 : 6)));
  const totalPages = Math.max(1, Math.ceil(jobs.length / resultsPerPage));
  const pagedJobs = jobs.slice(currentPage * resultsPerPage, (currentPage + 1) * resultsPerPage);
  // Fixed width per source toggle, each independently truncated — a long
  // failure detail (e.g. "2/8 failed: some-slug, another-slug") must never
  // overflow into the next source's cell or force the row onto a second
  // line, which corrupted the frame below it (the list has no reserved
  // extra row for a wrapped source line).
  const sourceColW = columns > 0 ? Math.max(20, Math.floor(columns / SOURCES.length) - 1) : 24;

  const busy = action !== "idle";
  // Also captured while toggling sources (sourceFocused): that mode uses
  // ←/→, which would otherwise be stolen by App's top-level tab-switch
  // handler (also bound to ←/→) since both useInput hooks fire
  // independently on the same keypress. "t" itself (the mode's entry/exit
  // key) is intentionally a key App never binds, so there's no race on
  // the very first press before this capture flag takes effect.
  const capturesInput = active && (editing || sourceFocused) && !busy;
  useEffect(() => {
    onInputActiveChange(capturesInput);
    return () => onInputActiveChange(false);
  }, [capturesInput, onInputActiveChange]);

  useEffect(() => {
    const next = Math.max(0, Math.min(pagedJobs.length - 1, cursor));
    if (next !== cursor) setCursor(next);
    const maxOffset = Math.max(0, pagedJobs.length - visible);
    if (offset > maxOffset) setOffset(maxOffset);
  }, [cursor, pagedJobs.length, offset, visible]);

  // Back to page 1 whenever the total page count shrinks below the
  // current page (a smaller "Results per page" mid-session, or a new
  // search with fewer pages of results) — never strand the view on a
  // now out-of-range page.
  useEffect(() => {
    if (currentPage > totalPages - 1) setCurrentPage(Math.max(0, totalPages - 1));
  }, [currentPage, totalPages]);

  const changePage = (delta: number) => {
    const next = Math.max(0, Math.min(totalPages - 1, currentPage + delta));
    if (next === currentPage) return;
    setCurrentPage(next);
    setCursor(0);
    setOffset(0);
  };

  const move = (delta: number) => {
    const next = Math.max(0, Math.min(pagedJobs.length - 1, cursor + delta));
    setCursor(next);
    setOffset((current) => {
      if (next < current) return next;
      if (next >= current + visible) return next - visible + 1;
      return current;
    });
  };

  const search = async () => {
    setEditing(false);
    setAction("searching");
    const activeLabels = SOURCES.filter((s) => enabledSources[s]).map((s) => SOURCE_LABEL[s]);
    setMessage(`Fetching ${activeLabels.length ? activeLabels.join(", ") : "no"} sources…`);
    try {
      const result = await searchJobs(root, query.trim(), enabledSources);
      setJobs(result.jobs);
      setSources(result.sources);
      setCursor(0);
      setOffset(0);
      setCurrentPage(0);
      setMessage(
        result.jobs.length === 0
          ? "No matching titles found. Press / to refine the query."
          : `${result.jobs.length} matching postings — ↑/↓ select · enter open · f fit · s save`,
      );
    } catch (err) {
      setMessage(`Search failed: ${errorMessage(err)}`);
    } finally {
      setAction("idle");
    }
  };

  const fit = async (job: SearchJob) => {
    setAction("fitting");
    setMessage(`Running deterministic fit gate for ${job.title}…`);
    try {
      const result = await checkJobFit(root, job);
      setFits((current) => ({ ...current, [job.url]: result }));
      setMessage(result.reasoning);
    } catch (err) {
      setMessage(`Fit check failed: ${errorMessage(err)}`);
    } finally {
      setAction("idle");
    }
  };

  const save = async (job: SearchJob) => {
    setAction("saving");
    setMessage(`Saving ${job.title} to review…`);
    try {
      const result = await saveJobForReview(root, job);
      setMessage(result === "saved" ? "Saved to review queue." : "Already saved; no duplicate records written.");
      if (result === "saved") onStateChange();
    } catch (err) {
      setMessage(`Save failed: ${errorMessage(err)}`);
    } finally {
      setAction("idle");
    }
  };

  useInput(
    (input, key) => {
      if (editing) {
        if (key.return) void search();
        else if (key.escape) setEditing(false);
        else if (key.leftArrow) {
          const next = moveCursorLeft({ value: query, cursor: queryCursor });
          setQueryCursor(next.cursor);
        } else if (key.rightArrow) {
          const next = moveCursorRight({ value: query, cursor: queryCursor });
          setQueryCursor(next.cursor);
        } else if (key.backspace || key.delete) {
          // macOS Backspace arrives as DEL (0x7f), which Ink reports as
          // key.delete — treating it as forward-delete made the key a
          // no-op at the end of the line. Both erase backward, like every
          // shell prompt (ink-text-input does the same).
          const next = deleteBackward({ value: query, cursor: queryCursor });
          setQuery(next.value);
          setQueryCursor(next.cursor);
        } else if (!key.ctrl && !key.meta && input && !/\p{C}/u.test(input)) {
          const next = insertAtCursor({ value: query, cursor: queryCursor }, input);
          setQuery(next.value);
          setQueryCursor(next.cursor);
        }
        return;
      }
      if (busy) return;
      if (input === "/") {
        setEditing(true);
        return setQueryCursor(query.length);
      }
      if (input === "t") {
        setSourceFocused((f) => !f);
        return;
      }
      if (sourceFocused) {
        if (key.escape) return setSourceFocused(false);
        if (key.leftArrow || input === "h") return setSourceCursor((c) => (c - 1 + SOURCES.length) % SOURCES.length);
        if (key.rightArrow || input === "l") return setSourceCursor((c) => (c + 1) % SOURCES.length);
        if (key.return || input === " ") {
          const src = SOURCES[sourceCursor];
          setEnabledSources((cur) => ({ ...cur, [src]: !cur[src] }));
        }
        return;
      }
      if (key.downArrow || input === "j") return move(1);
      if (key.upArrow || input === "k") return move(-1);
      // Full-page jump — a page here is "however many rows fit on screen"
      // (`visible`), not the Settings-configurable per-search result count;
      // n/p are a plain-ASCII fallback since not every terminal forwards
      // PageDown/PageUp reliably.
      if (key.pageDown || input === "n") return move(visible);
      if (key.pageUp || input === "p") return move(-visible);
      // Discrete pages (resultsPerPage items each) — distinct from n/p
      // above, which scroll within one page by however many rows fit on
      // screen. A page can still be taller than the terminal.
      if (input === "]") return changePage(1);
      if (input === "[") return changePage(-1);
      const isAction = key.return || input === "o" || input === "f" || input === "s";
      if (!isAction) return;
      const selected = pagedJobs[cursor];
      if (!selected) {
        // Feedback instead of a silently dead key.
        setMessage(
          jobs.length === 0
            ? "No results yet — press / to type a query, then enter to search."
            : "Nothing selected — use ↑/↓ to pick a posting first.",
        );
        return;
      }
      if (key.return || input === "o") {
        try {
          openUrl(selected.apply_url || selected.url);
          setMessage("Opened posting in your browser.");
        } catch (err) {
          setMessage(`Could not open browser: ${errorMessage(err)}`);
        }
      }
      if (input === "f") void fit(selected);
      if (input === "s") void save(selected);
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );

  const selected = pagedJobs[cursor];
  const selectedFit = selected ? fits[selected.url] : undefined;
  const viewportRows = pagedJobs.slice(offset, offset + visible);

  // Fixed column grid for the results table — computed from whatever
  // width the list actually gets (less than `columns` when the detail
  // pane is also showing), so every cell keeps a stable width across
  // resizes instead of the title column silently overrunning the rest.
  const listWidth = pane.show ? Math.max(20, columns - pane.width - 1) : columns;
  const MARKER_W = 2;
  const COMPANY_W = 14;
  // The table column is the year-less short form ("23h ago"/"4d ago"/
  // "mm/dd") — 8 comfortably fits the longest of those ("23h ago", 7
  // chars). The full mm/dd/yyyy date lives in the detail pane instead
  // (formatPostedFull), not this column.
  const POSTED_W = 8;
  const LOCATION_W = 16;
  const FIT_W = 7;
  const GAPS = 5; // one single-space Text between each of the 6 cells
  // The full reasoning behind a fit score lives in the detail pane/stacked
  // summary below (the "extra info" section) — keeping it out of the row
  // itself means the date/location/fit cells actually stay visible instead
  // of the table constantly fighting a long reasoning tail for room.
  const TITLE_W = Math.max(12, listWidth - MARKER_W - COMPANY_W - POSTED_W - LOCATION_W - FIT_W - GAPS);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={theme.accent}>Jobs </Text><Text dimColor>manual search · query </Text>
        <InlineTextInput
          value={query}
          cursor={queryCursor}
          active={editing}
          placeholder="type a job title"
          wrap="truncate-end"
        />
      </Box>
      {/* Each cell has a fixed width and truncates independently — a long
          failure detail (e.g. "2/8 failed: some-slug, another-slug") can't
          overflow into the next source's cell or grow the row onto a
          second line, which corrupted the frame below it (the list has no
          reserved extra row for a wrapped source line). */}
      <Box>
        {SOURCES.map((source, i) => {
          const on = enabledSources[source];
          const hit = sourceFocused && i === sourceCursor;
          return (
            <Box key={source} width={sourceColW} flexShrink={0}>
              <Text wrap="truncate-end">
                <Text color={hit ? theme.accent : undefined} bold={hit}>{hit ? "> " : "  "}[</Text>
                <Text color={on ? theme.good : undefined}>{on ? statusGlyph.applied : " "}</Text>
                <Text color={hit ? theme.accent : undefined} bold={hit}>{"] "}</Text>
                <Text dimColor={!on}>{SOURCE_LABEL[source]} </Text>
                <SourceBadge result={sources[source]} loading={action === "searching" && on} />
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="row" minHeight={pane.show ? visible : undefined}>
        <Box flexDirection="column" flexGrow={1}>
          <Box>
            <Col width={MARKER_W} hit={false} dim>{""}</Col>
            <Col width={COMPANY_W} hit={false} dim>Company</Col>
            <Col width={1} hit={false}>{""}</Col>
            <Col width={TITLE_W} hit={false} dim>Title</Col>
            <Col width={1} hit={false}>{""}</Col>
            <Col width={POSTED_W} hit={false} dim>Posted</Col>
            <Col width={1} hit={false}>{""}</Col>
            <Col width={LOCATION_W} hit={false} dim>Location</Col>
            <Col width={1} hit={false}>{""}</Col>
            <Col width={FIT_W} hit={false} dim>Fit</Col>
          </Box>
          {viewportRows.map((job, index) => {
            const absolute = offset + index;
            const fitResult = fits[job.url];
            const hit = absolute === cursor;
            const fitCell = fitResult ? `${fitGlyph(fitResult.fit_status)} ${fitResult.fit_score}` : "–";
            return (
              <Box key={job.url}>
                <Col width={MARKER_W} hit={hit}>{hit ? SELECT_MARKER + " " : "  "}</Col>
                <Col width={COMPANY_W} hit={hit}>{job.company}</Col>
                <Col width={1} hit={hit}>{" "}</Col>
                <Col width={TITLE_W} hit={hit}>{job.title}</Col>
                <Col width={1} hit={hit}>{" "}</Col>
                <Col width={POSTED_W} hit={hit}>{formatPosted(job.posted_at)}</Col>
                <Col width={1} hit={hit}>{" "}</Col>
                <Col width={LOCATION_W} hit={hit}>{job.location || "–"}</Col>
                <Col width={1} hit={hit}>{" "}</Col>
                <Col width={FIT_W} hit={hit} color={fitResult ? fitColor(fitResult.fit_status) : undefined}>{fitCell}</Col>
              </Box>
            );
          })}
        </Box>
        {pane.show ? (
          <DetailPane width={pane.width}>
            {selected ? (
              <>
                <Text bold color={theme.accent} wrap="truncate-end">
                  {selected.title}
                </Text>
                <PaneRow label="company" value={selected.company} />
                <PaneRow label="source" value={SOURCE_LABEL[selected.source]} />
                <PaneRow label="location" value={selected.location || "not listed"} />
                <PaneRow label="posted" value={formatPostedFull(selected.posted_at)} />
                <PaneRule title="fit gate" />
                {selectedFit ? (
                  <>
                    <PaneRow
                      label="verdict"
                      value={`${selectedFit.fit_status} · score ${selectedFit.fit_score}`}
                      color={selectedFit.fit_status === "candidate" ? theme.good : selectedFit.fit_status === "needs_review" ? theme.warn : theme.danger}
                    />
                    <Text wrap="wrap">{selectedFit.reasoning}</Text>
                  </>
                ) : (
                  <Text dimColor wrap="wrap">not run yet — press f to fit-check this posting</Text>
                )}
                <PaneRule title="actions" />
                <Text dimColor wrap="wrap">enter/o open · f fit · s save to review</Text>
              </>
            ) : (
              <>
                <Text dimColor>No selection</Text>
                <Text dimColor wrap="wrap">
                  Press / to type a title query, enter to search the live boards, then ↑/↓ to browse.
                </Text>
              </>
            )}
          </DetailPane>
        ) : null}
      </Box>
      {!pane.show && selected ? (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">
            company {selected.company}  source {SOURCE_LABEL[selected.source]}  location {selected.location || "not listed"}  posted {formatPostedFull(selected.posted_at)}
          </Text>
          {selectedFit ? (
            <Text color={fitColor(selectedFit.fit_status)} wrap="wrap">
              {selectedFit.fit_status} · score {selectedFit.fit_score} · {selectedFit.reasoning}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {totalPages > 1 ? (
        <Box>
          <Text dimColor>
            page {currentPage + 1}/{totalPages} · {jobs.length} results · [/] change page
          </Text>
        </Box>
      ) : null}
      <Box>
        {action === "searching" ? (
          <Text color={theme.accent}>
            loading{".".repeat(loadingDots)}
          </Text>
        ) : (
          <Text color={message.startsWith("Search failed") || message.startsWith("Fit check failed") || message.startsWith("Save failed") ? theme.danger : undefined} dimColor={!busy && !message.startsWith("Saved")} wrap="truncate-end">
            {busy ? "● " : ""}{message}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function SourceBadge({ result, loading }: { result?: SourceResult; loading: boolean }) {
  if (loading) return <Text color={theme.accent}>● loading</Text>;
  if (!result) return <Text dimColor>–</Text>;
  if (result.state === "warning") return <Text color={theme.warn}>{statusGlyph.needs_review} {result.detail}</Text>;
  if (result.state === "skipped") return <Text dimColor>– off</Text>;
  return <Text color={theme.good}>{statusGlyph.applied} {result.count}</Text>;
}

export const SEARCH_HINTS = "/ query · t sources · ↑↓ move · n/p scroll · [/] page · enter/o open · f fit · s save";
export const SEARCH_EDIT_HINTS = "type · ←→ move · backspace erase · enter search · esc done";
