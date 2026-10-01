mod config;
mod fuse;
use tauri::Manager;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            config::load_setup,
            config::save_remote,
            config::save_setup,
            fuse::mount_action,
            fuse::mount_status
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            tauri::tray::TrayIconBuilder::with_id(fuse::TRAY_ID)
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/tray.png"
                ))?)
                .tooltip("Canvas mounts")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    id => fuse::handle_menu_event(app, id),
                })
                .build(app)?;
            fuse::rebuild_tray_menu(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Error running Canvas Desktop");
}
