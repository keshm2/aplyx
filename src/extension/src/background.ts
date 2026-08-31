// Background service worker, the only component that holds the bridge
// token and talks to the localhost bridge. Content scripts message it;
// safe_fields values pass through only for the specific keys a page's
// form actually mapped.
import { BridgeMessage, DEFAULT_BRIDGE_URL } from "./shared.js";

// There's no popup UI (manifest's "action" has no default_popup), so a
// toolbar-icon click would otherwise do nothing. Options is the one
// screen the extension has, so that's where a click should land, same
// as the right-click context menu's existing "Options" entry already
// goes.
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

interface BridgeSettings {
  bridgeUrl: string;
  token: string;
}

async function settings(): Promise<BridgeSettings> {
  const stored = await chrome.storage.local.get(["bridgeUrl", "token"]);
  return {
    bridgeUrl: (stored.bridgeUrl as string) || DEFAULT_BRIDGE_URL,
    token: (stored.token as string) || "",
  };
}

async function callBridge(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const { bridgeUrl, token } = await settings();
  if (!token) {
    return {
      ok: false,
      error: "bridge token not set: open the aplyx extension options and paste the token from src/config/extension_bridge.json",
    };
  }
  let response: Response;
  try {
    response = await fetch(`${bridgeUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return {
      ok: false,
      error: "bridge unreachable: start src/scripts/runtime/extension_bridge.py (Windows: py -3 ..., macOS/Linux: python3 ...)",
    };
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `bridge returned a non-JSON response (HTTP ${response.status})` };
  }
}

function handle(message: BridgeMessage): Promise<Record<string, unknown>> {
  switch (message.type) {
    case "health":
      return callBridge("GET", "/health");
    case "fit":
      return callBridge("POST", "/fit", { job: message.job });
    case "fields":
      return callBridge("POST", "/fields", { keys: message.keys });
    case "outcome":
      return callBridge("POST", "/outcome", { job: message.job, status: message.status });
  }
}

chrome.runtime.onMessage.addListener((message: BridgeMessage, _sender, sendResponse) => {
  handle(message).then(sendResponse, (err: unknown) =>
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true; // async response
});
