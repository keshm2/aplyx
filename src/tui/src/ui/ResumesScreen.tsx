import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { listResumeFiles, resumesDir, type ResumeFile } from "../resumes.js";
import { openPath, convertResumePdf, setResumeDescription, helperError } from "@aplyx/core/helpers.js";
import { theme, statusGlyph } from "../theme.js";
import { InlineTextInput, deleteBackward, insertAtCursor, moveCursorLeft, moveCursorRight } from "./TextInput.js";

/**
 * Resumes screen: shows what's in data/resumes/ against the 6 filenames
 * resume-tailor.md actually reads (src/agents/bodies/resume-tailor.md "Step 1
 * — Select base resume"), lets the user open that folder in the OS file
 * manager, and offers to convert a PDF that's missing its markdown
 * counterpart — the case that otherwise silently leaves the tailoring
 * agent unable to use a resume the user thinks they've already added.
 *
 * A resume under a non-conventional filename (two uploads both named
 * generically, say) still gets picked correctly without a rename: press
 * `d` to attach a short "what roles this targets" description at any
 * time, independent of conversion — resolve_resume.py (see its own
 * docstring) matches on it when the filename alone doesn't resolve.
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
  const [descMode, setDescMode] = useState<"convert" | "describe">("convert");
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

  const runSetDescription = (stem: string, description: string) => {
    const result = setResumeDescription(root, stem, description);
    if (result.ok) {
      setMessage(description ? `Saved: "${description}"` : `Cleared description for ${stem}.`);
      setMessageIsError(false);
    } else {
      setMessage(`Could not save description: ${result.error}`);
      setMessageIsError(true);
    }
    setNonce((n) => n + 1);
  };

  useInput(
    (input, key) => {
      if (descPrompt) {
        if (key.return) {
          setDescPrompt(false);
          if (descStem) {
            if (descMode === "convert") runConversion(descStem, descValue.trim());
            else runSetDescription(descStem, descValue.trim());
          }
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
              ? `${selected.stem}.md already exists — nothing to convert. Press d to set its description.`
              : `No PDF for ${selected.category ?? selected.stem} yet — add one to data/resumes/ first.`,
          );
          setMessageIsError(false);
          return;
        }
        setDescMode("convert");
        setDescStem(selected.stem);
        setDescValue("");
        setDescCursor(0);
        setDescPrompt(true);
        setMessage("");
      }
      if (input === "d" && selected) {
        if (!selected.hasMarkdown && !selected.hasPdf) {
          setMessage(`No file for ${selected.category ?? selected.stem} yet — add one to data/resumes/ first.`);
          setMessageIsError(false);
          return;
        }
        setDescMode("describe");
        setDescStem(selected.stem);
        setDescValue(selected.description ?? "");
        setDescCursor((selected.description ?? "").length);
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
            "{selected.stem}" isn't one of resume-tailor's auto-matched filenames — press d to describe what roles
            it targets (e.g. "backend + cloud roles") so it still gets picked correctly, or see docs/SETUP.md for
            the expected names.
          </Text>
        ) : null}
      </Box>

      {descPrompt ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.accent}>
            What roles is this resume best for?{" "}
            {descMode === "convert" ? "(optional — enter to convert)" : "(optional — enter to save)"}
          </Text>
          <Text dimColor>e.g. "backend + cloud infra roles", "security / SOC internships"</Text>
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

export const RESUMES_HINTS = "↑↓ move · o open folder · c convert · d describe";
export const RESUMES_PROMPT_HINTS = "type · enter confirm · esc cancel · backspace erase";
