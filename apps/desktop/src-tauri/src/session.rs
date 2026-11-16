//! Session registry: one running pi process per open session.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use pi_rpc::{PiClient, SpawnOptions};

/// One open session: its pi process plus what the UI needs to show it.
pub struct SessionHandle {
    pub id: String,
    pub client: PiClient,
    pub project_dir: PathBuf,
    /// Display name; pi's own session name once it is known.
    pub label: String,
    /// Session file, once pi has told us where it is.
    pub session_path: Option<PathBuf>,
    /// Last error surfaced for this session, shown in the tab.
    pub last_error: Option<String>,
}

/// What the frontend sees for a session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub label: String,
    pub project_dir: String,
    pub session_path: Option<String>,
    pub pid: u32,
    pub launch_source: String,
    pub closed: bool,
    pub last_error: Option<String>,
}

impl SessionHandle {
    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            label: self.label.clone(),
            project_dir: self.project_dir.to_string_lossy().to_string(),
            session_path: self
                .session_path
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            pid: self.client.pid(),
            launch_source: self.client.launch_source().to_string(),
            closed: self.client.is_closed(),
            last_error: self.last_error.clone(),
        }
    }
}

/// All open sessions, keyed by our own session id.
#[derive(Default)]
pub struct Registry {
    sessions: BTreeMap<String, SessionHandle>,
    next_id: u64,
}

/// Tauri-managed state holding every open session.
#[derive(Default)]
pub struct SessionState {
    inner: Mutex<Registry>,
}

impl SessionState {
    /// Open a new pi process for `project_dir`.
    ///
    /// `session_path` resumes an existing session file; `None` starts a new
    /// one. Returns the id the frontend should use for this session.
    ///
    /// `app` is optional so tests (and future CLI entry points) can drive the
    /// registry without a Tauri window.
    pub fn open(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        project_dir: PathBuf,
        session_path: Option<PathBuf>,
        executable: Option<PathBuf>,
    ) -> Result<String, String> {
        let mut options = SpawnOptions::new(&project_dir);
        options.session = session_path.clone();
        options.executable = executable;
        options.no_session = false;

        let client = PiClient::spawn(options).map_err(|error| error.to_string())?;

        let id = {
            let mut registry = self.inner.lock().unwrap();
            registry.next_id += 1;
            let id = format!("s{}", registry.next_id);
            let label = session_path
                .as_ref()
                .map(|path| {
                    path.file_stem()
                        .map(|stem| stem.to_string_lossy().to_string())
                        .unwrap_or_else(|| "session".to_string())
                })
                .unwrap_or_else(|| {
                    project_dir
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| "project".to_string())
                });
            registry.sessions.insert(
                id.clone(),
                SessionHandle {
                    id: id.clone(),
                    client,
                    project_dir: project_dir.clone(),
                    label,
                    session_path,
                    last_error: None,
                },
            );
            id
        };

        if let Some(app) = app {
            self.spawn_pump(app, &id);
        }

        // Read the initial state in the background: it also tells us which
        // session file pi actually opened.
        let state = self.with(&id, |client| client.get_state()).ok();
        if let Some(state) = state {
            if let Some(path) = state.get("sessionFile").and_then(|value| value.as_str()) {
                self.set_session_path(&id, PathBuf::from(path));
            }
            let name = state
                .get("sessionName")
                .and_then(|value| value.as_str())
                .filter(|name| !name.is_empty());
            if let Some(name) = name {
                self.set_label(&id, name.to_string());
            }
        }

        Ok(id)
    }

    /// Close one session and tear down its pi process tree.
    pub fn close(&self, id: &str) -> Result<(), String> {
        let mut registry = self.inner.lock().unwrap();
        match registry.sessions.remove(id) {
            Some(handle) => handle.client.close().map_err(|error| error.to_string()),
            None => Err(format!("unknown session: {id}")),
        }
    }

    pub fn info(&self) -> Vec<SessionInfo> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .values()
            .map(SessionHandle::info)
            .collect()
    }

    /// Run a closure with the session's pi client.
    pub fn with<T>(
        &self,
        id: &str,
        f: impl FnOnce(&PiClient) -> pi_rpc::Result<T>,
    ) -> Result<T, String> {
        let registry = self.inner.lock().unwrap();
        let handle = registry
            .sessions
            .get(id)
            .ok_or_else(|| format!("unknown session: {id}"))?;
        f(&handle.client).map_err(|error| error.to_string())
    }

    /// Remember an error so the tab can show it.
    pub fn record_error(&self, id: &str, message: String) {
        let mut registry = self.inner.lock().unwrap();
        if let Some(handle) = registry.sessions.get_mut(id) {
            handle.last_error = Some(message);
        }
    }

    pub fn set_label(&self, id: &str, label: String) {
        let mut registry = self.inner.lock().unwrap();
        if let Some(handle) = registry.sessions.get_mut(id) {
            handle.label = label;
        }
    }

    pub fn set_session_path(&self, id: &str, path: PathBuf) {
        let mut registry = self.inner.lock().unwrap();
        if let Some(handle) = registry.sessions.get_mut(id) {
            handle.session_path = Some(path);
        }
    }

    /// Open a new pi process without a Tauri window (tests, future CLI use).
    pub fn open_no_app(
        self: &Arc<Self>,
        project_dir: PathBuf,
        session_path: Option<PathBuf>,
        executable: Option<PathBuf>,
    ) -> Result<String, String> {
        self.open(None, project_dir, session_path, executable)
    }

    /// Close everything. Called when the app exits.
    pub fn shutdown(&self) {
        let handles: Vec<SessionHandle> = {
            let mut registry = self.inner.lock().unwrap();
            std::mem::take(&mut registry.sessions)
                .into_values()
                .collect()
        };
        for handle in handles {
            let _ = handle.client.close();
        }
    }

    /// Start the pump thread that batches one session's events to the UI.
    fn spawn_pump(&self, app: &AppHandle, id: &str) {
        let events = self.with(id, |client| Ok(client.subscribe())).ok();
        let Some(events) = events else {
            return;
        };
        let app = app.clone();
        let id = id.to_string();

        std::thread::spawn(move || {
            // pi emits many small events; the pump batches them into one UI
            // update per window. It lives in pi-rpc so the batching rules stay
            // testable without a Tauri runtime.
            pi_rpc::run_pump(&events, |batch| {
                let payload = pi_rpc::batch_payload(&id, batch);
                let _ = app.emit("pi://event", payload);
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_info_uses_the_frontend_field_names() {
        let info = SessionInfo {
            id: "s1".into(),
            label: "Example".into(),
            project_dir: "C:\\project".into(),
            session_path: Some("C:\\sessions\\example.jsonl".into()),
            pid: 123,
            launch_source: "managed".into(),
            closed: false,
            last_error: None,
        };
        let payload = serde_json::to_value(info).unwrap();
        assert_eq!(payload["projectDir"], "C:\\project");
        assert_eq!(payload["sessionPath"], "C:\\sessions\\example.jsonl");
        assert_eq!(payload["launchSource"], "managed");
        assert!(payload.get("lastError").is_some());
        assert!(payload.get("project_dir").is_none());
    }
}
