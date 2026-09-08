/**
 * Canonical HTTP responses for every Edge Function. One rule: the body a
 * caller can read never carries internal detail — no Postgrest/DB message,
 * no stack, no env-var name, no upstream provider's raw error. The real
 * cause is written with console.error and lives only in the function's own
 * invocation logs, which no webview, browser, or webhook sender can see.
 *
 * Status classes, no exceptions:
 *   2xx  every success
 *   3xx  redirects only (Response.redirect / a Location header)
 *   4xx  the caller's fault — malformed input, missing or invalid auth
 *   5xx  our fault — anything that broke on our side, including a missing
 *        secret or an unconfigured upstream provider
 */

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

function body(payload: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
  });
}

function logCause(label: string, cause: unknown): void {
  console.error(`[${label}]`, cause instanceof Error ? (cause.stack ?? cause.message) : cause);
}

/** 200. `extra` is merged in for callers that already expect fields
 *  alongside `ok` (e.g. `{ ok: true, ignored: true }`). */
export function ok(extra: Record<string, unknown> = {}, headers?: Record<string, string>): Response {
  return body({ ok: true, ...extra }, 200, headers);
}

export function noContent(headers?: Record<string, string>): Response {
  return new Response(null, { status: 204, headers });
}

/** 400. `reason` must be a short, non-sensitive hint the caller can act on
 *  ("provider must be gmail or microsoft") — never an internal message. */
export function badRequest(reason = "bad request", headers?: Record<string, string>): Response {
  return body({ ok: false, error: reason }, 400, headers);
}

/** 401. Always the same opaque body, regardless of why auth failed. */
export function unauthorized(headers?: Record<string, string>): Response {
  return body({ ok: false, error: "unauthorized" }, 401, headers);
}

export function methodNotAllowed(headers?: Record<string, string>): Response {
  return body({ ok: false, error: "method not allowed" }, 405, headers);
}

/** 500 — our side. Logs the true cause; returns a fixed opaque body. */
export function serverError(label: string, cause?: unknown, headers?: Record<string, string>): Response {
  logCause(label, cause);
  return body({ ok: false, error: "internal error" }, 500, headers);
}

/** 503 — our side, transient or configuration: a dependency we need is
 *  unconfigured or unavailable. Opaque body; the caller may retry later. */
export function serviceUnavailable(label: string, cause?: unknown, headers?: Record<string, string>): Response {
  logCause(label, cause);
  return body({ ok: false, error: "service unavailable" }, 503, headers);
}
