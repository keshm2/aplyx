import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { py } from "@aplyx/core/platform.js";

/**
 * Reader/writer for the interest-letter store. Mirrors the rest of the TUI's
 * contract with state: Python owns the file, the TUI only shells out to the
 * helper (src/scripts/state/interest_letter.py) and never edits
 * data/interest_letters.json itself.
 */

export type LetterStatus = "pending" | "approved";

export interface LetterRequest {
  job_key: string;
  company: string;
  title: string;
  url: string;
  apply_url: string;
  question: string;
  jd_excerpt: string;
  status: LetterStatus;
  letter: string;
  requested_at: string;
  updated_at: string;
}

function storePath(root: string): string {
  return path.join(root, "data", "interest_letters.json");
}

/** Read-only listing. Reads the file directly (a read needs no helper — the
 *  write discipline is about mutations), returning [] when absent. */
export function loadLetters(root: string): LetterRequest[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(root), "utf8"));
    return Array.isArray(parsed) ? (parsed as LetterRequest[]) : [];
  } catch {
    return [];
  }
}

export function pendingLetters(root: string): LetterRequest[] {
  return loadLetters(root).filter((l) => l.status === "pending");
}

function helper(root: string, args: string[], input?: string): { ok: boolean; output: string } {
  const { cmd, args: full } = py([path.join("scripts", "state", "interest_letter.py"), ...args]);
  const r = spawnSync(cmd, full, { cwd: root, input, encoding: "utf8" });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, output };
}

/** Save without approving — the text stays editable and is NOT usable by a
 *  run until approveLetter is called. */
export function saveDraft(root: string, jobKey: string, text: string) {
  return helper(root, ["save-draft", jobKey, "-"], text);
}

/** The only call that makes a letter usable by the apply loop. Deliberately
 *  a distinct, explicit user action — generation only ever writes a draft. */
export function approveLetter(root: string, jobKey: string, text: string) {
  return helper(root, ["approve", jobKey, "-"], text);
}

export function discardLetter(root: string, jobKey: string) {
  return helper(root, ["discard", jobKey]);
}

/** Draft one via a direct Anthropic API call (src/scripts/runtime/
 *  generate_interest_letter.py — no coding-agent harness involved since
 *  the B1 migration). Synchronous + slow-ish (an LLM call, up to ~2 min),
 *  so callers must show a spinner; there is no partial output to stream. */
export function generateLetter(root: string, jobKey: string): { ok: boolean; output: string } {
  const { cmd, args } = py([path.join("scripts", "runtime", "generate_interest_letter.py"), jobKey]);
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  try {
    const obj = JSON.parse(raw.split("\n").filter(Boolean).pop() ?? "{}");
    if (obj.declined) return { ok: true, output: String(obj.note ?? "Model declined to draft.") };
    if (obj.ok) {
      const flags = Array.isArray(obj.flags) ? obj.flags : [];
      const flagNote = flags.length > 0 ? ` — review before approving: ${flags.join("; ")}` : "";
      return {
        ok: true,
        output: `Draft written (${obj.words ?? "?"} words, grounding confidence: ${obj.grounding_confidence ?? "unknown"}).${flagNote}`,
      };
    }
    return { ok: false, output: String(obj.error ?? raw) };
  } catch {
    return { ok: r.status === 0, output: raw || "no output from generator" };
  }
}

export { execFileSync };
