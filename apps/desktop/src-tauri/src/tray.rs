//! Keep the existing window and Pi processes alive while minimized to tray.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

const TRAY_ID: &str = "pi-workbench-resident";

pub fn setup(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "打开 Pi Workbench", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray-hide", "最小化到托盘", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 Pi Workbench", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Pi Workbench · 点击恢复窗口")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => crate::focus_window(app),
            "tray-hide" => {
                let _ = hide_main(app);
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                crate::focus_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn available(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

pub fn hide_main(app: &AppHandle) -> Result<(), String> {
    if !available(app) {
        return Err("系统托盘暂不可用，请使用普通最小化".into());
    }
    app.get_webview_window("main")
        .ok_or("主窗口不可用")?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn minimize_to_tray(app: AppHandle) -> Result<(), String> {
    hide_main(&app)
}
