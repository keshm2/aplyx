import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import {
  approveLetter,
  discardLetter,
  generateLetter,
  loadLetters,
  saveDraft,
  type LetterRequest,
} from "../letters.js";
import { DetailPane, PaneRow, PaneRule } from "./Pane.js";
import { KeyHints, SpinnerGlyph } from "./KeyHints.js";
import {
  InlineTextInput,
  deleteBackward,
  insertAtCursor,
  moveCursorLeft,
  moveCursorRight,
} from "./TextInput.js";

/**
 * Letters tab: the human half of the interest-letter flow.
 *
 * A run that meets a "Why do you want to work here?" question parks the job
 * (src/scripts/state/interest_letter.py) instead of inventing an answer, and
 * moves on; nothing is recorded and the job stays applicable. This screen is
 * where the user answers, and approving is what lets the next run apply.
 *
 * Generation writes a DRAFT only. Approval is always a separate keypress on
 * text the user has seen; that review step is the entire reason drafting is
 * allowed at all, so the two must never be collapsed into one action.
 */
export function LettersScreen({
  root,
  active,
  onInputActiveChange,
  contentRows = 20,
  contentColumns = 80,
  nonce = 0,
}: {
  root: string;
  active: boolean;
  onInputActiveChange: (active: boolean) => void;
  contentRows?: number;
  contentColumns?: number;
  nonce?: number;
}) {
  const [refresh, setRefresh] = useState(0);
  const letters = useMemo(() => loadLetters(root), [root, refresh, nonce]);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftCursor, setDraftCursor] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const selected: LetterRequest | undefined = letters[Math.min(cursor, letters.length - 1)];

  useEffect(() => {
    onInputActiveChange(active && editing);
    return () => onInputActiveChange(false);
  }, [active, editing, onInputActiveChange]);

  useEffect(() => {
    if (cursor > letters.length - 1) setCursor(Math.max(0, letters.length - 1));
  }, [letters.length, cursor]);

  const openEditor = () => {
    if (!selected) return;
    setDraft(selected.letter ?? "");
    setDraftCursor((selected.letter ?? "").length);
    setEditing(true);
    setMessage("Type your answer. enter saves a draft · ctrl+a approves it · esc cancels.");
  };

  useInput(
    (input, key) => {
      if (editing) {
        if (key.escape) {
          setEditing(false);
          setMessage("Cancelled: nothing saved.");
          return;
        }
        if (key.return) {
          if (!selected) return;
          const r = saveDraft(root, selected.job_key, draft);
          setEditing(false);
          setRefresh((n) => n + 1);
          setMessage(r.ok ? "Draft saved: press a to approve it when it reads right." : r.output);
          return;
        }
        // Approve straight from the editor, but still as its own keystroke on
        // text the user is looking at.
        if (key.ctrl && input === "a") {
          if (!selected) return;
          const r = approveLetter(root, selected.job_key, draft);
          setEditing(false);
          setRefresh((n) => n + 1);
          setMessage(r.ok ? "Approved: the next run will submit this answer." : r.output);
          return;
        }
        if (key.leftArrow) return setDraftCursor(moveCursorLeft({ value: draft, cursor: draftCursor }).cursor);
        if (key.rightArrow) return setDraftCursor(moveCursorRight({ value: draft, cursor: draftCursor }).cursor);
        if (key.backspace || key.delete) {
          const next = deleteBackward({ value: draft, cursor: draftCursor });
          setDraft(next.value);
          setDraftCursor(next.cursor);
          return;
        }
        if (!key.meta && input && !/\p{C}/u.test(input)) {
          const next = insertAtCursor({ value: draft, cursor: draftCursor }, input);
          setDraft(next.value);
          setDraftCursor(next.cursor);
        }
        return;
      }
      if (busy) return;
      if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === "j") return setCursor((c) => Math.min(letters.length - 1, c + 1));
      if (key.return || input === "e") return openEditor();
      if (input === "g") {
        if (!selected) return;
        setBusy(true);
        setMessage("Drafting via your coding agent: this can take a minute…");
        // Synchronous by design: spawnSync blocks the render loop, so the
        // spinner won't animate. Acceptable for a one-shot, user-initiated
        // action; the alternative (async + partial state) buys nothing here
        // because the generator has no streamable output.
        const r = generateLetter(root, selected.job_key);
        setBusy(false);
        setRefresh((n) => n + 1);
        setMessage(r.output);
        return;
      }
      if (input === "a") {
        if (!selected) return;
        if (!selected.letter?.trim()) {
          setMessage("Nothing to approve yet: press e to write one, or g to draft one.");
          return;
        }
        const r = approveLetter(root, selected.job_key, selected.letter);
        setRefresh((n) => n + 1);
        setMessage(r.ok ? "Approved: the next run will submit this answer." : r.output);
        return;
      }
      if (input === "d") {
        if (!selected) return;
        const r = discardLetter(root, selected.job_key);
        setRefresh((n) => n + 1);
        setMessage(r.ok ? `Discarded: aplyx won't apply to ${selected.company}.` : r.output);
        return;
      }
      if (input === "R") setRefresh((n) => n + 1);
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );

  if (letters.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          Letters
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>No applications are waiting on an answer.</Text>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              When a form asks "Why do you want to work here?", aplyx parks that job here instead of
              inventing an answer, and carries on with the rest of the run. Nothing is recorded and the
              job stays applicable; once you approve an answer, the next run submits it.
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  const listRows = Math.max(3, Math.min(letters.length, contentRows - 6));
  const offset = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), letters.length - listRows));
  const visible = letters.slice(offset, offset + listRows);

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Letters{" "}
        <Text dimColor>
          {letters.filter((l) => l.status === "pending").length} awaiting you ·{" "}
          {letters.filter((l) => l.status === "approved").length} approved
        </Text>
      </Text>

      <Box marginTop={1} flexDirection="row">
        <Box flexDirection="column" width={34} flexShrink={0}>
          {visible.map((l, i) => {
            const idx = offset + i;
            const focused = idx === cursor;
            const glyph = l.status === "approved" ? "✓" : l.letter?.trim() ? "✎" : "○";
            return (
              <Text
                key={l.job_key}
                color={focused ? theme.accent : undefined}
                bold={focused}
                wrap="truncate-end"
              >
                {focused ? "> " : "  "}
                <Text color={l.status === "approved" ? theme.good : theme.warn}>{glyph}</Text>{" "}
                {l.company}: {l.title}
              </Text>
            );
          })}
        </Box>

        {selected ? (
          <Box marginLeft={1} flexGrow={1}>
            <DetailPane width={Math.max(24, contentColumns - 35)}>
              <PaneRule title={selected.status === "approved" ? "approved" : "awaiting your answer"} />
              <PaneRow label="company" value={selected.company} />
              <PaneRow label="role" value={selected.title} />
              <PaneRow label="asked" value={selected.question || "(question not recorded)"} />
              <Box marginTop={1} flexDirection="column">
                <Text dimColor>answer</Text>
                {editing ? (
                  <InlineTextInput value={draft} cursor={draftCursor} active placeholder="(type your answer)" />
                ) : (
                  <Text wrap="wrap">
                    {selected.letter?.trim() ? selected.letter : <Text dimColor>(empty)</Text>}
                  </Text>
                )}
              </Box>
            </DetailPane>
          </Box>
        ) : null}
      </Box>

      {message ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {busy ? <SpinnerGlyph color={theme.accent} /> : null} {message}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <KeyHints hints={editing ? LETTERS_EDIT_HINTS : LETTERS_HINTS} />
      </Box>
    </Box>
  );
}

export const LETTERS_HINTS = "↑↓ move · e write · g draft it for me · a approve · d discard";
export const LETTERS_EDIT_HINTS = "type · ←→ move · enter save draft · ctrl+a approve · esc cancel";
