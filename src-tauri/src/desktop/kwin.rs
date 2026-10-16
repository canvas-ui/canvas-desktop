//! KDE Plasma bridge. No toolkit exposes virtual desktops, and on Wayland GTK
//! can neither read nor set a toplevel's position. KWin's scripting interface
//! on the session bus does both, for X11 and Wayland windows alike. Each call
//! loads a tiny script that reports back to this process over DBus.
use super::Rect;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};

const PATH: &str = "/com/idncstreams/desktop/kwin";
const IFACE: &str = "com.idncstreams.desktop.KWin";
const REPORT_TTL: Duration = Duration::from_millis(80);
const SCRIPT_TIMEOUT: Duration = Duration::from_millis(2500);
const MAP_TIMEOUT: Duration = Duration::from_millis(700);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct VirtualDesktop {
    pub id: String,
    pub number: u32,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
struct OutputInfo {
    name: String,
    x: f64,
    y: f64,
}
#[derive(Clone, Debug, Deserialize)]
struct WindowInfo {
    id: String,
    caption: String,
    frame: [f64; 4],
    client: [f64; 4],
    output: Option<OutputInfo>,
    all: bool,
    minimized: bool,
    desktops: Vec<VirtualDesktop>,
}
#[derive(Clone, Debug, Deserialize)]
struct Report {
    windows: Vec<WindowInfo>,
    desktops: Vec<VirtualDesktop>,
    #[allow(dead_code)]
    current: String,
}
#[derive(Deserialize)]
struct Failure {
    error: Option<String>,
}

/// What KWin knows about one of our windows, in physical pixels like Tauri.
pub(super) struct Info {
    pub rect: Rect,
    pub output: Option<String>,
    /// Logical top-left of the output, matched against monitor positions.
    pub output_origin: Option<(f64, f64)>,
    pub minimized: bool,
    /// `Some(vec![])` means the window is on every desktop.
    pub desktops: Option<Vec<VirtualDesktop>>,
}

#[derive(Clone, Debug, Default, Serialize)]
struct Frame {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}
#[derive(Clone, Debug, Default, Serialize)]
struct Pending {
    #[serde(skip_serializing_if = "Option::is_none")]
    frame: Option<Frame>,
    #[serde(skip_serializing_if = "Option::is_none")]
    desktops: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maximized: Option<bool>,
}
#[derive(Serialize)]
struct Op<'a> {
    id: &'a str,
    #[serde(flatten)]
    pending: &'a Pending,
}

type Results = Arc<(Mutex<HashMap<String, String>>, Condvar)>;
struct Receiver {
    results: Results,
}
#[zbus::interface(name = "com.idncstreams.desktop.KWin")]
impl Receiver {
    fn report(&self, token: String, payload: String) {
        let (lock, ready) = &*self.results;
        if let Ok(mut results) = lock.lock() {
            results.insert(token, payload);
        }
        ready.notify_all();
    }
}

struct Bridge {
    conn: zbus::blocking::Connection,
    service: String,
    results: Results,
    run: Mutex<()>,
    seq: AtomicU64,
}
static BRIDGE: OnceLock<Option<Bridge>> = OnceLock::new();
static WAYLAND: OnceLock<bool> = OnceLock::new();
static IDS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
static PENDING: Mutex<BTreeMap<String, Pending>> = Mutex::new(BTreeMap::new());
static CACHE: Mutex<Option<(Instant, Arc<Report>)>> = Mutex::new(None);

/// Detect the GDK backend on the main thread before any window work.
pub(super) fn init() {
    use glib::object::ObjectExt;
    let wayland = gdk::Display::default()
        .map(|display| display.type_().name() == "GdkWaylandDisplay")
        .unwrap_or_else(wayland_env);
    let _ = WAYLAND.set(wayland);
}

fn wayland_env() -> bool {
    match std::env::var("GDK_BACKEND") {
        Ok(backend) => backend
            .split(',')
            .next()
            .is_some_and(|first| first.trim() == "wayland"),
        Err(_) => std::env::var_os("WAYLAND_DISPLAY").is_some(),
    }
}

fn connect() -> Result<Bridge, String> {
    if std::env::var("CANVAS_DESKTOP_KWIN").as_deref() == Ok("0") {
        return Err("disabled by CANVAS_DESKTOP_KWIN=0".into());
    }
    let conn = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let present: bool = conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "NameHasOwner",
            &("org.kde.KWin",),
        )
        .map_err(|e| e.to_string())?
        .body()
        .deserialize()
        .map_err(|e| e.to_string())?;
    if !present {
        return Err("KWin is not on the session bus".into());
    }
    let results: Results = Arc::new((Mutex::new(HashMap::new()), Condvar::new()));
    conn.object_server()
        .at(
            PATH,
            Receiver {
                results: results.clone(),
            },
        )
        .map_err(|e| e.to_string())?;
    let service = conn
        .unique_name()
        .ok_or("no unique bus name")?
        .to_string();
    Ok(Bridge {
        conn,
        service,
        results,
        run: Mutex::new(()),
        seq: AtomicU64::new(0),
    })
}

fn bridge() -> Option<&'static Bridge> {
    BRIDGE
        .get_or_init(|| match connect() {
            Ok(bridge) => Some(bridge),
            Err(error) => {
                eprintln!("KWin integration unavailable: {error}");
                None
            }
        })
        .as_ref()
}

/// KWin is reachable: virtual desktops can be saved and restored.
pub(super) fn managed() -> bool {
    bridge().is_some()
}

/// KWin is reachable and GTK runs on Wayland: placement must go through KWin.
pub(super) fn wayland_managed() -> bool {
    *WAYLAND.get_or_init(wayland_env) && managed()
}

fn script_dir() -> std::path::PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(std::env::temp_dir)
}

fn run_script(bridge: &Bridge, body: &str) -> Result<String, String> {
    let _serial = bridge.run.lock().map_err(|e| e.to_string())?;
    let token = format!(
        "{}-{}",
        std::process::id(),
        bridge.seq.fetch_add(1, Ordering::SeqCst)
    );
    let plugin = format!("canvas-desktop-{token}");
    let path = script_dir().join(format!("{plugin}.js"));
    let report = format!(
        "callDBus({}, {}, {}, \"Report\", {}, ",
        serde_json::json!(bridge.service),
        serde_json::json!(PATH),
        serde_json::json!(IFACE),
        serde_json::json!(token)
    );
    let source = body.replace("__REPORT__(", &report);
    std::fs::write(&path, source).map_err(|e| format!("{}: {e}", path.display()))?;
    let result = (|| {
        let load = |bridge: &Bridge| -> Result<i32, String> {
            bridge
                .conn
                .call_method(
                    Some("org.kde.KWin"),
                    "/Scripting",
                    Some("org.kde.kwin.Scripting"),
                    "loadScript",
                    &(path.to_string_lossy().as_ref(), plugin.as_str()),
                )
                .map_err(|e| e.to_string())?
                .body()
                .deserialize()
                .map_err(|e| e.to_string())
        };
        let mut id = load(bridge)?;
        if id < 0 {
            unload(bridge, &plugin);
            id = load(bridge)?;
        }
        if id < 0 {
            return Err("KWin refused to load the script".into());
        }
        bridge
            .conn
            .call_method(
                Some("org.kde.KWin"),
                format!("/Scripting/Script{id}"),
                Some("org.kde.kwin.Script"),
                "run",
                &(),
            )
            .map_err(|e| e.to_string())?;
        let (lock, ready) = &*bridge.results;
        let guard = lock.lock().map_err(|e| e.to_string())?;
        let (mut results, _) = ready
            .wait_timeout_while(guard, SCRIPT_TIMEOUT, |results| !results.contains_key(&token))
            .map_err(|e| e.to_string())?;
        results
            .remove(&token)
            .ok_or_else(|| "KWin script did not report back".to_string())
    })();
    unload(bridge, &plugin);
    let _ = std::fs::remove_file(&path);
    let payload = result?;
    if let Ok(Failure { error: Some(error) }) = serde_json::from_str::<Failure>(&payload) {
        return Err(format!("KWin script failed: {error}"));
    }
    Ok(payload)
}

fn unload(bridge: &Bridge, plugin: &str) {
    let _ = bridge.conn.call_method(
        Some("org.kde.KWin"),
        "/Scripting",
        Some("org.kde.kwin.Scripting"),
        "unloadScript",
        &(plugin,),
    );
}

const REPORT_SCRIPT: &str = r#"(function () {
  let result;
  try {
    const pid = __PID__;
    const desktop = d => ({ id: d.id, number: d.x11DesktopNumber, name: d.name });
    const windows = [];
    for (const w of workspace.windowList()) {
      if (w.pid !== pid) continue;
      const f = w.frameGeometry, c = w.clientGeometry;
      let output = null;
      try { if (w.output) output = { name: w.output.name, x: w.output.geometry.x, y: w.output.geometry.y }; } catch (e) {}
      windows.push({
        id: String(w.internalId), caption: w.caption,
        frame: [f.x, f.y, f.width, f.height], client: [c.x, c.y, c.width, c.height],
        output, all: w.onAllDesktops, minimized: w.minimized,
        desktops: w.desktops.map(desktop)
      });
    }
    result = { windows, desktops: workspace.desktops.map(desktop), current: workspace.currentDesktop.id };
  } catch (e) { result = { error: String(e) }; }
  __REPORT__(JSON.stringify(result));
})();
"#;

const APPLY_SCRIPT: &str = r#"(function () {
  let result;
  try {
    const ops = __OPS__;
    const by = {};
    for (const op of ops) by[op.id] = op;
    const applied = [], errors = [];
    for (const w of workspace.windowList()) {
      const op = by[String(w.internalId)];
      if (!op) continue;
      try {
        if (op.desktops) {
          if (op.desktops.length === 0) w.onAllDesktops = true;
          else {
            const ds = workspace.desktops.filter(d => op.desktops.indexOf(d.id) >= 0);
            if (ds.length) w.desktops = ds;
          }
        }
        if (op.maximized === false) w.setMaximize(false, false);
        if (op.frame) {
          const f = w.frameGeometry, c = w.clientGeometry;
          w.frameGeometry = { x: op.frame.x, y: op.frame.y,
            width: op.frame.width + (f.width - c.width), height: op.frame.height + (f.height - c.height) };
        }
        if (op.maximized === true) w.setMaximize(true, true);
        applied.push(op.id);
      } catch (e) { errors.push(op.id + ": " + String(e)); }
    }
    result = { applied, errors };
  } catch (e) { result = { error: String(e) }; }
  __REPORT__(JSON.stringify(result));
})();
"#;

fn report(fresh: bool) -> Result<Arc<Report>, String> {
    let bridge = bridge().ok_or("KWin is unavailable")?;
    if !fresh {
        if let Ok(cache) = CACHE.lock() {
            if let Some((at, report)) = cache.as_ref() {
                if at.elapsed() < REPORT_TTL {
                    return Ok(report.clone());
                }
            }
        }
    }
    let payload = run_script(
        bridge,
        &REPORT_SCRIPT.replace("__PID__", &std::process::id().to_string()),
    )?;
    let report: Arc<Report> = Arc::new(
        serde_json::from_str(&payload).map_err(|e| format!("Unreadable KWin report: {e}"))?,
    );
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), report.clone()));
    }
    Ok(report)
}

fn invalidate() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

/// Resolve our window to KWin's id. Windows are matched by pid and caption;
/// when several share a caption the window briefly carries a unique title.
/// The match is cached until the window is unmapped.
fn identify(window: &WebviewWindow, report: &Report) -> Option<String> {
    let label = window.label().to_string();
    // Query the window first: never hold a bridge lock across a main-thread call.
    let title = window.title().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0).max(0.01);
    let size = window
        .inner_size()
        .ok()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale));
    let candidates: Vec<String> = {
        let mut ids = IDS.lock().ok()?;
        if let Some(id) = ids.get(&label) {
            if report.windows.iter().any(|w| &w.id == id) {
                return Some(id.clone());
            }
            ids.remove(&label);
        }
        let claimed: HashSet<&String> = ids.values().collect();
        let mut candidates: Vec<&WindowInfo> = report
            .windows
            .iter()
            .filter(|w| !claimed.contains(&w.id) && w.caption == title)
            .collect();
        if let Some((width, height)) = size {
            candidates.sort_by(|a, b| {
                let d = |w: &WindowInfo| {
                    (w.client[2] - width).abs() + (w.client[3] - height).abs()
                };
                d(a).total_cmp(&d(b))
            });
        }
        candidates.into_iter().map(|w| w.id.clone()).collect()
    };
    let id = match candidates.len() {
        0 => return None,
        1 => candidates[0].clone(),
        _ => probe(window, &title).or_else(|| candidates.first().cloned())?,
    };
    IDS.lock().ok()?.insert(label, id.clone());
    Some(id)
}

/// Tell identical captions apart with a momentary unique title.
fn probe(window: &WebviewWindow, title: &str) -> Option<String> {
    let nonce = format!(
        "{title} \u{2063}{}",
        bridge()?.seq.fetch_add(1, Ordering::SeqCst)
    );
    window.set_title(&nonce).ok()?;
    let mut found = None;
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(15));
        if let Ok(report) = report(true) {
            found = report
                .windows
                .iter()
                .find(|w| w.caption == nonce)
                .map(|w| w.id.clone());
            if found.is_some() {
                break;
            }
        }
    }
    let _ = window.set_title(title);
    found
}

/// Drop cached identity and queued work; KWin treats a re-mapped window as new.
pub(super) fn forget(label: &str) {
    if let Ok(mut ids) = IDS.lock() {
        ids.remove(label);
    }
    if let Ok(mut pending) = PENDING.lock() {
        pending.remove(label);
    }
}

/// None when KWin does not (yet) list the window, e.g. before it is mapped.
pub(super) fn info(window: &WebviewWindow) -> Result<Option<Info>, String> {
    if !managed() {
        return Ok(None);
    }
    let report = report(false)?;
    let Some(id) = identify(window, &report) else {
        return Ok(None);
    };
    let Some(w) = report.windows.iter().find(|w| w.id == id) else {
        return Ok(None);
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    Ok(Some(Info {
        rect: Rect {
            x: (w.frame[0] * scale).round() as i32,
            y: (w.frame[1] * scale).round() as i32,
            width: (w.client[2] * scale).round().max(0.0) as u32,
            height: (w.client[3] * scale).round().max(0.0) as u32,
        },
        output: w.output.as_ref().map(|o| o.name.clone()),
        output_origin: w.output.as_ref().map(|o| (o.x, o.y)),
        minimized: w.minimized,
        desktops: Some(if w.all { vec![] } else { w.desktops.clone() }),
    }))
}

pub(super) fn desktops() -> Result<Vec<VirtualDesktop>, String> {
    Ok(report(false)?.desktops.clone())
}

/// Saved desktops map by id, then by position for recreated desktops.
pub(super) fn resolve_desktops(
    saved: &[VirtualDesktop],
    available: &[VirtualDesktop],
) -> Vec<String> {
    let mut ids = Vec::new();
    for desktop in saved {
        let found = available
            .iter()
            .find(|d| d.id == desktop.id)
            .or_else(|| available.iter().find(|d| d.number == desktop.number));
        if let Some(found) = found {
            if !ids.contains(&found.id) {
                ids.push(found.id.clone());
            }
        }
    }
    ids
}

fn queue(window: &WebviewWindow, update: impl FnOnce(&mut Pending)) -> Result<(), String> {
    let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
    update(pending.entry(window.label().to_string()).or_default());
    Ok(())
}

/// Queue a placement: outer position and client size in physical pixels.
pub(super) fn place(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?.max(0.01);
    let frame = Frame {
        x: (rect.x as f64 / scale).round() as i32,
        y: (rect.y as f64 / scale).round() as i32,
        width: (rect.width as f64 / scale).round() as i32,
        height: (rect.height as f64 / scale).round() as i32,
    };
    queue(window, |p| p.frame = Some(frame))
}

/// Queue desktop membership (empty = all desktops) and/or maximized state.
pub(super) fn set_state(
    window: &WebviewWindow,
    desktops: Option<Vec<String>>,
    maximized: Option<bool>,
) -> Result<(), String> {
    queue(window, |p| {
        if desktops.is_some() {
            p.desktops = desktops;
        }
        if maximized.is_some() {
            p.maximized = maximized;
        }
    })
}

/// Apply queued work once KWin lists the windows. Call after showing them.
pub(super) fn flush(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(bridge) = bridge() else {
        return Ok(());
    };
    let mut remaining: BTreeMap<String, Pending> = {
        let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
        std::mem::take(&mut *pending)
    };
    if remaining.is_empty() {
        return Ok(());
    }
    let deadline = Instant::now() + MAP_TIMEOUT;
    let mut ops: Vec<(String, Pending)> = Vec::new();
    loop {
        let report = report(true)?;
        let labels: Vec<String> = remaining.keys().cloned().collect();
        for label in labels {
            let Some(window) = app.get_webview_window(&label) else {
                remaining.remove(&label);
                continue;
            };
            if !window.is_visible().unwrap_or(false) {
                // Hidden again before it was mapped; nothing to place.
                remaining.remove(&label);
                continue;
            }
            if let Some(id) = identify(&window, &report) {
                ops.push((id, remaining.remove(&label).unwrap()));
            }
        }
        if remaining.is_empty() || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !remaining.is_empty() {
        eprintln!(
            "KWin did not list {} window(s) in time; their placement was skipped.",
            remaining.len()
        );
    }
    if ops.is_empty() {
        return Ok(());
    }
    let ops: Vec<Op> = ops
        .iter()
        .map(|(id, pending)| Op { id, pending })
        .collect();
    let script = APPLY_SCRIPT.replace(
        "__OPS__",
        &serde_json::to_string(&ops).map_err(|e| e.to_string())?,
    );
    let payload = run_script(bridge, &script);
    invalidate();
    let payload = payload?;
    #[derive(Deserialize)]
    struct Applied {
        #[serde(default)]
        errors: Vec<String>,
    }
    if let Ok(Applied { errors }) = serde_json::from_str::<Applied>(&payload) {
        if !errors.is_empty() {
            return Err(format!("KWin could not place: {}", errors.join("; ")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d(id: &str, number: u32) -> VirtualDesktop {
        VirtualDesktop {
            id: id.into(),
            number,
            name: format!("Desktop {number}"),
        }
    }
    #[test]
    fn desktops_resolve_by_id_then_position_and_vanish_when_gone() {
        let available = vec![d("a", 1), d("b", 2), d("c", 3)];
        assert_eq!(resolve_desktops(&[d("c", 1)], &available), vec!["c"]);
        assert_eq!(resolve_desktops(&[d("old", 2)], &available), vec!["b"]);
        assert!(resolve_desktops(&[d("old", 6)], &available).is_empty());
        assert_eq!(
            resolve_desktops(&[d("a", 1), d("old", 1)], &available),
            vec!["a"]
        );
    }
    #[test]
    fn apply_ops_serialize_flat_and_sparse() {
        let pending = Pending {
            frame: Some(Frame {
                x: 10,
                y: 20,
                width: 300,
                height: 200,
            }),
            desktops: Some(vec![]),
            maximized: None,
        };
        let json = serde_json::to_value([Op {
            id: "{uuid}",
            pending: &pending,
        }])
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!([{"id":"{uuid}","frame":{"x":10,"y":20,"width":300,"height":200},"desktops":[]}])
        );
        assert!(!APPLY_SCRIPT.contains("__PID__") && REPORT_SCRIPT.contains("__REPORT__("));
    }
    #[test]
    fn reports_parse_with_all_desktops_and_missing_outputs() {
        let report: Report = serde_json::from_str(r#"{"windows":[{"id":"{1}","caption":"c","frame":[1.5,2,3,4],"client":[1.5,2,3,4],"output":null,"all":true,"minimized":false,"desktops":[]}],"desktops":[{"id":"x","number":1,"name":"One"}],"current":"x"}"#).unwrap();
        assert!(report.windows[0].all && report.windows[0].output.is_none());
        assert_eq!(report.desktops[0].number, 1);
    }
}
