// Content script — runs on the four supported ATS families. Renders a
// small shadow-DOM panel with three user-driven actions:
//
//   Fit check     -> extract the posting, ask the bridge for the phase 4
//                    fit verdict (canonicalize + upsert + fit gate).
//   Autofill      -> map the visible form controls to safe_fields keys,
//                    request ONLY those keys' values from the bridge, and
//                    fill empty controls. Unmapped required fields are
//                    highlighted for the user — values are never invented.
//   Record        -> after the USER submits, record applied (or save for
//                    review) through the bridge's helper-backed writes.
//
// The defining safety property of hybrid mode: this script NEVER clicks
// submit and never fills anything not present in safe_fields.
import {
  detectAts,
  extractJob,
  fieldDescriptor,
  matchByType,
  matchField,
  type FieldKey,
} from "./ats.js";
import type {
  ExtractedJob,
  FieldsResponse,
  FitResponse,
  OutcomeResponse,
} from "./shared.js";

const ats = detectAts(location.hostname);
if (ats) init();

interface MappedControl {
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  key: FieldKey;
}

/** A zero-size bounding rect alone (display:none, or a display:none
 *  ancestor) already covers most hidden cases, but NOT visibility:hidden
 *  or opacity:0 — both can still report a nonzero rect. That gap matters
 *  here specifically: several ATS forms plant honeypot fields (invisible
 *  to a real applicant, meant to catch bots) using exactly those two
 *  properties rather than display:none. Autofilling one and having the
 *  user submit it would look like automated/bot traffic to the ATS's own
 *  anti-abuse checks — the opposite of this extension's entire "a human
 *  reviews and submits" safety story. */
function visible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
}

function fillable(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLSelectElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  return !el.readOnly && ["text", "email", "tel", "url", "number", "search"].includes(type);
}

function scanForm(): { mapped: MappedControl[]; unmappedRequired: HTMLElement[] } {
  const mapped: MappedControl[] = [];
  const unmappedRequired: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
    if (!fillable(el)) continue;
    const control = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (control.disabled || !visible(control)) continue;
    const key = matchByType(control) ?? matchField(fieldDescriptor(control, document));
    if (key) {
      mapped.push({ el: control, key });
    } else if (control.required || control.getAttribute("aria-required") === "true") {
      unmappedRequired.push(control);
    }
  }
  return { mapped, unmappedRequired };
}

/** Set a value the way a user would, so React/Vue-controlled inputs
 *  (Ashby, Workday) see the change. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function selectOption(el: HTMLSelectElement, value: string): boolean {
  const wanted = value.trim().toLowerCase();
  for (const option of Array.from(el.options)) {
    const label = option.textContent?.trim().toLowerCase() ?? "";
    if (label === wanted || (wanted && label.startsWith(wanted))) {
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
  }
  return false;
}

function outline(el: HTMLElement, color: string, title: string): void {
  el.style.outline = `2px solid ${color}`;
  el.style.outlineOffset = "1px";
  el.title = title;
}

function resolveValue(key: FieldKey, fields: Record<string, string>): string {
  if (key === "full_name") {
    const first = fields.first_name ?? "";
    const last = fields.last_name ?? "";
    return `${first} ${last}`.trim();
  }
  return fields[key] ?? "";
}

async function autofill(): Promise<string> {
  const { mapped, unmappedRequired } = scanForm();
  if (mapped.length === 0 && unmappedRequired.length === 0) {
    return "No application form detected on this page — open the posting's Apply form first.";
  }
  const keys = new Set<string>();
  for (const { key } of mapped) {
    if (key === "full_name") {
      keys.add("first_name");
      keys.add("last_name");
    } else {
      keys.add(key);
    }
  }
  const response = (await chrome.runtime.sendMessage({
    type: "fields",
    keys: Array.from(keys),
  })) as FieldsResponse;
  if (!response.ok || !response.fields) {
    return response.error ?? "Bridge did not return profile fields.";
  }
  let filled = 0;
  let attention = 0;
  for (const { el, key } of mapped) {
    const value = resolveValue(key, response.fields);
    if (!value) {
      // The profile has no value for this mapped field — highlight, never invent.
      outline(el, "#d97706", "aplyx: no profile value for this field — fill it yourself");
      attention += 1;
      continue;
    }
    if (el instanceof HTMLSelectElement) {
      if (selectOption(el, value)) {
        outline(el, "#0f6e2a", "aplyx: filled from your profile");
        filled += 1;
      } else {
        outline(el, "#d97706", `aplyx: no option matches "${value}" — pick one yourself`);
        attention += 1;
      }
      continue;
    }
    if (el.value.trim()) continue; // never clobber something the user typed
    setNativeValue(el, value);
    outline(el, "#0f6e2a", "aplyx: filled from your profile");
    filled += 1;
  }
  for (const el of unmappedRequired) {
    outline(el, "#d97706", "aplyx: required field the profile can't answer — fill it yourself");
    attention += 1;
  }
  return `Filled ${filled} field${filled === 1 ? "" : "s"}.` +
    (attention > 0 ? ` ${attention} highlighted for you.` : "") +
    " Review everything, then submit yourself.";
}

// ---------------------------------------------------------------------------
// Panel UI (shadow DOM so page CSS can't corrupt it and vice versa)

function init(): void {
  const host = document.createElement("div");
  host.id = "aplyx-panel-host";
  const shadow = host.attachShadow({ mode: "closed" });
  const iconUrl = chrome.runtime.getURL("icons/icon32.png");
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      /* Moss — the app's actual dark palette (src/tauri/src/styles/tokens.css),
         not an invented panel-specific scheme. This used to be a violet/indigo
         palette that matched nothing else aplyx ships. */
      .panel {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        width: 300px; padding: 12px 14px; border-radius: 12px;
        background: #1e1b14; color: #ede6d6;
        font: 13px/1.45 -apple-system, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif;
        box-shadow: 0 10px 32px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.06);
        transition: width .18s ease, padding .18s ease;
      }
      .panel.collapsed { width: auto; padding: 8px 10px; cursor: pointer; }
      .head { display: flex; align-items: center; gap: 8px; }
      .head img { width: 18px; height: 18px; border-radius: 4px; display: block; }
      .brand { font-weight: 700; color: #ede6d6; letter-spacing: .02em; }
      .spacer { flex: 1; }
      button {
        font: inherit; font-weight: 600; border: 0; border-radius: 8px; cursor: pointer;
        padding: 7px 10px; margin-top: 8px; width: 100%;
        background: #7fae86; color: #17140f;
        transition: background .12s ease, opacity .12s ease, transform .08s ease;
      }
      button:hover:not(:disabled) { background: #9cc4a1; }
      button:active:not(:disabled) { transform: scale(.98); }
      button.secondary { background: #322c1f; color: #ede6d6; }
      button.secondary:hover:not(:disabled) { background: #3d3524; }
      button:disabled { opacity: .5; cursor: default; }
      .toggle { background: none; color: #b0a68e; width: auto; margin: 0; padding: 2px 6px; }
      .toggle:hover:not(:disabled) { background: none; color: #ede6d6; }
      .body { overflow: hidden; max-height: 0; opacity: 0; transition: max-height .18s ease, opacity .15s ease; }
      .body.open { max-height: 22rem; opacity: 1; }
      .status { margin-top: 8px; min-height: 1.2em; color: #b0a68e; word-break: break-word; }
      .fit { margin-top: 8px; padding: 6px 8px; border-radius: 8px; display: none; font-weight: 600; }
      .fit.candidate { display: block; background: rgba(111,190,138,.16); color: #6fbe8a; }
      .fit.needs_review { display: block; background: rgba(224,172,82,.16); color: #e0ac52; }
      .fit.skipped_unfit { display: block; background: rgba(224,135,112,.16); color: #e08770; }
      .note { margin-top: 8px; color: #7a7260; font-size: 11px; }
    </style>
    <div class="panel collapsed" id="panel">
      <div class="head">
        <img src="${iconUrl}" alt="" />
        <span class="brand">aplyx</span>
        <span class="spacer"></span>
        <button class="toggle" id="toggle" title="expand / collapse">▴</button>
      </div>
      <div class="body" id="body">
        <button id="fit">Fit check</button>
        <div class="fit" id="fitResult"></div>
        <button id="autofill">Autofill from profile</button>
        <button id="save" class="secondary">Save for review</button>
        <button id="applied" class="secondary">I submitted this — record it</button>
        <div class="status" id="status"></div>
        <div class="note">aplyx never submits a form — you review and click submit yourself.</div>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const panel = shadow.getElementById("panel")!;
  const body = shadow.getElementById("body")!;
  const toggle = shadow.getElementById("toggle")!;
  const status = shadow.getElementById("status")!;
  const fitResult = shadow.getElementById("fitResult")!;
  const actionButtons = ["fit", "autofill", "save", "applied"].map(
    (id) => shadow.getElementById(id) as HTMLButtonElement,
  );

  let expanded = false;
  const setExpanded = (value: boolean) => {
    expanded = value;
    body.classList.toggle("open", expanded);
    panel.classList.toggle("collapsed", !expanded);
    toggle.textContent = expanded ? "▾" : "▴";
  };
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setExpanded(!expanded);
  });
  panel.addEventListener("click", () => {
    if (!expanded) setExpanded(true);
  });

  const say = (message: string) => {
    status.textContent = message;
  };

  // All four actions talk to the same single-threaded bridge and read/
  // write the same job's state — running two at once (a fast double-click,
  // or clicking Autofill while Fit check is still in flight) previously
  // had no guard at all, risking overlapping bridge calls racing each
  // other. Disabling every action button for the duration of any one of
  // them, not just the clicked one, is the simplest correct fix — these
  // are all quick, sequential, single-user actions with no legitimate
  // reason to overlap.
  let busy = false;
  async function runExclusive<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (busy) return undefined;
    busy = true;
    actionButtons.forEach((btn) => (btn.disabled = true));
    try {
      return await task();
    } finally {
      busy = false;
      actionButtons.forEach((btn) => (btn.disabled = false));
    }
  }

  const job = (): ExtractedJob | null => extractJob(ats!, document, new URL(location.href));

  shadow.getElementById("fit")!.addEventListener("click", () =>
    runExclusive(async () => {
      const extracted = job();
      if (!extracted) return say("Could not read a posting from this page — open a specific job posting.");
      if (!extracted.jd_text) return say("No description text found on this page.");
      say("Running the fit gate…");
      const result = (await chrome.runtime.sendMessage({ type: "fit", job: extracted })) as FitResponse;
      if (!result.ok) return say(result.error ?? "Fit check failed.");
      fitResult.className = `fit ${result.fit_status}`;
      fitResult.textContent = `${result.fit_status} · score ${result.fit_score}` +
        (result.can_apply === false ? " · already recorded" : "");
      say(result.reasoning ?? "");
    }),
  );

  shadow.getElementById("autofill")!.addEventListener("click", () =>
    runExclusive(async () => {
      say("Scanning the form…");
      try {
        say(await autofill());
      } catch (err) {
        say(err instanceof Error ? err.message : String(err));
      }
    }),
  );

  const record = (statusValue: "applied" | "needs_review") =>
    runExclusive(async () => {
      const extracted = job();
      if (!extracted) return say("Could not read a posting from this page.");
      if (statusValue === "applied" &&
          !confirm(`Record that you applied to "${extracted.title}" at ${extracted.company}?\n\nOnly confirm after you actually submitted the application.`)) {
        return;
      }
      say("Recording…");
      const result = (await chrome.runtime.sendMessage({
        type: "outcome",
        job: extracted,
        status: statusValue,
      })) as OutcomeResponse;
      if (!result.ok) return say(result.error ?? "Recording failed.");
      if (!result.recorded) return say(`Not recorded: ${result.reason ?? "already recorded"}.`);
      say(statusValue === "applied"
        ? `Recorded as applied ✓${result.tracker_sync === "synced" ? " (tracker synced)" : ""}`
        : "Saved to the review queue ✓");
    });
  shadow.getElementById("applied")!.addEventListener("click", () => void record("applied"));
  shadow.getElementById("save")!.addEventListener("click", () => void record("needs_review"));
}
