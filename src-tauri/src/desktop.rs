//! Native surfaces. Content, navigation and tools share the same small frontend;
//! external browser windows never receive these capabilities or credentials.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
mod geometry;
mod keyboard;
#[cfg(target_os = "linux")]
mod kwin;
#[cfg(not(target_os = "linux"))]
#[path = "desktop/kwin_stub.rs"]
mod kwin;
pub mod urls;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, Window};

/// The native window behind a single-webview surface. Canvas windows gain
/// child webviews for URL tabs, so window lookups go through `get_window`.
fn win(surface: &WebviewWindow) -> Window {
    AsRef::<tauri::Webview>::as_ref(surface).window()
}

/// Main-thread setup: detect the display backend before any window work.
pub fn init(app: &tauri::AppHandle) {
    kwin::init();
    for window in app.windows().values() {
        keyboard::install(window);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = kwin::install_shortcuts(app.clone()) {
            geometry::report(&app, error);
        }
    });
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    browser_tabs: Vec<String>,
    namespace: String,
    scope: String,
    frames: Vec<Frame>,
    focused: String,
    arrangement: String,
    gap: u32,
    auto_tile: bool,
    placement: String,
    menu: String,
    toolbox_open: bool,
}
#[derive(Clone, Debug, Deserialize)]
struct Frame {
    id: String,
    kind: String,
    title: String,
    pinned: bool,
}
/// Titles, active apps and ordinary focus changes do not change window geometry.
fn needs_reconcile(previous: &Request, next: &Request) -> bool {
    previous.namespace != next.namespace
        || previous.scope != next.scope
        || previous.arrangement != next.arrangement
        || previous.gap != next.gap
        || previous.auto_tile != next.auto_tile
        || previous.placement != next.placement
        || previous.menu != next.menu
        || previous.toolbox_open != next.toolbox_open
        || (next.arrangement == "focus" && previous.focused != next.focused)
        || !previous
            .frames
            .iter()
            .map(|f| (&f.id, f.pinned))
            .eq(next.frames.iter().map(|f| (&f.id, f.pinned)))
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
    operations: tauri::async_runtime::Mutex<()>,
    prepared: Mutex<Option<String>>,
    labels: Mutex<BTreeMap<String, String>>,
    frames: Mutex<BTreeMap<String, String>>,
    sequence: AtomicU64,
    request: Mutex<Option<Request>>,
    geometry: geometry::GeometryState,
}
fn frame_key(request: &Request, id: &str) -> String {
    let identity = serde_json::to_vec(&(&request.namespace, id)).unwrap();
    format!("canvas-{:x}", Sha256::digest(identity))
}
fn label(app: &tauri::AppHandle, request: &Request, id: &str) -> String {
    let key = frame_key(request, id);
    app.state::<DesktopState>()
        .labels
        .lock()
        .ok()
        .and_then(|labels| labels.get(&key).cloned())
        .unwrap_or(key)
}

fn menu_key(request: &Request) -> String {
    let identity = serde_json::to_vec(&(
        &request.namespace,
        &request.placement,
        matches!(request.menu.as_str(), "hidden" | "m0"),
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
/// Content starts beside the menu only on the output it intersects.
fn content_area(mut area: Rect, menu: Rect, top: bool) -> Rect {
    if menu.x >= area.x + area.width as i32
        || menu.x + menu.width as i32 <= area.x
        || menu.y >= area.y + area.height as i32
        || menu.y + menu.height as i32 <= area.y
    {
        return area;
    }
    if top {
        let reserve = (menu.y + menu.height as i32 - area.y).max(0) as u32;
        area.y += reserve.min(area.height) as i32;
        area.height = area.height.saturating_sub(reserve);
    } else {
        let reserve = (menu.x + menu.width as i32 - area.x).max(0) as u32;
        area.x += reserve.min(area.width) as i32;
        area.width = area.width.saturating_sub(reserve);
    }
    area
}
/// Keep a fixed window clear by taking the largest remaining rectangle.
fn avoid(area: Rect, obstacle: Rect) -> Rect {
    let left = obstacle.x.max(area.x).min(area.x + area.width as i32);
    let right = (obstacle.x + obstacle.width as i32)
        .max(area.x)
        .min(area.x + area.width as i32);
    let top = obstacle.y.max(area.y).min(area.y + area.height as i32);
    let bottom = (obstacle.y + obstacle.height as i32)
        .max(area.y)
        .min(area.y + area.height as i32);
    if left >= right || top >= bottom {
        return area;
    }
    [
        Rect {
            width: (left - area.x) as u32,
            ..area
        },
        Rect {
            x: right,
            width: (area.x + area.width as i32 - right) as u32,
            ..area
        },
        Rect {
            height: (top - area.y) as u32,
            ..area
        },
        Rect {
            y: bottom,
            height: (area.y + area.height as i32 - bottom) as u32,
            ..area
        },
    ]
    .into_iter()
    .max_by_key(|r| r.width as u64 * r.height as u64)
    .unwrap()
}
/// Outer position plus client size, physical pixels. On KDE Wayland GTK cannot
/// position toplevels, so the move is queued for KWin (see `kwin::flush`).
fn place(window: &Window, rect: Rect) -> Result<(), String> {
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
    window: &Window,
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
    window: &Window,
    key: &str,
    monitors: &[tauri::Monitor],
    primary: &tauri::Monitor,
    min: (f64, f64),
) -> Result<(), String> {
    let was_hidden = !window.is_visible().unwrap_or(true);
    if !was_hidden {
        return Ok(());
    }
    window.show().map_err(|e| e.to_string())?;
    if window.label().starts_with("canvas-") && window.webviews().len() > 1 {
        // GTK show_all also reveals background page widgets. Restore tab visibility.
        urls::layout(app, window.label())?;
    }
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
/// Every surface draws its own chrome; the OS title bar is never shown.
fn build_surface(
    app: &tauri::AppHandle,
    label: &str,
    title: &str,
    url: WebviewUrl,
    canvas: bool,
) -> Result<WebviewWindow, String> {
    let builder = tauri::WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .visible(false)
        .focused(false)
        .decorations(false)
        .inner_size(900.0, 700.0)
        .min_inner_size(
            if canvas { 320.0 } else { 60.0 },
            if canvas { 240.0 } else { 60.0 },
        );
    let builder = if label == "toolbox" {
        builder
            .transparent(true)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .shadow(false)
    } else {
        builder
    };
    #[cfg(feature = "desktop-smoke-test")]
    let builder = if let Ok(profile) = std::env::var("CANVAS_DESKTOP_SMOKE_PROFILE") {
        builder.data_directory(profile.into())
    } else {
        builder
    };
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::tls::install(window.as_ref())?;
    keyboard::install(&win(&window));
    Ok(window)
}
#[tauri::command]
pub async fn desktop_sync(app: tauri::AppHandle, request: Request) -> Result<bool, String> {
    let state = app.state::<DesktopState>();
    let _operation = state.operations.lock().await;
    if request.frames.len() > 24 || request.gap > 64 {
        return Err("This foundation supports up to 24 windows per path.".into());
    }
    let previous = app
        .state::<DesktopState>()
        .request
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if previous
        .as_ref()
        .is_none_or(|old| old.browser_tabs != request.browser_tabs)
    {
        urls::retain(&app, &request.browser_tabs).await?;
    }
    if let Some(old) = previous
        .as_ref()
        .filter(|old| !needs_reconcile(old, &request))
    {
        for (before, frame) in old.frames.iter().zip(&request.frames) {
            if before.title != frame.title {
                if let Some(window) = app.get_window(&label(&app, &request, &frame.id)) {
                    window
                        .set_title(&format!("{} — canvas", frame.title))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        *app.state::<DesktopState>()
            .request
            .lock()
            .map_err(|e| e.to_string())? = Some(request);
        return Ok(state.prepared.lock().map_err(|e| e.to_string())?.is_none());
    }
    let main = app.get_window("main").ok_or("Main menu is unavailable")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    let primary = main
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| monitors.first().cloned())
        .ok_or("No display is available")?;
    let geometry = geometry::load(&app)?;
    let switched = previous
        .as_ref()
        .is_none_or(|old| old.scope != request.scope || old.namespace != request.namespace);
    let desired: Vec<_> = request
        .frames
        .iter()
        .map(|frame| label(&app, &request, &frame.id))
        .collect();
    if previous
        .as_ref()
        .is_some_and(|old| old.namespace != request.namespace)
    {
        let prepared = state.prepared.lock().map_err(|e| e.to_string())?.take();
        if let Some(prepared) = prepared {
            if let Some(window) = app.get_window(&prepared) {
                window.destroy().map_err(|e| e.to_string())?;
            }
        }
    }
    let prepared = state.prepared.lock().map_err(|e| e.to_string())?.clone();
    for (id, window) in app.windows() {
        if prepared.as_ref() == Some(&id) && !desired.contains(&id) {
            continue;
        }
        if id.starts_with("canvas-") && !desired.contains(&id) {
            if window.is_visible().unwrap_or(false) {
                geometry::remember(&window)?;
                window.hide().map_err(|e| e.to_string())?;
                kwin::forget(&id);
            }
            // Reuse canvases on return to a recent context, cap dormant webviews.
            if app.windows().len() > request.frames.len() + 10 && window.webviews().len() == 1 {
                urls::forget_window(&app, &id);
                window.destroy().map_err(|e| e.to_string())?;
            }
        }
    }
    let area = monitor_area(&primary);
    let scale = primary.scale_factor();
    let compact = matches!(request.menu.as_str(), "hidden" | "m0");
    let menu_width = if request.placement == "top" && compact {
        900.0_f64.min(area.width as f64 / scale - 32.0)
    } else if compact {
        76.0
    } else if request.placement == "top" {
        390.0
    } else {
        340.0
    };
    let menu_height = if request.placement == "top" && compact {
        100.0
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

    for (index, frame) in request.frames.iter().enumerate() {
        let key = frame_key(&request, &frame.id);
        let mut id = label(&app, &request, &frame.id);
        if app.get_window(&id).is_none() {
            let prepared = state.prepared.lock().map_err(|e| e.to_string())?.take();
            if let Some(prepared) = prepared {
                state
                    .labels
                    .lock()
                    .map_err(|e| e.to_string())?
                    .insert(key.clone(), prepared.clone());
                id = prepared;
            }
        }
        let window = if let Some(window) = app
            .get_window(&id)
            .filter(|_| geometry::bound_key(&app, &id).is_some())
        {
            window
        } else {
            let window = if let Some(window) = app.get_window(&id) {
                window
            } else {
                win(&build_surface(
                    &app,
                    &id,
                    &format!("{} — canvas", frame.title),
                    surface_url("canvas", &request.scope, &frame.id),
                    true,
                )?)
            };
            if let Some(saved) = geometry.get(&key) {
                geometry::restore(&window, saved, &monitors, &primary, (320.0, 240.0))?;
            } else {
                // New windows get a cascading placement without moving existing canvases.
                // The newly focused frame is this still-hidden window. Use the
                // previous focused canvas to select the user's current display.
                let focused = previous
                    .as_ref()
                    .filter(|_| !switched)
                    .and_then(|old| app.get_window(&label(&app, old, &old.focused)));
                let monitor = focused
                    .as_ref()
                    .and_then(|w| window_monitor(w, None).ok().flatten())
                    .or_else(|| window_monitor(&main, None).ok().flatten())
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
        if previous
            .as_ref()
            .and_then(|old| old.frames.iter().find(|f| f.id == frame.id))
            .is_none_or(|old| old.title != frame.title)
        {
            window
                .set_title(&format!("{} — canvas", frame.title))
                .map_err(|e| e.to_string())?;
        }
        if request.arrangement == "focus" && frame.id != request.focused && !frame.pinned {
            if window.is_visible().unwrap_or(false) {
                geometry::remember(&window)?;
                window.hide().map_err(|e| e.to_string())?;
                kwin::forget(&id);
            }
        } else {
            show_restored(&app, &window, &key, &monitors, &primary, (320.0, 240.0))?;
        }
        state
            .frames
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), frame.id.clone());
        let _ = app.emit_to(&id, "desktop:bind-frame", &frame.id);
        geometry::bind(&window, key)?;
    }
    if kwin::managed() {
        kwin::set_state(&main, Some(vec![]), None)?;
    }
    // KWin applies queued placement once the shown windows are mapped.
    let place_error = kwin::flush(&app).err();
    *app.state::<DesktopState>()
        .request
        .lock()
        .map_err(|e| e.to_string())? = Some(request.clone());
    // Pinned frames keep their monitor and bounds while following navigation.
    let rearrange = request.auto_tile
        && previous.as_ref().is_none_or(|old| {
            switched
                || old.arrangement != request.arrangement
                || old.gap != request.gap
                || old.menu != request.menu
                || old.placement != request.placement
                || old.auto_tile != request.auto_tile
                || old.toolbox_open != request.toolbox_open
                || old.frames.iter().map(|f| &f.id).collect::<Vec<_>>()
                    != request.frames.iter().map(|f| &f.id).collect::<Vec<_>>()
        });
    let tile_error = if rearrange {
        desktop_tile(app.clone()).await.err()
    } else {
        None
    };
    // A toolbox is its own webview and keeps its global applets across switches.
    let toolbox = if let Some(window) = app.get_window("toolbox") {
        window
    } else {
        win(&build_surface(
            &app,
            "toolbox",
            "Toolbox — canvas",
            surface_url("toolbox", "", ""),
            false,
        )?)
    };
    let focus_window = app.get_window(&label(&app, &request, &request.focused));
    let monitor = focus_window
        .as_ref()
        .and_then(|window| window_monitor(window, None).ok().flatten())
        .unwrap_or(primary);
    let toolbox_key = toolbox_key(&request);
    if geometry::bound_key(&app, "toolbox").as_ref() != Some(&toolbox_key) {
        geometry::unbind(&toolbox)?;
        if let Some(saved) = geometry::load(&app)?.get(&toolbox_key) {
            geometry::restore(&toolbox, saved, &monitors, &monitor, (60.0, 60.0))?;
        } else {
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
        show_restored(
            &app,
            &toolbox,
            &toolbox_key,
            &monitors,
            &monitor,
            (60.0, 60.0),
        )?;
    }
    kwin::flush(&app)?;
    if switched
        || previous
            .as_ref()
            .is_some_and(|old| old.focused != request.focused)
    {
        if let Some(window) = focus_window {
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }
    if let Some(error) = tile_error.or(place_error) {
        return Err(error);
    }
    let prepare = state.prepared.lock().map_err(|e| e.to_string())?.is_none();
    Ok(prepare)
}
/// One hidden, bootstrapped UI surface for the next frame that needs a renderer.
#[tauri::command]
pub async fn desktop_prepare(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    namespace: String,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Only the menu host prepares canvas windows".into());
    }
    let state = app.state::<DesktopState>();
    let _operation = state.operations.lock().await;
    let request = state
        .request
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No active desktop")?;
    if namespace != request.namespace {
        return Err("Desktop account changed".into());
    }
    if state.prepared.lock().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let id = format!("prepared-{}", state.sequence.fetch_add(1, Ordering::SeqCst));
    let label = frame_key(&request, &id);
    build_surface(
        &app,
        &label,
        "Canvas — canvas",
        surface_url("canvas", "", ""),
        true,
    )?;
    *state.prepared.lock().map_err(|e| e.to_string())? = Some(label);
    Ok(())
}
#[tauri::command]
pub fn desktop_frame(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<Option<String>, String> {
    if !webview.label().starts_with("canvas-") {
        return Err("Only canvas surfaces have a frame binding".into());
    }
    let state = app.state::<DesktopState>();
    let frame = state
        .frames
        .lock()
        .map_err(|e| e.to_string())?
        .get(webview.label())
        .cloned();
    Ok(frame)
}
#[cfg(feature = "desktop-smoke-test")]
pub(crate) fn geometry_key(app: &tauri::AppHandle, id: &str) -> Option<String> {
    geometry::bound_key(app, id)
}
#[cfg(feature = "desktop-smoke-test")]
pub(crate) fn is_prepared(app: &tauri::AppHandle, id: &str) -> bool {
    app.state::<DesktopState>()
        .prepared
        .lock()
        .ok()
        .is_some_and(|prepared| prepared.as_deref() == Some(id))
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
    let main = app.get_window("main").ok_or("Main menu is unavailable")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    // Resolve each window's output once, rather than once per output.
    let windows: Vec<_> = request
        .frames
        .iter()
        .filter(|frame| {
            !frame.pinned && (request.arrangement != "focus" || frame.id == request.focused)
        })
        .filter_map(|frame| app.get_window(&label(&app, &request, &frame.id)))
        .filter_map(|window| {
            window_monitor(&window, None)
                .ok()
                .flatten()
                .map(|monitor| (window, monitor))
        })
        .collect();
    if windows.is_empty() {
        return Ok(());
    }
    let menu = geometry::capture(&main)?.map(|g| g.rect);
    let pinned: Vec<_> = request
        .frames
        .iter()
        .filter(|frame| frame.pinned)
        .filter_map(|frame| app.get_window(&label(&app, &request, &frame.id)))
        .map(|window| geometry::capture(&window))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .map(|g| g.rect)
        .collect();
    let mut planned = Vec::new();
    for monitor in monitors {
        let windows: Vec<_> = windows
            .iter()
            .filter(|(_, output)| output.position() == monitor.position())
            .map(|(window, _)| window)
            .collect();
        if windows.is_empty() {
            continue;
        }
        let focused_label = label(&app, &request, &request.focused);
        let mut area = monitor_area(&monitor);
        let scale = monitor.scale_factor();
        // Reserve the menu's actual bounds, including manual moves and top placement.
        if let Some(menu) = menu {
            area = content_area(
                area,
                menu,
                request.placement == "top" && matches!(request.menu.as_str(), "hidden" | "m0"),
            );
        }
        for rect in &pinned {
            area = avoid(area, *rect);
        }
        let toolbox_space = if request.toolbox_open
            && windows.iter().any(|window| window.label() == focused_label)
        {
            (326.0 * scale) as u32
        } else {
            0
        };
        area.width = area.width.saturating_sub(toolbox_space);
        for (i, window) in windows.iter().enumerate() {
            let rect = tile_rect(
                area,
                i,
                windows.len(),
                request.arrangement == "grid",
                (request.gap as f64 * scale) as u32,
            );
            if rect.width < (320.0 * scale) as u32 || rect.height < (240.0 * scale) as u32 {
                return Err("Too many windows to tile on this display. Group canvases into tabs or move a window to another display.".into());
            }
            planned.push(((*window).clone(), rect));
        }
    }
    // Validate the whole layout before moving any window.
    for (window, rect) in &planned {
        if window.is_maximized().map_err(|e| e.to_string())? {
            window.unmaximize().map_err(|e| e.to_string())?;
        }
        if window.is_minimized().map_err(|e| e.to_string())? {
            window.unminimize().map_err(|e| e.to_string())?;
        }
        place(window, *rect)?;
    }
    // One KWin round trip for every tile, then record the resulting bounds.
    kwin::flush(&app)?;
    for (window, _) in &planned {
        geometry::remember(window)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_hide_surfaces(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let _operation = state.operations.lock().await;
    *state.prepared.lock().map_err(|e| e.to_string())? = None;
    geometry::save_all(&app)?;
    for window in app.windows().values() {
        geometry::unbind(window)?;
    }
    for (id, window) in app.windows() {
        if id.starts_with("canvas-") || id == "toolbox" {
            // Destruction clears rendered private content on logout.
            urls::forget_window(&app, &id);
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
pub async fn desktop_reveal_menu(app: tauri::AppHandle) -> Result<(), String> {
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
            .get_window("main")
            .and_then(|main| main.available_monitors().ok())
            .unwrap_or_default();
        let primary = app
            .get_window("main")
            .and_then(|main| main.primary_monitor().ok().flatten())
            .or_else(|| monitors.first().cloned());
        let reveal = |window: Window, key: &str, min: (f64, f64)| {
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
            if request.arrangement == "focus" && frame.id != request.focused && !frame.pinned {
                continue;
            }
            let id = label(&app, &request, &frame.id);
            if let Some(window) = app.get_window(&id) {
                reveal(window, &frame_key(&request, &frame.id), (320.0, 240.0));
            }
        }
        if let Some(toolbox) = app.get_window("toolbox") {
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
        let state = window.app_handle().state::<DesktopState>();
        if let Ok(mut labels) = state.labels.lock() {
            labels.retain(|_, physical| physical != id);
        }
        if let Ok(mut frames) = state.frames.lock() {
            frames.remove(id);
        }
        crate::tls::forget_window(window.app_handle(), id);
        geometry::forget(window.app_handle(), id);
        kwin::forget(id);
        urls::forget_window(window.app_handle(), id);
    }
    if matches!(event, tauri::WindowEvent::Resized(_)) {
        urls::relayout(window.app_handle(), id);
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
        } else if let Err(error) = geometry::remember(window) {
            geometry::report(window.app_handle(), error);
        }
    }
    if id.starts_with("canvas-") {
        // Only this window's host webview owns the frame these events concern.
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.app_handle().emit_to(id, "desktop:close", ());
            }
            tauri::WindowEvent::Focused(true) => {
                let _ = window.app_handle().emit_to(id, "desktop:focused", ());
            }
            _ => {}
        }
    }
}
pub fn run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    if matches!(event, tauri::RunEvent::Exit) {
        crate::terminal::shutdown(app);
        kwin::remove_shortcuts();
    }
    if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
        crate::terminal::shutdown(app);
        if let Err(error) = geometry::save_all(app) {
            geometry::report(app, error);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_and_ordinary_focus_do_not_reconcile_geometry() {
        let old: Request = serde_json::from_value(serde_json::json!({
            "browserTabs": [], "namespace": "account", "scope": "context", "frames": [
                {"id":"one", "kind":"content", "title":"Canvas", "pinned":false},
                {"id":"two", "kind":"content", "title":"Canvas", "pinned":false}
            ], "focused":"one", "arrangement":"columns", "gap":16,
            "autoTile":true, "placement":"left", "menu":"m2", "toolboxOpen":false
        }))
        .unwrap();
        let mut next = old.clone();
        next.frames[0].title = "Website".into();
        next.frames[0].kind = "browser".into();
        next.browser_tabs.push("page".into());
        next.focused = "two".into();
        assert!(!needs_reconcile(&old, &next));
        next.frames[0].pinned = true;
        assert!(needs_reconcile(&old, &next));
        next = old.clone();
        next.toolbox_open = true;
        assert!(needs_reconcile(&old, &next));
        next = old.clone();
        next.scope = "another context".into();
        assert!(needs_reconcile(&old, &next));
        let mut focus = old.clone();
        focus.arrangement = "focus".into();
        next = focus.clone();
        next.focused = "two".into();
        assert!(needs_reconcile(&focus, &next));
    }
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
    fn menu_and_pinned_bounds_reserve_only_their_own_output() {
        let area = Rect {
            x: 100,
            y: 30,
            width: 1600,
            height: 900,
        };
        let menu = Rect {
            x: 116,
            y: 54,
            width: 340,
            height: 740,
        };
        let content = content_area(area, menu, false);
        assert_eq!(content.x, 456);
        assert_eq!(content.width, 1244);
        assert_eq!(content_area(area, Rect { x: -1920, ..menu }, false), area);
        assert_eq!(content_area(area, Rect { height: 76, ..menu }, true).y, 130);
        let remaining = avoid(
            content,
            Rect {
                x: 1000,
                y: 30,
                width: 700,
                height: 900,
            },
        );
        assert_eq!(remaining.x + remaining.width as i32, 1000);
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
