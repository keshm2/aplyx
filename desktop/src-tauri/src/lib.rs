// Local-mode IPC: the frontend calls these narrow, typed commands via
// invoke() rather than being granted a general shell-execute permission.
// Each command shells out (Rust-side only) to the shared @aplyx/core
// bridge CLI (packages/core/src/bridge.ts) over stdio — a spawned
// subprocess, not a localhost server — reusing the exact same profile/state
// logic the Ink TUI already uses. Hosted mode bypasses this entirely: the
// frontend talks to Supabase directly via @supabase/supabase-js.
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use tauri::path::BaseDirectory;
use tauri::Manager;

/// Resolves the bridge script for both a packaged/installed build and a
/// local `tauri dev` checkout.
///
/// A prebuilt release (see .github/workflows/desktop-release.yml, which
/// compiles on a GitHub-hosted CI runner and installers download the
/// result) bakes `env!("CARGO_MANIFEST_DIR")` in at *compile* time — on
/// the CI runner that's something like
/// `/Users/runner/work/aplyx/aplyx/desktop/src-tauri`, a path that only
/// ever exists on the machine that ran `cargo build`. Every end user
/// hitting "core bridge not found at /Users/runner/work/..." was this
/// exact bug: the dev-relative path is meaningless outside a full source
/// checkout built in place. Resources declared in tauri.conf.json's
/// `bundle.resources` (`packages/core/dist` → `core/`) are copied into
/// the app bundle at build time and resolved here at *run* time via
/// `resource_dir()`, so a downloaded/installed build finds its own copy
/// regardless of where it was compiled. The dev-relative path remains the
/// fallback for `tauri dev` against a full checkout, same as before.
fn bridge_script_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // The path never changes within a process lifetime, but every bridge
    // command re-probed the filesystem (two exists() checks, and under
    // tauri dev a resource-dir resolution) on every call — once per
    // search, fit, save, profile read, etc. Cache it after the first hit.
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    if let Some(p) = CACHE.get() {
        return Ok(p.clone());
    }
    let resolved = bridge_script_path_uncached(app)?;
    let _ = CACHE.set(resolved.clone());
    Ok(resolved)
}

/// `PathBuf::canonicalize()` on Windows always returns an extended-length
/// "verbatim" path prefixed `\\?\` (from `GetFinalPathNameByHandleW` — this
/// is documented Windows/Rust behavior, not a bug). That prefix opts OUT of
/// normal Win32 path processing, and several Windows APIs explicitly don't
/// support it — `SetCurrentDirectory`/`CreateProcess`'s working-directory
/// argument being one (Microsoft's own "Maximum Path Length Limitation"
/// docs call this out by name). Using an un-stripped canonical path as a
/// spawned process's `current_dir()` risks exactly the kind of spawn-time
/// failure this file already exists to avoid. Canonicalizing still buys
/// the thing we actually want (a fully resolved, unambiguous, real path
/// with no relative components or symlink indirection) — just strip the
/// prefix back off before the path leaves this function, so nothing
/// downstream has to know or care that it was ever there. No-op on
/// non-Windows, where canonicalize() never adds this prefix.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    match path.to_str() {
        Some(s) => {
            if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
                PathBuf::from(format!(r"\\{rest}"))
            } else if let Some(rest) = s.strip_prefix(r"\\?\") {
                PathBuf::from(rest)
            } else {
                path
            }
        }
        None => path,
    }
}

fn bridge_script_path_uncached(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_path) = app.path().resolve("core/bridge.js", BaseDirectory::Resource) {
        if resource_path.exists() {
            // Canonicalize before handing this to Command: on Windows a
            // GUI-launched app's resolved resource path can come back non-
            // fully-qualified (relative components, a bare drive prefix
            // with no root, etc. depending on how resource_dir() derived
            // it from current_exe()). Node's own startup does
            // fs.realpathSync() on argv[1] before any of our code runs
            // (resolveMainPath -> toRealPath in node:internal/modules) —
            // handing it something already-canonical avoids feeding that
            // codepath anything ambiguous. A path that exists but fails to
            // canonicalize is treated as not found rather than risking a
            // bad argv[1] reaching node at all.
            if let Ok(canonical) = resource_path.canonicalize() {
                return Ok(strip_verbatim_prefix(canonical));
            }
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_path = manifest_dir
        .join("..")
        .join("..")
        .join("packages")
        .join("core")
        .join("dist")
        .join("bridge.js");
    if let Ok(canonical) = dev_path.canonicalize() {
        return Ok(strip_verbatim_prefix(canonical));
    }

    Err(format!(
        "core bridge not found in the app's bundled resources or at {} — run `npm run build:core` from the repo root",
        dev_path.display()
    ))
}

/// A Finder-launched .app inherits launchd's minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin), which does not include Homebrew, nvm,
/// or Volta install locations — so `Command::new("node")` works under
/// `tauri dev` (terminal PATH) but fails in the installed bundle. That
/// spawn failure surfaced as the auth screen hanging on "Checking sign-in
/// availability…" forever. Probe the common install locations before
/// falling back to PATH lookup.
///
/// Windows GUI processes (Start Menu/taskbar-launched) DO inherit the
/// registry-derived user/machine PATH at logon, unlike launchd — but that
/// PATH is stale for any node install that happened after the current
/// login session started (a very normal sequence: install Node, don't
/// reboot, launch aplyx from the Start Menu the same session), and
/// nvm-windows/Volta both manage their active version through paths this
/// process's inherited PATH may not include even when fresh. Probe the
/// same well-known install locations there too rather than relying solely
/// on inherited PATH.
fn node_binary() -> PathBuf {
    // Probing Homebrew/Volta/nvm install paths (several exists() checks
    // and a read_dir) on every bridge command is wasteful — the node
    // binary doesn't move during a process lifetime. Cache the first hit.
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    if let Some(p) = CACHE.get() {
        return p.clone();
    }
    let resolved = node_binary_uncached();
    let _ = CACHE.set(resolved.clone());
    resolved
}

#[cfg(target_os = "windows")]
fn node_binary_uncached() -> PathBuf {
    // Covers both the official Node installer's default install dir AND
    // nvm-windows, whose default `path` setting (the symlink/junction it
    // repoints to the active version) is this same directory.
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(dir) = std::env::var(var) {
            let path = PathBuf::from(dir).join("nodejs").join("node.exe");
            if path.exists() {
                return path;
            }
        }
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        // Volta on Windows.
        let volta = PathBuf::from(&local_app_data)
            .join("Volta")
            .join("bin")
            .join("node.exe");
        if volta.exists() {
            return volta;
        }
    }
    PathBuf::from("node")
}

#[cfg(not(target_os = "windows"))]
fn node_binary_uncached() -> PathBuf {
    for p in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/local/bin/node",
    ] {
        let path = PathBuf::from(p);
        if path.exists() {
            return path;
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let volta = PathBuf::from(&home).join(".volta").join("bin").join("node");
        if volta.exists() {
            return volta;
        }
        let nvm_versions = PathBuf::from(&home).join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
            let mut nodes: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path().join("bin").join("node"))
                .filter(|p| p.exists())
                .collect();
            nodes.sort();
            if let Some(newest) = nodes.pop() {
                return newest;
            }
        }
    }
    PathBuf::from("node")
}

fn run_bridge(app: &tauri::AppHandle, command: &str, args: Option<Value>) -> Result<Value, String> {
    let script = bridge_script_path(app)?;
    let mut cmd = Command::new(node_binary());
    // On Windows, spawning a console subprocess (node.exe) from a GUI app
    // with no console of its own makes Windows allocate a brand-new
    // console window for it by default — visible as a black cmd-style
    // window flashing open and closed. std::process::Command does not
    // suppress this on its own; CREATE_NO_WINDOW is the documented way to
    // opt out. Reported live: "a bunch of command prompts that open and
    // close in the background in quick sub-second intervals" whenever a
    // screen fires several bridge calls in a row (e.g. one per profile
    // field before the batching fix below) — window allocation isn't free
    // either, so this was also part of the reported per-page slowness, not
    // just the visual flashing. No-op on macOS/Linux, where a spawned
    // process never gets its own terminal window regardless.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Never let node inherit this process's cwd. A GUI-launched app's
    // working directory is whatever the OS/shortcut happened to set it to
    // (observed on Windows: a bare drive root with no trailing
    // separator), and that gets passed straight through to the spawned
    // node process. Node's startup resolves argv[1] via
    // path.resolve(cwd, main) before any of our code runs, so an
    // unpredictable inherited cwd is a hazard even when `script` itself is
    // a fully-qualified, canonical path. Anchoring to the script's own
    // parent directory — guaranteed to exist, since bridge_script_path()
    // just verified the script file itself — removes the dependency on
    // ambient process state entirely.
    if let Some(parent) = script.parent() {
        cmd.current_dir(parent);
    }
    cmd.arg(&script).arg(command);
    if let Some(a) = &args {
        cmd.arg(a.to_string());
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn node ({}): {e}", script.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("bridge produced non-JSON output: {e} (stdout: {stdout}, stderr: {stderr})")
    })?;
    let ok = parsed.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if ok {
        Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("bridge command failed")
            .to_string())
    }
}

#[tauri::command]
fn find_root(app: tauri::AppHandle) -> Result<Value, String> {
    run_bridge(&app, "findRoot", None)
}

#[tauri::command]
fn validate_root(app: tauri::AppHandle, dir: String) -> Result<Value, String> {
    run_bridge(&app, "validateRoot", Some(serde_json::json!({ "dir": dir })))
}

#[tauri::command]
fn ensure_targets_file(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "ensureTargetsFile", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn read_profile_field(app: tauri::AppHandle, root: String, id: String) -> Result<Value, String> {
    run_bridge(
        &app,
        "readProfileField",
        Some(serde_json::json!({ "root": root, "id": id })),
    )
}

#[tauri::command]
fn write_profile_field(app: tauri::AppHandle, root: String, id: String, value: Value) -> Result<Value, String> {
    run_bridge(
        &app,
        "writeProfileField",
        Some(serde_json::json!({ "root": root, "id": id, "value": value })),
    )
}

/// Batched siblings of read/write_profile_field — one bridge spawn (one
/// node process) for a whole page of fields instead of one per field. See
/// packages/core/src/bridge.ts's matching comment for why: each of these
/// commands is a separate `node <script>` process (run_bridge above has no
/// long-lived bridge process to reuse), so N fields meant N concurrent
/// cold-started processes — reported live as flashing console windows and
/// multi-second page transitions on Windows, worst on the onboarding
/// Profile step and Settings' Profile screen (which read every field up
/// front).
#[tauri::command]
fn read_profile_fields(app: tauri::AppHandle, root: String, ids: Vec<String>) -> Result<Value, String> {
    run_bridge(
        &app,
        "readProfileFields",
        Some(serde_json::json!({ "root": root, "ids": ids })),
    )
}

#[tauri::command]
fn write_profile_fields(app: tauri::AppHandle, root: String, values: Value) -> Result<Value, String> {
    run_bridge(
        &app,
        "writeProfileFields",
        Some(serde_json::json!({ "root": root, "values": values })),
    )
}

#[tauri::command]
fn load_local_state(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "loadState", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn run_validator(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "runValidator", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn read_supabase_config(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "readSupabaseConfig", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn detect_harnesses(app: tauri::AppHandle) -> Result<Value, String> {
    run_bridge(&app, "detectHarnesses", None)
}

#[tauri::command]
fn list_companies(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "listCompanies", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn read_harness(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "readHarness", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn write_harness(app: tauri::AppHandle, root: String, harness: String) -> Result<Value, String> {
    run_bridge(
        &app,
        "writeHarness",
        Some(serde_json::json!({ "root": root, "harness": harness })),
    )
}

#[tauri::command]
fn read_discord_config(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "readDiscordConfig", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn write_discord_config(app: tauri::AppHandle, root: String, enabled: Option<bool>, routes: Value) -> Result<Value, String> {
    run_bridge(
        &app,
        "writeDiscordConfig",
        Some(serde_json::json!({ "root": root, "enabled": enabled, "routes": routes })),
    )
}

#[tauri::command]
fn list_resumes(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "listResumes", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn convert_resume(app: tauri::AppHandle, root: String, stem: String, description: Option<String>) -> Result<Value, String> {
    run_bridge(
        &app,
        "convertResume",
        Some(serde_json::json!({ "root": root, "stem": stem, "description": description.unwrap_or_default() })),
    )
}

#[tauri::command]
fn import_resume_file(app: tauri::AppHandle, root: String, source_path: String, stem: String) -> Result<Value, String> {
    run_bridge(
        &app,
        "importResumeFile",
        Some(serde_json::json!({ "root": root, "sourcePath": source_path, "stem": stem })),
    )
}

#[tauri::command]
fn open_extension_folder(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "openExtensionFolder", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn search_jobs(app: tauri::AppHandle, root: String, query: String, sources: Value) -> Result<Value, String> {
    run_bridge(
        &app,
        "searchJobs",
        Some(serde_json::json!({ "root": root, "query": query, "sources": sources })),
    )
}

#[tauri::command]
fn check_job_fit(app: tauri::AppHandle, root: String, job: Value) -> Result<Value, String> {
    run_bridge(&app, "checkJobFit", Some(serde_json::json!({ "root": root, "job": job })))
}

#[tauri::command]
fn save_job_for_review(app: tauri::AppHandle, root: String, job: Value) -> Result<Value, String> {
    run_bridge(&app, "saveJobForReview", Some(serde_json::json!({ "root": root, "job": job })))
}

#[tauri::command]
fn mark_queue_entry_applied(app: tauri::AppHandle, root: String, entry: Value) -> Result<Value, String> {
    run_bridge(
        &app,
        "markQueueEntryApplied",
        Some(serde_json::json!({ "root": root, "entry": entry })),
    )
}

#[tauri::command]
fn dismiss_queue_entry(app: tauri::AppHandle, root: String, entry: Value) -> Result<Value, String> {
    run_bridge(
        &app,
        "dismissQueueEntry",
        Some(serde_json::json!({ "root": root, "entry": entry })),
    )
}

#[tauri::command]
fn list_resume_details(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "listResumeDetails", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn open_resumes_folder(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "openResumesFolder", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn read_onboarding_completed(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "readOnboardingCompleted", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn write_onboarding_completed(app: tauri::AppHandle, root: String, completed: bool) -> Result<Value, String> {
    run_bridge(
        &app,
        "writeOnboardingCompleted",
        Some(serde_json::json!({ "root": root, "completed": completed })),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Auth callback deep link (aplyx://auth-callback — see
        // desktop/src/lib/AuthContext.tsx). Works out of the box on macOS
        // once the app is bundled+installed. On Windows/Linux, a deep-link
        // click spawns a NEW app instance with the URL as a CLI arg rather
        // than routing into this one — combine with tauri-plugin-single-
        // instance before shipping cross-platform; not added yet since
        // this pass only needed macOS to work.
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            find_root,
            validate_root,
            ensure_targets_file,
            read_profile_field,
            write_profile_field,
            read_profile_fields,
            write_profile_fields,
            load_local_state,
            run_validator,
            read_supabase_config,
            detect_harnesses,
            list_companies,
            read_harness,
            write_harness,
            read_discord_config,
            write_discord_config,
            list_resumes,
            convert_resume,
            import_resume_file,
            open_extension_folder,
            search_jobs,
            check_job_fit,
            save_job_for_review,
            mark_queue_entry_applied,
            dismiss_queue_entry,
            list_resume_details,
            open_resumes_folder,
            read_onboarding_completed,
            write_onboarding_completed
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
