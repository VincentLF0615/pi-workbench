//! Tauri entry point: registers state, commands, and shutdown handling.

mod commands;
pub mod files;
pub mod git;
mod model_options;
pub mod session;
pub mod sessions;
pub mod settings;
mod startup;
mod tray;

use std::sync::Arc;

use session::SessionState;
use startup::StartupState;
use tauri::{Emitter, Manager};
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(SessionState::default());
    let startup = Arc::new(StartupState::default());

    // What this launch was asked to open: a positional directory, a
    // `--session <path>`, or nothing (restore from settings).
    let intent = startup::from_args(std::env::args().skip(1));
    if intent.is_some() {
        startup.set(intent);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // One app process. A second launch hands its arguments to the running
        // instance instead of starting a duplicate.
        .plugin(tauri_plugin_single_instance::init({
            let startup = Arc::clone(&startup);
            move |app, args, _cwd| {
                if let Some(intent) = startup::from_args(args.into_iter().skip(1)) {
                    startup.set(Some(intent));
                    // Tell the frontend now, so it reacts without a restart.
                    let _ = app.emit("pi-workbench:open-request", ());
                }
                focus_window(app);
            }
        }))
        .manage(Arc::clone(&state))
        .manage(Arc::clone(&startup))
        .setup(|app| {
            // Keep the regular window usable if the OS cannot create a tray.
            if let Err(error) = tray::setup(app) {
                eprintln!("Could not initialize the system tray: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::discover_pi,
            commands::list_projects,
            commands::list_sessions_for,
            commands::list_sessions,
            commands::open_session,
            commands::close_session,
            commands::get_state,
            commands::get_session_snapshot,
            commands::get_messages,
            commands::get_session_stats,
            commands::get_available_models,
            commands::configure_model,
            commands::get_commands,
            commands::get_tree,
            commands::send_prompt,
            commands::steer,
            commands::follow_up,
            commands::abort,
            commands::set_model,
            commands::set_thinking,
            commands::compact,
            commands::new_session,
            commands::switch_session,
            commands::set_session_name,
            commands::export_html,
            commands::fork_session,
            commands::clone_session,
            commands::get_entries,
            commands::get_fork_messages,
            commands::get_slash_commands,
            commands::delete_session,
            commands::get_settings,
            commands::save_settings,
            commands::settings_location,
            commands::debug_log,
            commands::git_status,
            commands::git_diff,
            commands::list_files,
            commands::read_text_file,
            commands::file_language,
            commands::session_logs,
            commands::answer_ui,
            startup::take_startup_intent,
            tray::minimize_to_tray,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Resized(_))
                && window.is_minimized().unwrap_or(false)
                && tray::available(window.app_handle())
                && settings::load().minimize_to_tray
            {
                let _ = window.hide();
            }
            // Closing the window must tear down every pi process tree.
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<Arc<SessionState>>();
                state.shutdown();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Tray Quit and OS shutdown must release Pi even with no visible window.
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<SessionState>>().shutdown();
            }
        });
}

/// Bring the main window forward.
pub(crate) fn focus_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
