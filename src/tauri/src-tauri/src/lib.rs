// Local-mode IPC: the frontend calls these narrow, typed commands via
// invoke() rather than being granted a general shell-execute permission.
// Each command shells out (Rust-side only) to the shared @aplyx/core
// bridge CLI (src/core/src/bridge.ts) over stdio — a spawned
// subprocess, not a localhost server — reusing the exact same profile/state
// logic the Ink TUI already uses. Hosted mode bypasses this entirely: the
// frontend talks to Supabase directly via @supabase/supabase-js.
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::Manager;

/// Resolves the bridge script for both a packaged/installed build and a
/// local `tauri dev` checkout.
///
/// A prebuilt release (see .github/workflows/desktop-release.yml, which
/// compiles on a GitHub-hosted CI runner and installers download the
/// result) bakes `env!("CARGO_MANIFEST_DIR")` in at *compile* time — on
/// the CI runner that's something like
/// `/Users/runner/work/aplyx/aplyx/src/tauri/src-tauri`, a path that only
/// ever exists on the machine that ran `cargo build`. Every end user
/// hitting "core bridge not found at /Users/runner/work/..." was this
/// exact bug: the dev-relative path is meaningless outside a full source
/// checkout built in place. Resources declared in tauri.conf.json's
/// `bundle.resources` (`core/dist` → `core/`) are copied into
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

/// A persistent `bridge.js --serve` process (see that file's header) —
/// spawned lazily on the first search, kept alive for the rest of the
/// app session instead of the normal spawn-per-command model every
/// other bridge command still uses. Its whole reason to exist is
/// jobCache.ts's in-memory browse-all snapshot: that state only survives
/// between searches if the process itself does. `child` is kept so the
/// reader thread can reap it (avoiding a zombie on Unix) once it exits,
/// and so it can be killed explicitly on app quit — a spawned child is
/// NOT killed automatically when this process exits (Rust's `Child`
/// drop does not do that), so without this the daemon would keep
/// running as an orphan after the app window closes.
struct SearchDaemon {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    child: Mutex<Child>,
}

type SearchDaemonState = Mutex<Option<Arc<SearchDaemon>>>;

/// Generous relative to jobs.ts's own internal deadlines (2.2s per live
/// source, 1.2s Postgres, 0.9s Redis — a normal worst-case search lands
/// comfortably under 3s) — this is a last-resort ceiling for something
/// actually wrong (a hung/dead daemon), not a budget real searches are
/// expected to approach. Timing out here just means falling back to the
/// existing one-shot path, so erring generous costs nothing but a slower
/// single search on the rare unlucky case.
const DAEMON_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

fn spawn_search_daemon(app: &tauri::AppHandle) -> Result<Arc<SearchDaemon>, String> {
    let script = bridge_script_path(app)?;
    let mut cmd = Command::new(node_binary());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(parent) = script.parent() {
        cmd.current_dir(parent);
    }
    cmd.arg(&script)
        .arg("--serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn search daemon ({}): {e}", script.display()))?;
    let stdin = child.stdin.take().ok_or("search daemon has no stdin")?;
    let stdout = child.stdout.take().ok_or("search daemon has no stdout")?;
    let stderr = child.stderr.take();

    let daemon = Arc::new(SearchDaemon {
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        child: Mutex::new(child),
    });

    // Reader thread: one line in, look up the pending sender for that
    // request id, hand it the result. Requests are never processed in
    // arrival order on the write side either (see bridge.ts's serve()) —
    // a slow search never blocks a faster concurrent one from returning
    // first, which matters here specifically because the desktop app's
    // two-phase search fires both searchJobs() calls at once.
    {
        let daemon = Arc::clone(&daemon);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Ok(parsed) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Some(id) = parsed.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                let ok = parsed.get("ok").and_then(Value::as_bool).unwrap_or(false);
                let result = if ok {
                    Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(parsed
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("search daemon returned an error")
                        .to_string())
                };
                let sender = daemon.pending.lock().unwrap().remove(&id);
                if let Some(sender) = sender {
                    let _ = sender.send(result);
                }
            }
            // stdout closed — the daemon process exited (crashed, or was
            // killed on app quit). Reap it so it doesn't linger as a
            // zombie, and clear out any still-pending requests so their
            // callers hit the timeout path promptly instead of waiting
            // the full DAEMON_REQUEST_TIMEOUT for a response that will
            // now never arrive.
            let _ = daemon.child.lock().unwrap().wait();
            daemon.pending.lock().unwrap().clear();
        });
    }

    // Drain stderr so a chatty child (e.g. the in-memory refresh loop's
    // own error logging) never blocks on a full pipe buffer. Forwarded
    // to this process's stderr, prefixed, purely for local debugging —
    // never parsed or acted on.
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[search-daemon] {line}");
            }
        });
    }

    Ok(daemon)
}

fn get_or_spawn_daemon(app: &tauri::AppHandle) -> Result<Arc<SearchDaemon>, String> {
    let state = app.state::<SearchDaemonState>();
    let mut guard = state.lock().unwrap();
    if let Some(daemon) = guard.as_ref() {
        // A previously-spawned daemon whose process has since died (see
        // the reader thread's cleanup above) still lives in this Option
        // until replaced — detect that and respawn rather than handing
        // back a daemon nothing will ever respond through.
        if daemon.child.lock().unwrap().try_wait().ok().flatten().is_none() {
            return Ok(Arc::clone(daemon));
        }
    }
    let daemon = spawn_search_daemon(app)?;
    *guard = Some(Arc::clone(&daemon));
    Ok(daemon)
}

/// Sends one request to the persistent search daemon and waits for its
/// response, falling back to nothing on any failure — the caller (see
/// search_jobs below) is responsible for retrying via the existing
/// one-shot run_bridge path when this returns Err, so a daemon bug can
/// only ever make a search as slow as it already was before this
/// existed, never slower or broken.
fn send_daemon_request(app: &tauri::AppHandle, command: &str, args: Value) -> Result<Value, String> {
    let daemon = get_or_spawn_daemon(app)?;
    let id = daemon.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    daemon.pending.lock().unwrap().insert(id, tx);

    let request = serde_json::json!({ "id": id, "command": command, "args": args }).to_string();
    {
        let mut stdin = daemon.stdin.lock().unwrap();
        if let Err(e) = writeln!(stdin, "{request}").and_then(|_| stdin.flush()) {
            daemon.pending.lock().unwrap().remove(&id);
            return Err(format!("failed to write to search daemon: {e}"));
        }
    }

    match rx.recv_timeout(DAEMON_REQUEST_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            daemon.pending.lock().unwrap().remove(&id);
            Err("search daemon request timed out".to_string())
        }
    }
}

/// Best-effort — called on app exit so the daemon doesn't keep running
/// as an orphaned background process after the window closes.
fn kill_search_daemon(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SearchDaemonState>() {
        if let Some(daemon) = state.lock().unwrap().take() {
            let _ = daemon.child.lock().unwrap().kill();
        }
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
/// src/core/src/bridge.ts's matching comment for why: each of these
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
fn convert_resume(app: tauri::AppHandle, root: String, stem: String, description: Option<String>, force: Option<bool>) -> Result<Value, String> {
    run_bridge(
        &app,
        "convertResume",
        Some(serde_json::json!({ "root": root, "stem": stem, "description": description.unwrap_or_default(), "force": force.unwrap_or(false) })),
    )
}

#[tauri::command]
fn set_resume_description(app: tauri::AppHandle, root: String, stem: String, description: Option<String>) -> Result<Value, String> {
    run_bridge(
        &app,
        "setResumeDescription",
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
fn get_master_resume(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "getMasterResume", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn set_master_resume(app: tauri::AppHandle, root: String, resume: Value) -> Result<Value, String> {
    run_bridge(&app, "setMasterResume", Some(serde_json::json!({ "root": root, "resume": resume })))
}

#[tauri::command]
fn read_resume_markdown(app: tauri::AppHandle, root: String, stem: String) -> Result<Value, String> {
    run_bridge(&app, "readResumeMarkdown", Some(serde_json::json!({ "root": root, "stem": stem })))
}

#[tauri::command]
fn read_fill_record(app: tauri::AppHandle, root: String, path: String) -> Result<Value, String> {
    run_bridge(&app, "readFillRecord", Some(serde_json::json!({ "root": root, "path": path })))
}

#[tauri::command]
fn import_master_resume_from_markdown(app: tauri::AppHandle, root: String, markdown: String) -> Result<Value, String> {
    run_bridge(
        &app,
        "importMasterResumeFromMarkdown",
        Some(serde_json::json!({ "root": root, "markdown": markdown })),
    )
}

// async: this calls preview_resume.py, which makes a real Anthropic API
// request (tailoring + humanizing a full resume can legitimately take
// 10-60s) — same reasoning as export_resume_pdf/search_jobs above, a
// plain fn would freeze the whole window for the call's duration.
#[tauri::command]
async fn preview_tailored_resume(
    app: tauri::AppHandle, root: String, title: String, company: String, jd_text: String, resume: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_bridge(
            &app,
            "previewTailoredResume",
            Some(serde_json::json!({
                "root": root, "title": title, "company": company, "jdText": jd_text, "resume": resume
            })),
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("preview task panicked: {e}")))
}

// async: the render loop (headless Chrome launch + up to a couple dozen
// print-and-recount iterations in the worst case) is real blocking work —
// see the search_jobs comment above on why a plain fn would freeze the
// whole window for its duration.
#[tauri::command]
async fn export_resume_pdf(app: tauri::AppHandle, root: String, resume: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_bridge(&app, "exportResumePdf", Some(serde_json::json!({ "root": root, "resume": resume })))
    })
    .await
    .unwrap_or_else(|e| Err(format!("export task panicked: {e}")))
}

// `async fn` here is load-bearing, not stylistic. A plain (non-async)
// #[tauri::command] runs ON TAURI'S MAIN THREAD — see
// https://v2.tauri.app/develop/calling-rust/: "Commands without the async
// keyword are executed on the main thread unless defined with
// #[tauri::command(async)]." Every command in this file used to be a
// plain `fn`, which was fine for the sub-100ms profile/config reads, but
// search_jobs's own blocking work (send_daemon_request's mpsc
// recv_timeout, up to DAEMON_REQUEST_TIMEOUT=8s, or run_bridge's
// synchronous subprocess `.output()` wait in the fallback path) froze
// the entire native window — no repaint, no input, nothing — for the
// full duration of every manual job search, regardless of how fast
// Redis/Postgres caching made the underlying fetch (jobs.ts's own
// deadlines bound the DATA fetch; nothing bounded the IPC dispatch
// itself running synchronously on the main thread). This also silently
// broke JobsScreen.tsx's two-phase search: its comment assumes
// phase1Promise/phase2Promise (two concurrent invoke("search_jobs")
// calls) run concurrently and cap total wait at max(phase1, phase2) —
// but two plain-fn commands can't actually run concurrently on the same
// main thread, so they serialized instead, closer to phase1 + phase2
// back to back. Moving the actual blocking body onto a dedicated
// blocking thread via spawn_blocking (matching Tauri's own guidance for
// commands that do blocking I/O) fixes both: the main thread is free
// immediately, and the two phases genuinely overlap now.
#[tauri::command]
async fn search_jobs(app: tauri::AppHandle, root: String, query: String, sources: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args = serde_json::json!({ "root": root, "query": query, "sources": sources });
        // Daemon first — its whole point is an in-memory cache that only a
        // long-lived process can hold — falling back to the always-correct
        // one-shot path on any failure (spawn error, dead process, timeout,
        // malformed response) so a daemon bug degrades to exactly today's
        // behavior rather than breaking search.
        match send_daemon_request(&app, "searchJobs", args.clone()) {
            Ok(result) => Ok(result),
            Err(_) => run_bridge(&app, "searchJobs", Some(args)),
        }
    })
    .await
    .unwrap_or_else(|e| Err(format!("search task panicked: {e}")))
}

#[tauri::command]
fn check_job_fit(app: tauri::AppHandle, root: String, job: Value) -> Result<Value, String> {
    run_bridge(&app, "checkJobFit", Some(serde_json::json!({ "root": root, "job": job })))
}

#[tauri::command]
fn check_job_fit_batch(app: tauri::AppHandle, root: String, jobs: Value) -> Result<Value, String> {
    run_bridge(&app, "checkJobFitBatch", Some(serde_json::json!({ "root": root, "jobs": jobs })))
}

#[tauri::command]
fn fetch_job_description(app: tauri::AppHandle, root: String, job: Value) -> Result<Value, String> {
    run_bridge(&app, "fetchJobDescription", Some(serde_json::json!({ "root": root, "job": job })))
}

#[tauri::command]
fn get_recommended_jobs(app: tauri::AppHandle, root: String, exclude_job_ids: Vec<String>) -> Result<Value, String> {
    run_bridge(
        &app,
        "getRecommendedJobs",
        Some(serde_json::json!({ "root": root, "excludeJobIds": exclude_job_ids })),
    )
}

#[tauri::command]
fn get_scheduler_status(app: tauri::AppHandle, root: String) -> Result<Value, String> {
    run_bridge(&app, "getSchedulerStatus", Some(serde_json::json!({ "root": root })))
}

#[tauri::command]
fn set_scheduler_installed(app: tauri::AppHandle, root: String, installed: bool) -> Result<Value, String> {
    run_bridge(
        &app,
        "setSchedulerInstalled",
        Some(serde_json::json!({ "root": root, "installed": installed })),
    )
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

// Phase 16C, Part C: reopens a needs_review application pre-filled from its
// saved fill record (src/scripts/runtime/replay_fill.py) instead of a bare URL.
// The bridge call itself returns within a few seconds (it only waits for
// replay_fill.py to report a fast failure, then treats a still-running
// process as launched) — the actual browser review can take as long as the
// human needs, running detached from both the bridge subprocess and this
// one, so run_bridge's synchronous wait here is bounded, not open-ended.
//
// async: bounded is not instant — this still blocks on run_bridge's
// synchronous subprocess `.output()` wait for however long that grace
// window is (several seconds), and a plain (non-async) #[tauri::command]
// runs on Tauri's main thread (see search_jobs's own comment above for the
// full story: no repaint, no input, nothing, for the entire wait). This
// command and trigger_single_job_apply below were missed when that fix
// went in elsewhere — reported live as "Apply with aplyx hangs the app
// when clicked", which is exactly this: every click froze the window for
// the length of the launch-grace window, even though the actual apply run
// itself was already correctly detached and backgrounded on the Node/
// Python side. Moving the blocking wait onto spawn_blocking fixes both
// commands the same way search_jobs/export_resume_pdf already were.
#[tauri::command]
async fn reopen_application_filled(app: tauri::AppHandle, root: String, job_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_bridge(
            &app,
            "reopenApplicationFilled",
            Some(serde_json::json!({ "root": root, "jobId": job_id })),
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("reopen task panicked: {e}")))
}

// "Apply with aplyx" from the Jobs screen's manual-search results — runs
// the exact same job-application agent a scheduled run does (harness,
// job-scraper.md prompt, every AGENTS.md safety rule) for one already-
// known job instead of the agent's own board search. Same bounded-wait
// shape as reopen_application_filled above: the bridge call returns once
// triggerSingleJobApply's own launch-grace window elapses (it only waits
// to catch a fast startup failure), not once the run itself finishes —
// a real fit-gate+tailor+apply run keeps going detached, independent of
// this process, for as long as it takes. async for the same reason as
// reopen_application_filled just above — see that comment.
#[tauri::command]
async fn trigger_single_job_apply(app: tauri::AppHandle, root: String, job: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_bridge(&app, "triggerSingleJobApply", Some(serde_json::json!({ "root": root, "job": job })))
    })
    .await
    .unwrap_or_else(|e| Err(format!("apply task panicked: {e}")))
}

// Confirm-before-submit "Approve" (docs/hosted-auto-apply-plan.md Stage 1):
// the agent paused with a filled-but-not-submitted form; this tells it to
// complete the submission. Same bounded-wait + spawn_blocking shape as
// trigger_single_job_apply above — the bridge call returns once its launch-
// grace window elapses, not once the actual submit finishes. See that
// command's comment for the full async reasoning.
#[tauri::command]
async fn approve_submit(app: tauri::AppHandle, root: String, entry: Value, workday: Option<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_bridge(
            &app,
            "approveSubmit",
            Some(serde_json::json!({ "root": root, "entry": entry, "workday": workday })),
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("approve task panicked: {e}")))
}

// Reads a confirm-before-submit screenshot as a base64 data URL — the
// webview can't read local files directly. Same sync shape as
// read_fill_record: a small file read that returns well within a main-
// thread tick, no spawn_blocking needed.
#[tauri::command]
fn read_screenshot(app: tauri::AppHandle, root: String, path: String) -> Result<Value, String> {
    run_bridge(&app, "readScreenshot", Some(serde_json::json!({ "root": root, "path": path })))
}

#[tauri::command]
fn read_workday_checkpoint(app: tauri::AppHandle, root: String, job_id: String) -> Result<Value, String> {
    run_bridge(
        &app,
        "readWorkdayCheckpoint",
        Some(serde_json::json!({ "root": root, "jobId": job_id })),
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
        // src/tauri/src/lib/AuthContext.tsx). Works out of the box on macOS
        // once the app is bundled+installed. On Windows/Linux, a deep-link
        // click spawns a NEW app instance with the URL as a CLI arg rather
        // than routing into this one — combine with tauri-plugin-single-
        // instance before shipping cross-platform; not added yet since
        // this pass only needed macOS to work.
        .plugin(tauri_plugin_deep_link::init())
        .manage::<SearchDaemonState>(Mutex::new(None))
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
            set_resume_description,
            import_resume_file,
            open_extension_folder,
            search_jobs,
            check_job_fit,
            check_job_fit_batch,
            fetch_job_description,
            get_recommended_jobs,
            get_scheduler_status,
            set_scheduler_installed,
            save_job_for_review,
            mark_queue_entry_applied,
            dismiss_queue_entry,
            reopen_application_filled,
            trigger_single_job_apply,
            approve_submit,
            read_screenshot,
            read_workday_checkpoint,
            list_resume_details,
            open_resumes_folder,
            get_master_resume,
            set_master_resume,
            read_resume_markdown,
            read_fill_record,
            import_master_resume_from_markdown,
            export_resume_pdf,
            preview_tailored_resume,
            read_onboarding_completed,
            write_onboarding_completed
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // The search daemon (see spawn_search_daemon) is a
            // persistent child process — nothing kills it automatically
            // when this process exits, so without this it would keep
            // running as an orphan after the window closes.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                kill_search_daemon(app_handle);
            }
        });
}
