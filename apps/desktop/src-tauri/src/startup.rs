//! What this launch was asked to open.
//!
//! Two entry points feed the same intent:
//!
//! 1. this process's own command line (`pi-workbench <dir>` or
//!    `pi-workbench --session <file.jsonl>`);
//! 2. a second launch while the app is already running, whose arguments the
//!    single-instance plugin forwards here.
//!
//! The frontend takes the intent once at boot (or on `open-request`) and turns
//! it into a session. Keeping the parsing in Rust means the CLI contract is
//! testable without a window.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// What to open, if anything.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartupIntent {
    /// A project directory to open a fresh session in.
    pub project_dir: Option<String>,
    /// A session file to resume.
    pub session_path: Option<String>,
}

impl StartupIntent {
    /// Whether this intent asks for anything at all.
    pub fn is_empty(&self) -> bool {
        self.project_dir.is_none() && self.session_path.is_none()
    }
}

/// Holds the pending intent until the frontend takes it.
#[derive(Default)]
pub struct StartupState {
    intent: Mutex<Option<StartupIntent>>,
}

impl StartupState {
    pub fn set(&self, intent: Option<StartupIntent>) {
        *self.intent.lock().unwrap() = intent.filter(|intent| !intent.is_empty());
    }

    pub fn take(&self) -> Option<StartupIntent> {
        self.intent.lock().unwrap().take()
    }
}

/// Parse a command line into an intent.
///
/// Accepted forms:
///
/// ```text
/// pi-workbench                          no intent; restore from settings
/// pi-workbench E:\project               open that directory
/// pi-workbench --session <file.jsonl>   resume that session
/// ```
///
/// Unknown flags are ignored so a future flag does not break launching.
pub fn from_args<I, S>(args: I) -> Option<StartupIntent>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut session_path: Option<String> = None;
    let mut positional: Option<String> = None;
    let mut expect_session = false;

    for arg in args {
        let arg = arg.as_ref();
        if expect_session {
            session_path = Some(arg.to_string());
            expect_session = false;
            continue;
        }
        match arg {
            "--session" | "-s" => expect_session = true,
            "--help" | "-h" | "--version" | "-V" => return None,
            value if value.starts_with('-') => {
                // Unknown flag: skip it. It may carry a value, which then shows
                // up as a positional, so the directory form still works.
                continue;
            }
            value => positional = Some(value.to_string()),
        }
    }

    // An explicit session wins; a bare positional is a project directory.
    if let Some(path) = session_path {
        return Some(StartupIntent {
            project_dir: None,
            session_path: Some(path),
        });
    }
    positional.map(|dir| StartupIntent {
        project_dir: Some(dir),
        session_path: None,
    })
}

/// Take the pending startup intent, if any. Called once by the frontend.
///
/// The state is registered as `Arc<StartupState>`, so the parameter type must
/// match what `manage()` was given.
#[tauri::command]
pub fn take_startup_intent(
    state: tauri::State<'_, std::sync::Arc<StartupState>>,
) -> Option<StartupIntent> {
    state.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_arguments_means_no_intent() {
        assert_eq!(from_args(Vec::<String>::new()), None);
    }

    #[test]
    fn a_positional_argument_is_a_project_directory() {
        let intent = from_args(["E:\\project"]).expect("an intent");
        assert_eq!(intent.project_dir.as_deref(), Some("E:\\project"));
        assert_eq!(intent.session_path, None);
    }

    #[test]
    fn a_session_flag_resumes_a_session() {
        let intent = from_args(["--session", "C:\\sessions\\a.jsonl"]).expect("an intent");
        assert_eq!(
            intent.session_path.as_deref(),
            Some("C:\\sessions\\a.jsonl")
        );
        assert_eq!(intent.project_dir, None);
    }

    #[test]
    fn the_short_session_flag_also_works() {
        let intent = from_args(["-s", "a.jsonl"]).expect("an intent");
        assert_eq!(intent.session_path.as_deref(), Some("a.jsonl"));
    }

    #[test]
    fn a_session_flag_wins_over_a_positional_directory() {
        let intent = from_args(["E:\\project", "--session", "a.jsonl"]).expect("an intent");
        assert_eq!(intent.session_path.as_deref(), Some("a.jsonl"));
        assert_eq!(intent.project_dir, None);
    }

    #[test]
    fn help_and_version_produce_no_intent() {
        assert_eq!(from_args(["--help"]), None);
        assert_eq!(from_args(["--version"]), None);
    }

    #[test]
    fn unknown_flags_are_ignored() {
        let intent = from_args(["--future-flag", "E:\\project"]).expect("an intent");
        assert_eq!(intent.project_dir.as_deref(), Some("E:\\project"));
    }

    #[test]
    fn the_state_hands_out_an_intent_once() {
        let state = StartupState::default();
        assert_eq!(state.take(), None);

        state.set(Some(StartupIntent {
            project_dir: Some("E:\\p".to_string()),
            session_path: None,
        }));
        let first = state.take().expect("an intent");
        assert_eq!(first.project_dir.as_deref(), Some("E:\\p"));
        // The second take finds nothing: the intent was consumed.
        assert_eq!(state.take(), None);
    }

    #[test]
    fn an_empty_intent_is_not_stored() {
        let state = StartupState::default();
        state.set(Some(StartupIntent::default()));
        assert_eq!(state.take(), None);
    }
}
