//! Session registry. Registry locks never cover process I/O.
use pi_rpc::{PiClient, SpawnOptions};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter};

pub struct SessionHandle {
    pub id: String,
    pub client: Arc<PiClient>,
    pub project_dir: PathBuf,
    pub label: String,
    pub session_path: Option<PathBuf>,
    pub last_error: Option<String>,
    pub generation: u64,
    operation: Arc<Mutex<()>>,
    executable: Option<PathBuf>,
}

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
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub info: SessionInfo,
    pub state: Value,
    pub messages: Vec<Value>,
    pub stats: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchResult {
    pub cancelled: bool,
    pub original: SessionSnapshot,
    pub branch: Option<SessionSnapshot>,
    pub selected_text: Option<String>,
}

impl SessionHandle {
    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            label: self.label.clone(),
            project_dir: self.project_dir.to_string_lossy().into_owned(),
            session_path: self
                .session_path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            pid: self.client.pid(),
            launch_source: self.client.launch_source().into(),
            closed: self.client.is_closed(),
            last_error: self.last_error.clone(),
            generation: self.generation,
        }
    }
}

#[derive(Default)]
pub struct Registry {
    sessions: BTreeMap<String, SessionHandle>,
    paths: HashMap<String, String>,
    opening: HashSet<String>,
    next_id: u64,
}

#[derive(Default)]
pub struct SessionState {
    inner: Mutex<Registry>,
    opened: Condvar,
    // Serialize ownership changes only. Existing sessions' RPC/control calls
    // never acquire this gate and remain independent.
    ownership: Mutex<()>,
}

pub fn path_key(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path)
        .or_else(|_| {
            let parent = path.parent().unwrap_or(Path::new("."));
            std::fs::canonicalize(parent).map(|p| p.join(path.file_name().unwrap_or_default()))
        })
        .unwrap_or_else(|_| path.to_path_buf());
    let text = resolved.to_string_lossy().replace('/', "\\");
    #[cfg(windows)]
    {
        text.trim_start_matches("\\\\?\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text
    }
}

impl SessionState {
    pub fn open(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        project_dir: PathBuf,
        session_path: Option<PathBuf>,
        executable: Option<PathBuf>,
    ) -> Result<String, String> {
        let _ownership = self.ownership.lock().unwrap();
        self.open_owned(app, project_dir, session_path, executable)
    }

    fn open_owned(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        project_dir: PathBuf,
        session_path: Option<PathBuf>,
        executable: Option<PathBuf>,
    ) -> Result<String, String> {
        let key = session_path.as_deref().map(path_key);
        if let Some(key) = &key {
            let mut registry = self.inner.lock().unwrap();
            loop {
                if let Some(id) = registry.paths.get(key).cloned() {
                    if registry
                        .sessions
                        .get(&id)
                        .is_some_and(|h| !h.client.has_exited())
                    {
                        return Ok(id);
                    }
                    registry.paths.remove(key);
                }
                if registry.opening.insert(key.clone()) {
                    break;
                }
                registry = self.opened.wait(registry).unwrap();
            }
        }
        let result = self.open_inner(app, project_dir, session_path, executable);
        if let Some(key) = key {
            self.inner.lock().unwrap().opening.remove(&key);
            self.opened.notify_all();
        }
        result
    }

    fn open_inner(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        project_dir: PathBuf,
        session_path: Option<PathBuf>,
        executable: Option<PathBuf>,
    ) -> Result<String, String> {
        let mut options = SpawnOptions::new(&project_dir);
        options.session = session_path.clone();
        options.executable = executable.clone();
        let client = Arc::new(PiClient::spawn(options).map_err(|e| e.to_string())?);
        let events = client.subscribe();
        let info = {
            let mut registry = self.inner.lock().unwrap();
            registry.next_id += 1;
            let id = format!("s{}", registry.next_id);
            let handle = SessionHandle {
                id: id.clone(),
                client,
                project_dir,
                label: "正在打开…".into(),
                session_path,
                last_error: None,
                generation: 1,
                operation: Arc::new(Mutex::new(())),
                executable,
            };
            let info = handle.info();
            registry.sessions.insert(id, handle);
            info
        };
        if let Some(app) = app {
            let _ = app.emit("pi://session-opened", &info);
            Self::spawn_pump(app, &info.id, info.generation, events);
        }
        match self.snapshot(&info.id) {
            Ok(_) => Ok(info.id),
            Err(error) => {
                let _ = self.close(&info.id);
                Err(format!("会话启动失败：{error}"))
            }
        }
    }

    fn client(&self, id: &str) -> Result<Arc<PiClient>, String> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .map(|h| Arc::clone(&h.client))
            .ok_or_else(|| format!("unknown session: {id}"))
    }

    pub fn with<T>(
        &self,
        id: &str,
        f: impl FnOnce(&PiClient) -> pi_rpc::Result<T>,
    ) -> Result<T, String> {
        let client = self.client(id)?;
        f(&client).map_err(|e| e.to_string())
    }

    fn operation(&self, id: &str) -> Result<Arc<Mutex<()>>, String> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .map(|h| Arc::clone(&h.operation))
            .ok_or_else(|| format!("unknown session: {id}"))
    }

    pub fn with_mutation<T>(
        &self,
        id: &str,
        f: impl FnOnce(&PiClient) -> pi_rpc::Result<T>,
    ) -> Result<T, String> {
        let operation = self.operation(id)?;
        let _guard = operation
            .try_lock()
            .map_err(|_| "该会话正在处理其他操作，请稍后重试".to_string())?;
        self.with(id, f)
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

    pub fn has_writer(&self, path: &Path) -> bool {
        let key = path_key(path);
        self.inner.lock().unwrap().sessions.values().any(|handle| {
            !handle.client.has_exited()
                && handle
                    .session_path
                    .as_deref()
                    .is_some_and(|p| path_key(p) == key)
        })
    }

    fn sync_info(
        &self,
        id: &str,
        client: &Arc<PiClient>,
        state: &Value,
    ) -> Result<SessionInfo, String> {
        let mut registry = self.inner.lock().unwrap();
        let path = state
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        if let Some(path) = &path {
            let key = path_key(path);
            if let Some(owner) = registry.paths.get(&key)
                && owner != id
            {
                return Err(format!("会话已在标签 {owner} 中打开"));
            }
        }
        let handle = registry.sessions.get_mut(id).ok_or("会话已关闭")?;
        if !Arc::ptr_eq(&handle.client, client) {
            return Err("会话进程已更换".into());
        }
        handle.session_path = path.clone();
        handle.label = state
            .get("sessionName")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                handle
                    .project_dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let info = handle.info();
        registry.paths.retain(|_, owner| owner != id);
        if let Some(path) = path {
            registry.paths.insert(path_key(&path), id.into());
        }
        Ok(info)
    }

    pub fn snapshot(&self, id: &str) -> Result<SessionSnapshot, String> {
        let client = self.client(id)?;
        let state = client.get_state().map_err(|e| e.to_string())?;
        let messages = client.get_messages().map_err(|e| e.to_string())?["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let stats = client.get_session_stats().map_err(|e| e.to_string())?;
        let info = self.sync_info(id, &client, &state)?;
        Ok(SessionSnapshot {
            info,
            state,
            messages,
            stats,
        })
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let client = match self.client(id) {
            Ok(client) => client,
            Err(_) => return Ok(()),
        };
        if let Err(error) = client.close() {
            self.record_error(id, format!("关闭失败，请重试：{error}"));
            return Err(error.to_string());
        }
        {
            let mut registry = self.inner.lock().unwrap();
            if registry
                .sessions
                .get(id)
                .is_some_and(|handle| Arc::ptr_eq(&handle.client, &client))
            {
                registry.paths.retain(|_, owner| owner != id);
                registry.sessions.remove(id);
            }
        }
        Ok(())
    }

    pub fn record_error(&self, id: &str, message: String) {
        if let Some(handle) = self.inner.lock().unwrap().sessions.get_mut(id) {
            handle.last_error = Some(message);
        }
    }
    pub fn set_label(&self, id: &str, label: String) {
        if let Some(handle) = self.inner.lock().unwrap().sessions.get_mut(id) {
            handle.label = label;
        }
    }

    pub fn open_no_app(
        self: &Arc<Self>,
        project_dir: PathBuf,
        session_path: Option<PathBuf>,
        executable: Option<PathBuf>,
    ) -> Result<String, String> {
        self.open(None, project_dir, session_path, executable)
    }

    pub fn shutdown(&self) {
        let handles = {
            let mut registry = self.inner.lock().unwrap();
            registry.paths.clear();
            std::mem::take(&mut registry.sessions)
                .into_values()
                .collect::<Vec<_>>()
        };
        std::thread::scope(|scope| {
            for handle in handles {
                scope.spawn(move || {
                    let _ = handle.client.close();
                });
            }
        });
    }

    pub fn replace(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        id: &str,
        path: &Path,
        new: bool,
    ) -> Result<SessionSnapshot, String> {
        let _ownership = self.ownership.lock().unwrap();
        if !new {
            let registry = self.inner.lock().unwrap();
            if let Some(owner) = registry.paths.get(&path_key(path)).cloned()
                && owner != id
            {
                drop(registry);
                return self.snapshot(&owner);
            }
        }
        let operation = self.operation(id)?;
        let _guard = operation
            .try_lock()
            .map_err(|_| "会话正在处理其他操作".to_string())?;
        self.with(id, |client| {
            ensure_idle(client)?;
            let response = if new {
                client.new_session()?
            } else {
                client.switch_session(path)?
            };
            if response["cancelled"].as_bool() == Some(true) {
                return Err(pi_rpc::Error::Protocol("会话切换已取消".into()));
            }
            Ok(())
        })?;
        let snapshot = self.snapshot(id)?;
        if let Some(app) = app {
            let _ = app.emit("pi://session-snapshot", &snapshot);
        }
        Ok(snapshot)
    }

    pub fn branch(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        id: &str,
        entry: Option<&str>,
    ) -> Result<BranchResult, String> {
        let _ownership = self.ownership.lock().unwrap();
        let operation = self.operation(id)?;
        let _guard = operation
            .try_lock()
            .map_err(|_| "会话正在处理其他操作".to_string())?;
        let client = self.client(id)?;
        ensure_idle(&client).map_err(|e| e.to_string())?;
        let before = client.get_state().map_err(|e| e.to_string())?;
        let source = before["sessionFile"].as_str().ok_or("会话尚未保存")?;
        let original_path = PathBuf::from(source);
        let response = match entry {
            Some(entry) => client.fork(entry),
            None => client.clone_session(),
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                // A timeout can arrive after Pi has already changed sessions.
                // Replacing the process also cancels any unfinished replacement.
                self.restart(app, id, &original_path)?;
                let original = self.snapshot(id)?;
                if let Some(app) = app {
                    let _ = app.emit("pi://session-snapshot", &original);
                }
                return Err(format!("分叉未完成，原会话已恢复：{error}"));
            }
        };
        if response["cancelled"].as_bool() == Some(true) {
            return Ok(BranchResult {
                cancelled: true,
                original: self.snapshot(id)?,
                branch: None,
                selected_text: None,
            });
        }
        let after = client.get_state().map_err(|e| e.to_string());
        let branch_path = after
            .as_ref()
            .ok()
            .and_then(|s| s["sessionFile"].as_str())
            .map(PathBuf::from);
        // Pi deliberately does not write a branch containing only metadata.
        // Persist that exact RPC entry snapshot before switching away from it.
        let saved = branch_path
            .as_deref()
            .map(|path| {
                if path.exists() {
                    Ok(())
                } else {
                    persist_empty_branch(&client, &original_path, path, after.as_ref().unwrap())
                }
            })
            .transpose();
        let restored = client.switch_session(&original_path).and_then(|result| {
            if result["cancelled"].as_bool() == Some(true) {
                return Err(pi_rpc::Error::Protocol("恢复原会话被取消".into()));
            }
            let state = client.get_state()?;
            if state["sessionFile"]
                .as_str()
                .map(|p| path_key(Path::new(p)))
                != Some(path_key(&original_path))
            {
                return Err(pi_rpc::Error::Protocol("恢复后的会话路径不一致".into()));
            }
            Ok(())
        });
        if restored.is_err() {
            self.restart(app, id, &original_path)?;
        }
        let original = self.snapshot(id)?;
        if let Some(app) = app {
            let _ = app.emit("pi://session-snapshot", &original);
        }
        saved?;
        let branch_path = branch_path.ok_or_else(|| {
            format!(
                "已恢复原会话，但无法获取新分支路径：{}",
                after.err().unwrap_or_default()
            )
        })?;
        if path_key(&branch_path) == path_key(&original_path) {
            return Err("pi 未创建新会话".into());
        }
        let project_dir = PathBuf::from(&original.info.project_dir);
        let executable = self
            .inner
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .and_then(|h| h.executable.clone());
        let branch_id = self
            .open_owned(app, project_dir, Some(branch_path.clone()), executable)
            .map_err(|error| {
                format!(
                    "原会话已保留，新分支位于 {}，打开失败：{error}",
                    branch_path.display()
                )
            })?;
        let branch = self.snapshot(&branch_id)?;
        Ok(BranchResult {
            cancelled: false,
            original,
            branch: Some(branch),
            selected_text: response["text"].as_str().map(str::to_owned),
        })
    }

    fn restart(
        self: &Arc<Self>,
        app: Option<&AppHandle>,
        id: &str,
        path: &Path,
    ) -> Result<(), String> {
        let (old, project, executable) = {
            let registry = self.inner.lock().unwrap();
            let handle = registry.sessions.get(id).ok_or("会话已关闭")?;
            (
                Arc::clone(&handle.client),
                handle.project_dir.clone(),
                handle.executable.clone(),
            )
        };
        old.close().map_err(|e| e.to_string())?;
        let mut options = SpawnOptions::new(project);
        options.session = Some(path.into());
        options.executable = executable;
        let client = Arc::new(PiClient::spawn(options).map_err(|e| {
            self.record_error(
                id,
                format!("恢复失败；原会话保留在 {}：{e}", path.display()),
            );
            e.to_string()
        })?);
        let events = client.subscribe();
        let info = {
            let mut registry = self.inner.lock().unwrap();
            let handle = registry.sessions.get_mut(id).ok_or("会话已关闭")?;
            handle.client = client;
            handle.generation += 1;
            handle.session_path = Some(path.into());
            handle.info()
        };
        if let Some(app) = app {
            let _ = app.emit("pi://session-opened", &info);
            Self::spawn_pump(app, id, info.generation, events);
        }
        Ok(())
    }

    fn spawn_pump(
        app: &AppHandle,
        id: &str,
        generation: u64,
        events: std::sync::mpsc::Receiver<pi_rpc::ClientEvent>,
    ) {
        let app = app.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            pi_rpc::run_pump(&events, |batch| {
                let _ = app.emit(
                    "pi://event",
                    serde_json::json!({"sessionId":id,"generation":generation,"events":batch}),
                );
            });
        });
    }
}

fn persist_empty_branch(
    client: &PiClient,
    source: &Path,
    destination: &Path,
    state: &Value,
) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let mut header_line = String::new();
    std::io::BufReader::new(std::fs::File::open(source).map_err(|e| e.to_string())?)
        .read_line(&mut header_line)
        .map_err(|e| e.to_string())?;
    let mut header: Value = serde_json::from_str(&header_line).map_err(|e| e.to_string())?;
    if header["type"].as_str() != Some("session") || header["version"].as_u64() != Some(3) {
        return Err("无法保存空分支：需要 pi v3 会话格式；原会话将保留".into());
    }
    let id = state["sessionId"].as_str().ok_or("新分支缺少 sessionId")?;
    let entries = client.get_entries(None).map_err(|e| e.to_string())?;
    let records = entries["entries"].as_array().ok_or("新分支缺少 entries")?;
    header["id"] = serde_json::json!(id);
    header["parentSession"] = serde_json::json!(source);
    header["timestamp"] = serde_json::json!(
        time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|e| e.to_string())?
    );
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|e| e.to_string())?;
    let result = (|| -> std::io::Result<()> {
        writeln!(file, "{}", header)?;
        for record in records {
            writeln!(file, "{}", record)?;
        }
        file.sync_all()
    })();
    drop(file);
    if let Err(error) = result {
        let _ = std::fs::remove_file(destination);
        return Err(error.to_string());
    }
    Ok(())
}

fn ensure_idle(client: &PiClient) -> pi_rpc::Result<()> {
    let state = client.get_state()?;
    if state["isStreaming"].as_bool() == Some(true) || state["isCompacting"].as_bool() == Some(true)
    {
        return Err(pi_rpc::Error::Protocol(
            "请先结束当前任务，再操作会话".into(),
        ));
    }
    Ok(())
}
