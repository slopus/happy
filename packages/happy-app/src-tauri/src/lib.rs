mod tray;
mod notifications;
mod keychain;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .invoke_handler(tauri::generate_handler![
      tray::update_tray_status,
      notifications::send_notification,
      keychain::keychain_get,
      keychain::keychain_set,
      keychain::keychain_delete,
    ])
    .setup(|app| {
      // Setup system tray
      tray::setup_tray(app.handle())?;

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let window = window.clone();
        std::thread::spawn(move || {
          let confirmed = rfd::MessageDialog::new()
            .set_title("Quit Happy")
            .set_description("Are you sure you want to quit?")
            .set_buttons(rfd::MessageButtons::YesNo)
            .show();
          if confirmed == rfd::MessageDialogResult::Yes {
            let _ = window.destroy();
          }
        });
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
