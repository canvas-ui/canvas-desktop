use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub static CONFIG_LOCK: Mutex<()> = Mutex::new(());
pub fn user_home() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("CANVAS_USER_HOME").filter(|h| !h.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    dirs::home_dir()
        .map(|h| h.join(if cfg!(windows) { "Canvas" } else { ".canvas" }))
        .ok_or("Cannot determine home directory".into())
}
pub fn read(path: &Path) -> Result<Value, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}
pub fn write(path: &Path, value: &Value) -> Result<(), String> {
    use std::io::Write;
    fs::create_dir_all(path.parent().ok_or("Invalid config path")?).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())
}
pub fn component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.starts_with('-')
        || value
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        return Err(format!("Invalid path component: {value:?}"));
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mount {
    pub remote: String,
    pub workspace: String,
    pub export: String, // home | tree | contexts
    pub tree: Option<String>,
    pub mode: String, // mount | mirror (Home only)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopConfig {
    pub version: u32,
    pub workspace_root: PathBuf,
    pub mounts: Vec<Mount>,
}
pub fn load() -> Result<DesktopConfig, String> {
    let value = read(&user_home()?.join("config/desktop.json"))?;
    if value == json!({}) {
        return Ok(DesktopConfig {
            version: 1,
            workspace_root: dirs::home_dir()
                .ok_or("Missing home")?
                .join("Canvas/Workspaces"),
            mounts: vec![],
        });
    }
    serde_json::from_value(value).map_err(|e| e.to_string())
}
pub fn mount_path(cfg: &DesktopConfig, mount: &Mount) -> Result<PathBuf, String> {
    component(&mount.remote)?;
    component(&mount.workspace)?;
    if !cfg.workspace_root.is_absolute() {
        return Err("Workspace root must be absolute".into());
    }
    if mount.mode != "mount" && mount.mode != "mirror" {
        return Err("Unknown mount mode".into());
    }
    if mount.mode == "mirror" && mount.export != "home" {
        return Err("Only Home supports mirroring".into());
    }
    let base = cfg
        .workspace_root
        .join(&mount.remote)
        .join(&mount.workspace);
    match mount.export.as_str() {
        "home" if mount.tree.is_none() => Ok(base.join("Home")),
        "contexts" if mount.tree.is_none() => Ok(base.join("Contexts")),
        "tree" => {
            let tree = mount.tree.as_deref().ok_or("Tree name required")?;
            component(tree)?;
            Ok(base.join("Trees").join(tree))
        }
        _ => Err("Invalid export".into()),
    }
}
// Login only needs remotes. A malformed mount plan must not block the web UI.
#[tauri::command]
pub async fn load_remotes() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
        read(&user_home()?.join("config/remotes.json"))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn load_setup() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(load_setup_impl)
        .await
        .map_err(|e| e.to_string())?
}
fn load_setup_impl() -> Result<Value, String> {
    let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    Ok(json!({ "config": load()?, "remotes": read(&user_home()?.join("config/remotes.json"))? }))
}
#[tauri::command]
pub async fn save_remote(id: String, url: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_remote_impl(id, url, token))
        .await
        .map_err(|e| e.to_string())?
}
fn save_remote_impl(id: String, url: String, token: String) -> Result<(), String> {
    component(&id)?;
    let parts: Vec<_> = id.split('@').collect();
    if parts.len() != 2 || parts.iter().any(|part| part.trim().is_empty()) {
        return Err("Use the CLI remote naming convention: user@remote-name".into());
    }
    let parsed: tauri::Url = url.parse().map_err(|_| "Invalid server URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Use an HTTP(S) server URL without credentials, query or fragment".into());
    }
    if token.trim().is_empty() {
        return Err("Token required".into());
    }
    let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let path = user_home()?.join("config/remotes.json");
    let mut remotes = read(&path)?;
    let obj = remotes.as_object_mut().ok_or("Invalid remotes file")?;
    let mut remote = obj.get(&id).cloned().unwrap_or(json!({}));
    let entry = remote.as_object_mut().ok_or("Invalid remote entry")?;
    entry.insert("url".into(), json!(url.trim_end_matches('/')));
    entry.insert("auth".into(), json!({"method":"token", "tokenType": if token.starts_with("canvas-") {"api"} else {"jwt"}, "token":token}));
    obj.insert(id, remote);
    write(&path, &remotes)
}
#[tauri::command]
pub async fn save_setup(app: tauri::AppHandle, config: DesktopConfig) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_setup_impl(config))
        .await
        .map_err(|e| e.to_string())??;
    crate::fuse::rebuild_later(&app);
    Ok(())
}
fn save_setup_impl(config: DesktopConfig) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    if !config.workspace_root.is_absolute() {
        return Err("Workspace root must be absolute".into());
    }
    if config.version != 1 {
        return Err("Unsupported config version".into());
    }
    let remotes = read(&user_home()?.join("config/remotes.json"))?;
    let mut paths = std::collections::HashSet::new();
    for mount in &config.mounts {
        if remotes.get(&mount.remote).is_none() {
            return Err(format!("Unknown remote {}", mount.remote));
        }
        if !paths.insert(mount_path(&config, mount)?) {
            return Err("Duplicate mount".into());
        }
    }
    // Editing active mount paths would strand running processes. Stop first.
    if serde_json::to_value(load()?).map_err(|e| e.to_string())?
        != serde_json::to_value(&config).map_err(|e| e.to_string())?
        && crate::fuse::has_active_mounts()?
    {
        return Err("Stop configured mounts before changing the plan".into());
    }
    write(
        &user_home()?.join("config/desktop.json"),
        &serde_json::to_value(config).map_err(|e| e.to_string())?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_remotes_preserve_metadata_and_reject_corruption() {
        let dir =
            std::env::temp_dir().join(format!("canvas-desktop-config-test-{}", std::process::id()));
        let previous = std::env::var_os("CANVAS_USER_HOME");
        std::env::set_var("CANVAS_USER_HOME", &dir);
        let path = dir.join("config/remotes.json");
        write(&path, &json!({"admin@existing":{"url":"https://old.example", "device":{"token":"device-token"}}, "other":{"url":"https://other.example"}})).unwrap();
        save_remote_impl(
            "admin@existing".into(),
            "https://new.example/".into(),
            "canvas-test-token".into(),
        )
        .unwrap();
        let remotes = read(&path).unwrap();
        assert_eq!(remotes["admin@existing"]["url"], "https://new.example");
        assert_eq!(remotes["admin@existing"]["device"]["token"], "device-token");
        assert_eq!(remotes["other"]["url"], "https://other.example");
        assert!(save_remote_impl(
            "../escape".into(),
            "https://example.com".into(),
            "token".into()
        )
        .is_err());
        fs::write(&path, "broken json").unwrap();
        assert!(save_remote_impl(
            "admin@existing".into(),
            "https://example.com".into(),
            "token".into()
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "broken json");
        match previous {
            Some(v) => std::env::set_var("CANVAS_USER_HOME", v),
            None => std::env::remove_var("CANVAS_USER_HOME"),
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
