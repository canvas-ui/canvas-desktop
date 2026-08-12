mod config;
mod fuse;

use tauri::Manager;

// Show/focus the overlay if hidden, hide it if visible. Used by the tray.
fn toggle_overlay(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // The activation accelerator is configurable, so it's registered from the
    // frontend (which knows the saved config). Here we just load the plugin.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .manage(fuse::FuseState::default())
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            config::config_path,
            fuse::set_mountables,
            fuse::fuse_status,
            fuse::fuse_available,
        ])
        .setup(|app| {
            use tauri::tray::TrayIconBuilder;

            // Tray uses the Canvas mark (white-ring variant from
            // extensions/browser-extensions/assets/icons), bundled at icons/tray.png.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id(fuse::TRAY_ID)
                .icon(tray_icon)
                .tooltip("Canvas")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_overlay(app),
                    "quit" => app.exit(0),
                    id => fuse::handle_menu_event(app, id),
                })
                .build(app)?;
            // Menu is rebuilt on the fly (mountables arrive from the frontend,
            // mounts toggle); the initial build shows the static items.
            fuse::rebuild_tray_menu(app.handle())?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
