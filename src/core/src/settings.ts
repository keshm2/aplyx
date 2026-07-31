import fs from "node:fs";
import path from "node:path";

/**
 * Read/write helpers for the Settings screen. These touch CONFIG files
 * only (src/config/targets.json safe_fields, src/config/discord_config.json,
 * src/config/env.json) — the same files the setup wizard writes; runtime
 * STATE stays with the Python helpers. Writes are read-modify-write so
 * unrelated keys are preserved.
 */

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, data: Json): void {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  // targets.json/discord_config.json/env.json all carry PII (name, DOB,
  // address, webhook URLs) — don't rely on ambient umask; writeFileSync's
  // mode option only applies on create, so chmod explicitly every write.
  fs.chmodSync(file, 0o600);
}

// --- Personal info (src/config/targets.json safe_fields) -----------------------

const targetsPath = (root: string) => path.join(root, "src", "config", "targets.json");

/** A truly fresh install has no src/config/targets.json yet. Seed it from the
 *  committed example template before the first field write, so a
 *  read-modify-write that only knows about one key doesn't silently drop
 *  role_keywords/preferred_locations/target_companies defaults. Shared by
 *  the TUI onboarding wizard and the desktop app's bridge — one seeding
 *  implementation, not two. */
export function ensureTargetsFile(root: string): void {
  const file = targetsPath(root);
  if (fs.existsSync(file)) return;
  try {
    fs.copyFileSync(path.join(root, "src", "config", "targets.example.json"), file);
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort — subsequent reads/writes still degrade gracefully via
    // readJson's own try/catch
  }
}

/** True once onboarding has been completed at least once — the same
 *  targets.json `_onboarding.completed` flag the TUI's OnboardingWizard
 *  writes, so either surface finishing onboarding is recognized by both. */
export function readOnboardingCompleted(root: string): boolean {
  const raw = readJson(targetsPath(root))._onboarding as { completed?: unknown } | undefined;
  return raw?.completed === true;
}

export function writeOnboardingCompleted(root: string, completed: boolean): void {
  const file = targetsPath(root);
  const data = readJson(file);
  const existing = (data._onboarding as Json | undefined) ?? {};
  data._onboarding = { ...existing, completed };
  writeJson(file, data);
}

export function readSafeField(root: string, key: string): string {
  const safe = (readJson(targetsPath(root)).safe_fields ?? {}) as Json;
  const val = String(safe[key] ?? "").trim();
  return val === "REPLACE_ME" || /^YOUR_/.test(val) ? "" : val;
}

export function writeSafeField(root: string, key: string, value: string): void {
  const file = targetsPath(root);
  const targets = readJson(file);
  const safe = (targets.safe_fields ?? {}) as Json;
  safe[key] = value;
  targets.safe_fields = safe;
  writeJson(file, targets);
}

/** Name the TUI greets the user by: preferred_name, else first_name. */
export function displayName(root: string): string | undefined {
  return readSafeField(root, "preferred_name") || readSafeField(root, "first_name") || undefined;
}

// --- Top-level targets.json arrays (role_keywords, preferred_locations, ...) --

export function readTargetsArray(root: string, key: string): string {
  const targets = readJson(targetsPath(root));
  const arr = Array.isArray(targets[key]) ? (targets[key] as unknown[]) : [];
  return arr.map((v) => String(v)).join(", ");
}

export function writeTargetsArray(root: string, key: string, value: string): void {
  const file = targetsPath(root);
  const targets = readJson(file);
  targets[key] = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  writeJson(file, targets);
}

/** List-native counterparts of readTargetsArray/writeTargetsArray. The
 *  comma-string versions above are lossy for any array whose entries
 *  themselves contain a comma — e.g. "Seattle, WA" round-tripped through
 *  a join(", ")+split(",") silently becomes two entries, "Seattle" and
 *  "WA". Every caller that already holds (or produces) a real string[]
 *  — the itemized add/remove editors, the location/company autocomplete
 *  fields — must use these instead so an entry's own commas are never
 *  mistaken for the array's join delimiter. */
export function readTargetsArrayList(root: string, key: string): string[] {
  const targets = readJson(targetsPath(root));
  const arr = Array.isArray(targets[key]) ? (targets[key] as unknown[]) : [];
  return arr.map((v) => String(v));
}

export function writeTargetsArrayList(root: string, key: string, values: string[]): void {
  const file = targetsPath(root);
  const targets = readJson(file);
  targets[key] = values.map((v) => v.trim()).filter(Boolean);
  writeJson(file, targets);
}

/** Top-level targets.json booleans (e.g. allow_experienced_roles) — a
 *  missing key reads as `false`, matching every such flag's documented
 *  default in targets.example.json's _help notes. */
export function readTargetsBool(root: string, key: string): boolean {
  return Boolean(readJson(targetsPath(root))[key]);
}

export function writeTargetsBool(root: string, key: string, value: boolean): void {
  const file = targetsPath(root);
  const targets = readJson(file);
  targets[key] = value;
  writeJson(file, targets);
}

// --- Discord (src/config/discord_config.json) ----------------------------------

const discordPath = (root: string) => path.join(root, "src", "config", "discord_config.json");

export function readDiscordEnabled(root: string): boolean {
  const cfg = readJson(discordPath(root));
  if (!fs.existsSync(discordPath(root))) return false;
  return cfg.enabled === undefined ? true : Boolean(cfg.enabled);
}

export function writeDiscordEnabled(root: string, enabled: boolean): void {
  const file = discordPath(root);
  const cfg = readJson(file);
  cfg.enabled = enabled;
  if (cfg.webhooks === undefined) cfg.webhooks = {};
  writeJson(file, cfg);
}

export function readDiscordRoute(root: string, route: string): string {
  const hooks = (readJson(discordPath(root)).webhooks ?? {}) as Json;
  const val = String(hooks[route] ?? "").trim();
  return val === "REPLACE_ME" ? "" : val;
}

export function writeDiscordRoute(root: string, route: string, url: string): void {
  const file = discordPath(root);
  const cfg = readJson(file);
  const hooks = (cfg.webhooks ?? {}) as Json;
  if (url) hooks[route] = url;
  else delete hooks[route];
  cfg.webhooks = hooks;
  if (cfg.enabled === undefined) cfg.enabled = true;
  writeJson(file, cfg);
}

// --- Environment overrides (src/config/env.json) --------------------------------
// Persisted APLYX_* overrides; the runner exports them at startup and the
// TUI reads them for its own paths. A real environment variable always wins.

const envPath = (root: string) => path.join(root, "src", "config", "env.json");

export function readEnvOverride(root: string, key: string): string {
  return String(readJson(envPath(root))[key] ?? "").trim();
}

export function writeEnvOverride(root: string, key: string, value: string): void {
  const file = envPath(root);
  const cfg = readJson(file);
  if (value) cfg[key] = value;
  else delete cfg[key];
  writeJson(file, cfg);
}

/** Effective value + where it came from (env > src/config/env.json > default).
 *  `key` accepts a list so a rebrand can pass the current name first and
 *  older names (still honored) after — e.g. `["APLYX_X", "FLUX_X"]`. */
export function effectiveEnv(
  root: string,
  key: string | readonly string[],
  fallback: string,
): { value: string; origin: "env" | "config" | "default" } {
  const keys = Array.isArray(key) ? key : [key];
  for (const k of keys) {
    const fromEnv = (process.env[k] ?? "").trim();
    if (fromEnv) return { value: fromEnv, origin: "env" };
  }
  for (const k of keys) {
    const fromConfig = readEnvOverride(root, k);
    if (fromConfig) return { value: fromConfig, origin: "config" };
  }
  return { value: fallback, origin: "default" };
}

/** Log directory honored by the runner and the TUI's log readers. */
export function logDir(root: string): string {
  const dir = effectiveEnv(root, ["APLYX_LOG_DIR", "FLUX_LOG_DIR"], "logs").value;
  return path.isAbsolute(dir) ? dir : path.join(root, dir);
}
