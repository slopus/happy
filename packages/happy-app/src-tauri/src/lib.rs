use serde::Serialize;
use std::fs;

/// Auto-discovered config from the user's CLI install, exposed to the JS layer
/// so the Tauri-bundled webapp boots already-pointing-at-the-right-server and
/// already-authenticated when the user has run the CLI on this machine.
///
/// Fields use snake_case here, matching what serde will emit; the JS side
/// reads them directly. We don't fail loudly when the files are missing or
/// malformed — those are valid states (fresh install, no CLI), so the
/// command returns a HappyConfig with None fields and the webapp falls back
/// to its normal defaults (in-app Settings → Server screen still works).
#[derive(Serialize, Default)]
struct HappyConfig {
    server_url: Option<String>,
    webapp_url: Option<String>,
    auth: Option<HappyAuth>,
}

#[derive(Serialize)]
struct HappyAuth {
    token: String,
    secret: String,
}

#[tauri::command]
fn read_happy_config() -> HappyConfig {
    let Some(home) = dirs::home_dir() else {
        return HappyConfig::default();
    };
    let happy_dir = home.join(".happy");

    let mut cfg = HappyConfig::default();

    // settings.json → server_url / webapp_url
    if let Ok(text) = fs::read_to_string(happy_dir.join("settings.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            cfg.server_url = json.get("serverUrl").and_then(|v| v.as_str()).map(String::from);
            cfg.webapp_url = json.get("webappUrl").and_then(|v| v.as_str()).map(String::from);
        }
    }

    // access.key → auth (legacy format only — { secret, token })
    if let Ok(text) = fs::read_to_string(happy_dir.join("access.key")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            let token = json.get("token").and_then(|v| v.as_str()).map(String::from);
            let secret = json.get("secret").and_then(|v| v.as_str()).map(String::from);
            if let (Some(t), Some(s)) = (token, secret) {
                cfg.auth = Some(HappyAuth { token: t, secret: s });
            }
        }
    }

    cfg
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_happy_config])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
