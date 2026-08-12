// FUSE mounts via the canvas-fuse sidecar CLI. One detached canvas-fuse
// process per mount (its own daemon, state file, and ws bridge), so a mount
// survives app restarts and a crash in one mount can't take down the others
// or the app. This module only orchestrates: spawn `mount -d`, `unmount`,
// and read `status --json`; canvas-fuse owns the daemon lifecycle.
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};

use crate::config;

pub const TRAY_ID: &str = "canvas-tray";

// A context or workspace the user can mount, supplied by the frontend after
// auth (the webview owns the API client; workspaces aren't listable via the
// canvas-fuse CLI).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Mountable {
    /// "context" | "workspace"
    pub kind: String,
    /// workspace name, or a `<workspace>/<context-id>` context selector
    /// (canvas-fuse addresses contexts inside their workspace)
    pub id: String,
    /// display label for the tray menu
    pub label: String,
}

#[derive(Default)]
pub struct FuseState {
    pub mountables: Mutex<Vec<Mountable>>,
    /// mountpoints with a mount/unmount currently in flight (debounces clicks)
    pub busy: Mutex<HashSet<String>>,
}

// ── binary / path resolution ────────────────────────────────────────────────

/// canvas-fuse binary: `fusePath` config override, else $PATH lookup.
fn fuse_binary() -> Option<PathBuf> {
    if let Some(p) = config::load_config()
        .get("fusePath")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join("canvas-fuse"))
        .find(|c| c.is_file())
}

/// Mount root: `mountRoot` config override, else ~/Canvas. (~/.canvas is the
/// hidden config home on unix, so the visible ~/Canvas is free for mounts.)
fn mount_root() -> PathBuf {
    if let Some(p) = config::load_config()
        .get("mountRoot")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Canvas")
}

/// Where the mount actually lands. canvas-fuse appends the mounted thing's
/// name to the mountpoint it is given (`<arg>/<workspace>` for -w,
/// `<arg>/<context-id>` for a single -c), so we hand it the PARENT directory
/// and predict the joined path here for status matching and unmount.
fn mountpoint_for(kind: &str, id: &str) -> PathBuf {
    // Per-kind namespaces; a context selector `ws/ctx` nests under its
    // workspace so same-named contexts in different workspaces can't collide.
    let sub = if kind == "workspace" { "Workspaces" } else { "Contexts" };
    let mut p = mount_root().join(sub);
    for part in id.split('/').filter(|s| !s.is_empty()) {
        p = p.join(part);
    }
    p
}

// ── canvas-fuse invocations ─────────────────────────────────────────────────

fn run_fuse(args: &[&str]) -> Result<String, String> {
    let bin = fuse_binary().ok_or("canvas-fuse binary not found (install it or set fusePath in canvas-desktop.json)")?;
    let out = Command::new(&bin)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run {}: {e}", bin.display()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        Err(if err.is_empty() {
            format!("canvas-fuse exited with {}", out.status)
        } else {
            err.to_string()
        })
    }
}

/// Parsed `canvas-fuse status --json` (empty list when the binary is missing —
/// no mounts is the truthful answer then).
fn status_entries() -> Vec<serde_json::Value> {
    if fuse_binary().is_none() {
        return Vec::new();
    }
    run_fuse(&["status", "--json"])
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Mountpoints the kernel currently has mounted (status "ok" or "orphaned").
fn mounted_paths() -> HashSet<String> {
    status_entries()
        .iter()
        .filter(|e| e.get("mounted").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|e| e.get("mountpoint").and_then(|v| v.as_str()).map(String::from))
        .collect()
}

fn do_mount(kind: &str, id: &str) -> Result<String, String> {
    let cfg = config::load_config();
    let server = cfg
        .get("serverUrl")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("not signed in (no serverUrl in desktop config)")?
        .to_string();
    let token = cfg
        .get("token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("not signed in (no token in desktop config)")?
        .to_string();

    // canvas-fuse joins the target's name onto the mountpoint itself, so we
    // pass the parent dir; `mp` is where the mount will actually appear.
    let mp = mountpoint_for(kind, id);
    let parent = mp.parent().ok_or("invalid mountpoint")?.to_path_buf();
    std::fs::create_dir_all(&parent)
        .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let parent_str = parent.to_string_lossy().into_owned();
    // `id` for a context is `<workspace>/<context-id>`; only its leaf lands in
    // the daemon's join, so the parent must be the ws subdir (mountpoint_for
    // already nests it) — hand -c the full selector, the parent dir the path.
    let flag = if kind == "workspace" { "-w" } else { "-c" };
    let selector = if kind == "workspace" {
        id.to_string()
    } else {
        id.trim_matches('/').to_string()
    };

    // -d daemonizes after pre-flight, so config/connectivity errors still
    // surface here as a non-zero exit before the process detaches.
    run_fuse(&[
        "mount", "-d", "--server", &server, "--token", &token, flag, &selector, &parent_str,
    ])?;
    Ok(mp.to_string_lossy().into_owned())
}

fn do_unmount(kind: &str, id: &str) -> Result<String, String> {
    let mp = mountpoint_for(kind, id).to_string_lossy().into_owned();
    run_fuse(&["unmount", &mp])?;
    Ok(mp)
}

// ── tray menu ───────────────────────────────────────────────────────────────

/// Rebuild the whole tray menu (Mounts submenu + Show/Hide + Quit). Must run
/// on the main thread; callers off it go through run_on_main_thread.
pub fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<FuseState>();
    let mountables = state.mountables.lock().unwrap().clone();
    let busy = state.busy.lock().unwrap().clone();
    let mounted = mounted_paths();

    let mounts_menu = {
        let sub = Submenu::with_id(app, "mounts", "Mounts", true)?;
        if fuse_binary().is_none() {
            sub.append(&MenuItem::with_id(
                app,
                "fuse-missing",
                "canvas-fuse not installed",
                false,
                None::<&str>,
            )?)?;
        } else if mountables.is_empty() {
            sub.append(&MenuItem::with_id(
                app,
                "fuse-empty",
                "Sign in to list contexts",
                false,
                None::<&str>,
            )?)?;
        } else {
            let (contexts, workspaces): (Vec<_>, Vec<_>) =
                mountables.iter().partition(|m| m.kind != "workspace");
            for (header, group) in [("Contexts", contexts), ("Workspaces", workspaces)] {
                if group.is_empty() {
                    continue;
                }
                if sub.items()?.len() > 0 {
                    sub.append(&PredefinedMenuItem::separator(app)?)?;
                }
                sub.append(&MenuItem::with_id(
                    app,
                    format!("fuse-header-{header}"),
                    header,
                    false,
                    None::<&str>,
                )?)?;
                for m in group {
                    let mp = mountpoint_for(&m.kind, &m.id).to_string_lossy().into_owned();
                    let is_busy = busy.contains(&mp);
                    let label = if is_busy { format!("{} …", m.label) } else { m.label.clone() };
                    sub.append(&CheckMenuItem::with_id(
                        app,
                        format!("fuse:{}:{}", m.kind, m.id),
                        label,
                        !is_busy,
                        mounted.contains(&mp),
                        None::<&str>,
                    )?)?;
                }
            }
            if !mounted.is_empty() {
                sub.append(&PredefinedMenuItem::separator(app)?)?;
                sub.append(&MenuItem::with_id(
                    app,
                    "fuse-unmount-all",
                    "Unmount all",
                    true,
                    None::<&str>,
                )?)?;
            }
        }
        sub
    };

    let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = tauri::menu::Menu::with_items(
        app,
        &[&mounts_menu, &PredefinedMenuItem::separator(app)?, &show, &quit],
    )?;

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

fn rebuild_later(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = rebuild_tray_menu(&app2);
    });
}

/// Handle a `fuse:` / `fuse-unmount-all` tray menu event. Toggles the mount in
/// a worker thread (mount pre-flight talks to the server; never block the UI).
pub fn handle_menu_event(app: &AppHandle, id: &str) {
    if id == "fuse-unmount-all" {
        let app = app.clone();
        std::thread::spawn(move || {
            for mp in mounted_paths() {
                if let Err(e) = run_fuse(&["unmount", &mp]) {
                    report_error(&app, &format!("unmount {mp}: {e}"));
                }
            }
            rebuild_later(&app);
        });
        return;
    }

    let Some(rest) = id.strip_prefix("fuse:") else { return };
    let Some((kind, target)) = rest.split_once(':') else { return };
    let (kind, target) = (kind.to_string(), target.to_string());
    let mp = mountpoint_for(&kind, &target).to_string_lossy().into_owned();

    let state = app.state::<FuseState>();
    if !state.busy.lock().unwrap().insert(mp.clone()) {
        return; // already toggling this mountpoint
    }
    rebuild_later(app); // repaint with the busy marker

    let app = app.clone();
    std::thread::spawn(move || {
        let currently_mounted = mounted_paths().contains(&mp);
        let result = if currently_mounted {
            do_unmount(&kind, &target).map(|_| None)
        } else {
            do_mount(&kind, &target).map(Some)
        };
        match result {
            // Reveal a fresh mount in the file manager — that's the payoff of
            // the click, and the only feedback a hidden overlay can give.
            Ok(Some(mountpoint)) => {
                use tauri_plugin_opener::OpenerExt;
                let _ = app.opener().open_path(mountpoint, None::<&str>);
            }
            Ok(None) => {}
            Err(e) => report_error(&app, &e),
        }
        app.state::<FuseState>().busy.lock().unwrap().remove(&mp);
        rebuild_later(&app);
    });
}

fn report_error(app: &AppHandle, msg: &str) {
    eprintln!("[canvas-fuse] {msg}");
    let _ = app.emit("fuse:error", msg.to_string());
}

// ── commands (frontend surface) ─────────────────────────────────────────────

/// Frontend pushes the mountable contexts/workspaces after auth (and on
/// refresh); the tray submenu is rebuilt from them.
#[tauri::command]
pub fn set_mountables(app: AppHandle, items: Vec<Mountable>) {
    *app.state::<FuseState>().mountables.lock().unwrap() = items;
    rebuild_later(&app);
}

/// Raw `canvas-fuse status --json` entries, for any future mounts UI.
#[tauri::command]
pub fn fuse_status() -> Vec<serde_json::Value> {
    status_entries()
}

/// Path of the resolved canvas-fuse binary, or null when not installed.
#[tauri::command]
pub fn fuse_available() -> Option<String> {
    fuse_binary().map(|p| p.to_string_lossy().into_owned())
}
