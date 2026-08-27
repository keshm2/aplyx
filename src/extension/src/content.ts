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
if (ats) watchForForm();

/** How long to keep watching a page for a form that isn't there yet at
 *  document_idle before giving up quietly. Several supported ATS
 *  families (Ashby, Workday) hydrate their application form client-side
 *  well after the initial page load — a single one-shot scan would miss
 *  those and never prompt at all. Bounded, not indefinite: a page that
 *  genuinely never gets a form (a board index, a "thanks for applying"
 *  page) must not leave an observer running for the rest of the tab's
 *  life. */
const FORM_WATCH_TIMEOUT_MS = 12_000;

function hasApplicationForm(): boolean {
  const { mapped, unmappedRequired } = scanForm();
  return mapped.length > 0 || unmappedRequired.length > 0;
}

/** Detect-then-prompt, not always-on: the extension now stays completely
 *  invisible on any page that isn't an actual application form (a job
 *  listing, a search results page, a "thanks for applying" page) — a
 *  real improvement over the previous design, which showed a persistent
 *  corner panel on every matched-hostname page regardless of whether a
 *  fillable form was anywhere on it. */
function watchForForm(): void {
  if (hasApplicationForm()) {
    init();
    return;
  }
  // Debounced, not scanned on every callback — a React/Vue app hydrating
  // (Ashby, Workday) can fire dozens of mutation records in the same
  // burst, and each scan walks every input/textarea/select on the page
  // plus a getComputedStyle() call per element. Re-running that on every
  // single mutation would be real, visible jank on a busy page; waiting
  // for mutations to settle for a beat first costs nothing a user would
  // notice (this is a background detector, not something anyone is
  // staring at waiting for) and turns a burst of N mutations into one
  // scan instead of N.
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (hasApplicationForm()) {
        observer.disconnect();
        init();
      }
    }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => {
    clearTimeout(debounceTimer);
    observer.disconnect();
  }, FORM_WATCH_TIMEOUT_MS);
}

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
// Prompt UI (shadow DOM so page CSS can't corrupt it and vice versa) —
// only mounted once watchForForm() above has confirmed a real
// application form is present. Slides down from top-center asking a
// single yes/no question first, matching the "detects a form, asks
// before acting" pattern rather than the previous design's always-there
// corner panel.

function init(): void {
  const host = document.createElement("div");
  host.id = "aplyx-prompt-host";
  const shadow = host.attachShadow({ mode: "closed" });
  const iconUrl = chrome.runtime.getURL("icons/icon32.png");
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      /* Moss — the app's actual dark palette (src/tauri/src/styles/tokens.css)
         — plus a frosted-glass material (translucent + backdrop blur) over
         it, and the site's own --ease-out-expo curve (src/site/styles.css:
         cubic-bezier(.16,1,.3,1)) for the entrance, instead of an invented
         easing. Always dark regardless of the host page's own light/dark
         styling — deliberate, same reasoning as the homepage's review-demo
         mockup: this is a fixed recreation of a specific product surface,
         not a surface that should chameleon to whatever page it's overlaid
         on.
         Starts translated up + scaled down + transparent (not fully
         off-screen) — closer to how a real macOS notification banner
         actually enters than a hard slide from off-canvas, and
         pointer-events:none while hidden matters here specifically: unlike
         the old off-screen-translate version, this hidden state still sits
         near the top of the viewport, so without this it would silently
         eat clicks on whatever the host page has in that spot (its own nav,
         a banner) before the prompt is ever visible. */
      .prompt {
        position: fixed; top: 14px; left: 50%; z-index: 2147483647;
        width: 340px; max-width: calc(100vw - 24px);
        padding: 14px 16px; border-radius: 16px;
        background: rgba(30, 27, 20, 0.72);
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        color: #ede6d6;
        font: 13px/1.45 -apple-system, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif;
        box-shadow: 0 20px 48px -12px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08), inset 0 1px 0 rgba(255,255,255,.07);
        transform: translate(-50%, -14px) scale(.94);
        opacity: 0;
        pointer-events: none;
        transition: transform .4s cubic-bezier(.16,1,.3,1), opacity .3s cubic-bezier(.16,1,.3,1);
      }
      .prompt.visible {
        transform: translate(-50%, 0) scale(1);
        opacity: 1;
        pointer-events: auto;
      }
      .head { display: flex; align-items: center; gap: 8px; }
      .head img { width: 18px; height: 18px; border-radius: 4px; display: block; }
      .brand { font-weight: 700; color: #ede6d6; letter-spacing: .02em; }
      .spacer { flex: 1; }
      .close {
        display: flex; align-items: center; justify-content: center;
        width: 20px; height: 20px;
        background: rgba(255,255,255,.06); border: 0; border-radius: 50%; color: #b0a68e; cursor: pointer;
        font-size: 13px; line-height: 1; padding: 0;
        transition: background .12s ease, color .12s ease;
      }
      .close:hover { background: rgba(255,255,255,.12); color: #ede6d6; }
      .ask-text { margin-top: 10px; font-weight: 600; }
      .ask-row { display: flex; gap: 8px; margin-top: 12px; }
      button {
        font: inherit; font-weight: 600; border: 0; border-radius: 10px; cursor: pointer;
        padding: 8px 10px;
        background: #7fae86; color: #17140f;
        transition: background .15s cubic-bezier(.16,1,.3,1), opacity .12s ease, transform .12s cubic-bezier(.16,1,.3,1);
      }
      .ask-row button { flex: 1; }
      button.secondary { background: rgba(255,255,255,.08); color: #ede6d6; }
      button:hover:not(:disabled) { background: #9cc4a1; }
      button.secondary:hover:not(:disabled) { background: rgba(255,255,255,.14); }
      button:active:not(:disabled) { transform: scale(.97); }
      button:disabled { opacity: .5; cursor: default; }
      .body { overflow: hidden; max-height: 0; opacity: 0; transition: max-height .3s cubic-bezier(.16,1,.3,1), opacity .2s ease; }
      .body.open { max-height: 22rem; opacity: 1; margin-top: 6px; }
      .body button { width: 100%; margin-top: 8px; }
      .status { margin-top: 8px; min-height: 1.2em; color: #b0a68e; word-break: break-word; }
      .fit { margin-top: 8px; padding: 6px 8px; border-radius: 8px; display: none; font-weight: 600; }
      .fit.candidate { display: block; background: rgba(111,190,138,.18); color: #6fbe8a; }
      .fit.needs_review { display: block; background: rgba(224,172,82,.18); color: #e0ac52; }
      .fit.skipped_unfit { display: block; background: rgba(224,135,112,.18); color: #e08770; }
      .note { margin-top: 8px; color: #a89d84; font-size: 11px; }
      @media (prefers-reduced-motion: reduce) {
        .prompt, button, .body { transition-duration: .01ms !important; }
      }
    </style>
    <div class="prompt" id="prompt">
      <div class="head">
        <img src="${iconUrl}" alt="" />
        <span class="brand">aplyx</span>
        <span class="spacer"></span>
        <button class="close" id="close" title="dismiss" aria-label="dismiss">×</button>
      </div>
      <div class="ask" id="ask">
        <div class="ask-text">Autofill this application with aplyx?</div>
        <div class="ask-row">
          <button id="autofill">Autofill</button>
          <button class="secondary" id="notNow">Not now</button>
        </div>
      </div>
      <div class="body" id="body">
        <div class="status" id="status"></div>
        <button id="fit">Fit check</button>
        <div class="fit" id="fitResult"></div>
        <button id="autofillAgain">Autofill again</button>
        <button id="save" class="secondary">Save for review</button>
        <button id="applied" class="secondary">I submitted this — record it</button>
        <div class="note">aplyx never submits a form — you review and click submit yourself.</div>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const prompt = shadow.getElementById("prompt")!;
  const ask = shadow.getElementById("ask")!;
  const body = shadow.getElementById("body")!;
  const status = shadow.getElementById("status")!;
  const fitResult = shadow.getElementById("fitResult")!;
  const actionButtons = ["autofill", "autofillAgain", "fit", "save", "applied"].map(
    (id) => shadow.getElementById(id) as HTMLButtonElement,
  );

  // Two rAFs, not one — the element has to actually paint once at its
  // off-screen transform before adding .visible, or the browser can
  // coalesce both style changes into a single frame and the slide-down
  // never animates, it just appears already in place.
  requestAnimationFrame(() => requestAnimationFrame(() => prompt.classList.add("visible")));

  function dismiss(): void {
    prompt.classList.remove("visible");
  }
  shadow.getElementById("close")!.addEventListener("click", dismiss);

  // "Not now" means "don't autofill yet," not "go away" — it still
  // reveals the same fit-check/save/record actions the old panel always
  // had reachable together, just without running autofill. Only the ×
  // in the header actually dismisses the whole thing.
  function reveal(): void {
    ask.style.display = "none";
    body.classList.add("open");
  }
  shadow.getElementById("notNow")!.addEventListener("click", reveal);

  const say = (message: string) => {
    status.textContent = message;
  };

  // All actions talk to the same single-threaded bridge and read/write
  // the same job's state — running two at once (a fast double-click, or
  // clicking Autofill while Fit check is still in flight) has no guard
  // otherwise, risking overlapping bridge calls racing each other.
  // Disabling every action button for the duration of any one of them,
  // not just the clicked one, is the simplest correct fix — these are
  // all quick, sequential, single-user actions with no legitimate reason
  // to overlap.
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

  const runAutofill = () =>
    runExclusive(async () => {
      reveal();
      say("Scanning the form…");
      try {
        say(await autofill());
      } catch (err) {
        say(err instanceof Error ? err.message : String(err));
      }
    });
  shadow.getElementById("autofill")!.addEventListener("click", () => void runAutofill());
  shadow.getElementById("autofillAgain")!.addEventListener("click", () => void runAutofill());

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
