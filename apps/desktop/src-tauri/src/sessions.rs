//! Reading pi's session directory so the GUI can list and reopen sessions.
//!
//! Layout (see pi's `docs/session-format.md`):
//!
//! ```text
//! ~/.pi/agent/sessions/--<sanitized path>--/<timestamp>_<session-id>.jsonl
//! ```
//!
//! The first line of a file is a session header; the first user message is
//! used as a preview. We only ever read these files: pi owns writing them.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Default sessions root: `~/.pi/agent/sessions`.
pub fn default_sessions_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let dir = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".pi").join("agent"))
        .join("sessions");
    dir.is_dir().then_some(dir)
}

/// One session file found on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    /// Absolute path to the `.jsonl` file.
    pub path: String,
    /// Session id from the header, or derived from the file name.
    pub id: String,
    /// Working directory recorded in the header, when present.
    pub cwd: Option<String>,
    /// First user message, truncated, for a list preview.
    pub preview: String,
    /// Number of message entries.
    pub message_count: usize,
    /// File modification time, milliseconds since the epoch.
    pub modified_at: i64,
}

/// Group sessions by the working directory recorded in their header.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectGroup {
    pub cwd: String,
    pub sessions: Vec<SessionFile>,
}

/// List every session file, newest first, grouped by working directory.
pub fn list_sessions(sessions_dir: Option<&Path>) -> Vec<ProjectGroup> {
    let Some(root) = sessions_dir
        .map(Path::to_path_buf)
        .or_else(default_sessions_dir)
    else {
        return Vec::new();
    };
    let mut groups: std::collections::BTreeMap<String, Vec<SessionFile>> = Default::default();

    for group_dir in read_dirs(&root) {
        let files = read_files(&group_dir);
        for path in files {
            let Some(file) = read_session_file(&path) else {
                continue;
            };
            // The header's cwd is authoritative; the directory name is only a
            // fallback label (pi's sanitizing is lossy, so we never guess).
            let key = file
                .cwd
                .clone()
                .unwrap_or_else(|| dir_label(&dir_name(&group_dir)).unwrap_or_default());
            groups.entry(key).or_default().push(file);
        }
    }

    groups
        .into_iter()
        .map(|(cwd, mut sessions)| {
            // Newest session first: `sort_by_key` cannot express a descending
            // order without an extra wrapper, so compare in reverse directly.
            #[allow(clippy::unnecessary_sort_by)]
            sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
            ProjectGroup { cwd, sessions }
        })
        .collect()
}

/// Sessions for one working directory.
pub fn sessions_for(cwd: &str, sessions_dir: Option<&Path>) -> Vec<SessionFile> {
    list_sessions(sessions_dir)
        .into_iter()
        .find(|group| group.cwd == cwd)
        .map(|group| group.sessions)
        .unwrap_or_default()
}

fn read_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect()
}

/// Last component of a path, for building a display label.
fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn read_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().map(|ext| ext == "jsonl").unwrap_or(false))
        .collect();
    files.sort();
    files
}

/// Label for pi's session sub-directory name.
///
/// pi builds the directory as `--<sanitized path>--` and replaces `/`, `\`
/// and `:` with `-`. That mapping is lossy: `E:\a-b` and `E:\a\b` both become
/// `E--a-b`, so it cannot be decoded back into a path. We only use this as a
/// display label for files whose header carries no `cwd`; the authoritative
/// working directory always comes from the session header.
fn dir_label(name: &str) -> Option<String> {
    let trimmed = name.trim_start_matches("--").trim_end_matches("--");
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Read a session file's header and first user message.
pub fn read_session_file(path: &Path) -> Option<SessionFile> {
    type Cached = (SystemTime, u64, SessionFile);
    static CACHE: OnceLock<Mutex<std::collections::HashMap<PathBuf, Cached>>> = OnceLock::new();
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some((stamp, size, result)) = cache.lock().unwrap().get(path)
        && *stamp == modified
        && *size == metadata.len()
    {
        return Some(result.clone());
    }
    let file = fs::File::open(path).ok()?;
    let mut lines = BufReader::new(file).split(b'\n');
    let header = lines.next()?.ok()?;
    let header: serde_json::Value = serde_json::from_slice(&header).ok()?;
    let id = header
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            path.file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
        })?;
    let cwd = header
        .get("cwd")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| dir_label(&name.to_string_lossy()))
        });

    let mut preview = String::new();
    let mut message_count = 0usize;
    for line in lines {
        let Ok(line) = line else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<serde_json::Value>(&line) else {
            continue;
        };
        if record.get("type").and_then(|value| value.as_str()) != Some("message") {
            continue;
        }
        let Some(message) = record.get("message") else {
            continue;
        };
        let role = message.get("role").and_then(|value| value.as_str());
        match role {
            Some("user") => {
                message_count += 1;
                if preview.is_empty() {
                    preview = message_text(message);
                }
            }
            Some("assistant") | Some("toolResult") | Some("bashExecution") => message_count += 1,
            _ => {}
        }
    }

    let modified_at = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();

    let result = SessionFile {
        path: path.to_string_lossy().to_string(),
        id,
        cwd,
        preview: truncate(&preview, 160),
        message_count,
        modified_at,
    };
    let mut cache = cache.lock().unwrap();
    if cache.len() >= 4096 {
        cache.clear();
    }
    cache.insert(
        path.to_path_buf(),
        (modified, metadata.len(), result.clone()),
    );
    Some(result)
}

fn message_text(message: &serde_json::Value) -> String {
    match message.get("content") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(|value| value.as_str()) == Some("text") {
                    block.get("text").and_then(|value| value.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn truncate(text: &str, max: usize) -> String {
    let first_line = text.lines().next().unwrap_or("").trim();
    if first_line.chars().count() <= max {
        first_line.to_string()
    } else {
        let mut out: String = first_line.chars().take(max).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_index_refreshes_after_append_and_ignores_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        fs::write(
            &path,
            "{\"type\":\"session\",\"id\":\"test\",\"cwd\":\"C:/project\"}\n",
        )
        .unwrap();
        assert_eq!(read_session_file(&path).unwrap().message_count, 0);
        assert_eq!(read_session_file(&path).unwrap().message_count, 0);
        use std::io::Write;
        writeln!(
            fs::OpenOptions::new().append(true).open(&path).unwrap(),
            "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}"
        )
        .unwrap();
        let changed = read_session_file(&path).unwrap();
        assert_eq!(changed.message_count, 1);
        assert_eq!(changed.preview, "hello");
        fs::remove_file(&path).unwrap();
        assert!(read_session_file(&path).is_none());
    }

    #[test]
    fn session_catalog_uses_the_frontend_field_names() {
        let file = SessionFile {
            path: "example.jsonl".into(),
            id: "example".into(),
            cwd: Some("C:\\project".into()),
            preview: "hello".into(),
            message_count: 2,
            modified_at: 1234,
        };
        let payload = serde_json::to_value(file).unwrap();
        assert_eq!(payload["messageCount"], 2);
        assert_eq!(payload["modifiedAt"], 1234);
        assert!(payload.get("message_count").is_none());
    }

    #[test]
    fn sanitized_directory_names_stay_unresolved() {
        // The mapping pi uses is lossy, so we must not invent a path.
        assert_eq!(
            dir_label("--E--default-workspace--").as_deref(),
            Some("E--default-workspace")
        );
        assert_eq!(dir_label("--"), None);
    }

    #[test]
    fn extracts_first_user_message() {
        let json = r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello there","timestamp":1733234401000}}"#;
        let message: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(message_text(message.get("message").unwrap()), "Hello there");
    }

    #[test]
    fn truncates_long_previews_on_the_first_line() {
        let long = "x".repeat(500);
        assert_eq!(truncate(&long, 10).chars().count(), 11);
    }
}
