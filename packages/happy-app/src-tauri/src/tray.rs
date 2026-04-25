use serde::Deserialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

#[derive(Debug, Deserialize)]
pub struct TraySession {
    pub id: String,
    pub name: String,
}

/// Restore and focus the main window from minimized/hidden state
fn restore_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    // macOS: activate the application itself
    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }
}

/// Build and register the system tray icon with default menu
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, true, &[])?;

    let mut tray_builder = TrayIconBuilder::new()
        .tooltip("Happy");

    // Use app icon if available
    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder
        .menu(&menu)
        // Left click opens menu (standard macOS pattern). "Show Window" is the first item.
        .on_menu_event(move |app, event| {
            let id = event.id().0.as_str();
            match id {
                "show" => {
                    restore_window(app);
                }
                "new-session" => {
                    let _ = app.emit("tray-action", serde_json::json!({
                        "action": "new-session"
                    }));
                    restore_window(app);
                }
                "quit" => {
                    app.exit(0);
                }
                id if id.starts_with("session:") => {
                    let session_id = id.strip_prefix("session:").unwrap_or("");
                    let _ = app.emit("tray-action", serde_json::json!({
                        "action": "navigate",
                        "sessionId": session_id
                    }));
                    restore_window(app);
                }
                _ => {}
            }
        })
        // No custom tray icon click — menu handles all interactions
        .build(app)?;

    Ok(())
}

/// Rebuild the tray menu with current status and sessions
fn build_menu(
    app: &AppHandle,
    online: bool,
    sessions: &[TraySession],
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let mut builder = MenuBuilder::new(app);

    // Show Window
    builder = builder.item(&MenuItemBuilder::with_id("show", "Show Window").build(app)?);
    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Session list
    if sessions.is_empty() {
        builder = builder.item(
            &MenuItemBuilder::with_id("no-sessions", "No active sessions")
                .enabled(false)
                .build(app)?,
        );
    } else {
        for (i, session) in sessions.iter().take(5).enumerate() {
            let label = if session.name.len() > 30 {
                format!("{}...", &session.name[..27])
            } else {
                session.name.clone()
            };
            let status = if online { "●" } else { "○" };
            builder = builder.item(
                &MenuItemBuilder::with_id(
                    format!("session:{}", session.id),
                    format!("{} {}", status, label),
                )
                .build(app)?,
            );
            if i >= 4 {
                break;
            }
        }
    }

    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // New Session
    builder = builder.item(&MenuItemBuilder::with_id("new-session", "New Session").build(app)?);
    builder = builder.item(&PredefinedMenuItem::separator(app)?);

    // Quit
    builder = builder.item(&MenuItemBuilder::with_id("quit", "Quit Happy").build(app)?);

    builder.build()
}

/// Tauri command: update tray status and session list from JS
#[tauri::command]
pub fn update_tray_status(
    app: AppHandle,
    online: bool,
    sessions: Vec<TraySession>,
) -> Result<(), String> {
    let menu = build_menu(&app, online, &sessions).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
