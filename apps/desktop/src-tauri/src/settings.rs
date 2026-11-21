//! App-level settings, stored next to the app's own data.
//!
//! These are *our* settings, not pi's. pi's `~/.pi/agent/settings.json` is only
//! ever read, never written from here. The file lives in
//! `%APPDATA%\pi-workbench\settings.json` and is rewritten atomically.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Where our settings live.
pub fn settings_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PI_WORKBENCH_DATA_DIR") {
        return Some(PathBuf::from(dir).join("settings.json"));
    }
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from)?;
    Some(app_data.join("pi-workbench").join("settings.json"))
}

/// User settings. Every field has a default so a missing file still works.
///
/// Field names are camelCase on the wire, matching pi's own settings files, so
/// the same file is readable by a person who knows pi's conventions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// `system`, `light`, `parchment` or `dark`.
    pub theme: String,
    /// Font size in px for transcript text.
    pub font_size: u32,
    /// Font family for transcript text; empty means the built-in stack.
    pub font_family: String,
    /// Sidebar width in px.
    pub sidebar_width: u32,
    /// Right workbench dock width in px.
    pub dock_width: u32,
    /// Last opened project directory.
    pub last_project: Option<String>,
    /// Sessions to reopen on launch.
    pub open_sessions: Vec<String>,
    /// Show tool call details by default.
    pub expand_tools: bool,
    /// Log level for the app's own tracing output.
    pub log_level: String,
    /// Hide the window in the system tray when the minimize button is used.
    pub minimize_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "light".to_string(),
            font_size: 14,
            font_family: String::new(),
            sidebar_width: 300,
            dock_width: 320,
            last_project: None,
            open_sessions: Vec::new(),
            expand_tools: false,
            log_level: "info".to_string(),
            minimize_to_tray: true,
        }
    }
}

/// Read settings, falling back to defaults when the file is missing or broken.
pub fn load() -> Settings {
    let Some(path) = settings_path() else {
        return Settings::default();
    };
    load_from(&path)
}

/// Read settings from a specific path.
pub fn load_from(path: &Path) -> Settings {
    let Ok(text) = fs::read_to_string(path) else {
        return Settings::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// Write settings atomically: temp file plus rename.
pub fn save(settings: &Settings) -> Result<(), String> {
    let path = settings_path().ok_or("no APPDATA directory")?;
    save_to(&path, settings)
}

/// Write settings to a specific path, atomically.
pub fn save_to(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json).map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch settings file, so tests never touch the user's real one.
    fn scratch_path(name: &str) -> std::path::PathBuf {
        let dir = Path::new(&std::env::var("LOCALAPPDATA").unwrap())
            .join("pi-workbench-test")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn defaults_round_trip_through_json() {
        let settings = Settings::default();
        let json = serde_json::to_string(&settings).unwrap();
        let parsed: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.theme, "light");
        assert_eq!(parsed.font_size, 14);
        assert_eq!(parsed.sidebar_width, 300);
        assert!(parsed.open_sessions.is_empty());
    }

    #[test]
    fn save_and_load_round_trip_through_a_file() {
        let path = scratch_path("settings-round-trip");
        let probe = Settings {
            theme: "dark".to_string(),
            font_size: 17,
            sidebar_width: 360,
            open_sessions: vec!["probe-session.jsonl".to_string()],
            ..Settings::default()
        };

        save_to(&path, &probe).expect("save");
        let loaded = load_from(&path);
        assert_eq!(loaded.theme, "dark");
        assert_eq!(loaded.font_size, 17);
        assert_eq!(loaded.sidebar_width, 360);
        assert_eq!(
            loaded.open_sessions,
            vec!["probe-session.jsonl".to_string()]
        );
    }

    #[test]
    fn a_partial_file_still_loads_with_defaults() {
        let path = scratch_path("settings-partial");
        fs::write(&path, r#"{"theme":"light"}"#).unwrap();

        let loaded = load_from(&path);
        assert_eq!(loaded.theme, "light");
        assert_eq!(loaded.font_size, Settings::default().font_size);
    }

    #[test]
    fn a_missing_file_loads_defaults() {
        let path = scratch_path("settings-missing").join("nope.json");
        let loaded = load_from(&path);
        assert_eq!(loaded.theme, "light");
    }

    #[test]
    fn a_broken_file_loads_defaults() {
        let path = scratch_path("settings-broken");
        fs::write(&path, "{not json").unwrap();
        let loaded = load_from(&path);
        assert_eq!(loaded.theme, "light");
    }

    #[test]
    fn camel_case_field_names_are_accepted() {
        let parsed: Settings =
            serde_json::from_str(r#"{"sidebarWidth":420,"openSessions":["a.jsonl"]}"#).unwrap();
        assert_eq!(parsed.sidebar_width, 420);
        assert_eq!(parsed.dock_width, 320);
        assert_eq!(parsed.open_sessions, vec!["a.jsonl".to_string()]);
    }

    #[test]
    fn parchment_theme_and_dock_width_round_trip() {
        let path = scratch_path("settings-parchment");
        let probe = Settings {
            theme: "parchment".to_string(),
            dock_width: 440,
            ..Settings::default()
        };
        save_to(&path, &probe).expect("save");
        let loaded = load_from(&path);
        assert_eq!(loaded.theme, "parchment");
        assert_eq!(loaded.dock_width, 440);
    }
}
