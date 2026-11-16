//! Tauri commands exposed to the frontend.
//!
//! Every command that talks to pi runs on a blocking thread: the pi client is
//! synchronous, and blocking the async runtime would stall other commands and
//! the event pump.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tauri::{Emitter, State};

use crate::session::{SessionInfo, SessionState};
use crate::sessions;

/// Where pi was found, and whether the app can start it at all.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PiInstall {
    pub found: bool,
    pub source: Option<String>,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OpenSessionRequest {
    pub project_dir: String,
    pub session_path: Option<String>,
    pub executable: Option<String>,
}

#[tauri::command]
pub fn discover_pi() -> PiInstall {
    match pi_rpc::discover::discover(None) {
        Ok(spec) => {
            let (program, _) = spec.program();
            PiInstall {
                found: true,
                source: Some(spec.source.clone()),
                executable: Some(program.to_string_lossy().to_string()),
                version: pi_version(),
                error: None,
            }
        }
        Err(error) => PiInstall {
            found: false,
            source: None,
            executable: None,
            version: None,
            error: Some(error.to_string()),
        },
    }
}

/// Read pi's version with a short lived `--version` process.
fn pi_version() -> Option<String> {
    let spec = pi_rpc::discover::discover(None).ok()?;
    let (program, prefix) = spec.program();
    let mut command = std::process::Command::new(program);
    command.args(prefix);
    command.arg("--version");
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|line| !line.trim().is_empty())?;
    Some(line.trim().to_string())
}

#[tauri::command]
pub fn list_projects() -> Vec<sessions::ProjectGroup> {
    sessions::list_sessions(None)
}

#[tauri::command]
pub fn list_sessions_for(project_dir: String) -> Vec<sessions::SessionFile> {
    sessions::sessions_for(&project_dir, None)
}

#[tauri::command]
pub fn list_sessions(state: State<'_, Arc<SessionState>>) -> Vec<SessionInfo> {
    state.info()
}

#[tauri::command]
pub async fn open_session(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    request: OpenSessionRequest,
) -> Result<String, String> {
    let state = Arc::clone(state.inner());
    let project_dir = PathBuf::from(&request.project_dir);
    let session_path = request.session_path.map(PathBuf::from);
    let executable = request.executable.map(PathBuf::from);

    // Spawning blocks briefly (node startup), so keep it off the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        state.open(Some(&app), project_dir, session_path, executable)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn close_session(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.close(&session_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_state(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, |client| {
        client.get_state()
    })
    .await
}

#[tauri::command]
pub async fn get_messages(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, |client| {
        client.get_messages()
    })
    .await
}

#[tauri::command]
pub async fn get_session_stats(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, |client| {
        client.get_session_stats()
    })
    .await
}

#[tauri::command]
pub async fn get_available_models(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, |client| {
        let mut catalog = client.get_available_models()?;
        crate::model_options::annotate_catalog(&mut catalog);
        Ok(catalog)
    })
    .await
}

#[tauri::command]
pub async fn configure_model(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    provider: String,
    model_id: String,
    thinking_level: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, move |client| {
        crate::model_options::configure(client, &provider, &model_id, &thinking_level)
    })
    .await
}

#[tauri::command]
pub async fn get_commands(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, |client| {
        client.get_commands()
    })
    .await
}

#[tauri::command]
pub async fn get_tree(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, |client| {
        client.get_tree()
    })
    .await
}

#[tauri::command]
pub async fn send_prompt(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    let outcome = run(
        Arc::clone(state.inner()),
        session_id.clone(),
        move |client| client.prompt(text),
    )
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

#[tauri::command]
pub async fn steer(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    let outcome = run(
        Arc::clone(state.inner()),
        session_id.clone(),
        move |client| client.steer(text),
    )
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

#[tauri::command]
pub async fn follow_up(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    let outcome = run(
        Arc::clone(state.inner()),
        session_id.clone(),
        move |client| client.follow_up(text),
    )
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

#[tauri::command]
pub async fn abort(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    let outcome = run(Arc::clone(state.inner()), session_id.clone(), |client| {
        client.abort()
    })
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

#[tauri::command]
pub async fn set_model(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    provider: String,
    model_id: String,
) -> Result<Value, String> {
    let outcome = run(
        Arc::clone(state.inner()),
        session_id.clone(),
        move |client| client.set_model(&provider, &model_id),
    )
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

#[tauri::command]
pub async fn set_thinking(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    level: String,
) -> Result<Value, String> {
    let outcome = run(
        Arc::clone(state.inner()),
        session_id.clone(),
        move |client| client.set_thinking_level(&level),
    )
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

#[tauri::command]
pub async fn compact(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    let outcome = run(Arc::clone(state.inner()), session_id.clone(), |client| {
        client.compact()
    })
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

#[tauri::command]
pub async fn new_session(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    let outcome = run(Arc::clone(state.inner()), session_id.clone(), |client| {
        client.new_session()
    })
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

#[tauri::command]
pub async fn switch_session(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    session_path: String,
) -> Result<Value, String> {
    let path = PathBuf::from(session_path);
    let outcome = run(
        Arc::clone(state.inner()),
        session_id.clone(),
        move |client| client.switch_session(&path),
    )
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

#[tauri::command]
pub async fn set_session_name(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    name: String,
) -> Result<Value, String> {
    let label = name.clone();
    let outcome = run(
        Arc::clone(state.inner()),
        session_id.clone(),
        move |client| client.set_session_name(&name),
    )
    .await;
    record(&app, &state, &session_id, &outcome);
    if outcome.is_ok() {
        state.set_label(&session_id, label);
    }
    outcome
}

#[tauri::command]
pub async fn export_html(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    output_path: Option<String>,
) -> Result<Value, String> {
    let path = output_path.map(PathBuf::from);
    run(Arc::clone(state.inner()), session_id, move |client| {
        client.export_html(path.as_deref())
    })
    .await
}

/// Fork the active session from an earlier user message.
///
/// pi creates a new session file; we then open a second tab for it so the user
/// keeps the original branch visible.
#[tauri::command]
pub async fn fork_session(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    entry_id: String,
) -> Result<Value, String> {
    let outcome = run(Arc::clone(state.inner()), session_id.clone(), move |client| {
        client.fork(&entry_id)
    })
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

/// Duplicate the current branch into a new session.
#[tauri::command]
pub async fn clone_session(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    let outcome = run(Arc::clone(state.inner()), session_id.clone(), |client| {
        client.clone_session()
    })
    .await;
    record(&app, &state, &session_id, &outcome);
    outcome
}

/// Entries after a cursor, for incremental history loading.
#[tauri::command]
pub async fn get_entries(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    since: Option<String>,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, move |client| {
        client.get_entries(since.as_deref())
    })
    .await
}

/// User messages that can be forked from.
#[tauri::command]
pub async fn get_fork_messages(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, |client| {
        client.request(serde_json::json!({"type": "get_fork_messages"}))
    })
    .await
}

/// pi's slash commands: extensions, prompt templates and skills.
#[tauri::command]
pub async fn get_slash_commands(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, |client| {
        client.get_commands()
    })
    .await
}

/// Delete a session file, preferring the recycle bin when a trash CLI exists.
#[tauri::command]
pub fn delete_session(session_path: String) -> Result<(), String> {
    let path = PathBuf::from(&session_path);
    if !path.is_file() {
        return Err(format!("no such session file: {session_path}"));
    }
    // `trash` is what pi itself uses in /resume; fall back to a plain delete.
    if let Some(trash) = pi_rpc::discover::which(&["trash.exe", "trash"]) {
        let status = std::process::Command::new(&trash)
            .arg(&path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
    }
    std::fs::remove_file(&path).map_err(|error| error.to_string())
}

/// Read the app's own settings.
#[tauri::command]
pub fn get_settings() -> crate::settings::Settings {
    crate::settings::load()
}

/// Write the app's own settings.
#[tauri::command]
pub fn save_settings(settings: crate::settings::Settings) -> Result<(), String> {
    crate::settings::save(&settings)
}

/// Temporary diagnostic channel: append a line to a log file.
///
/// Used to see frontend startup errors in a release build, where the webview
/// console is not reachable.
#[tauri::command]
pub fn debug_log(message: String) {
    let Some(mut path) = crate::settings::settings_path() else {
        return;
    };
    path.set_file_name("debug.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            use std::io::Write;
            writeln!(file, "[{stamp}] {message}")
        });
}

/// Where the app keeps its settings, for the settings page's hint.
#[tauri::command]
pub fn settings_location() -> Option<String> {
    crate::settings::settings_path().map(|path| path.to_string_lossy().to_string())
}

// ---------- M3: code workbench ----------

/// Git status for a project directory.
#[tauri::command]
pub fn git_status(project_dir: String) -> crate::git::GitStatus {
    crate::git::status(Path::new(&project_dir))
}

/// Diff for one file, or for the whole project when `path` is `None`.
#[tauri::command]
pub fn git_diff(
    project_dir: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, String> {
    crate::git::diff(
        Path::new(&project_dir),
        path.as_deref(),
        staged.unwrap_or(false),
    )
}

/// List a project's files. `depth` 1 means one level; larger walks deeper.
#[tauri::command]
pub fn list_files(
    project_dir: String,
    relative: Option<String>,
    depth: Option<usize>,
) -> Result<Vec<crate::files::FileNode>, String> {
    crate::files::list_dir(
        Path::new(&project_dir),
        relative.as_deref(),
        depth.unwrap_or(2).clamp(1, 6),
    )
}

/// Read a text file for the preview pane.
#[tauri::command]
pub fn read_text_file(
    path: String,
    max_bytes: Option<usize>,
) -> Result<crate::files::TextFile, String> {
    crate::files::read_text(Path::new(&path), max_bytes.unwrap_or(512 * 1024))
}

/// Language hint for a path, so the preview can label the code block.
#[tauri::command]
pub fn file_language(path: String) -> String {
    crate::files::language_of(Path::new(&path)).to_string()
}

/// pi's recent stderr output, for the log panel.
#[tauri::command]
pub async fn session_logs(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
) -> Result<Value, String> {
    run(Arc::clone(state.inner()), session_id, |client| {
        Ok(client.stderr_tail())
    })
    .await
    .map(|logs| serde_json::json!({ "lines": logs }))
}

#[derive(Debug, Deserialize)]
pub struct UiReplyRequest {
    pub request_id: String,
    /// `value` | `confirmed` | `cancelled`
    pub kind: String,
    pub value: Option<String>,
}

#[tauri::command]
pub async fn answer_ui(
    state: State<'_, Arc<SessionState>>,
    session_id: String,
    reply: UiReplyRequest,
) -> Result<(), String> {
    let reply_value = match reply.kind.as_str() {
        "cancelled" => pi_rpc::UiReply::Cancelled,
        "confirmed" => pi_rpc::UiReply::Confirmed(reply.value.as_deref() == Some("true")),
        _ => pi_rpc::UiReply::Value(reply.value.unwrap_or_default()),
    };
    run(Arc::clone(state.inner()), session_id, move |client| {
        client
            .respond_ui(&reply.request_id, &reply_value)
            .map(|_| ())
    })
    .await
    .map(|_| ())
}

/// Run one blocking pi call off the async runtime.
async fn run<T>(
    state: std::sync::Arc<SessionState>,
    session_id: String,
    f: impl FnOnce(&pi_rpc::PiClient) -> pi_rpc::Result<T> + Send + 'static,
) -> Result<Value, String>
where
    T: serde::Serialize,
{
    tauri::async_runtime::spawn_blocking(move || {
        state
            .with(&session_id, f)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Keep the last error on the session so the tab can surface it.
fn record(
    app: &tauri::AppHandle,
    state: &SessionState,
    session_id: &str,
    outcome: &Result<Value, String>,
) {
    if let Err(error) = outcome {
        state.record_error(session_id, error.clone());
        let _ = app.emit(
            "pi://toast",
            serde_json::json!({ "sessionId": session_id, "message": error }),
        );
    }
}
