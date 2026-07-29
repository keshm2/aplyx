import { DEFAULT_BRIDGE_URL, HealthResponse } from "./shared.js";

const urlInput = document.getElementById("bridgeUrl") as HTMLInputElement;
const tokenInput = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status") as HTMLDivElement;

function show(message: string, ok: boolean): void {
  status.textContent = message;
  status.className = ok ? "ok" : "err";
}

async function restore(): Promise<void> {
  const stored = await chrome.storage.local.get(["bridgeUrl", "token"]);
  urlInput.value = (stored.bridgeUrl as string) || DEFAULT_BRIDGE_URL;
  tokenInput.value = (stored.token as string) || "";
}

document.getElementById("save")!.addEventListener("click", async () => {
  const bridgeUrl = urlInput.value.trim() || DEFAULT_BRIDGE_URL;
  try {
    const parsed = new URL(bridgeUrl);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      show("The bridge must be local (127.0.0.1) — refusing to save a remote URL.", false);
      return;
    }
  } catch {
    show("Bridge URL is not a valid URL.", false);
    return;
  }
  await chrome.storage.local.set({ bridgeUrl, token: tokenInput.value.trim() });
  show("Saved.", true);
});

document.getElementById("test")!.addEventListener("click", async () => {
  show("Testing…", true);
  const result = (await chrome.runtime.sendMessage({ type: "health" })) as HealthResponse;
  if (result.ok) {
    show(`Connected — ${result.service} (${result.version}).`, true);
  } else {
    show(result.error ?? "Bridge did not respond.", false);
  }
});

void restore();
