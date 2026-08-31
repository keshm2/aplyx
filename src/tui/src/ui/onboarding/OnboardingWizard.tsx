import React, { useEffect, useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import fs from "node:fs";
import path from "node:path";
import { theme, MIN_COLUMNS, MIN_ROWS, SIDE_PANEL_WIDTH } from "../../theme.js";
import { readSafeField, writeSafeField, readTargetsArrayList, writeTargetsArrayList } from "@aplyx/core/settings.js";
import { readProfileUsername, writeProfileUsername } from "@aplyx/core/profileLinks.js";
import { US_CITIES } from "@aplyx/core/data/usCities.js";
import { loadCompanyDirectory, companyWeight, type CompanyEntry } from "@aplyx/core/data/companyDirectory.js";
import { readCommittedCompanyDisplays, writeCommittedCompanyDisplays } from "@aplyx/core/companyTargets.js";
import { KeyHints } from "../KeyHints.js";
import { OnboardingSidePanel } from "../OnboardingSidePanel.js";
import { RESUMES_HINTS, RESUMES_PROMPT_HINTS } from "../ResumesScreen.js";
import {
  InlineTextInput,
  deleteBackward,
  insertAtCursor,
  moveCursorLeft,
  moveCursorRight,
} from "../TextInput.js";
import { filterSuggestions } from "../autocomplete.js";
import { acceptDobDigit, deleteDobDigit, dobDigits, dobError, formatDob } from "./dateInput.js";
import { PAGES, TOTAL_FIELDS, RESUME_PAGE_INDEX, COMPLETION_PAGE_INDEX, type FieldDef } from "@aplyx/core/onboarding/fields.js";
import { useFieldFocus } from "./useFieldFocus.js";
import { useSkipDefaultFlow } from "./useSkipDefaultFlow.js";
import { QuestionFrame } from "./QuestionFrame.js";
import { TextField } from "./TextField.js";
import { YesNoTextField } from "./YesNoTextField.js";
import { Select3TextField } from "./Select3TextField.js";
import { AutocompleteTextField } from "./AutocompleteTextField.js";
import { MultiEntryAutocomplete } from "../MultiEntryAutocomplete.js";
import { ResumeStep } from "./ResumeStep.js";

/**
 * Top-level onboarding wizard. Standalone, self-contained component:
 * not mounted inside <App>; a later phase wires it into cli.tsx's
 * "setup" case and first-run auto-launch. Persists every field
 * immediately on commit (write-through, not end-of-run) so Ctrl-C
 * mid-wizard never loses progress, and resumes-in-place on mount by
 * reading src/config/targets.json's `_onboarding` block.
 */

type Json = Record<string, unknown>;

function targetsJsonPath(root: string): string {
  return path.join(root, "src", "config", "targets.json");
}

function readTargetsJsonFile(root: string): Json {
  try {
    const parsed = JSON.parse(fs.readFileSync(targetsJsonPath(root), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

function writeTargetsJsonFile(root: string, data: Json): void {
  const file = targetsJsonPath(root);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  // targets.json carries PII (name, DOB, address); don't rely on ambient
  // umask; writeFileSync's mode option only applies on create, so chmod
  // explicitly every write.
  fs.chmodSync(file, 0o600);
}

/** A truly fresh install has no src/config/targets.json yet. Seed it from
 *  the example template (same base src/tui/src/wizard.ts already reads)
 *  before the wizard's first write, so role_keywords/boards/etc. aren't
 *  silently dropped by a read-modify-write that only knows about the
 *  one key it's touching. */
function ensureTargetsFile(root: string): void {
  const file = targetsJsonPath(root);
  if (fs.existsSync(file)) return;
  try {
    fs.copyFileSync(path.join(root, "src", "config", "targets.example.json"), file);
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort: subsequent reads/writes still degrade gracefully via
    // readTargetsJsonFile's own try/catch
  }
}

/** Roles/locations default lists are read live from targets.example.json,
 *  the single source of truth, never hardcoded here as a duplicate. */
function readExampleArray(root: string, key: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "src", "config", "targets.example.json"), "utf8"));
    const value = (parsed as Json)[key];
    return Array.isArray(value) ? value.filter((s: unknown): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

interface OnboardingMeta {
  completed: boolean;
  committed_fields: string[];
  current_page: number;
}

function readOnboardingMeta(root: string): OnboardingMeta {
  const raw = readTargetsJsonFile(root)._onboarding as Partial<OnboardingMeta> | undefined;
  const committed = Array.isArray(raw?.committed_fields)
    ? raw!.committed_fields!.filter((s): s is string => typeof s === "string")
    : [];
  return {
    completed: raw?.completed === true,
    committed_fields: committed,
    current_page: typeof raw?.current_page === "number" ? raw.current_page : 0,
  };
}

function persistOnboardingMeta(root: string, committedFields: string[], currentPage: number, completed: boolean): void {
  const data = readTargetsJsonFile(root);
  data._onboarding = { completed, committed_fields: committedFields, current_page: currentPage };
  writeTargetsJsonFile(root, data);
}

function computeInitialValues(root: string, directory: CompanyEntry[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const page of PAGES) {
    for (const field of page.fields) {
      switch (field.id) {
        case "linkedin_username":
          out[field.id] = readProfileUsername(root, "linkedin");
          break;
        case "github_username":
          out[field.id] = readProfileUsername(root, "github");
          break;
        case "role_keywords":
          out[field.id] = readTargetsArrayList(root, "role_keywords");
          break;
        case "preferred_locations":
          out[field.id] = readTargetsArrayList(root, "preferred_locations");
          break;
        case "target_companies":
          out[field.id] = readCommittedCompanyDisplays(root, directory);
          break;
        default:
          out[field.id] = readSafeField(root, field.id);
      }
    }
  }
  return out;
}

/** Write-through: every commit lands on disk immediately via the same
 *  files/helpers Settings uses (safe_fields via settings.ts,
 *  linkedin/github via profileLinks.ts), never a raw safe_fields
 *  read/write for the profile-link fields, so they interoperate with
 *  the legacy full-URL fallback. */
function persistFieldValue(root: string, id: string, value: string | string[], directory: CompanyEntry[]): void {
  switch (id) {
    case "linkedin_username":
      writeProfileUsername(root, "linkedin", value as string);
      break;
    case "github_username":
      writeProfileUsername(root, "github", value as string);
      break;
    case "role_keywords":
      writeTargetsArrayList(root, "role_keywords", value as string[]);
      break;
    case "preferred_locations":
      writeTargetsArrayList(root, "preferred_locations", value as string[]);
      break;
    case "target_companies":
      writeCommittedCompanyDisplays(root, value as string[], directory);
      break;
    default:
      writeSafeField(root, id, value as string);
  }
}

/** True once every field on the given field page id has been committed
 *  (entered or explicitly skipped via Enter): the gate Shift+→ checks
 *  before leaving a page, so a user can't blow through the wizard
 *  without ever committing anything. */
function allFieldsCommittedOnPage(pageIndex: number, committedSet: Set<string>): boolean {
  const page = PAGES[pageIndex];
  if (!page) return true;
  return page.fields.every((field) => committedSet.has(field.id));
}

function stdoutSize(): { columns: number; rows: number } {
  return {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

export function OnboardingWizard({ root, onDone }: { root: string; onDone: () => void }) {
  const [directory] = useState<CompanyEntry[]>(() => loadCompanyDirectory(root));
  const [initialMeta] = useState<OnboardingMeta>(() => {
    ensureTargetsFile(root);
    return readOnboardingMeta(root);
  });
  const [values, setValues] = useState<Record<string, string | string[]>>(() =>
    computeInitialValues(root, directory),
  );
  const [currentPage, setCurrentPage] = useState(initialMeta.current_page);
  const [showIntro, setShowIntro] = useState(
    () => initialMeta.current_page === 0 && initialMeta.committed_fields.length === 0,
  );
  const focus = useFieldFocus(initialMeta.committed_fields);

  const initialField = PAGES[initialMeta.current_page]?.fields[0];
  const [draftText, setDraftText] = useState<string>(() => {
    if (!initialField) return "";
    if (initialField.kind === "multi-location" || initialField.kind === "multi-company") return "";
    const raw = values[initialField.id];
    return typeof raw === "string" ? raw : "";
  });
  const [draftCursor, setDraftCursor] = useState<number>(() => draftText.length);
  const [addedItems, setAddedItems] = useState<string[]>(() => {
    if (!initialField) return [];
    if (initialField.kind !== "multi-location" && initialField.kind !== "multi-company") return [];
    const raw = values[initialField.id];
    return Array.isArray(raw) ? [...raw] : [];
  });
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  /** Whether the user has explicitly arrowed onto a suggestion. Enter only
   *  substitutes a suggestion for what they typed once this is true or the
   *  suggestion genuinely completes their text; see resolveTypedChoice. */
  const [suggestionTouched, setSuggestionTouched] = useState(false);
  const [entryHint, setEntryHint] = useState("");
  const [resumeInputActive, setResumeInputActive] = useState(false);
  const [size, setSize] = useState(stdoutSize);
  /** Set on a blocked Shift+→ attempt (current page has uncommitted
   *  fields); cleared on any successful page navigation. The banner
   *  itself is derived fresh each render (blockedAdvanceAttempted &&
   *  !allFieldsCommittedOnPage) rather than toggled off by hand, so it
   *  can never go stale: e.g. it disappears the instant the user
   *  commits the page's last field via Enter, with no extra bookkeeping. */
  const [blockedAdvanceAttempted, setBlockedAdvanceAttempted] = useState(false);

  useEffect(() => {
    const onResize = () => setSize(stdoutSize());
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  const skipFlow = useSkipDefaultFlow(`${currentPage}:${focus.focusIndex}`);

  const { columns, rows } = size;
  const isFieldPage = currentPage >= 0 && currentPage < PAGES.length;
  const isResumePage = currentPage === RESUME_PAGE_INDEX;
  const isCompletionPage = currentPage === COMPLETION_PAGE_INDEX;
  const fields = isFieldPage ? PAGES[currentPage]!.fields : [];
  const focusedField: FieldDef | undefined = fields[focus.focusIndex];

  const locationPool = US_CITIES;
  const suggestions: string[] =
    focusedField?.kind === "location" || focusedField?.kind === "multi-location"
      ? filterSuggestions(draftText, locationPool, 8)
      : focusedField?.kind === "multi-company"
        ? filterSuggestions(draftText, directory, 8, (e) => e.display, companyWeight).map((e) => e.display)
        : [];

  /**
   * Persist whatever the focused field currently holds, without advancing.
   *
   * Called on every way of *leaving* a field (tab, up/down, page change).
   * Drafts used to live only in `draftText`/`addedItems` and were folded
   * into `values` solely by commitAndAdvance (only on Enter), so
   * `loadDraftForField` would overwrite them the moment focus moved.
   * Typing your target companies or roles and then tabbing away silently
   * threw them out; that is the "target jobs during install is not saved"
   * report. A blank draft is deliberately left uncommitted so the
   * enter-on-blank skip/default flow keeps its meaning.
   */
  function commitDraftForField(field: FieldDef | undefined): Set<string> | undefined {
    if (!field) return undefined;
    if (field.kind === "multi-location" || field.kind === "multi-company") {
      if (addedItems.length === 0) return undefined;
      const existing = values[field.id];
      const unchanged =
        Array.isArray(existing) &&
        existing.length === addedItems.length &&
        existing.every((v, i) => v === addedItems[i]);
      if (unchanged) return undefined;
      persistFieldValue(root, field.id, addedItems, directory);
      setValues((v) => ({ ...v, [field.id]: [...addedItems] }));
      return focus.commit(field.id);
    }
    const text = draftText.trim();
    if (!text) return undefined;
    if (field.kind === "date" && dobError(dobDigits(text))) return undefined; // never persist an invalid date
    const value: string | string[] =
      field.kind === "roles" ? text.split(",").map((s) => s.trim()).filter(Boolean) : text;
    const existing = values[field.id];
    if (typeof existing === "string" && existing === text) return undefined;
    persistFieldValue(root, field.id, value, directory);
    setValues((v) => ({ ...v, [field.id]: value }));
    return focus.commit(field.id);
  }

  function loadDraftForField(field: FieldDef | undefined) {
    setEntryHint("");
    setSuggestionIndex(0);
    setSuggestionTouched(false);
    if (!field) {
      setDraftText("");
      setDraftCursor(0);
      setAddedItems([]);
      return;
    }
    const raw = values[field.id];
    if (field.kind === "multi-location" || field.kind === "multi-company") {
      setAddedItems(Array.isArray(raw) ? [...raw] : []);
      setDraftText("");
      setDraftCursor(0);
    } else {
      const text = typeof raw === "string" ? raw : "";
      setDraftText(text);
      setDraftCursor(text.length);
      setAddedItems([]);
    }
  }

  function focusField(newIndex: number) {
    const clamped = Math.max(0, Math.min(fields.length - 1, newIndex));
    if (clamped === focus.focusIndex) return;
    commitDraftForField(focusedField);
    focus.setFocusIndex(clamped);
    loadDraftForField(fields[clamped]);
  }

  function goToPage(nextPageRaw: number, committedOverride?: Set<string>) {
    // `focus.committed` is a stale closure once commitDraftForField has run
    // this tick, so thread the set it returns through rather than reading it
    // back (same reasoning as useFieldFocus.commit's own doc comment).
    const committedNow = committedOverride ?? commitDraftForField(focusedField) ?? focus.committed;
    const nextPage = Math.max(0, Math.min(COMPLETION_PAGE_INDEX, nextPageRaw));
    setCurrentPage(nextPage);
    focus.setFocusIndex(0);
    loadDraftForField(PAGES[nextPage]?.fields[0]);
    persistOnboardingMeta(root, [...committedNow], nextPage, nextPage === COMPLETION_PAGE_INDEX);
    // Every page change: whichever of the three ways it happens (blocked
    // Shift+→'s own successful retry, Shift+←, or the last field on a page
    // auto-advancing via advanceFocusOrPage), lands on a page the alert
    // hasn't been attempted-and-blocked on yet, so always clear it here
    // rather than only at the Shift+→ call sites (a stale true would
    // otherwise leak onto the next page's fresh, untouched fields).
    setBlockedAdvanceAttempted(false);
  }

  function advanceFocusOrPage(committedSet: Set<string>) {
    if (focus.focusIndex < fields.length - 1) {
      const nextIndex = focus.focusIndex + 1;
      focus.setFocusIndex(nextIndex);
      loadDraftForField(fields[nextIndex]);
      persistOnboardingMeta(root, [...committedSet], currentPage, false);
    } else {
      const nextPage = currentPage + 1;
      setCurrentPage(nextPage);
      focus.setFocusIndex(0);
      loadDraftForField(PAGES[nextPage]?.fields[0]);
      persistOnboardingMeta(root, [...committedSet], nextPage, nextPage === COMPLETION_PAGE_INDEX);
      // Committing a page's last field can itself land on a new page: the
      // same "leaving a page" event goToPage handles for Shift+←/→, so
      // clear the gate here too, or a stale true from an earlier blocked
      // Shift+→ on the previous page would falsely re-trigger the alert
      // against the new page's (still untouched) fields.
      setBlockedAdvanceAttempted(false);
    }
  }

  function commitAndAdvance(id: string, value: string | string[]) {
    persistFieldValue(root, id, value, directory);
    setValues((v) => ({ ...v, [id]: value }));
    const nextCommitted = focus.commit(id);
    advanceFocusOrPage(nextCommitted);
  }

  function editText(input: string, key: Key, resetSuggestion: boolean) {
    if (key.leftArrow) {
      setDraftCursor(moveCursorLeft({ value: draftText, cursor: draftCursor }).cursor);
      return;
    }
    if (key.rightArrow) {
      setDraftCursor(moveCursorRight({ value: draftText, cursor: draftCursor }).cursor);
      return;
    }
    if (key.backspace || key.delete) {
      const next = deleteBackward({ value: draftText, cursor: draftCursor });
      setDraftText(next.value);
      setDraftCursor(next.cursor);
      if (resetSuggestion) {
        setSuggestionIndex(0);
        // Editing the text invalidates any earlier arrow-selection: the
        // highlighted row is about to be a match for different text.
        setSuggestionTouched(false);
      }
      setEntryHint("");
      return;
    }
    if (!key.ctrl && !key.meta && input && !/\p{C}/u.test(input)) {
      const next = insertAtCursor({ value: draftText, cursor: draftCursor }, input);
      setDraftText(next.value);
      setDraftCursor(next.cursor);
      if (resetSuggestion) {
        setSuggestionIndex(0);
        // Editing the text invalidates any earlier arrow-selection: the
        // highlighted row is about to be a match for different text.
        setSuggestionTouched(false);
      }
      setEntryHint("");
    }
  }

  function handleRolesEnter(field: FieldDef) {
    const typed = draftText.trim();
    if (typed) {
      const list = typed.split(",").map((s) => s.trim()).filter(Boolean);
      commitAndAdvance(field.id, list);
      return;
    }
    const outcome = skipFlow.resolveBlankEnter();
    if (outcome === "warn") return;
    commitAndAdvance(field.id, readExampleArray(root, "role_keywords"));
  }

  /**
   * What Enter means in a location field once the user has typed
   * something. A suggestion only replaces their text if they explicitly
   * arrowed onto it, or if it genuinely *completes* what they typed
   * (case-insensitive prefix: "seat" → "Seattle, WA").
   *
   * Previously this was `suggestions[suggestionIndex] ?? typed`, which
   * blindly took the top fuzzy match: typing a city that isn't in
   * US_CITIES ("Marysville, WA", "Lynnwood, WA") but that fuzzy-matches
   * some unrelated entry would silently commit the wrong city. Freehand is
   * always allowed; US_CITIES only offers suggestions, it is not an enum.
   */
  function resolveLocationChoice(typed: string): string {
    const highlighted = suggestions[suggestionIndex];
    if (suggestionTouched && highlighted) return highlighted;
    if (highlighted && highlighted.toLowerCase().startsWith(typed.toLowerCase())) return highlighted;
    return typed;
  }

  function handleLocationEnter(field: FieldDef) {
    const typed = draftText.trim();
    if (!typed) {
      commitAndAdvance(field.id, "");
      return;
    }
    commitAndAdvance(field.id, resolveLocationChoice(typed));
  }

  function handleMultiEnter(field: FieldDef) {
    const typed = draftText.trim();
    if (typed) {
      // Locations are an open set (freehand allowed, see
      // resolveLocationChoice); companies are a closed vetted set, so only
      // a real directory entry can be added.
      const chosen =
        field.kind === "multi-location" ? resolveLocationChoice(typed) : suggestions[suggestionIndex];
      if (!chosen) {
        setEntryHint(
          "No matching vetted company. Pick one from the list, or leave blank and press enter twice to skip.",
        );
        return;
      }
      if (!addedItems.includes(chosen)) setAddedItems((items) => [...items, chosen]);
      setDraftText("");
      setDraftCursor(0);
      setSuggestionIndex(0);
      setEntryHint("");
      return;
    }
    if (addedItems.length > 0) {
      commitAndAdvance(field.id, addedItems);
      return;
    }
    const outcome = skipFlow.resolveBlankEnter();
    if (outcome === "warn") return;
    // Both commit empty. Locations are deliberately NOT defaulted to a
    // starter list any more: they vary per person (a Seattle-area default
    // is wrong for most users), and per AGENTS.md "Location handling"
    // preferred_locations is a priority list, not a filter, so empty
    // costs the user nothing except result ordering.
    commitAndAdvance(field.id, []);
  }

  /** Date-of-birth editing. `draftText` holds the *formatted* value; the
   *  raw digits are derived from it, so there's no second source of truth
   *  to keep in sync. The cursor is pinned to the end: the separators are
   *  machine-inserted, so mid-string editing would only fight the
   *  formatter. */
  function editDob(input: string, key: Key) {
    const current = dobDigits(draftText);
    if (key.backspace || key.delete) {
      const shown = formatDob(deleteDobDigit(current));
      setDraftText(shown);
      setDraftCursor(shown.length);
      setEntryHint("");
      return;
    }
    if (key.ctrl || key.meta || !input) return;
    let next = current;
    for (const ch of input) next = acceptDobDigit(next, ch);
    if (next === current) return; // keystroke refused (would make an invalid date)
    const shown = formatDob(next);
    setDraftText(shown);
    setDraftCursor(shown.length);
    setEntryHint("");
  }

  /** Suggestion lists own up/down only while they have something to show;
   *  otherwise up/down move between fields (see handleFieldInput). */
  function moveSuggestion(delta: number) {
    setSuggestionTouched(true);
    setSuggestionIndex((i) => Math.max(0, Math.min(Math.max(0, suggestions.length - 1), i + delta)));
  }

  function handleFieldInput(input: string, key: Key) {
    const field = focusedField;
    if (!field) return;
    const suggestionsOpen =
      (field.kind === "location" || field.kind === "multi-location" || field.kind === "multi-company") &&
      suggestions.length > 0;
    // Up/down move between fields: the wizard's other navigation key
    // besides tab. Requested because tab-only meant that once focus left a
    // field the only way back was to walk the page or bounce off it. An
    // open suggestion list claims up/down first (it needs them to pick a
    // row); with no list showing they fall through to field movement.
    if ((key.upArrow || key.downArrow) && !suggestionsOpen) {
      return focusField(focus.focusIndex + (key.downArrow ? 1 : -1));
    }
    switch (field.kind) {
      case "text":
        if (key.return) return commitAndAdvance(field.id, draftText.trim());
        return editText(input, key, false);
      case "date":
        if (key.return) {
          const err = dobError(dobDigits(draftText));
          if (err) return setEntryHint(err);
          return commitAndAdvance(field.id, draftText.trim());
        }
        return editDob(input, key);
      case "roles":
        if (key.return) return handleRolesEnter(field);
        return editText(input, key, false);
      case "yesno":
        if (key.return) return commitAndAdvance(field.id, draftText);
        if (input.toLowerCase() === "y") return setDraftText("Yes");
        if (input.toLowerCase() === "n") return setDraftText("No");
        if (key.backspace || key.delete) return setDraftText("");
        return;
      case "select3": {
        // Stores the option's machine value ("not_veteran"/"veteran"/
        // "decline", etc.): same convention FieldInput.tsx (Tauri) uses
        // for this kind, not the display label, so both UIs write the
        // same shape to safe_fields.
        const opts3 = field.options ?? [];
        if (key.return) {
          if (!draftText && field.required) return; // required: Enter with nothing chosen does nothing
          return commitAndAdvance(field.id, draftText);
        }
        if (input === "1" && opts3[0]) return setDraftText(opts3[0].value);
        if (input === "2" && opts3[1]) return setDraftText(opts3[1].value);
        if (input === "3" && opts3[2]) return setDraftText(opts3[2].value);
        if (!field.required && (key.backspace || key.delete)) return setDraftText("");
        return;
      }
      case "location":
        if (key.return) return handleLocationEnter(field);
        if (key.upArrow) return moveSuggestion(-1);
        if (key.downArrow) return moveSuggestion(1);
        return editText(input, key, true);
      case "multi-location":
      case "multi-company":
        if (key.return) return handleMultiEnter(field);
        if (key.upArrow) return moveSuggestion(-1);
        if (key.downArrow) return moveSuggestion(1);
        return editText(input, key, true);
    }
  }

  useInput(
    (input, key) => {
      if (resumeInputActive) return;

      if (showIntro) {
        if (key.return) setShowIntro(false);
        else if (input === "q") onDone();
        return;
      }

      if (isCompletionPage) {
        if (key.return) onDone();
        return;
      }

      // PageUp/PageDown are the primary back/forward keys: a dedicated,
      // unambiguous escape sequence (\x1b[5~ / \x1b[6~) every terminal
      // sends the same way, unlike Shift+Arrow: several Windows terminal
      // hosts (legacy conhost.exe, and some Windows Terminal/shell
      // combinations) don't reliably emit the modifier-prefixed CSI
      // sequence arrow keys need to report Shift, so key.shift can just
      // never come through, silently making Shift+←/→ inert with no
      // error, which read as "the back/forth buttons don't work" on
      // Windows. Shift+←/→ stays wired too (works fine on most
      // terminals, and is worth keeping for muscle memory), but
      // PageUp/PageDown no longer depend on modifier detection at all.
      if (key.pageUp || (key.shift && key.leftArrow)) return goToPage(currentPage - 1);
      if (key.pageDown || (key.shift && key.rightArrow)) {
        // Commit first, then gate. A value typed but not yet Entered is an
        // answer: checking the gate before committing meant typing a field
        // and pressing shift+→ was refused with "answer every field on this
        // page", pointing at the field the user had just filled in.
        const committedNow = commitDraftForField(focusedField) ?? focus.committed;
        if (isFieldPage && !allFieldsCommittedOnPage(currentPage, committedNow)) {
          setBlockedAdvanceAttempted(true);
          return;
        }
        return goToPage(currentPage + 1, committedNow);
      }

      // Enter is taken on this page by ResumesScreen itself (converts the
      // selected resume / shows a status message): it's the one page
      // where the universal "commit & advance" key doesn't advance, so
      // Escape doubles as an explicit, easy-to-guess "skip this step"
      // (PageDown/Shift+→, handled above, still works too).
      if (isResumePage && key.escape) return goToPage(currentPage + 1);
      if (isResumePage) return; // ResumesScreen (mounted below) owns the rest of the keyboard

      if (fields.length === 0) return;
      if (key.tab) {
        if (key.shift) focusField(focus.focusIndex - 1);
        else focusField(focus.focusIndex + 1);
        return;
      }
      handleFieldInput(input, key);
    },
    { isActive: Boolean(process.stdin.isTTY) && !resumeInputActive },
  );

  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={2} alignItems="center">
        <Text bold color={theme.accent}>
          aplyx
        </Text>
        <Text dimColor>terminal too small</Text>
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <Text dimColor>
            need at least {MIN_COLUMNS}×{MIN_ROWS}, have {columns}×{rows}
          </Text>
        </Box>
      </Box>
    );
  }

  if (showIntro) {
    const boxWidth = Math.min(72, columns - 2);
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        <Box borderStyle="round" borderColor={theme.rule} flexDirection="column" width={boxWidth} paddingX={2} paddingY={1}>
          <Text bold color={theme.accent}>
            Welcome to aplyx!
          </Text>
          <Box marginTop={1}>
            <Text wrap="wrap">
              This will guide you through the installation process: your profile, job targets, and resumes.
              Everything is optional and editable later in Settings.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.warn} wrap="wrap">
              ⚠ Nothing you enter ever leaves this machine.
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <KeyHints hints="enter begin · q skip setup for now" />
        </Box>
      </Box>
    );
  }

  const showSidebar = columns >= 72 && rows >= 18;
  const contentCols = Math.max(24, columns - 2 - (showSidebar ? SIDE_PANEL_WIDTH + 3 : 0));
  const contentRows = Math.max(6, rows - 6);
  const percent = focus.percentage(TOTAL_FIELDS);

  function renderField(field: FieldDef, idx: number) {
    const isFocused = idx === focus.focusIndex;
    const committedRaw = values[field.id];
    const committedText = typeof committedRaw === "string" ? committedRaw : Array.isArray(committedRaw) ? committedRaw.join(", ") : "";
    const committedList = Array.isArray(committedRaw) ? committedRaw : [];

    switch (field.kind) {
      case "text":
        return (
          <TextField
            key={field.id}
            label={field.label}
            value={isFocused ? draftText : committedText}
            cursor={isFocused ? draftCursor : committedText.length}
            focused={isFocused}
            placeholder={field.placeholder}
            help={field.help}
          />
        );
      case "date":
        return (
          <TextField
            key={field.id}
            label={field.label}
            value={isFocused ? draftText : committedText}
            cursor={isFocused ? draftCursor : committedText.length}
            focused={isFocused}
            placeholder={field.placeholder}
            help={field.help}
            // Only the live per-keystroke complaint (e.g. "Feb has 28
            // days in 2005"); refused digits simply don't appear.
            warning={isFocused && entryHint ? entryHint : undefined}
          />
        );
      case "roles":
        return (
          <TextField
            key={field.id}
            label={field.label}
            value={isFocused ? draftText : committedText}
            cursor={isFocused ? draftCursor : committedText.length}
            focused={isFocused}
            placeholder={field.placeholder}
            warning={
              isFocused && skipFlow.warned
                ? `No roles entered; aplyx will use its default list: ${readExampleArray(root, "role_keywords").join(", ")}. Press enter again to accept, or start typing to override.`
                : undefined
            }
          />
        );
      case "yesno":
        return (
          <YesNoTextField
            key={field.id}
            label={field.label}
            value={isFocused ? draftText : committedText}
            focused={isFocused}
          />
        );
      case "select3": {
        const opts3 = field.options ?? [];
        const rawValue = isFocused ? draftText : committedText;
        const resolvedLabel = opts3.find((o) => o.value === rawValue)?.label ?? "";
        return (
          <Select3TextField key={field.id} label={field.label} value={resolvedLabel} focused={isFocused} options={opts3} />
        );
      }
      case "location":
        return (
          <AutocompleteTextField
            key={field.id}
            label={field.label}
            query={isFocused ? draftText : committedText}
            cursor={isFocused ? draftCursor : committedText.length}
            focused={isFocused}
            suggestions={isFocused ? suggestions : []}
            suggestionIndex={suggestionIndex}
            placeholder={field.placeholder}
            help={field.help}
          />
        );
      case "multi-location":
      case "multi-company": {
        const warning = isFocused
          ? skipFlow.warned
            ? field.kind === "multi-location"
              ? "No preferred locations: aplyx still searches the whole US either way; these only push matching jobs to the top. Press enter again to continue, or start typing to add one."
              : "No companies added: the project's vetted company list is still watched regardless. Press enter again to continue, or start typing to add one."
            : entryHint || undefined
          : undefined;
        return (
          <MultiEntryAutocomplete
            key={field.id}
            label={field.label}
            query={isFocused ? draftText : ""}
            cursor={isFocused ? draftCursor : 0}
            focused={isFocused}
            suggestions={isFocused ? suggestions : []}
            suggestionIndex={suggestionIndex}
            addedItems={isFocused ? addedItems : committedList}
            warning={warning}
            placeholder={field.placeholder}
            help={field.help}
          />
        );
      }
    }
  }

  let body: React.ReactNode;
  let footerHints: string;
  if (isCompletionPage) {
    body = (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          You're all set.
        </Text>
        <Box marginTop={1}>
          <Text wrap="wrap">
            Change any of this any time from the Config tab, or by editing src/config/targets.json directly. Add more
            resumes any time from the Resumes tab.
          </Text>
        </Box>
      </Box>
    );
    footerHints = "enter open aplyx";
  } else if (isResumePage) {
    body = (
      <ResumeStep root={root} active={isResumePage} onInputActiveChange={setResumeInputActive} contentRows={contentRows} />
    );
    footerHints = resumeInputActive ? RESUMES_PROMPT_HINTS : `${RESUMES_HINTS} · esc/PgDn skip for now · PgUp back`;
  } else {
    const page = PAGES[currentPage]!;
    const showAdvanceGateAlert = blockedAdvanceAttempted && !allFieldsCommittedOnPage(currentPage, focus.committed);
    body = (
      <QuestionFrame
        title={page.title}
        alert={showAdvanceGateAlert ? "Answer every field on this page before continuing: press enter on each (blank is fine)." : undefined}
      >
        {page.fields.map((field, idx) => renderField(field, idx))}
      </QuestionFrame>
    );
    footerHints = "↑↓/tab move field · enter commit & next · PgUp/PgDn prev/next page";
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="row">
        <Box
          flexDirection="column"
          width={contentCols}
          flexShrink={0}
          borderStyle="round"
          borderColor={theme.rule}
          paddingX={2}
          paddingY={1}
          overflow="hidden"
        >
          {body}
        </Box>
        {showSidebar ? (
          <Box
            marginLeft={1}
            borderStyle="single"
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            borderColor={theme.rule}
          >
            <OnboardingSidePanel percent={percent} />
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={footerHints} />
      </Box>
    </Box>
  );
}
