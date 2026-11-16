//! Spawn and drive `pi --mode rpc`.
//!
//! ## Threading model
//!
//! * one writer thread owns pi's stdin and serializes command records;
//! * one reader thread owns pi's stdout, splits JSONL records and dispatches
//!   them to the pending-request map, the event bus, and the extension UI bus;
//! * one stderr thread keeps a small tail for diagnostics;
//! * one waiter thread reaps the child and publishes `ClientEvent::Exited`.
//!
//! Every command goes through [`PiClient::request`], which correlates the
//! matching `{"type":"response"}` by `id`.
//!
//! Blocking IO keeps the dependency graph tiny and makes the client easy to
//! drive from a GUI event loop (one pump thread, channels in, channels out).

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::discover::{self, LaunchSpec};
use crate::error::{Error, Result};
use crate::events::PiEvent;
use crate::framer::Framer;
use crate::ui::{UiReply, UiRequest};
use crate::wire::{parse_incoming, Incoming, Response};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Default timeout for commands that should answer promptly. Commands that
/// legitimately take minutes (compaction) use [`PiClient::request_with_timeout`].
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// How long pi gets to shut down after its stdin closes.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Messages a client can receive after spawning pi.
#[derive(Debug, Clone)]
pub enum ClientEvent {
    /// A session event (streaming text, tool activity, compaction, ...).
    Pi(PiEvent),
    /// An extension asks the client for input or for a status update.
    Ui(Box<UiRequest>),
    /// pi exited. The integer is the process exit code when known.
    Exited(Option<i32>),
    /// A record could not be parsed or correlated. Never fatal.
    ProtocolError(String),
}

/// How to start pi.
#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub cwd: PathBuf,
    /// Explicit pi executable/launcher; otherwise discovered.
    pub executable: Option<PathBuf>,
    /// Resume this session file.
    pub session: Option<PathBuf>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    /// Start without persisting a session (`--no-session`).
    pub no_session: bool,
    pub extra_args: Vec<String>,
}

impl SpawnOptions {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            executable: None,
            session: None,
            provider: None,
            model: None,
            thinking: None,
            no_session: false,
            extra_args: Vec::new(),
        }
    }
}

#[derive(Default)]
struct Bus {
    subscribers: Mutex<Vec<Sender<ClientEvent>>>,
}

impl Bus {
    fn subscribe(&self) -> Receiver<ClientEvent> {
        let (sender, receiver) = mpsc::channel();
        self.subscribers.lock().unwrap().push(sender);
        receiver
    }

    fn publish(&self, event: ClientEvent) {
        let mut subscribers = self.subscribers.lock().unwrap();
        subscribers.retain(|sender| sender.send(event.clone()).is_ok());
    }
}

struct Inner {
    pending: Mutex<HashMap<String, Sender<Response>>>,
    bus: Bus,
    sequence: AtomicU64,
    closed: Arc<AtomicBool>,
    stderr_tail: Mutex<VecDeque<String>>,
}

/// A running pi RPC session.
pub struct PiClient {
    inner: Arc<Inner>,
    pid: u32,
    launch_source: String,
    /// Wrapped in a mutex so the client is `Sync` and can be shared behind an
    /// `Arc` (a raw `std::sync::mpsc::Sender` is `Send` but not `Sync`).
    commands: Mutex<Sender<Value>>,
    shutdown: Arc<AtomicBool>,
}

impl PiClient {
    /// Discover pi and start it with `--mode rpc`.
    pub fn spawn(options: SpawnOptions) -> Result<Self> {
        let spec = discover::discover(options.executable.as_deref())?;
        Self::spawn_with_spec(spec, options)
    }

    /// Start pi from an already resolved launch spec.
    pub fn spawn_with_spec(spec: LaunchSpec, options: SpawnOptions) -> Result<Self> {
        let (program, prefix) = spec.program();
        let mut command = Command::new(&program);
        command.args(prefix);
        command.arg("--mode").arg("rpc");
        if options.no_session {
            command.arg("--no-session");
        }
        if let Some(session) = &options.session {
            command.arg("--session").arg(session);
        }
        if let Some(provider) = &options.provider {
            command.arg("--provider").arg(provider);
        }
        if let Some(model) = &options.model {
            command.arg("--model").arg(model);
        }
        if let Some(thinking) = &options.thinking {
            command.arg("--thinking").arg(thinking);
        }
        for extra in &options.extra_args {
            command.arg(extra);
        }
        command.current_dir(&options.cwd);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: never flash a console window for the child.
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| Error::Spawn(format!("{}: {error}", program.display())))?;
        let pid = child.id();

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Spawn("pi stdin was not piped".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Spawn("pi stdout was not piped".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Spawn("pi stderr was not piped".into()))?;

        let closed = Arc::new(AtomicBool::new(false));
        let shutdown = Arc::new(AtomicBool::new(false));
        let inner = Arc::new(Inner {
            pending: Mutex::new(HashMap::new()),
            bus: Bus::default(),
            sequence: AtomicU64::new(0),
            closed: Arc::clone(&closed),
            stderr_tail: Mutex::new(VecDeque::new()),
        });

        let (command_sender, command_receiver) = mpsc::channel::<Value>();
        spawn_writer(stdin, command_receiver, Arc::clone(&shutdown));
        spawn_reader(stdout, Arc::clone(&inner));
        spawn_stderr(stderr, Arc::clone(&inner));
        spawn_waiter(child, Arc::clone(&inner));

        Ok(Self {
            inner,
            pid,
            launch_source: spec.source,
            commands: Mutex::new(command_sender),
            shutdown,
        })
    }

    /// Where pi was found (for logs and the "about" panel).
    pub fn launch_source(&self) -> &str {
        &self.launch_source
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// Subscribe to session events, UI requests and exit notifications.
    pub fn subscribe(&self) -> Receiver<ClientEvent> {
        self.inner.bus.subscribe()
    }

    /// Recent stderr lines from pi (diagnostics only, never protocol data).
    pub fn stderr_tail(&self) -> Vec<String> {
        self.inner
            .stderr_tail
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect()
    }

    /// Send one raw record to pi's stdin.
    pub fn send(&self, value: Value) -> Result<()> {
        if self.is_closed() {
            return Err(Error::Closed);
        }
        self.commands
            .lock()
            .unwrap()
            .send(value)
            .map_err(|_| Error::Closed)
    }

    /// Answer an extension dialog. Fire-and-forget UI methods must not be
    /// answered.
    pub fn respond_ui(&self, id: &str, reply: &UiReply) -> Result<()> {
        self.send(reply.to_record(id))
    }

    /// Send a command and wait for its `response`.
    pub fn request(&self, command: Value) -> Result<Value> {
        self.request_with_timeout(command, DEFAULT_REQUEST_TIMEOUT)
    }

    /// Same as [`Self::request`], with a custom timeout.
    pub fn request_with_timeout(&self, mut command: Value, wait: Duration) -> Result<Value> {
        if self.is_closed() {
            return Err(Error::Closed);
        }
        let id = match command.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                let next = self.inner.sequence.fetch_add(1, Ordering::Relaxed) + 1;
                let id = format!("req-{next}");
                command["id"] = json!(id);
                id
            }
        };

        let (sender, receiver) = mpsc::channel();
        self.inner
            .pending
            .lock()
            .unwrap()
            .insert(id.clone(), sender);

        if self.commands.lock().unwrap().send(command).is_err() {
            self.inner.pending.lock().unwrap().remove(&id);
            return Err(Error::Closed);
        }

        match receiver.recv_timeout(wait) {
            Ok(response) => {
                if response.success {
                    Ok(response.data.unwrap_or(Value::Null))
                } else {
                    Err(Error::Rpc {
                        command: response.command,
                        message: response
                            .error
                            .unwrap_or_else(|| "unknown error".to_string()),
                    })
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                self.inner.pending.lock().unwrap().remove(&id);
                Err(Error::Timeout(wait))
            }
            Err(RecvTimeoutError::Disconnected) => {
                self.inner.pending.lock().unwrap().remove(&id);
                Err(Error::Closed)
            }
        }
    }

    pub fn prompt(&self, message: impl Into<String>) -> Result<Value> {
        self.request(json!({"type": "prompt", "message": message.into()}))
    }

    /// Queue a steering message while the agent is running.
    pub fn steer(&self, message: impl Into<String>) -> Result<Value> {
        self.request(json!({"type": "steer", "message": message.into()}))
    }

    pub fn follow_up(&self, message: impl Into<String>) -> Result<Value> {
        self.request(json!({"type": "follow_up", "message": message.into()}))
    }

    pub fn abort(&self) -> Result<Value> {
        self.request(json!({"type": "abort"}))
    }

    pub fn clear_queue(&self) -> Result<Value> {
        self.request(json!({"type": "clear_queue"}))
    }

    pub fn get_state(&self) -> Result<Value> {
        self.request(json!({"type": "get_state"}))
    }

    pub fn get_messages(&self) -> Result<Value> {
        self.request(json!({"type": "get_messages"}))
    }

    pub fn get_session_stats(&self) -> Result<Value> {
        self.request(json!({"type": "get_session_stats"}))
    }

    pub fn get_available_models(&self) -> Result<Value> {
        self.request(json!({"type": "get_available_models"}))
    }

    pub fn get_commands(&self) -> Result<Value> {
        self.request(json!({"type": "get_commands"}))
    }

    pub fn set_model(&self, provider: &str, model_id: &str) -> Result<Value> {
        self.request(json!({
            "type": "set_model",
            "provider": provider,
            "modelId": model_id
        }))
    }

    pub fn set_thinking_level(&self, level: &str) -> Result<Value> {
        self.request(json!({"type": "set_thinking_level", "level": level}))
    }

    pub fn compact(&self) -> Result<Value> {
        self.request_with_timeout(json!({"type": "compact"}), Duration::from_secs(10 * 60))
    }

    pub fn new_session(&self) -> Result<Value> {
        self.request(json!({"type": "new_session"}))
    }

    pub fn switch_session(&self, session_path: &std::path::Path) -> Result<Value> {
        self.request(json!({
            "type": "switch_session",
            "sessionPath": session_path
        }))
    }

    pub fn fork(&self, entry_id: &str) -> Result<Value> {
        self.request(json!({"type": "fork", "entryId": entry_id}))
    }

    pub fn clone_session(&self) -> Result<Value> {
        self.request(json!({"type": "clone"}))
    }

    pub fn get_tree(&self) -> Result<Value> {
        self.request(json!({"type": "get_tree"}))
    }

    pub fn get_entries(&self, since: Option<&str>) -> Result<Value> {
        match since {
            Some(since) => self.request(json!({"type": "get_entries", "since": since})),
            None => self.request(json!({"type": "get_entries"})),
        }
    }

    pub fn set_session_name(&self, name: &str) -> Result<Value> {
        self.request(json!({"type": "set_session_name", "name": name}))
    }

    pub fn export_html(&self, output_path: Option<&std::path::Path>) -> Result<Value> {
        match output_path {
            Some(path) => self.request(json!({"type": "export_html", "outputPath": path})),
            None => self.request(json!({"type": "export_html"})),
        }
    }

    /// Graceful shutdown: close stdin, wait briefly, then kill the process
    /// tree if pi is still alive.
    pub fn close(&self) -> Result<()> {
        self.shutdown.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            if self.is_closed() {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(25));
        }
        kill_tree(self.pid);
        Ok(())
    }
}

impl Drop for PiClient {
    fn drop(&mut self) {
        if !self.is_closed() {
            self.shutdown.store(true, Ordering::SeqCst);
            kill_tree(self.pid);
        }
    }
}

fn spawn_writer(
    mut stdin: std::process::ChildStdin,
    commands: Receiver<Value>,
    shutdown: Arc<AtomicBool>,
) {
    thread::spawn(move || loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        match commands.recv_timeout(Duration::from_millis(100)) {
            Ok(value) => {
                let mut line = match serde_json::to_vec(&value) {
                    Ok(line) => line,
                    Err(_) => continue,
                };
                line.push(b'\n');
                if stdin.write_all(&line).is_err() || stdin.flush().is_err() {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    });
    // Dropping stdin here sends EOF, which is pi's orderly shutdown request.
}

fn spawn_reader(stdout: std::process::ChildStdout, inner: Arc<Inner>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut framer = Framer::default();
        let mut chunk = Vec::new();
        loop {
            chunk.clear();
            match reader.read_until(b'\n', &mut chunk) {
                Ok(0) => break,
                Ok(_) => {
                    for line in framer.push(&chunk) {
                        dispatch(&inner, line);
                    }
                }
                Err(_) => break,
            }
        }
        inner.closed.store(true, Ordering::SeqCst);
    });
}

fn dispatch(inner: &Arc<Inner>, line: Vec<u8>) {
    let value: Value = match serde_json::from_slice(&line) {
        Ok(value) => value,
        Err(error) => {
            inner
                .bus
                .publish(ClientEvent::ProtocolError(format!("invalid JSON: {error}")));
            return;
        }
    };

    match parse_incoming(value) {
        Incoming::Response(response) => {
            if let Some(id) = &response.id {
                let waiter = inner.pending.lock().unwrap().remove(id);
                match waiter {
                    Some(waiter) => {
                        let _ = waiter.send(response);
                    }
                    None => {
                        inner.bus.publish(ClientEvent::ProtocolError(format!(
                            "response for unknown request id {id} ({})",
                            response.command
                        )));
                    }
                }
            } else {
                let message = response
                    .error
                    .unwrap_or_else(|| "request rejected".to_string());
                inner.bus.publish(ClientEvent::ProtocolError(format!(
                    "{} failed: {message}",
                    response.command
                )));
            }
        }
        Incoming::Event(event) => inner.bus.publish(ClientEvent::Pi(event)),
        Incoming::Ui(request) => inner.bus.publish(ClientEvent::Ui(request)),
        Incoming::Unknown(_) => {}
    }
}

fn spawn_stderr(stderr: std::process::ChildStderr, inner: Arc<Inner>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let mut tail = inner.stderr_tail.lock().unwrap();
                    tail.push_back(line.trim_end().to_string());
                    if tail.len() > 200 {
                        tail.pop_front();
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_waiter(mut child: Child, inner: Arc<Inner>) {
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        inner.closed.store(true, Ordering::SeqCst);
        inner.bus.publish(ClientEvent::Exited(code));
    });
}

/// Kill the process tree started by pi (bash, git, language servers, ...).
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.creation_flags(CREATE_NO_WINDOW);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
