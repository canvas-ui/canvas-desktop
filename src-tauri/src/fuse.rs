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
    Some(crate::runtime_path::path())
        .and_then(|p| {
            std::env::split_paths(&p)
                .map(|dir| dir.join(name))
                .find(|p| {
                    if !p.is_file() {
                        return false;
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        p.metadata()
                            .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
                    }
                    #[cfg(not(unix))]
                    {
                        true
                    }
                })
        })
        .ok_or(format!("{name} not installed or not on PATH"))
}
fn run(name: &str, args: &[String]) -> Result<String, String> {
    let output = Command::new(binary(name)?)
        .args(args)
        .env("PATH", crate::runtime_path::path())
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
fn supported_fuse(version: &str) -> bool {
    let Some(raw) = version.split_whitespace().last() else {
        return false;
    };
    let parts = raw
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>();
    matches!(parts, Ok(v) if v.len() == 3 && (v[0], v[1], v[2]) >= (0, 9, 1))
}
fn check_fuse() -> Result<String, String> {
    let version = run("canvas-fuse", &["--version".into()])?.trim().to_owned();
    if !supported_fuse(&version) {
        return Err(format!("{version} is incompatible; install canvas-fuse 0.9.1 or newer (shared remote home and empty environment fixes required)"));
    }
    Ok(version)
}
fn pm2_list() -> Result<Vec<Value>, String> {
    serde_json::from_str(&run("pm2", &["jlist".into()])?).map_err(|e| e.to_string())
}
fn legacy_process_name(m: &Mount) -> String {
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
fn name_part(value: &str) -> String {
    // Escape delimiters and filename-unsafe bytes without collapsing distinct
    // remote/workspace names onto the same PM2 service.
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'.' | b'_') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    if out.len() > 60 {
        // Extremely long components would exceed PM2 log filename limits.
        // Truncate on an escape boundary and retain a short collision suffix.
        let mut end = 40;
        while out[..end].rfind('%').is_some_and(|i| end - i < 3) {
            end -= 1;
        }
        out = format!("{}~{:x}", &out[..end], Sha256::digest(value.as_bytes()));
        out.truncate(end + 1 + 12);
    }
    out
}
pub fn process_name(m: &Mount) -> String {
    let export = match m.export.as_str() {
        "home" => "Home".into(),
        "contexts" => "Contexts".into(),
        "tree" => format!(
            "Trees-{}",
            name_part(m.tree.as_deref().unwrap_or("unknown"))
        ),
        other => name_part(other),
    };
    format!(
        "canvas-desktop-{}-{}-{export}",
        name_part(&m.remote),
        name_part(&m.workspace)
    )
}
fn matches_process(process: &Value, mount: &Mount) -> bool {
    process["name"] == process_name(mount) || process["name"] == legacy_process_name(mount)
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
// Clear inherited overrides inside the actual PM2 child, including overrides
// retained by an already-running daemon. No credential is written to disk.
fn fuse_launch(binary: PathBuf, args: Vec<String>) -> (PathBuf, Vec<String>) {
    #[cfg(unix)]
    {
        let mut launch = vec![
            "-u".into(),
            "CANVAS_SERVER".into(),
            "-u".into(),
            "CANVAS_API_TOKEN".into(),
            binary.to_string_lossy().into_owned(),
        ];
        launch.extend(args);
        (PathBuf::from("/usr/bin/env"), launch)
    }
    #[cfg(not(unix))]
    {
        (binary, args)
    }
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
        let path = config::mount_path(&cfg, m)?;
        if processes
            .iter()
            .any(|p| matches_process(p, m) && p["pm2_env"]["status"] == "online")
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
    if action != "stop" {
        check_fuse()?;
    }
    let existing: Vec<Value> = pm2_list()?
        .into_iter()
        .filter(|p| matches_process(p, m))
        .collect();
    if action == "start"
        && existing.len() == 1
        && existing[0]["name"] == name
        && existing[0]["pm2_env"]["status"] == "online"
    {
        return Ok(());
    }
    // Recreate legacy services under their readable name, and remove both if
    // an interrupted migration left duplicate records. No new parallel mount.
    for process in &existing {
        if let Some(id) = process["pm_id"].as_u64() {
            run("pm2", &["delete".into(), id.to_string()])?;
        } else if let Some(old_name) = process["name"].as_str() {
            run("pm2", &["delete".into(), old_name.into()])?;
        }
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
    let mut args = mount_args(&cfg, m)?;
    let remotes = config::read(&config::user_home()?.join("config/remotes.json"))?;
    let server = remotes
        .get(&m.remote)
        .and_then(|r| r.get("url"))
        .and_then(Value::as_str)
        .ok_or("Selected remote has no server URL")?;
    let url = tauri::Url::parse(server)
        .map_err(|_| "Selected remote must have an absolute HTTP(S) server URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Selected remote must have an absolute HTTP(S) server URL".into());
    }
    args.extend(["--server".into(), server.into()]);
    let (script, args) = fuse_launch(binary("canvas-fuse")?, args);
    let file = config::user_home()?
        .join("var/desktop-pm2")
        .join(&m.remote)
        .join(&m.workspace)
        .join(&m.export)
        .join(format!("{}.json", m.tree.as_deref().unwrap_or("process")));
    config::write(
        &file,
        &json!({ "apps": [{
            "name":name, "script":script, "args":args,
            "interpreter":"none", "exec_mode":"fork", "instances":1,
            "autorestart":false, "kill_timeout":10000,
            "env": { "CANVAS_USER_HOME": config::user_home()?, "PATH": crate::runtime_path::path() }
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
        let fuse_check = fuse.as_ref().map(|_| check_fuse());
        let fuse_ready = matches!(&fuse_check, Some(Ok(_)));
        let fuse_error = fuse_check.as_ref().and_then(|r| r.as_ref().err());
        let pm2 = binary("pm2").ok();
        let processes = if pm2.is_some() { pm2_list()? } else { vec![] };
        let mounts: Value = if fuse_ready { serde_json::from_str(&run("canvas-fuse", &["status".into(), "--json".into()])?).map_err(|e| e.to_string())? } else { json!([]) };
        let rows: Vec<Value> = cfg.mounts.iter().map(|m| {
            let name = process_name(m);
            let path = config::mount_path(&cfg, m)?;
            let process = processes.iter().find(|p| matches_process(p, m));
            let status = mounts.as_array().and_then(|items| items.iter().find(|s| s["mountpoint"].as_str() == path.to_str()));
            Ok(json!({"name":name,"path":path,"process":process.map(|p| &p["pm2_env"]["status"]), "fuse":status}))
        }).collect::<Result<_, String>>()?;
        Ok(json!({"fuseAvailable":fuse_ready, "fuseError":fuse_error, "pm2Available":pm2.is_some(), "mounts":rows}))
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
                workspace_root: std::env::temp_dir().join("Workspaces"),
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
    fn rejects_old_fuse_before_mount_launch() {
        assert!(!supported_fuse("canvas-fuse 0.9.0"));
        assert!(!supported_fuse("unknown"));
        assert!(supported_fuse("canvas-fuse 0.9.1"));
        assert!(supported_fuse("canvas-fuse 0.9.2"));
        assert!(supported_fuse("canvas-fuse 1.0.0"));
    }
    #[test]
    #[cfg(unix)]
    fn fuse_child_drops_pm2_overrides() {
        let (script, args) = fuse_launch(
            PathBuf::from("/bin/sh"),
            vec![
                "-c".into(),
                "test -z \"${CANVAS_SERVER+x}\" && test -z \"${CANVAS_API_TOKEN+x}\"".into(),
            ],
        );
        assert!(Command::new(script)
            .args(args)
            .env("CANVAS_SERVER", "")
            .env("CANVAS_API_TOKEN", "stale-daemon-token")
            .status()
            .unwrap()
            .success());
    }
    #[test]
    #[cfg(unix)]
    fn gui_launch_finds_shell_pm2_and_its_node_interpreter() {
        use std::os::unix::fs::PermissionsExt;
        if std::env::var_os("CANVAS_PATH_TEST_CHILD").is_some() {
            assert_eq!(run("pm2", &[]).unwrap().trim(), "mock-node-ok");
            return;
        }
        let dir = std::env::temp_dir().join(format!("canvas-pm2-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in [
            ("shell", "#!/bin/sh\nprintf '\\0CANVAS_PATH\\0%s:/usr/bin:/bin\\0' \"$CANVAS_PATH_TEST_CHILD\"\n"),
            ("pm2", "#!/usr/bin/env node\n"),
            ("node", "#!/bin/sh\necho mock-node-ok\n"),
        ] {
            let path = dir.join(name);
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "fuse::tests::gui_launch_finds_shell_pm2_and_its_node_interpreter",
                "--nocapture",
            ])
            .env("PATH", "/usr/bin:/bin")
            .env("SHELL", dir.join("shell"))
            .env("CANVAS_PATH_TEST_CHILD", &dir)
            .output()
            .unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn home_is_direct_and_mirror_pins_everything() {
        let (cfg, m) = plan("home", "mirror");
        let args = mount_args(&cfg, &m).unwrap();
        assert_eq!(
            args[1],
            cfg.workspace_root
                .join("local")
                .join("test")
                .join("Home")
                .to_string_lossy()
        );
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
    fn readable_names_distinguish_exports_and_escape_collisions() {
        let (_, mut m) = plan("home", "mirror");
        m.remote = "user@remote".into();
        m.workspace = "universe".into();
        assert_eq!(process_name(&m), "canvas-desktop-user@remote-universe-Home");
        assert!(matches_process(
            &json!({"name":legacy_process_name(&m)}),
            &m
        ));
        m.mode = "mount".into();
        assert_eq!(process_name(&m), "canvas-desktop-user@remote-universe-Home");
        m.export = "contexts".into();
        assert_eq!(
            process_name(&m),
            "canvas-desktop-user@remote-universe-Contexts"
        );
        m.export = "tree".into();
        m.tree = Some("directory".into());
        assert_eq!(
            process_name(&m),
            "canvas-desktop-user@remote-universe-Trees-directory"
        );
        assert_ne!(name_part("a-b"), name_part("a%2Db"));
        assert_ne!(name_part("a/b"), name_part("a_b"));
        let long = name_part(&"a".repeat(300));
        assert!(long.len() <= 60);
        assert_ne!(long, name_part(&format!("{}b", "a".repeat(299))));
    }
    #[test]
    fn process_names_distinguish_remotes() {
        let (_, mut m) = plan("home", "mount");
        let a = process_name(&m);
        m.remote = "another".into();
        assert_ne!(a, process_name(&m));
    }
}
