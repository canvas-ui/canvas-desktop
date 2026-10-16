mod browser;
mod config;
mod desktop;
#[cfg(feature = "desktop-smoke-test")]
mod desktop_smoke;
mod fuse;
mod runtime_path;
mod tls;
use tauri::{Emitter, Manager};

pub(crate) fn open_main_ui(app: &tauri::AppHandle, restart: bool) -> tauri::Result<()> {
    let window = if let Some(window) = app.get_webview_window("main") {
        if restart {
            window.reload()?;
        }
        window
    } else {
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|config| config.label == "main")
            .expect("main window configuration is required");
        tauri::WebviewWindowBuilder::from_config(app, config)?.build()?
    };
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Configure WebKit before GTK initialization or any webview is created.
    #[cfg(target_os = "linux")]
    configure_linux_renderer();
    tauri::Builder::default()
        .manage(tls::TlsState::default())
        .manage(desktop::DesktopState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            tls::activate_tls,
            tls::prepare_tls_import,
            tls::save_remote_tls,
            tls::native_tls_status,
            tls::remove_native_identity,
            tls::restart_connections,
            config::load_setup,
            config::load_remotes,
            config::save_remote,
            config::save_setup,
            fuse::mount_action,
            fuse::mount_status,
            browser::open_browser,
            desktop::desktop_sync,
            desktop::desktop_tile,
            desktop::desktop_hide_surfaces,
            desktop::desktop_reveal_menu,
            desktop::desktop_open_web
        ])
        .on_window_event(|window, event| {
            desktop::window_event(window, event);
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            desktop::init();
            tauri::tray::TrayIconBuilder::with_id(fuse::TRAY_ID)
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/tray.png"
                ))?)
                .tooltip("canvas")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" | "restart-ui" => {
                        desktop::restore_active(app);
                        if let Err(error) = open_main_ui(app, event.id.as_ref() == "restart-ui") {
                            eprintln!("Unable to open Canvas UI: {error}");
                        }
                    }
                    "quit" => app.exit(0),
                    "menu" | "settings" | "mounts" | "logout" => {
                        if open_main_ui(app, false).is_ok() {
                            if let Some(main) = app.get_webview_window("main") {
                                if let Ok(mut url) = main.url() {
                                    if !["/", "/index.html", "/desktop"].contains(&url.path()) {
                                        url.set_path("/");
                                        url.set_query(Some(&format!(
                                            "action={}",
                                            event.id.as_ref()
                                        )));
                                        let _ = main.navigate(url);
                                    } else {
                                        let _ = main.emit("desktop:action", event.id.as_ref());
                                    }
                                }
                            }
                        }
                    }
                    "minimize-all" => {
                        for window in app.webview_windows().values() {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.minimize();
                            }
                        }
                    }
                    id => fuse::handle_menu_event(app, id),
                })
                .build(app)?;
            fuse::rebuild_tray_menu(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Error building Canvas Desktop")
        .run(desktop::run_event);
}

#[cfg(target_os = "linux")]
fn configure_linux_renderer() {
    // Keep accelerated compositing on healthy drivers. The old tray prototype
    // disabled it on every Linux machine, limiting the desktop's paint budget.
    // Retain the blank-webview workaround on proprietary NVIDIA systems;
    // explicit environment settings remain authoritative on every driver.
    // https://github.com/tauri-apps/tauri/issues/9394
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists()
        || std::env::var("__GLX_VENDOR_LIBRARY_NAME").as_deref() == Ok("nvidia");
    if nvidia {
        for key in [
            "WEBKIT_DISABLE_DMABUF_RENDERER",
            "WEBKIT_DISABLE_COMPOSITING_MODE",
        ] {
            if std::env::var_os(key).is_none() {
                std::env::set_var(key, "1");
            }
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

#[cfg(feature = "tls-smoke-test")]
pub fn run_tls_smoke() {
    tls::smoke::run();
}

#[cfg(feature = "desktop-smoke-test")]
pub fn run_desktop_smoke() {
    #[cfg(target_os = "linux")]
    configure_linux_renderer();
    desktop_smoke::run();
}
