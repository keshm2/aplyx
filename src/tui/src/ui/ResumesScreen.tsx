import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { listResumeFiles, resumesDir, type ResumeFile } from "../resumes.js";
import { openPath, convertResumePdf, helperError } from "@aplyx/core/helpers.js";
import { theme, statusGlyph } from "../theme.js";
import { InlineTextInput, deleteBackward, insertAtCursor, moveCursorLeft, moveCursorRight } from "./TextInput.js";

/**
 * Resumes screen: shows what's in data/resumes/ against the 6 filenames
 * resume-tailor.md actually reads (src/agents/bodies/resume-tailor.md "Step 1
 * — Select base resume"), lets the user open that folder in the OS file
 * manager, and offers to convert a PDF that's missing its markdown
 * counterpart — the case that otherwise silently leaves the tailoring
 * agent unable to use a resume the user thinks they've already added.
 */
export function ResumesScreen({
  root,
  active,
  onInputActiveChange,
  contentRows = 20,
}: {
  root: string;
  active: boolean;
  onInputActiveChange: (active: boolean) => void;
  contentRows?: number;
}) {
  const [cursor, setCursor] = useState(0);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [nonce, setNonce] = useState(0); // re-scan the folder after open/convert
  const [descPrompt, setDescPrompt] = useState(false);
  const [descStem, setDescStem] = useState<string | null>(null);
  const [descValue, setDescValue] = useState("");
  const [descCursor, setDescCursor] = useState(0);

  const files: ResumeFile[] = listResumeFiles(root);
  const clampedCursor = Math.min(cursor, Math.max(0, files.length - 1));
  const selected = files[clampedCursor];
  const pendingCount = files.filter((f) => f.needsConversion).length;

  // While the description prompt is open this screen owns the keyboard —
  // otherwise free-typed text (digits, "q", "w", arrows…) would also hit
  // App's global tab-switch/quit handler.
  const captures = active && descPrompt;
  useEffect(() => {
    onInputActiveChange(captures);
    return () => onInputActiveChange(false);
  }, [captures, onInputActiveChange]);

  const rowStatus = (f: ResumeFile): { glyph: string; color?: string; text: string } => {
    if (f.hasMarkdown)
      return {
        glyph: statusGlyph.applied,
        color: theme.good,
        text: f.description ? `${f.stem}.md — "${f.description}"` : `${f.stem}.md`,
      };
    if (f.needsConversion)
      return { glyph: statusGlyph.needs_review, color: theme.warn, text: "PDF found — press c to convert" };
    return { glyph: "—", text: "not added yet" };
  };

  const runConversion = (stem: string, description: string) => {
    setMessage(`Converting ${stem}.pdf…`);
    setMessageIsError(false);
    const result = convertResumePdf(root, stem, description);
    if (result.ok) {
      setMessage(`Converted — wrote ${stem}.md (${result.chars} chars).`);
      setMessageIsError(false);
    } else {
      setMessage(`Conversion failed: ${result.error}`);
      setMessageIsError(true);
    }
    setNonce((n) => n + 1);
  };

  useInput(
    (input, key) => {
      if (descPrompt) {
        if (key.return) {
          setDescPrompt(false);
          if (descStem) runConversion(descStem, descValue.trim());
        } else if (key.escape) {
          setDescPrompt(false);
          setMessage("Conversion cancelled.");
          setMessageIsError(false);
        } else if (key.leftArrow) {
          setDescCursor(moveCursorLeft({ value: descValue, cursor: descCursor }).cursor);
        } else if (key.rightArrow) {
          setDescCursor(moveCursorRight({ value: descValue, cursor: descCursor }).cursor);
        } else if (key.backspace || key.delete) {
          const next = deleteBackward({ value: descValue, cursor: descCursor });
          setDescValue(next.value);
          setDescCursor(next.cursor);
        } else if (!key.ctrl && !key.meta && input && !/\p{C}/u.test(input)) {
          const next = insertAtCursor({ value: descValue, cursor: descCursor }, input);
          setDescValue(next.value);
          setDescCursor(next.cursor);
        }
        return;
      }
      if (key.downArrow || input === "j") {
        setCursor((c) => Math.min(files.length - 1, c + 1));
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (input === "o") {
        try {
          openPath(resumesDir(root));
          setMessage(`Opened ${resumesDir(root)}`);
          setMessageIsError(false);
        } catch (err) {
          setMessage(`Could not open the folder: ${helperError(err)}`);
          setMessageIsError(true);
        }
        return;
      }
      if ((input === "c" || key.return) && selected) {
        if (!selected.needsConversion) {
          setMessage(
            selected.hasMarkdown
              ? `${selected.stem}.md already exists — nothing to convert.`
              : `No PDF for ${selected.category ?? selected.stem} yet — add one to data/resumes/ first.`,
          );
          setMessageIsError(false);
          return;
        }
        setDescStem(selected.stem);
        setDescValue("");
        setDescCursor(0);
        setDescPrompt(true);
        setMessage("");
      }
    },
    { isActive: active && Boolean(process.stdin.isTTY) },
  );

  void nonce; // listResumeFiles re-reads the directory every render; nonce forces one after actions

  const listRows = Math.max(3, Math.min(files.length, contentRows - 8));

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Resumes{" "}
        <Text dimColor>
          {pendingCount > 0 ? `${pendingCount} need${pendingCount === 1 ? "s" : ""} conversion` : "data/resumes/"}
        </Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {files.slice(0, listRows).map((f, i) => {
          const focused = i === clampedCursor;
          const status = rowStatus(f);
          const label = f.category ?? f.stem;
          return (
            <Text key={f.stem} color={focused ? theme.accent : status.color} bold={focused} wrap="truncate-end">
              {focused ? ">" : " "} [{focused ? "x" : " "}] {label.padEnd(20)} {status.glyph} {status.text}
            </Text>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Folder: {resumesDir(root)}</Text>
        {selected && !selected.expected ? (
          <Text dimColor wrap="wrap">
            "{selected.stem}" isn't one of resume-tailor's auto-matched filenames — give it a description when
            converting to tell it apart later, or see docs/SETUP.md for the expected names.
          </Text>
        ) : null}
      </Box>

      {descPrompt ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.accent}>What's this resume for? (optional — enter to convert)</Text>
          <InlineTextInput
            value={descValue}
            cursor={descCursor}
            active
            placeholder="(leave blank to skip)"
            wrap="truncate-end"
          />
        </Box>
      ) : null}

      {message ? (
        <Box marginTop={1}>
          <Text color={messageIsError ? theme.danger : undefined} dimColor={!messageIsError}>
            {message}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const RESUMES_HINTS = "↑↓ move · o open folder · c convert";
export const RESUMES_PROMPT_HINTS = "type · enter convert · esc cancel · backspace erase";
