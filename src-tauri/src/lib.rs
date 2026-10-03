mod browser;
mod config;
mod fuse;
use tauri::Manager;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Configure WebKit before GTK initialization or any webview is created.
    #[cfg(target_os = "linux")]
    configure_linux_renderer();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            config::load_setup,
            config::save_remote,
            config::save_setup,
            fuse::mount_action,
            fuse::mount_status,
            browser::open_browser
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
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

#[cfg(target_os = "linux")]
fn configure_linux_renderer() {
    // Proprietary NVIDIA drivers can render a blank webview even when the
    // DMABUF renderer is disabled. This small tray/setup app defaults to the
    // non-composited path; explicit environment settings remain authoritative.
    // https://github.com/tauri-apps/tauri/issues/9394
    for key in [
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
    ] {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, "1");
        }
    }
    // CLUTTER_BACKEND does not select GTK's display backend. Honor an existing
    // X11 preference without overriding a user's explicit GDK_BACKEND choice.
    if std::env::var("CLUTTER_BACKEND").as_deref() == Ok("x11")
        && std::env::var_os("GDK_BACKEND").is_none()
    {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}
