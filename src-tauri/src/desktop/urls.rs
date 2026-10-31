//! Web pages inside a canvas window: one child webview per URL tab, shown
//! below the canvas chrome. These webviews are plain browsers with no IPC and
//! no Canvas credentials; they report titles and navigation back to the host
//! webview of their window, which owns the tab strip and the address bar.
//!
//! Linux packs child webviews into the window's vertical GTK box, so the
//! layout is "chrome on top, page below" by packing; other platforms place
//! the page by bounds.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Mutex};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window,
};

const CHROME_MIN: f64 = 40.0;
const CHROME_MAX: f64 = 400.0;

#[derive(Clone, Debug)]
struct Tab {
    window: String,
    visible: bool,
}
#[derive(Default)]
pub struct UrlState {
    operations: tauri::async_runtime::Mutex<()>,
    tabs: Mutex<BTreeMap<String, Tab>>,
    chrome: Mutex<BTreeMap<String, f64>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UrlEvent<'a> {
    tab: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
}

fn label(tab: &str) -> String {
    let identity = serde_json::to_vec(&tab).unwrap();
    let digest = Sha256::digest(identity);
    format!("url-{:x}", digest)[..20].to_string()
}

fn canvas_window(app: &tauri::AppHandle, label: &str) -> Result<Window, String> {
    if !label.starts_with("canvas-") {
        return Err("Web pages open inside canvas windows only.".into());
    }
    app.get_window(label)
        .ok_or("Canvas window is unavailable".into())
}

fn chrome_height(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(CHROME_MIN, CHROME_MAX)
    } else {
        CHROME_MIN
    }
}

fn owner(app: &tauri::AppHandle, tab: &str) -> Option<String> {
    app.state::<UrlState>()
        .tabs
        .lock()
        .ok()?
        .get(&label(tab))
        .map(|entry| entry.window.clone())
}
fn notify(app: &tauri::AppHandle, event: UrlEvent<'_>) {
    if let Some(window) = owner(app, event.tab) {
        let _ = app.emit_to(&window, "desktop:url", event);
    }
}

/// The shell model owns page lifetime, including tabs in dormant contexts.
pub(super) async fn retain(app: &tauri::AppHandle, tabs: &[String]) -> Result<(), String> {
    let state = app.state::<UrlState>();
    let _operation = state.operations.lock().await;
    let desired: std::collections::BTreeSet<_> = tabs.iter().map(|id| label(id)).collect();
    let removed: Vec<_> = state
        .tabs
        .lock()
        .map_err(|e| e.to_string())?
        .keys()
        .filter(|id| !desired.contains(*id))
        .cloned()
        .collect();
    for id in removed {
        close_registered_page(app, &id)?;
    }
    Ok(())
}

fn close_registered_page(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let window = app
        .state::<UrlState>()
        .tabs
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
        .map(|entry| entry.window);
    if let Some(view) = app.get_webview(id) {
        view.close().map_err(|e| e.to_string())?;
    }
    if let Some(window) = window {
        layout(app, &window)?;
    }
    Ok(())
}

/// Open or reuse the page webview of a tab. `chrome` is the logical height of
/// the host chrome (tab strip + address bar) the page must sit below.
#[tauri::command]
pub async fn desktop_url_open(
    app: tauri::AppHandle,
    window: String,
    tab: String,
    url: String,
    chrome: f64,
) -> Result<(), String> {
    let state = app.state::<UrlState>();
    let _operation = state.operations.lock().await;
    let target = crate::browser::browser_url(&url)?;
    let host = canvas_window(&app, &window)?;
    let id = label(&tab);
    state
        .chrome
        .lock()
        .map_err(|e| e.to_string())?
        .insert(window.clone(), chrome_height(chrome));
    if let Some(existing) = app.get_webview(&id) {
        let previous = owner(&app, &tab);
        let moving = previous.as_deref() != Some(&window);
        if moving {
            existing.reparent(&host).map_err(|e| e.to_string())?;
        }
        state.tabs.lock().map_err(|e| e.to_string())?.insert(
            id,
            Tab {
                window: window.clone(),
                visible: false,
            },
        );
        if let Some(previous) = previous.filter(|previous| previous != &window) {
            layout(&app, &previous)?;
        }
        if !moving && existing.url().map(|u| u != target).unwrap_or(true) {
            existing.navigate(target).map_err(|e| e.to_string())?;
        }
        return show(&app, &window, &tab, true);
    }
    let scale = host.scale_factor().map_err(|e| e.to_string())?;
    let size = host.inner_size().map_err(|e| e.to_string())?;
    let chrome = chrome_height(chrome);
    let events_tab = tab.clone();
    let title_tab = tab.clone();
    let (open_tab, open_app) = (tab.clone(), app.clone());
    let builder = WebviewBuilder::new(&id, WebviewUrl::External(target))
        .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
        .on_new_window(move |url, _features| {
            // target=_blank and window.open become a new tab in the same canvas.
            if matches!(url.scheme(), "http" | "https") {
                if let Some(window) = owner(&open_app, &open_tab) {
                    let _ = open_app.emit_to(
                        &window,
                        "desktop:url-open",
                        serde_json::json!({ "tab": open_tab, "url": url.to_string() }),
                    );
                }
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |webview, title| {
            notify(
                webview.app_handle(),
                UrlEvent {
                    tab: &title_tab,
                    url: None,
                    title: Some(title),
                    loading: None,
                },
            );
        })
        .on_page_load(move |webview, payload| {
            notify(
                webview.app_handle(),
                UrlEvent {
                    tab: &events_tab,
                    url: Some(payload.url().to_string()),
                    title: None,
                    loading: Some(matches!(payload.event(), PageLoadEvent::Started)),
                },
            );
        })
        .zoom_hotkeys_enabled(true);
    let builder = match crate::config::user_home() {
        // Site data lives apart from the Canvas session storage.
        Ok(home) => builder.data_directory(home.join("browser-profile")),
        Err(_) => builder,
    };
    let webview = host
        .add_child(
            builder,
            LogicalPosition::new(0.0, chrome),
            LogicalSize::new(
                size.width as f64 / scale,
                (size.height as f64 / scale - chrome).max(1.0),
            ),
        )
        .map_err(|e| e.to_string())?;
    if let Err(error) = crate::tls::install(&webview) {
        let _ = webview.close();
        return Err(error);
    }
    state.tabs.lock().map_err(|e| e.to_string())?.insert(
        id,
        Tab {
            window: window.clone(),
            visible: false,
        },
    );
    show(&app, &window, &tab, true)
}

#[tauri::command]
pub async fn desktop_url_show(
    app: tauri::AppHandle,
    window: String,
    tab: String,
    chrome: f64,
) -> Result<(), String> {
    let state = app.state::<UrlState>();
    let _operation = state.operations.lock().await;
    canvas_window(&app, &window)?;
    app.state::<UrlState>()
        .chrome
        .lock()
        .map_err(|e| e.to_string())?
        .insert(window.clone(), chrome_height(chrome));
    show(&app, &window, &tab, true)
}

#[tauri::command]
pub async fn desktop_url_hide(
    app: tauri::AppHandle,
    window: String,
    tab: String,
) -> Result<(), String> {
    let state = app.state::<UrlState>();
    let _operation = state.operations.lock().await;
    canvas_window(&app, &window)?;
    show(&app, &window, &tab, false)
}

#[cfg(feature = "desktop-smoke-test")]
pub(crate) async fn close_fixture_page(
    app: tauri::AppHandle,
    window: String,
    tab: String,
) -> Result<(), String> {
    let state = app.state::<UrlState>();
    let _operation = state.operations.lock().await;
    if owner(&app, &tab).as_deref() == Some(&window) {
        close_registered_page(&app, &label(&tab))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_url_action(
    app: tauri::AppHandle,
    window: String,
    tab: String,
    action: String,
) -> Result<(), String> {
    let state = app.state::<UrlState>();
    let _operation = state.operations.lock().await;
    canvas_window(&app, &window)?;
    let webview = app
        .get_webview(&label(&tab))
        .ok_or("This tab has no page yet")?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        _ => return Err("Unknown page action".into()),
    };
    webview.eval(script).map_err(|e| e.to_string())
}

fn set_visible(tabs: &mut BTreeMap<String, Tab>, window: &str, id: &str, visible: bool) -> bool {
    if !tabs.contains_key(id) {
        return false;
    }
    for (key, entry) in tabs.iter_mut() {
        if entry.window == window && (key == id || visible) {
            // Hiding a background tab must not hide the active page.
            entry.visible = key == id && visible;
        }
    }
    true
}

fn show(app: &tauri::AppHandle, window: &str, tab: &str, visible: bool) -> Result<(), String> {
    let id = label(tab);
    {
        let state = app.state::<UrlState>();
        let mut tabs = state.tabs.lock().map_err(|e| e.to_string())?;
        if !set_visible(&mut tabs, window, &id, visible) {
            return Ok(());
        }
    }
    layout(app, window)
}

/// Apply visibility and the chrome/page split for one window.
pub(super) fn layout(app: &tauri::AppHandle, window: &str) -> Result<(), String> {
    let Some(state) = app.try_state::<UrlState>() else {
        return Ok(());
    };
    let chrome = state
        .chrome
        .lock()
        .map_err(|e| e.to_string())?
        .get(window)
        .copied()
        .unwrap_or(CHROME_MIN);
    let tabs: Vec<(String, Tab)> = state
        .tabs
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|(_, tab)| tab.window == window)
        .map(|(id, tab)| (id.clone(), tab.clone()))
        .collect();
    let any_visible = tabs.iter().any(|(_, tab)| tab.visible);
    let Some(host) = app.get_window(window) else {
        return Ok(());
    };
    let scale = host.scale_factor().unwrap_or(1.0);
    let size = host.inner_size().map_err(|e| e.to_string())?;
    let page_height = (size.height as f64 / scale - chrome).max(1.0);
    let page_width = size.width as f64 / scale;
    if let Some(ui) = app.get_webview(window) {
        pack(&ui, !any_visible, chrome);
    }
    for (id, tab) in tabs {
        let Some(webview) = app.get_webview(&id) else {
            continue;
        };
        if tab.visible {
            pack(&webview, true, 0.0);
            #[cfg(not(target_os = "linux"))]
            webview
                .set_bounds(tauri_runtime::dpi::Rect {
                    position: LogicalPosition::new(0.0, chrome).into(),
                    size: LogicalSize::new(page_width, page_height).into(),
                })
                .map_err(|e| e.to_string())?;
            webview.show().map_err(|e| e.to_string())?;
        } else {
            webview.hide().map_err(|e| e.to_string())?;
        }
    }
    let _ = (page_width, page_height);
    Ok(())
}

/// Linux: the window's vertical GTK box decides the split. A non-expanding
/// chrome webview with a fixed height request leaves the rest to the page.
#[cfg(target_os = "linux")]
fn pack(webview: &Webview, expand: bool, height: f64) {
    use gtk::prelude::{BoxExt, Cast, WidgetExt};
    let _ = webview.with_webview(move |platform| {
        let view = platform.inner();
        if let Some(parent) = view.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) {
            parent.set_child_packing(&view, expand, true, 0, gtk::PackType::Start);
        }
        view.set_size_request(-1, if expand { -1 } else { height.round() as i32 });
    });
}
#[cfg(not(target_os = "linux"))]
fn pack(_webview: &Webview, _expand: bool, _height: f64) {}

/// Window resized: re-apply bounds where the platform does not reflow.
pub(super) fn relayout(app: &tauri::AppHandle, window: &str) {
    if !window.starts_with("canvas-") {
        return;
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = layout(app, window);
    }
    let _ = (app, window);
}

pub(super) fn forget_window(app: &tauri::AppHandle, window: &str) {
    // Hosts without page tabs (fixtures) never manage this state.
    let Some(state) = app.try_state::<UrlState>() else {
        return;
    };
    if let Ok(mut tabs) = state.tabs.lock() {
        tabs.retain(|_, tab| tab.window != window);
    }
    if let Ok(mut chrome) = state.chrome.lock() {
        chrome.remove(window);
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn page_labels_are_short_stable_and_never_canvas_labels() {
        let a = label("tab-1");
        assert_eq!(a, label("tab-1"));
        assert_ne!(a, label("tab-2"));
        assert!(a.starts_with("url-") && a.len() == 20);
    }
    #[test]
    fn hiding_a_background_page_preserves_the_active_page_and_other_windows() {
        let mut tabs = BTreeMap::from([
            (
                "a".into(),
                Tab {
                    window: "one".into(),
                    visible: true,
                },
            ),
            (
                "b".into(),
                Tab {
                    window: "one".into(),
                    visible: false,
                },
            ),
            (
                "c".into(),
                Tab {
                    window: "two".into(),
                    visible: true,
                },
            ),
        ]);
        assert!(set_visible(&mut tabs, "one", "b", false));
        assert!(tabs["a"].visible && tabs["c"].visible);
        assert!(set_visible(&mut tabs, "one", "b", true));
        assert!(!tabs["a"].visible && tabs["b"].visible && tabs["c"].visible);
        assert!(!set_visible(&mut tabs, "one", "missing", true));
        assert!(tabs["b"].visible);
    }
    #[test]
    fn chrome_height_is_bounded() {
        assert_eq!(chrome_height(f64::NAN), CHROME_MIN);
        assert_eq!(chrome_height(10.0), CHROME_MIN);
        assert_eq!(chrome_height(96.5), 96.5);
        assert_eq!(chrome_height(5000.0), CHROME_MAX);
    }
}
