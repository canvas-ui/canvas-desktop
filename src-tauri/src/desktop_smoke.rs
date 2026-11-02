//! Fixture-only harness. It runs real GTK/WebKit windows and the production
//! frontend/window manager, with a private home and a local mock HTTP server.
use tauri::Manager;
#[tauri::command]
fn desktop_test_snapshot(app: tauri::AppHandle) -> serde_json::Value {
    // Windows, not webview windows: a canvas with a page tab hosts two webviews.
    serde_json::json!(app.windows().iter().map(|(id, window)| {
        let position = window.outer_position().ok();
        let size = window.inner_size().ok();
        let webviews: Vec<String> = window.webviews().iter().map(|w| w.label().to_string()).collect();
        serde_json::json!({ "id": id, "key": crate::desktop::geometry_key(&app, id), "prepared": crate::desktop::is_prepared(&app, id), "title": window.title().ok(), "visible": window.is_visible().unwrap_or(false), "maximized": window.is_maximized().unwrap_or(false), "minimized": window.is_minimized().unwrap_or(false), "x": position.map(|p| p.x), "y": position.map(|p| p.y), "width": size.map(|s| s.width), "height": size.map(|s| s.height), "webviews": webviews })
    }).collect::<Vec<_>>())
}
#[tauri::command]
async fn desktop_test_window_state(
    app: tauri::AppHandle,
    id: String,
    action: String,
) -> Result<(), String> {
    let window = app.get_window(&id).ok_or("Fixture window is missing")?;
    match action.as_str() {
        "maximize" => window.maximize(),
        "unmaximize" => window.unmaximize(),
        "minimize" => window.minimize(),
        "unminimize" => window.unminimize(),
        _ => return Err("Unknown fixture action".into()),
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
async fn desktop_test_place(
    app: tauri::AppHandle,
    id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let window = app.get_window(&id).ok_or("Fixture window is missing")?;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn desktop_test_url_close(
    app: tauri::AppHandle,
    window: String,
    tab: String,
) -> Result<(), String> {
    crate::desktop::urls::close_fixture_page(app, window, tab).await
}
#[tauri::command]
async fn desktop_test_widget(
    app: tauri::AppHandle,
    id: String,
) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, id);
        return Err("GTK allocations are available on Linux".into());
    }
    #[cfg(target_os = "linux")]
    {
        let view = app.get_webview(&id).ok_or("Fixture view is missing")?;
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        view.with_webview(move |platform| {
        use gtk::prelude::*;
        let mut widget = Some(platform.inner().upcast::<gtk::Widget>());
        let mut nodes = Vec::new();
        while let Some(view) = widget {
            let allocation = view.allocation();
            nodes.push(serde_json::json!({"type":view.type_().name(),"height":allocation.height(),"y":allocation.y(),"request":view.height_request(),"expand":view.property::<bool>("vexpand"),"visible":view.is_visible()}));
            widget = view.parent();
        }
        let _ = sender.try_send(serde_json::json!(nodes));
    }).map_err(|e| e.to_string())?;
        receiver.recv().await.ok_or("No GTK allocation".into())
    }
}
#[tauri::command]
async fn desktop_test_page_eval(
    app: tauri::AppHandle,
    id: String,
    script: String,
) -> Result<String, String> {
    let view = app.get_webview(&id).ok_or("Fixture page is missing")?;
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    view.eval_with_callback(script, move |result| {
        let _ = sender.try_send(result);
    })
    .map_err(|e| e.to_string())?;
    receiver
        .recv()
        .await
        .ok_or("Fixture page did not evaluate".into())
}
#[tauri::command]
async fn desktop_test_result(app: tauri::AppHandle, result: serde_json::Value) {
    let path = std::env::var("CANVAS_DESKTOP_SMOKE_RESULT").expect("result path");
    std::fs::write(path, result.to_string()).expect("write result");
    crate::terminal::shutdown(&app);
    app.exit(if result["ok"] == true { 0 } else { 1 });
}
pub fn run() {
    let url = std::env::var("CANVAS_DESKTOP_SMOKE_URL").expect("fixture URL");
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = Some(url.parse().unwrap());
    tauri::Builder::default()
        .manage(crate::tls::TlsState::default())
        .manage(crate::desktop::DesktopState::default())
        .manage(crate::desktop::urls::UrlState::default())
        .manage(crate::terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            crate::config::load_remotes, crate::tls::activate_tls,
            crate::desktop::desktop_sync, crate::desktop::desktop_prepare, crate::desktop::desktop_frame, crate::desktop::desktop_tile,
            crate::desktop::desktop_hide_surfaces,
            crate::desktop::desktop_reveal_menu,
            crate::desktop::urls::desktop_url_open, crate::desktop::urls::desktop_url_show, crate::desktop::urls::desktop_url_hide,
            crate::desktop::urls::desktop_url_action,
            crate::terminal::terminal_list, crate::terminal::terminal_create, crate::terminal::terminal_subscribe, crate::terminal::terminal_unsubscribe, crate::terminal::terminal_read, crate::terminal::terminal_write, crate::terminal::terminal_resize, crate::terminal::terminal_close, crate::terminal::terminal_close_all,
            desktop_test_snapshot, desktop_test_place, desktop_test_window_state, desktop_test_page_eval, desktop_test_url_close, desktop_test_widget, desktop_test_result
        ])
        .on_window_event(crate::desktop::window_event)
        .setup(move |app| {
            let seed = format!("localStorage.setItem('canvas.desktop.connection',JSON.stringify({{url:{url:?}}}));localStorage.setItem('canvas.desktop.session:'+encodeURIComponent({url:?})+':authToken','canvas-test-token');");
            let expected: serde_json::Value = serde_json::from_str(&std::env::var("CANVAS_DESKTOP_SMOKE_EXPECTED").unwrap_or("null".into()))?;
            let window_manager = std::env::var("CANVAS_DESKTOP_SMOKE_WM").as_deref() == Ok("1");
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .data_directory(std::env::var("CANVAS_DESKTOP_SMOKE_PROFILE").expect("private webview profile").into())
                .title("Canvas native fixture").inner_size(1200.0, 850.0)
                .initialization_script(seed)
                .initialization_script(format!("window.__NATIVE_GEOMETRY_EXPECTED__ = {expected};"))
                .initialization_script(format!("window.__NATIVE_SMOKE_WM__ = {window_manager};"))
                .initialization_script(include_str!("../../tests/native-shell.js"))
                .build()?;
            Ok(())
        })
        .build(context).expect("native desktop smoke app")
        .run(crate::desktop::run_event);
}
