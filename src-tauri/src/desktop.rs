//! Native surfaces. Content, navigation and tools share the same small frontend;
//! external browser windows never receive these capabilities or credentials.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Mutex};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    namespace: String,
    scope: String,
    frames: Vec<Frame>,
    focused: String,
    arrangement: String,
    gap: u32,
    placement: String,
    menu: String,
    toolbox_open: bool,
}
#[derive(Clone, Debug, Deserialize)]
struct Frame { id: String, title: String }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
struct Rect { x: i32, y: i32, width: u32, height: u32 }
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Geometry { rect: Rect, monitor: Option<String>, maximized: bool }
#[derive(Default)]
pub struct DesktopState {
    request: Mutex<Option<Request>>,
    geometry: Mutex<Option<BTreeMap<String, Geometry>>>,
}
fn label(request: &Request, id: &str) -> String {
    let identity = serde_json::to_vec(&(&request.namespace, &request.scope, id)).unwrap();
    format!("canvas-{:x}", Sha256::digest(identity))
}
fn geometry_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::config::user_home()?.join("config/desktop-windows.json"))
}
fn load_geometry(app: &tauri::AppHandle) -> Result<BTreeMap<String, Geometry>, String> {
    let state = app.state::<DesktopState>();
    let mut geometry = state.geometry.lock().map_err(|e| e.to_string())?;
    if geometry.is_none() {
        let raw = crate::config::read(&geometry_path()?)?;
        *geometry = Some(if raw == serde_json::json!({}) { BTreeMap::new() } else {
            if raw["version"] != 1 { return Err("Unsupported native window layout version; saved geometry was left untouched.".into()); }
            serde_json::from_value(raw["windows"].clone()).map_err(|e| format!("Invalid saved window geometry: {e}"))?
        });
    }
    Ok(geometry.as_ref().unwrap().clone())
}
fn capture(window: &WebviewWindow) -> Result<Geometry, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok(Geometry { rect: Rect { x: position.x, y: position.y, width: size.width, height: size.height }, monitor: window.current_monitor().ok().flatten().and_then(|m| m.name().cloned()), maximized: window.is_maximized().unwrap_or(false) })
}
#[tauri::command]
pub async fn desktop_save_geometry(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("canvas-") { return Ok(()); }
    let next = capture(&window)?;
    // Do not replace the normal bounds with maximized bounds.
    let state = app.state::<DesktopState>();
    load_geometry(&app)?;
    let _lock = crate::config::CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut geometry = state.geometry.lock().map_err(|e| e.to_string())?;
    let windows = geometry.as_mut().unwrap();
    if next.maximized {
        if let Some(old) = windows.get_mut(window.label()) { old.maximized = true; }
        else { windows.insert(window.label().into(), next); }
    } else { windows.insert(window.label().into(), next); }
    crate::config::write(&geometry_path()?, &serde_json::json!({ "version": 1, "windows": windows }))
}
fn monitor_area(monitor: &tauri::Monitor) -> Rect {
    let area = monitor.work_area();
    Rect { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height }
}
fn clamp(rect: Rect, area: Rect) -> Rect {
    let width = rect.width.max(320).min(area.width);
    let height = rect.height.max(240).min(area.height);
    Rect { x: rect.x.max(area.x).min(area.x + (area.width - width) as i32), y: rect.y.max(area.y).min(area.y + (area.height - height) as i32), width, height }
}
fn tile_rect(area: Rect, index: usize, count: usize, grid: bool, gap: u32) -> Rect {
    let columns = if grid { (count as f64).sqrt().ceil() as u32 } else { count as u32 }.max(1);
    let rows = (count as u32).div_ceil(columns).max(1);
    let gap = gap.min(area.width / (columns + 1)).min(area.height / (rows + 1));
    let width = area.width.saturating_sub(gap * (columns + 1)) / columns;
    let height = area.height.saturating_sub(gap * (rows + 1)) / rows;
    Rect { x: area.x + (gap + (index as u32 % columns) * (width + gap)) as i32, y: area.y + (gap + (index as u32 / columns) * (height + gap)) as i32, width: width.max(1), height: height.max(1) }
}
fn place(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    window.set_position(PhysicalPosition::new(rect.x, rect.y)).map_err(|e| e.to_string())?;
    window.set_size(PhysicalSize::new(rect.width, rect.height)).map_err(|e| e.to_string())
}
fn surface_url(surface: &str, scope: &str, id: &str) -> WebviewUrl {
    let mut url = tauri::Url::parse("http://localhost/").unwrap();
    url.query_pairs_mut().append_pair("surface", surface).append_pair("scope", scope).append_pair("frame", id);
    WebviewUrl::App(format!("index.html?{}", url.query().unwrap()).into())
}
fn build_surface(app: &tauri::AppHandle, label: &str, title: &str, url: WebviewUrl, decorations: bool) -> Result<WebviewWindow, String> {
    let window = tauri::WebviewWindowBuilder::new(app, label, url)
        .title(title).visible(false).decorations(decorations).inner_size(900.0, 700.0)
        .min_inner_size(if decorations { 320.0 } else { 60.0 }, if decorations { 240.0 } else { 60.0 })
        .build().map_err(|e| e.to_string())?;
    crate::tls::install(&window)?;
    Ok(window)
}
#[tauri::command]
pub async fn desktop_sync(app: tauri::AppHandle, request: Request) -> Result<(), String> {
    if request.frames.len() > 24 || request.gap > 64 { return Err("This foundation supports up to 24 windows per path.".into()); }
    let main = app.get_webview_window("main").ok_or("Main menu is unavailable")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    let primary = main.primary_monitor().map_err(|e| e.to_string())?.or_else(|| monitors.first().cloned()).ok_or("No display is available")?;
    let geometry = load_geometry(&app)?;
    let previous = app.state::<DesktopState>().request.lock().map_err(|e| e.to_string())?.clone();
    let switched = previous.as_ref().is_none_or(|old| old.scope != request.scope || old.namespace != request.namespace);
    let desired: Vec<_> = request.frames.iter().map(|frame| label(&request, &frame.id)).collect();
    for (id, window) in app.webview_windows() {
        if id.starts_with("canvas-") && !desired.contains(&id) {
            if window.is_visible().unwrap_or(false) { desktop_save_geometry(app.clone(), window.clone()).await?; }
            window.hide().map_err(|e| e.to_string())?;
            // Reuse canvases on return to a recent context, cap dormant webviews.
            if app.webview_windows().len() > request.frames.len() + 10 { window.destroy().map_err(|e| e.to_string())?; }
        }
    }
    let area = monitor_area(&primary);
    let scale = primary.scale_factor();
    let menu_width = if request.menu == "hidden" { 76.0 } else if request.placement == "top" { 390.0 } else { 340.0 };
    let menu_height = if request.placement == "top" && request.menu == "hidden" { 76.0 } else { 740.0_f64.min(area.height as f64 / scale - 60.0) };
    main.set_size(tauri::LogicalSize::new(menu_width, menu_height.max(240.0))).map_err(|e| e.to_string())?;
    if previous.as_ref().is_none_or(|old| old.placement != request.placement) {
        main.set_position(PhysicalPosition::new(if request.placement == "top" { area.x + (area.width as i32 - (menu_width * scale) as i32) / 2 } else { area.x + (16.0 * scale) as i32 }, area.y + (24.0 * scale) as i32)).map_err(|e| e.to_string())?;
    }
    let mut created = false;
    for frame in &request.frames {
        let id = label(&request, &frame.id);
        let existing = app.get_webview_window(&id);
        let window = if let Some(window) = existing { window } else {
            let window = build_surface(&app, &id, &format!("{} — canvas", frame.title), surface_url("canvas", &request.scope, &frame.id), true)?;
            if let Some(saved) = geometry.get(&id) {
                let monitor = monitors.iter().find(|monitor| monitor.name() == saved.monitor.as_ref()).unwrap_or(&primary);
                place(&window, clamp(saved.rect, monitor_area(monitor)))?;
                if saved.maximized { window.maximize().map_err(|e| e.to_string())?; }
            } else { created = true; }
            window
        };
        window.set_title(&format!("{} — canvas", frame.title)).map_err(|e| e.to_string())?;
        if request.arrangement == "focus" && frame.id != request.focused { window.hide().map_err(|e| e.to_string())?; }
        else { window.show().map_err(|e| e.to_string())?; }
    }
    *app.state::<DesktopState>().request.lock().map_err(|e| e.to_string())? = Some(request.clone());
    let rearrange = created || previous.as_ref().is_some_and(|old| old.arrangement != request.arrangement || old.gap != request.gap);
    if rearrange { desktop_tile(app.clone()).await?; }
    // A toolbox is its own webview and keeps its global applets across switches.
    let toolbox = if let Some(window) = app.get_webview_window("toolbox") { window } else {
        build_surface(&app, "toolbox", "Toolbox — canvas", surface_url("toolbox", "", ""), false)?
    };
    let focus_window = app.get_webview_window(&label(&request, &request.focused));
    let monitor = focus_window.as_ref().and_then(|window| window.current_monitor().ok().flatten()).unwrap_or(primary);
    let area = monitor_area(&monitor);
    let scale = monitor.scale_factor();
    let width = ((if request.toolbox_open { 310.0 } else { 64.0 }) * scale) as u32;
    let height = ((if request.toolbox_open { 610.0_f64.min(area.height as f64 / scale - 50.0) } else { 64.0 }) * scale) as u32;
    let anchor = focus_window.as_ref().and_then(|window| capture(window).ok()).map(|g| g.rect);
    let x = anchor.map(|rect| rect.x + rect.width as i32 + (16.0 * scale) as i32).unwrap_or(area.x + area.width as i32 - width as i32 - 20);
    let y = anchor.map(|rect| rect.y + rect.height as i32 - height as i32).unwrap_or(area.y + area.height as i32 - height as i32 - 30);
    let rect = Rect { x: x.min(area.x + area.width as i32 - width as i32), y: y.max(area.y), width: width.min(area.width), height: height.min(area.height) };
    place(&toolbox, rect)?;
    toolbox.show().map_err(|e| e.to_string())?;
    if switched { if let Some(window) = focus_window { window.set_focus().map_err(|e| e.to_string())?; } }
    Ok(())
}
#[tauri::command]
pub async fn desktop_tile(app: tauri::AppHandle) -> Result<(), String> {
    let request = app.state::<DesktopState>().request.lock().map_err(|e| e.to_string())?.clone();
    let Some(request) = request else { return Ok(()); };
    let main = app.get_webview_window("main").ok_or("Main menu is unavailable")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    for monitor in monitors {
        let windows: Vec<_> = request.frames.iter().filter(|frame| request.arrangement != "focus" || frame.id == request.focused)
            .filter_map(|frame| app.get_webview_window(&label(&request, &frame.id)))
            .filter(|window| window.current_monitor().ok().flatten().is_some_and(|current| current.position() == monitor.position())).collect();
        if windows.is_empty() { continue; }
        let mut area = monitor_area(&monitor);
        let scale = monitor.scale_factor();
        // Reserve controls only on the display containing the main menu.
        if main.current_monitor().ok().flatten().is_some_and(|current| current.position() == monitor.position()) && area.width as f64 / scale > 1000.0 {
            let reserve = ((if request.menu == "hidden" { 90.0 } else { 365.0 }) * scale) as u32;
            area.x += reserve as i32; area.width = area.width.saturating_sub(reserve);
        }
        area.height = area.height.saturating_sub((76.0 * scale) as u32);
        for (i, window) in windows.iter().enumerate() {
            let rect = tile_rect(area, i, windows.len(), request.arrangement == "grid", (request.gap as f64 * scale) as u32);
            if rect.width < (320.0 * scale) as u32 || rect.height < (240.0 * scale) as u32 { return Err("Too many windows to tile on this display. Group canvases into tabs or move a window to another display.".into()); }
            window.unmaximize().map_err(|e| e.to_string())?;
            window.unminimize().map_err(|e| e.to_string())?;
            place(window, rect)?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_hide_surfaces(app: tauri::AppHandle) -> Result<(), String> {
    for (id, window) in app.webview_windows() {
        if id.starts_with("canvas-") || id == "toolbox" {
            // Destruction clears rendered private content on logout.
            window.destroy().map_err(|e| e.to_string())?;
        }
    }
    *app.state::<DesktopState>().request.lock().map_err(|e| e.to_string())? = None;
    if let Some(main) = app.get_webview_window("main") { main.set_size(tauri::LogicalSize::new(900.0, 800.0)).map_err(|e| e.to_string())?; main.show().map_err(|e| e.to_string())?; }
    Ok(())
}
#[tauri::command]
pub fn desktop_reveal_menu(app: tauri::AppHandle) -> Result<(), String> { crate::open_main_ui(&app, false).map_err(|e| e.to_string()) }
pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let id = window.label();
    if id.starts_with("canvas-") {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => { api.prevent_close(); let _ = window.emit("desktop:close", ()); }
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => { let _ = window.emit("desktop:geometry", ()); }
            tauri::WindowEvent::Focused(true) => { let _ = window.emit("desktop:focused", ()); }
            _ => {}
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_negative_monitor_coordinates_and_recovers_unplugged_displays() {
        let left = Rect { x: -1920, y: 0, width: 1920, height: 1080 };
        let saved = Rect { x: -1800, y: 80, width: 900, height: 700 };
        assert_eq!(clamp(saved, left), saved);
        let primary = Rect { x: 0, y: 0, width: 1440, height: 900 };
        assert_eq!(clamp(saved, primary).x, 0);
        assert_eq!(clamp(Rect { width: 4000, height: 3000, ..saved }, primary), primary);
    }
    #[test]
    fn tiles_have_real_gaps_and_fit_the_work_area() {
        let area = Rect { x: 100, y: 30, width: 1600, height: 900 };
        let first = tile_rect(area, 0, 2, false, 16);
        let second = tile_rect(area, 1, 2, false, 16);
        assert_eq!(second.x - first.x - first.width as i32, 16);
        assert!(second.x + second.width as i32 <= area.x + area.width as i32);
        let last = tile_rect(area, 3, 4, true, 24);
        assert!(last.y + last.height as i32 <= area.y + area.height as i32);
    }
    #[test]
    fn tiny_displays_never_underflow_tiling_math() {
        let rect = tile_rect(Rect { x: 0, y: 0, width: 10, height: 10 }, 23, 24, false, 64);
        assert!(rect.width <= 10 && rect.height <= 10);
    }
}
