//! Local window state, independent of webview timers and the server.
use super::{monitor_area, place, DesktopState, Rect};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewWindow};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct Geometry {
    pub rect: Rect,
    monitor: Option<String>,
    maximized: bool,
    // Optional additions keep the original version-1 layout file readable.
    #[serde(default)]
    work_area: Option<Rect>,
    #[serde(default)]
    scale: Option<f64>,
}

#[derive(Default)]
pub(super) struct GeometryState {
    windows: Mutex<Option<BTreeMap<String, Geometry>>>,
    bindings: Mutex<BTreeMap<String, String>>,
    revision: AtomicU64,
    persisted: AtomicU64,
    writer_running: AtomicBool,
}

fn path() -> Result<std::path::PathBuf, String> {
    Ok(crate::config::user_home()?.join("config/desktop-windows.json"))
}

pub(super) fn load(app: &tauri::AppHandle) -> Result<BTreeMap<String, Geometry>, String> {
    let state = app.state::<DesktopState>();
    let mut windows = state.geometry.windows.lock().map_err(|e| e.to_string())?;
    if windows.is_none() {
        let raw = crate::config::read(&path()?)?;
        *windows = Some(if raw == serde_json::json!({}) {
            BTreeMap::new()
        } else {
            if raw["version"] != 1 {
                return Err(
                    "Unsupported native window layout version; saved geometry was left untouched."
                        .into(),
                );
            }
            serde_json::from_value(raw["windows"].clone())
                .map_err(|e| format!("Invalid saved window geometry: {e}"))?
        });
    }
    Ok(windows.as_ref().unwrap().clone())
}

pub(super) fn capture(window: &WebviewWindow) -> Result<Geometry, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?;
    Ok(Geometry {
        rect: Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        monitor: monitor.as_ref().and_then(|m| m.name().cloned()),
        maximized: window.is_maximized().map_err(|e| e.to_string())?,
        work_area: monitor.as_ref().map(monitor_area),
        scale: Some(window.scale_factor().map_err(|e| e.to_string())?),
    })
}

pub(super) fn bound_key(app: &tauri::AppHandle, label: &str) -> Option<String> {
    app.state::<DesktopState>()
        .geometry
        .bindings
        .lock()
        .ok()?
        .get(label)
        .cloned()
}

pub(super) fn bind(window: &WebviewWindow, key: String) -> Result<(), String> {
    window
        .app_handle()
        .state::<DesktopState>()
        .geometry
        .bindings
        .lock()
        .map_err(|e| e.to_string())?
        .insert(window.label().into(), key);
    remember(window)
}

pub(super) fn unbind(window: &WebviewWindow) -> Result<(), String> {
    remember(window)?;
    forget(window.app_handle(), window.label());
    Ok(())
}

pub(super) fn forget(app: &tauri::AppHandle, label: &str) {
    if let Ok(mut bindings) = app.state::<DesktopState>().geometry.bindings.lock() {
        bindings.remove(label);
    }
}

fn merge_normal_bounds(old: Option<&Geometry>, next: Geometry) -> Geometry {
    if next.maximized {
        if let Some(old) = old {
            // A maximized window can be sent to another display by the WM.
            // Keep its normal size/offset, but restore it on that new display.
            if let Some(area) = next.work_area {
                return Geometry {
                    rect: remap(old, area, next.scale.or(old.scale).unwrap_or(1.0)),
                    ..next
                };
            }
            return Geometry {
                maximized: true,
                ..old.clone()
            };
        }
    }
    next
}

pub(super) fn remember(window: &WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let Some(key) = bound_key(app, window.label()) else {
        return Ok(());
    };
    // Minimized/fullscreen/hidden bounds are not the user's normal placement.
    if !window.is_visible().map_err(|e| e.to_string())?
        || window.is_minimized().map_err(|e| e.to_string())?
        || window.is_fullscreen().map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    // Never hold a state lock while asking the UI thread for native geometry.
    let next = capture(window)?;
    if next.rect.width == 0 || next.rect.height == 0 {
        return Ok(());
    }
    let state = app.state::<DesktopState>();
    let bindings = state.geometry.bindings.lock().map_err(|e| e.to_string())?;
    if bindings.get(window.label()) != Some(&key) {
        return Ok(());
    }
    let mut geometry = state.geometry.windows.lock().map_err(|e| e.to_string())?;
    let windows = geometry
        .as_mut()
        .ok_or("Window layout has not been loaded")?;
    let next = merge_normal_bounds(windows.get(&key), next);
    if windows.get(&key) == Some(&next) {
        return Ok(());
    }
    windows.insert(key, next);
    state.geometry.revision.fetch_add(1, Ordering::SeqCst);
    drop(geometry);
    drop(bindings);
    schedule_write(app);
    Ok(())
}

fn schedule_write(app: &tauri::AppHandle) {
    if app
        .state::<DesktopState>()
        .geometry
        .writer_running
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<DesktopState>();
        let mut revision = state.geometry.revision.load(Ordering::SeqCst);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let current = state.geometry.revision.load(Ordering::SeqCst);
            if current != revision {
                revision = current;
                continue;
            }
            let result = flush(&app);
            state.geometry.writer_running.store(false, Ordering::SeqCst);
            if let Err(error) = result {
                report(&app, error);
            } else if state.geometry.revision.load(Ordering::SeqCst)
                != state.geometry.persisted.load(Ordering::SeqCst)
            {
                schedule_write(&app);
            }
            break;
        }
    });
}

fn flush(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    // Serialize writes, but release the in-memory lock before any disk I/O.
    let _lock = crate::config::CONFIG_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let geometry = state.geometry.windows.lock().map_err(|e| e.to_string())?;
    let revision = state.geometry.revision.load(Ordering::SeqCst);
    if revision == state.geometry.persisted.load(Ordering::SeqCst) {
        return Ok(());
    }
    let Some(windows) = geometry.as_ref().cloned() else {
        return Ok(());
    };
    drop(geometry);
    crate::config::write(
        &path()?,
        &serde_json::json!({ "version": 1, "windows": windows }),
    )?;
    state.geometry.persisted.store(revision, Ordering::SeqCst);
    Ok(())
}

pub(super) fn save_all(app: &tauri::AppHandle) -> Result<(), String> {
    for window in app.webview_windows().values() {
        remember(window)?;
    }
    flush(app)
}

pub(super) fn report(app: &tauri::AppHandle, error: String) {
    let error = format!("Could not save the desktop window layout: {error}");
    eprintln!("{error}");
    let _ = app.emit_to("main", "desktop:error", error);
}

fn remap(saved: &Geometry, area: Rect, scale: f64) -> Rect {
    let ratio = saved
        .scale
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| scale / v)
        .unwrap_or(1.0);
    let origin = saved.work_area.unwrap_or(area);
    Rect {
        x: area
            .x
            .saturating_add(((saved.rect.x as f64 - origin.x as f64) * ratio).round() as i32),
        y: area
            .y
            .saturating_add(((saved.rect.y as f64 - origin.y as f64) * ratio).round() as i32),
        width: (saved.rect.width as f64 * ratio).round() as u32,
        height: (saved.rect.height as f64 * ratio).round() as u32,
    }
}

pub(super) fn fit(rect: Rect, area: Rect, min: (u32, u32)) -> Rect {
    let width = rect.width.max(min.0).min(area.width);
    let height = rect.height.max(min.1).min(area.height);
    Rect {
        x: rect
            .x
            .max(area.x)
            .min(area.x.saturating_add((area.width - width) as i32)),
        y: rect
            .y
            .max(area.y)
            .min(area.y.saturating_add((area.height - height) as i32)),
        width,
        height,
    }
}

pub(super) fn restore(
    window: &WebviewWindow,
    saved: &Geometry,
    monitors: &[tauri::Monitor],
    primary: &tauri::Monitor,
    min: (f64, f64),
) -> Result<(), String> {
    let monitor = monitors
        .iter()
        .find(|m| saved.monitor.is_some() && m.name() == saved.monitor.as_ref())
        .or_else(|| {
            monitors
                .iter()
                .find(|m| Some(monitor_area(m)) == saved.work_area)
        })
        .unwrap_or(primary);
    let scale = monitor.scale_factor();
    let mut area = monitor_area(monitor);
    // Positions are outer bounds; sizes are client bounds. Leave room for OS decorations.
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    area.width = area
        .width
        .saturating_sub(outer.width.saturating_sub(inner.width));
    area.height = area
        .height
        .saturating_sub(outer.height.saturating_sub(inner.height));
    let rect = fit(
        remap(saved, monitor_area(monitor), scale),
        area,
        ((min.0 * scale) as u32, (min.1 * scale) as u32),
    );
    window.unmaximize().map_err(|e| e.to_string())?;
    place(window, rect)?;
    if saved.maximized {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn saved() -> Geometry {
        Geometry {
            rect: Rect {
                x: -1800,
                y: 80,
                width: 900,
                height: 700,
            },
            monitor: Some("left".into()),
            maximized: false,
            work_area: Some(Rect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
            }),
            scale: Some(1.0),
        }
    }
    #[test]
    fn monitor_origin_and_dpi_changes_preserve_logical_placement() {
        let area = Rect {
            x: 0,
            y: 30,
            width: 3840,
            height: 2130,
        };
        assert_eq!(
            remap(&saved(), area, 2.0),
            Rect {
                x: 240,
                y: 190,
                width: 1800,
                height: 1400
            }
        );
        let area = Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        };
        assert_eq!(
            fit(remap(&saved(), area, 1.0), area, (320, 240)),
            Rect {
                x: 120,
                y: 20,
                width: 900,
                height: 700
            }
        );
    }
    #[test]
    fn original_layout_files_keep_their_physical_bounds() {
        let legacy: Geometry = serde_json::from_value(serde_json::json!({"rect":{"x":100,"y":80,"width":900,"height":700},"monitor":"Display","maximized":false})).unwrap();
        assert_eq!(
            remap(
                &legacy,
                Rect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080
                },
                2.0
            ),
            legacy.rect
        );
    }
    #[test]
    fn maximize_preserves_normal_bounds_and_restore_updates_them() {
        let normal = saved();
        let maximized = Geometry {
            rect: normal.work_area.unwrap(),
            maximized: true,
            ..normal.clone()
        };
        let merged = merge_normal_bounds(Some(&normal), maximized);
        assert_eq!(merged.rect, normal.rect);
        assert!(merged.maximized);
        assert_eq!(merge_normal_bounds(Some(&merged), normal.clone()), normal);
    }
    #[test]
    fn moving_a_maximized_window_remembers_its_new_display() {
        let old = saved();
        let area = Rect {
            x: 0,
            y: 0,
            width: 3840,
            height: 2160,
        };
        let next = Geometry {
            rect: area,
            work_area: Some(area),
            scale: Some(2.0),
            monitor: Some("right".into()),
            maximized: true,
        };
        let merged = merge_normal_bounds(Some(&old), next);
        assert_eq!(merged.monitor.as_deref(), Some("right"));
        assert_eq!(
            merged.rect,
            Rect {
                x: 240,
                y: 160,
                width: 1800,
                height: 1400
            }
        );
        assert!(merged.maximized);
    }
    #[test]
    fn small_controls_remain_small_and_clamp_all_edges() {
        let area = Rect {
            x: -1920,
            y: 20,
            width: 1920,
            height: 1060,
        };
        let rect = Rect {
            x: -20,
            y: -40,
            width: 64,
            height: 64,
        };
        assert_eq!(
            fit(rect, area, (60, 60)),
            Rect {
                x: -64,
                y: 20,
                width: 64,
                height: 64
            }
        );
    }
}
