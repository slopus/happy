use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Send a native OS notification. Called from JS via invoke('send_notification').
/// The `route` field is stored so click-to-navigate can route the user.
#[tauri::command]
pub fn send_notification(
    app: AppHandle,
    title: String,
    body: String,
    _route: Option<String>,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())?;

    Ok(())
}
