//! PM2 owns one foreground FUSE process per saved export. Never pass credentials
//! in arguments or PM2 files: FUSE resolves --remote from the shared store.
use crate::config::{self, DesktopConfig, Mount};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Command};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};
pub const TRAY_ID: &str = "canvas-tray";

fn binary(name: &str) -> Result<PathBuf, String> {
    std::env::var_os("PATH")
        .and_then(|p| {
            std::env::split_paths(&p)
                .map(|dir| dir.join(name))
                .find(|p| p.is_file())
        })
        .ok_or(format!("{name} not installed or not on PATH"))
}
fn run(name: &str, args: &[String]) -> Result<String, String> {
    let output = Command::new(binary(name)?)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
fn pm2_list() -> Result<Vec<Value>, String> {
    serde_json::from_str(&run("pm2", &["jlist".into()])?).map_err(|e| e.to_string())
}
pub fn process_name(m: &Mount) -> String {
    // Stable, bounded names keep PM2 log filenames below filesystem limits.
    let key = serde_json::to_vec(&(
        m.remote.as_str(),
        m.workspace.as_str(),
        m.export.as_str(),
        &m.tree,
    ))
    .unwrap();
    format!("canvas-desktop-{:x}", Sha256::digest(key))
}
pub fn mount_args(cfg: &DesktopConfig, m: &Mount) -> Result<Vec<String>, String> {
    let path = config::mount_path(cfg, m)?;
    let mut args = vec![
        "mount".into(),
        path.to_string_lossy().into_owned(),
        "--remote".into(),
        m.remote.clone(),
        "--workspace".into(),
        m.workspace.clone(),
    ];
    match m.export.as_str() {
        "home" => args.extend(["--backend".into(), "workspace:home".into()]),
        "tree" => args.extend(["--tree".into(), m.tree.clone().ok_or("Missing tree")?]),
        "contexts" => args.push("--contexts-only".into()),
        _ => return Err("Unsupported export".into()),
    }
    if m.mode == "mirror" {
        // All Home files stay materialized; remote removals use mirror trash.
        args.extend([
            "--mirror".into(),
            "--pin".into(),
            "**".into(),
            "--deletes".into(),
            "propagate".into(),
        ]);
    }
    Ok(args)
}
pub fn has_active_mounts() -> Result<bool, String> {
    let cfg = config::load()?;
    if cfg.mounts.is_empty() {
        return Ok(false);
    }
    let processes = pm2_list()?;
    let status: Vec<Value> =
        serde_json::from_str(&run("canvas-fuse", &["status".into(), "--json".into()])?)
            .map_err(|e| e.to_string())?;
    for m in &cfg.mounts {
        let name = process_name(m);
        let path = config::mount_path(&cfg, m)?;
        if processes
            .iter()
            .any(|p| p["name"] == name && p["pm2_env"]["status"] == "online")
            || status
                .iter()
                .any(|p| p["mountpoint"].as_str() == path.to_str() && p["mounted"] == true)
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn action(index: usize, action: &str) -> Result<(), String> {
    let _guard = config::CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let cfg = config::load()?;
    let m = cfg.mounts.get(index).ok_or("Unknown mount")?;
    let name = process_name(m);
    let path = config::mount_path(&cfg, m)?;
    if !matches!(action, "start" | "stop" | "restart") {
        return Err("Unknown action".into());
    }
    let existing = pm2_list()?.into_iter().find(|p| p["name"] == name);
    if action == "start"
        && existing
            .as_ref()
            .is_some_and(|p| p["pm2_env"]["status"] == "online")
    {
        return Ok(());
    }
    if existing.is_some() {
        run("pm2", &["delete".into(), name.clone()])?;
    }
    // Only clean up a known Canvas mount, never unmount arbitrary filesystems.
    // PM2 can leave a stale kernel mount behind after killing a FUSE process.
    let mounts: Vec<Value> =
        serde_json::from_str(&run("canvas-fuse", &["status".into(), "--json".into()])?)
            .map_err(|e| e.to_string())?;
    if mounts
        .iter()
        .any(|m| m["mountpoint"].as_str() == path.to_str())
    {
        run(
            "canvas-fuse",
            &["unmount".into(), path.to_string_lossy().into_owned()],
        )?;
    }
    if action == "stop" {
        return Ok(());
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let args = mount_args(&cfg, m)?;
    let file = config::user_home()?
        .join("var/desktop-pm2")
        .join(&m.remote)
        .join(&m.workspace)
        .join(&m.export)
        .join(format!("{}.json", m.tree.as_deref().unwrap_or("process")));
    config::write(
        &file,
        &json!({ "apps": [{
            "name":name, "script":binary("canvas-fuse")?, "args":args,
            "interpreter":"none", "exec_mode":"fork", "instances":1,
            "autorestart":false, "kill_timeout":10000,
            "env": { "CANVAS_USER_HOME": config::user_home()?, "CANVAS_SERVER":"", "CANVAS_API_TOKEN":"" }
        }]}),
    )?;
    run(
        "pm2",
        &["start".into(), file.to_string_lossy().into_owned()],
    )?;
    Ok(())
}
#[tauri::command]
pub async fn mount_action(app: AppHandle, index: usize, operation: String) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || action(index, &operation))
        .await
        .map_err(|e| e.to_string())?;
    rebuild_later(&app);
    let _ = app.emit("mounts:changed", ());
    result
}
#[tauri::command]
pub async fn mount_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let cfg = config::load()?;
        let fuse = binary("canvas-fuse").ok();
        let pm2 = binary("pm2").ok();
        let processes = if pm2.is_some() { pm2_list()? } else { vec![] };
        let mounts: Value = if fuse.is_some() { serde_json::from_str(&run("canvas-fuse", &["status".into(), "--json".into()])?).map_err(|e| e.to_string())? } else { json!([]) };
        let rows: Vec<Value> = cfg.mounts.iter().map(|m| {
            let name = process_name(m);
            let path = config::mount_path(&cfg, m)?;
            let process = processes.iter().find(|p| p["name"] == name);
            let status = mounts.as_array().and_then(|items| items.iter().find(|s| s["mountpoint"].as_str() == path.to_str()));
            Ok(json!({"name":name,"path":path,"process":process.map(|p| &p["pm2_env"]["status"]), "fuse":status}))
        }).collect::<Result<_, String>>()?;
        Ok(json!({"fuseAvailable":fuse.is_some(), "pm2Available":pm2.is_some(), "mounts":rows}))
    }).await.map_err(|e| e.to_string())?
}
pub fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "show",
        "Setup / Manage mounts",
        true,
        None::<&str>,
    )?)?;
    if let Ok(cfg) = config::load() {
        for (i, m) in cfg.mounts.iter().enumerate() {
            let label = format!(
                "{} / {} / {}",
                m.remote,
                m.workspace,
                m.tree.as_deref().unwrap_or(&m.export)
            );
            let sub = Submenu::new(app, label, true)?;
            for (op, label) in [("start", "Start"), ("stop", "Stop"), ("restart", "Restart")] {
                sub.append(&MenuItem::with_id(
                    app,
                    format!("mount:{i}:{op}"),
                    label,
                    true,
                    None::<&str>,
                )?)?;
            }
            menu.append(&sub)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit tray (keep mounts running)",
        true,
        None::<&str>,
    )?)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
pub fn rebuild_later(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = rebuild_tray_menu(&handle);
    });
}
pub fn handle_menu_event(app: &AppHandle, id: &str) {
    let Some(rest) = id.strip_prefix("mount:") else {
        return;
    };
    let Some((index, operation)) = rest.split_once(':') else {
        return;
    };
    let Ok(index) = index.parse() else { return };
    let operation = operation.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = action(index, &operation) {
            let _ = app.emit("mounts:error", &error);
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        let _ = app.emit("mounts:changed", ());
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn plan(export: &str, mode: &str) -> (DesktopConfig, Mount) {
        (
            DesktopConfig {
                version: 1,
                workspace_root: PathBuf::from("/tmp/Workspaces"),
                mounts: vec![],
            },
            Mount {
                remote: "local".into(),
                workspace: "test".into(),
                export: export.into(),
                tree: None,
                mode: mode.into(),
            },
        )
    }
    #[test]
    fn home_is_direct_and_mirror_pins_everything() {
        let (cfg, m) = plan("home", "mirror");
        let args = mount_args(&cfg, &m).unwrap();
        assert_eq!(args[1], "/tmp/Workspaces/local/test/Home");
        assert!(args
            .windows(2)
            .any(|v| v == ["--backend", "workspace:home"]));
        assert!(args.windows(2).any(|v| v == ["--pin", "**"]));
        assert!(!args.iter().any(|a| a == "--token" || a == "--detach"));
    }
    #[test]
    fn contexts_are_scoped_and_mirror_is_home_only() {
        let (cfg, mut m) = plan("contexts", "mount");
        assert!(mount_args(&cfg, &m)
            .unwrap()
            .contains(&"--contexts-only".into()));
        m.mode = "mirror".into();
        assert!(mount_args(&cfg, &m).is_err());
        m.mode = "mount".into();
        m.workspace = "../escape".into();
        assert!(mount_args(&cfg, &m).is_err());
    }
    #[test]
    fn process_names_distinguish_remotes() {
        let (_, mut m) = plan("home", "mount");
        let a = process_name(&m);
        m.remote = "another".into();
        assert_ne!(a, process_name(&m));
    }
}
