//! Native surfaces. Content, navigation and tools share the same small frontend;
//! external browser windows never receive these capabilities or credentials.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
mod geometry;
#[cfg(target_os = "linux")]
mod kwin;
#[cfg(not(target_os = "linux"))]
#[path = "desktop/kwin_stub.rs"]
mod kwin;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow};

/// Main-thread setup: detect the display backend before any window work.
pub fn init() {
    kwin::init();
}

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
struct Frame {
    id: String,
    title: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}
#[derive(Default)]
pub struct DesktopState {
    request: Mutex<Option<Request>>,
    geometry: geometry::GeometryState,
}
fn label(request: &Request, id: &str) -> String {
    let identity = serde_json::to_vec(&(&request.namespace, &request.scope, id)).unwrap();
    format!("canvas-{:x}", Sha256::digest(identity))
}
fn menu_key(request: &Request) -> String {
    let identity = serde_json::to_vec(&(
        &request.namespace,
        &request.placement,
        request.menu == "hidden",
    ))
    .unwrap();
    format!("menu-{:x}", Sha256::digest(identity))
}
fn toolbox_key(request: &Request) -> String {
    let identity =
        serde_json::to_vec(&(&request.namespace, &request.scope, request.toolbox_open)).unwrap();
    format!("toolbox-{:x}", Sha256::digest(identity))
}
fn monitor_area(monitor: &tauri::Monitor) -> Rect {
    let area = monitor.work_area();
    Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    }
}
fn tile_rect(area: Rect, index: usize, count: usize, grid: bool, gap: u32) -> Rect {
    let columns = if grid {
        (count as f64).sqrt().ceil() as u32
    } else {
        count as u32
    }
    .max(1);
    let rows = (count as u32).div_ceil(columns).max(1);
    let gap = gap
        .min(area.width / (columns + 1))
        .min(area.height / (rows + 1));
    let width = area.width.saturating_sub(gap * (columns + 1)) / columns;
    let height = area.height.saturating_sub(gap * (rows + 1)) / rows;
    Rect {
        x: area.x + (gap + (index as u32 % columns) * (width + gap)) as i32,
        y: area.y + (gap + (index as u32 / columns) * (height + gap)) as i32,
        width: width.max(1),
        height: height.max(1),
    }
}
/// Outer position plus client size, physical pixels. On KDE Wayland GTK cannot
/// position toplevels, so the move is queued for KWin (see `kwin::flush`).
fn place(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    if kwin::wayland_managed() {
        return kwin::place(window, rect);
    }
    window
        .set_position(PhysicalPosition::new(rect.x, rect.y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(rect.width, rect.height))
        .map_err(|e| e.to_string())
}
/// The display a window is on. GDK cannot tell on Wayland; KWin's output
/// origin is matched against monitor positions instead.
fn window_monitor(
    window: &WebviewWindow,
    info: Option<&kwin::Info>,
) -> Result<Option<tauri::Monitor>, String> {
    if kwin::wayland_managed() {
        let fetched;
        let info = match info {
            Some(info) => Some(info),
            None => {
                fetched = kwin::info(window)?;
                fetched.as_ref()
            }
        };
        if let Some((x, y)) = info.and_then(|i| i.output_origin) {
            let monitors = window.available_monitors().map_err(|e| e.to_string())?;
            if let Some(monitor) = monitors.into_iter().find(|m| {
                let scale = m.scale_factor();
                (m.position().x as f64 - x * scale).abs() <= 1.0
                    && (m.position().y as f64 - y * scale).abs() <= 1.0
            }) {
                return Ok(Some(monitor));
            }
        }
    }
    window.current_monitor().map_err(|e| e.to_string())
}
/// Show a window and, where the compositor forgets hidden windows (Wayland),
/// re-apply its saved placement. Follow with `kwin::flush`.
fn show_restored(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    key: &str,
    monitors: &[tauri::Monitor],
    primary: &tauri::Monitor,
    min: (f64, f64),
) -> Result<(), String> {
    let was_hidden = !window.is_visible().unwrap_or(true);
    window.show().map_err(|e| e.to_string())?;
    if was_hidden && kwin::wayland_managed() {
        if let Some(saved) = geometry::load(app)?.get(key) {
            geometry::restore(window, saved, monitors, primary, min)?;
        }
    }
    Ok(())
}
fn surface_url(surface: &str, scope: &str, id: &str) -> WebviewUrl {
    let mut url = tauri::Url::parse("http://localhost/").unwrap();
    url.query_pairs_mut()
        .append_pair("surface", surface)
        .append_pair("scope", scope)
        .append_pair("frame", id);
    WebviewUrl::App(format!("index.html?{}", url.query().unwrap()).into())
}
fn build_surface(
    app: &tauri::AppHandle,
    label: &str,
    title: &str,
    url: WebviewUrl,
    decorations: bool,
) -> Result<WebviewWindow, String> {
    let builder = tauri::WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .visible(false)
        .decorations(decorations)
        .inner_size(900.0, 700.0)
        .min_inner_size(
            if decorations { 320.0 } else { 60.0 },
            if decorations { 240.0 } else { 60.0 },
        );
    #[cfg(feature = "desktop-smoke-test")]
    let builder = if let Ok(profile) = std::env::var("CANVAS_DESKTOP_SMOKE_PROFILE") {
        builder.data_directory(profile.into())
    } else {
        builder
    };
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::tls::install(&window)?;
    Ok(window)
}
#[tauri::command]
pub async fn desktop_sync(app: tauri::AppHandle, request: Request) -> Result<(), String> {
    if request.frames.len() > 24 || request.gap > 64 {
        return Err("This foundation supports up to 24 windows per path.".into());
    }
    let main = app
        .get_webview_window("main")
        .ok_or("Main menu is unavailable")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    let primary = main
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| monitors.first().cloned())
        .ok_or("No display is available")?;
    let geometry = geometry::load(&app)?;
    let previous = app
        .state::<DesktopState>()
        .request
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let switched = previous
        .as_ref()
        .is_none_or(|old| old.scope != request.scope || old.namespace != request.namespace);
    let desired: Vec<_> = request
        .frames
        .iter()
        .map(|frame| label(&request, &frame.id))
        .collect();
    for (id, window) in app.webview_windows() {
        if id.starts_with("canvas-") && !desired.contains(&id) {
            if window.is_visible().unwrap_or(false) {
                geometry::remember(&window)?;
            }
            window.hide().map_err(|e| e.to_string())?;
            kwin::forget(&id);
            // Reuse canvases on return to a recent context, cap dormant webviews.
            if app.webview_windows().len() > request.frames.len() + 10 {
                window.destroy().map_err(|e| e.to_string())?;
            }
        }
    }
    let area = monitor_area(&primary);
    let scale = primary.scale_factor();
    let menu_width = if request.menu == "hidden" {
        76.0
    } else if request.placement == "top" {
        390.0
    } else {
        340.0
    };
    let menu_height = if request.placement == "top" && request.menu == "hidden" {
        76.0
    } else {
        740.0_f64.min(area.height as f64 / scale - 60.0)
    };
    let menu_key = menu_key(&request);
    if geometry::bound_key(&app, "main").as_ref() != Some(&menu_key) {
        geometry::unbind(&main)?;
        if let Some(saved) = geometry::load(&app)?.get(&menu_key) {
            geometry::restore(&main, saved, &monitors, &primary, (60.0, 60.0))?;
        } else {
            main.unmaximize().map_err(|e| e.to_string())?;
            place(
                &main,
                geometry::fit(
                    Rect {
                        x: if request.placement == "top" {
                            area.x + (area.width as i32 - (menu_width * scale) as i32) / 2
                        } else {
                            area.x + (16.0 * scale) as i32
                        },
                        y: area.y + (24.0 * scale) as i32,
                        width: (menu_width * scale) as u32,
                        height: (menu_height.max(60.0) * scale) as u32,
                    },
                    area,
                    (60, 60),
                ),
            )?;
        }
        geometry::bind(&main, menu_key)?;
    }
    let mut all_new = !request.frames.is_empty();
    for (index, frame) in request.frames.iter().enumerate() {
        let id = label(&request, &frame.id);
        let existing = app.get_webview_window(&id);
        let window = if let Some(window) = existing {
            all_new = false;
            window
        } else {
            let window = build_surface(
                &app,
                &id,
                &format!("{} — canvas", frame.title),
                surface_url("canvas", &request.scope, &frame.id),
                true,
            )?;
            if let Some(saved) = geometry.get(&id) {
                all_new = false;
                geometry::restore(&window, saved, &monitors, &primary, (320.0, 240.0))?;
            } else {
                // New windows get a cascading placement without moving existing canvases.
                // The newly focused frame is this still-hidden window. Use the
                // previous focused canvas to select the user's current display.
                let focused = previous
                    .as_ref()
                    .filter(|_| !switched)
                    .and_then(|old| app.get_webview_window(&label(old, &old.focused)));
                let monitor = focused
                    .as_ref()
                    .and_then(|w| window_monitor(w, None).ok().flatten())
                    .unwrap_or(primary.clone());
                let area = monitor_area(&monitor);
                let scale = monitor.scale_factor();
                let offset = (index % 6) as f64 * 28.0;
                place(
                    &window,
                    geometry::fit(
                        Rect {
                            x: area.x
                                + (((area.width as f64 / scale - 900.0) / 2.0 + offset).max(16.0)
                                    * scale) as i32,
                            y: area.y
                                + (((area.height as f64 / scale - 700.0) / 2.0 + offset).max(16.0)
                                    * scale) as i32,
                            width: (900.0 * scale) as u32,
                            height: (700.0 * scale) as u32,
                        },
                        area,
                        ((320.0 * scale) as u32, (240.0 * scale) as u32),
                    ),
                )?;
            }
            window
        };
        window
            .set_title(&format!("{} — canvas", frame.title))
            .map_err(|e| e.to_string())?;
        if request.arrangement == "focus" && frame.id != request.focused {
            geometry::remember(&window)?;
            window.hide().map_err(|e| e.to_string())?;
            kwin::forget(&id);
        } else {
            show_restored(&app, &window, &id, &monitors, &primary, (320.0, 240.0))?;
        }
        geometry::bind(&window, id)?;
    }
    // KWin applies queued placement once the shown windows are mapped.
    let place_error = kwin::flush(&app).err();
    *app.state::<DesktopState>()
        .request
        .lock()
        .map_err(|e| e.to_string())? = Some(request.clone());
    // Context restoration, focus, tabs and toolbox toggles must not retile manual bounds.
    let rearrange = (switched && all_new)
        || (!switched
            && previous.as_ref().is_some_and(|old| {
                old.arrangement != request.arrangement || old.gap != request.gap
            }));
    let tile_error = if rearrange {
        desktop_tile(app.clone()).await.err()
    } else {
        None
    };
    // A toolbox is its own webview and keeps its global applets across switches.
    let toolbox = if let Some(window) = app.get_webview_window("toolbox") {
        window
    } else {
        build_surface(
            &app,
            "toolbox",
            "Toolbox — canvas",
            surface_url("toolbox", "", ""),
            false,
        )?
    };
    let focus_window = app.get_webview_window(&label(&request, &request.focused));
    let monitor = focus_window
        .as_ref()
        .and_then(|window| window_monitor(window, None).ok().flatten())
        .unwrap_or(primary);
    let area = monitor_area(&monitor);
    let scale = monitor.scale_factor();
    let width = ((if request.toolbox_open { 310.0 } else { 64.0 }) * scale) as u32;
    let height = ((if request.toolbox_open {
        610.0_f64.min(area.height as f64 / scale - 50.0)
    } else {
        64.0
    }) * scale) as u32;
    let anchor = focus_window
        .as_ref()
        .and_then(|window| geometry::capture(window).ok().flatten());
    let anchor_desktops = anchor.as_ref().and_then(|g| g.desktops.clone());
    let anchor = anchor.map(|g| g.rect);
    let x = anchor
        .map(|rect| rect.x + rect.width as i32 + (16.0 * scale) as i32)
        .unwrap_or(area.x + area.width as i32 - width as i32 - 20);
    let y = anchor
        .map(|rect| rect.y + rect.height as i32 - height as i32)
        .unwrap_or(area.y + area.height as i32 - height as i32 - 30);
    let toolbox_key = toolbox_key(&request);
    if geometry::bound_key(&app, "toolbox").as_ref() != Some(&toolbox_key) {
        geometry::unbind(&toolbox)?;
        if let Some(saved) = geometry::load(&app)?.get(&toolbox_key) {
            geometry::restore(&toolbox, saved, &monitors, &monitor, (60.0, 60.0))?;
        } else {
            toolbox.unmaximize().map_err(|e| e.to_string())?;
            place(
                &toolbox,
                geometry::fit(
                    Rect {
                        x,
                        y,
                        width,
                        height,
                    },
                    area,
                    (60, 60),
                ),
            )?;
            // A fresh toolbox follows the focused canvas onto its virtual desktop.
            if let Some(desktops) = anchor_desktops.filter(|_| kwin::managed()) {
                let ids: Vec<String> = desktops.into_iter().map(|d| d.id).collect();
                kwin::set_state(&toolbox, Some(ids), None)?;
            }
        }
        toolbox.show().map_err(|e| e.to_string())?;
        geometry::bind(&toolbox, toolbox_key)?;
    } else {
        show_restored(&app, &toolbox, &toolbox_key, &monitors, &monitor, (60.0, 60.0))?;
    }
    kwin::flush(&app)?;
    if switched {
        if let Some(window) = focus_window {
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }
    if let Some(error) = tile_error.or(place_error) {
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_tile(app: tauri::AppHandle) -> Result<(), String> {
    let request = app
        .state::<DesktopState>()
        .request
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let Some(request) = request else {
        return Ok(());
    };
    let main = app
        .get_webview_window("main")
        .ok_or("Main menu is unavailable")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    let mut placed = Vec::new();
    for monitor in monitors {
        let mut windows: Vec<_> = request
            .frames
            .iter()
            .filter(|frame| request.arrangement != "focus" || frame.id == request.focused)
            .filter_map(|frame| app.get_webview_window(&label(&request, &frame.id)))
            .filter(|window| {
                window_monitor(window, None)
                    .ok()
                    .flatten()
                    .is_some_and(|current| current.position() == monitor.position())
            })
            .collect();
        if windows.is_empty() {
            continue;
        }
        let focused_label = label(&request, &request.focused);
        windows.sort_by_key(|window| window.label() != focused_label);
        let mut area = monitor_area(&monitor);
        let scale = monitor.scale_factor();
        // Reserve controls only on the display containing the main menu.
        if window_monitor(&main, None)
            .ok()
            .flatten()
            .is_some_and(|current| current.position() == monitor.position())
            && area.width as f64 / scale > 1000.0
        {
            let reserve = ((if request.menu == "hidden" {
                90.0
            } else {
                365.0
            }) * scale) as u32;
            area.x += reserve as i32;
            area.width = area.width.saturating_sub(reserve);
        }
        area.height = area.height.saturating_sub((76.0 * scale) as u32);
        let toolbox_space = if request.toolbox_open
            && windows.iter().any(|window| window.label() == focused_label)
        {
            (326.0 * scale) as u32
        } else {
            0
        };
        area.width = area.width.saturating_sub(toolbox_space);
        for (i, window) in windows.iter().enumerate() {
            let mut rect = tile_rect(
                area,
                i,
                windows.len(),
                request.arrangement == "grid",
                (request.gap as f64 * scale) as u32,
            );
            if request.arrangement == "columns" && i > 0 {
                rect.x += toolbox_space as i32;
            }
            if rect.width < (320.0 * scale) as u32 || rect.height < (240.0 * scale) as u32 {
                return Err("Too many windows to tile on this display. Group canvases into tabs or move a window to another display.".into());
            }
            window.unmaximize().map_err(|e| e.to_string())?;
            window.unminimize().map_err(|e| e.to_string())?;
            place(window, rect)?;
            placed.push(window.clone());
        }
    }
    // One KWin round trip for every tile, then record the resulting bounds.
    kwin::flush(&app)?;
    for window in &placed {
        geometry::remember(window)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_hide_surfaces(app: tauri::AppHandle) -> Result<(), String> {
    geometry::save_all(&app)?;
    for window in app.webview_windows().values() {
        geometry::unbind(window)?;
    }
    for (id, window) in app.webview_windows() {
        if id.starts_with("canvas-") || id == "toolbox" {
            // Destruction clears rendered private content on logout.
            window.destroy().map_err(|e| e.to_string())?;
            kwin::forget(&id);
        }
    }
    *app.state::<DesktopState>()
        .request
        .lock()
        .map_err(|e| e.to_string())? = None;
    if let Some(main) = app.get_webview_window("main") {
        main.set_size(tauri::LogicalSize::new(900.0, 800.0))
            .map_err(|e| e.to_string())?;
        main.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn desktop_reveal_menu(app: tauri::AppHandle) -> Result<(), String> {
    crate::open_main_ui(&app, false).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn desktop_open_web(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return Err("Use a local Canvas route.".into());
    }
    let main = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let current = main.url().map_err(|e| e.to_string())?;
    let destination = current.join(&path).map_err(|e| e.to_string())?;
    if destination.origin() != current.origin() {
        return Err("Web UI must use the local Canvas origin.".into());
    }
    desktop_hide_surfaces(app.clone()).await?;
    main.navigate(destination).map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())
}
pub fn restore_active(app: &tauri::AppHandle) {
    let request = app
        .state::<DesktopState>()
        .request
        .lock()
        .ok()
        .and_then(|request| request.clone());
    if let Some(request) = request {
        let monitors = app
            .get_webview_window("main")
            .and_then(|main| main.available_monitors().ok())
            .unwrap_or_default();
        let primary = app
            .get_webview_window("main")
            .and_then(|main| main.primary_monitor().ok().flatten())
            .or_else(|| monitors.first().cloned());
        let reveal = |window: WebviewWindow, key: &str, min: (f64, f64)| {
            let _ = window.unminimize();
            match primary.as_ref() {
                Some(primary) => {
                    let _ = show_restored(app, &window, key, &monitors, primary, min);
                }
                None => {
                    let _ = window.show();
                }
            }
        };
        for frame in &request.frames {
            if request.arrangement == "focus" && frame.id != request.focused {
                continue;
            }
            let id = label(&request, &frame.id);
            if let Some(window) = app.get_webview_window(&id) {
                reveal(window, &id, (320.0, 240.0));
            }
        }
        if let Some(toolbox) = app.get_webview_window("toolbox") {
            reveal(toolbox, &toolbox_key(&request), (60.0, 60.0));
        }
        if let Err(error) = kwin::flush(app) {
            geometry::report(app, error);
        }
    }
}
pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let id = window.label();
    if matches!(event, tauri::WindowEvent::Destroyed) {
        crate::tls::forget_window(window.app_handle(), id);
        geometry::forget(window.app_handle(), id);
        kwin::forget(id);
    }
    if matches!(
        event,
        tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. }
            | tauri::WindowEvent::CloseRequested { .. }
    ) {
        if kwin::managed() {
            // Window events arrive on the UI thread; the KWin round trip must not.
            geometry::remember_later(window.app_handle(), id);
        } else if let Some(webview) = window.app_handle().get_webview_window(id) {
            if let Err(error) = geometry::remember(&webview) {
                geometry::report(window.app_handle(), error);
            }
        }
    }
    if id.starts_with("canvas-") {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.emit("desktop:close", ());
            }
            tauri::WindowEvent::Focused(true) => {
                let _ = window.emit("desktop:focused", ());
            }
            _ => {}
        }
    }
}
pub fn run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
        if let Err(error) = geometry::save_all(app) {
            geometry::report(app, error);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn clamp(rect: Rect, area: Rect) -> Rect {
        geometry::fit(rect, area, (320, 240))
    }
    #[test]
    fn restores_negative_monitor_coordinates_and_recovers_unplugged_displays() {
        let left = Rect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let saved = Rect {
            x: -1800,
            y: 80,
            width: 900,
            height: 700,
        };
        assert_eq!(clamp(saved, left), saved);
        let primary = Rect {
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
        };
        assert_eq!(clamp(saved, primary).x, 0);
        assert_eq!(
            clamp(
                Rect {
                    width: 4000,
                    height: 3000,
                    ..saved
                },
                primary
            ),
            primary
        );
    }
    #[test]
    fn tiles_have_real_gaps_and_fit_the_work_area() {
        let area = Rect {
            x: 100,
            y: 30,
            width: 1600,
            height: 900,
        };
        let first = tile_rect(area, 0, 2, false, 16);
        let second = tile_rect(area, 1, 2, false, 16);
        assert_eq!(second.x - first.x - first.width as i32, 16);
        assert!(second.x + second.width as i32 <= area.x + area.width as i32);
        let last = tile_rect(area, 3, 4, true, 24);
        assert!(last.y + last.height as i32 <= area.y + area.height as i32);
    }
    #[test]
    fn tiny_displays_never_underflow_tiling_math() {
        let rect = tile_rect(
            Rect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            23,
            24,
            false,
            64,
        );
        assert!(rect.width <= 10 && rect.height <= 10);
    }
}
