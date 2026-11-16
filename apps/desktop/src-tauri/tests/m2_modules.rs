//! Verifies the M2 session-index and settings modules without a Tauri window.
//!
//! These two modules are pure Rust (no Tauri dependency), so they can be
//! tested directly. The registry itself needs a window to emit events, so it
//! is covered by `pi-probe` and the app at runtime.

use std::path::Path;

use pi_workbench_lib::sessions;
use pi_workbench_lib::settings::{self, Settings};

/// The index finds the session file pi wrote and reports its working dir.
#[test]
fn index_finds_the_session_pi_wrote() {
    let groups = sessions::list_sessions(None);
    let files: Vec<&sessions::SessionFile> =
        groups.iter().flat_map(|group| group.sessions.iter()).collect();

    if files.is_empty() {
        // No session has been created on this machine yet; nothing to assert.
        eprintln!("no pi session on disk; skipping content checks");
        return;
    }

    for file in &files {
        assert!(std::path::Path::new(&file.path).is_file(), "{file:?}");
        // The header carries the authoritative cwd, not a decoded guess.
        assert!(file.cwd.is_some(), "{file:?}");
        assert!(file.cwd.as_deref() != Some(""), "{file:?}");
        assert!(file.modified_at > 0, "{file:?}");
    }

    for group in &groups {
        assert!(!group.sessions.is_empty());
        assert!(!group.cwd.is_empty());
    }
}

/// Sessions for one cwd are exactly that group's sessions.
#[test]
fn sessions_for_filters_by_cwd() {
    let groups = sessions::list_sessions(None);
    let Some(first) = groups.first() else {
        return;
    };
    let scoped = sessions::sessions_for(&first.cwd, None);
    assert_eq!(scoped.len(), first.sessions.len());
}

/// Settings round trip through a scratch file, never the user's real one.
#[test]
fn settings_save_and_load_round_trip() {
    let dir = Path::new(&std::env::var("LOCALAPPDATA").unwrap())
        .join("pi-workbench-test")
        .join("m2-settings");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("settings.json");

    let probe = Settings {
        theme: "dark".to_string(),
        font_size: 17,
        sidebar_width: 360,
        open_sessions: vec!["probe-session.jsonl".to_string()],
        ..Settings::default()
    };
    settings::save_to(&path, &probe).expect("save");

    let loaded = settings::load_from(&path);
    assert_eq!(loaded.theme, "dark");
    assert_eq!(loaded.font_size, 17);
    assert_eq!(loaded.sidebar_width, 360);
    assert_eq!(loaded.open_sessions, vec!["probe-session.jsonl".to_string()]);
}

/// A partial file still loads, with defaults filling the gaps.
#[test]
fn settings_tolerate_a_partial_file() {
    let dir = Path::new(&std::env::var("LOCALAPPDATA").unwrap())
        .join("pi-workbench-test")
        .join("m2-settings-partial");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("settings.json");
    std::fs::write(&path, r#"{"theme":"light"}"#).unwrap();

    let loaded = settings::load_from(&path);
    assert_eq!(loaded.theme, "light");
    assert_eq!(loaded.font_size, Settings::default().font_size);
}
