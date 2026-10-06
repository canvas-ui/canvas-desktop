mod identity;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(feature = "tls-smoke-test")]
pub mod smoke;
#[cfg(target_os = "windows")]
mod windows;
use identity::ClientIdentity;
pub use identity::TlsFiles;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tauri::{Manager, WebviewWindow};

#[derive(Default)]
pub struct TlsState {
    identities: Arc<Mutex<HashMap<(String, u16), Arc<ClientIdentity>>>>,
    installed: Mutex<HashSet<String>>,
}
fn endpoint(url: &str) -> Result<(String, u16), String> {
    let url = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    Ok((
        url.host_str()
            .ok_or("Remote has no hostname")?
            .trim_matches(['[', ']'])
            .to_ascii_lowercase(),
        url.port_or_known_default().ok_or("Remote has no port")?,
    ))
}

// This command returns only public certificate metadata. Private keys stay in Rust/native APIs.
#[tauri::command]
pub async fn activate_tls(
    app: tauri::AppHandle,
    url: String,
    tls: Option<TlsFiles>,
    allow_import: bool,
) -> Result<Value, String> {
    let key = endpoint(&url)?;
    let load_url = url.clone();
    let loaded = tauri::async_runtime::spawn_blocking(move || {
        tls.map(|files| files.load(&load_url))
            .transpose()
            .map_err(|e| format!("Client certificate: {e:#}"))
    })
    .await
    .map_err(|e| e.to_string())??
    .map(Arc::new);
    let state = app.state::<TlsState>();
    let mut reuse = false;
    {
        let identities = state.identities.lock().map_err(|e| e.to_string())?;
        if let Some(old) = identities.get(&key) {
            if !loaded.as_ref().is_some_and(|i| {
                i.fingerprint == old.fingerprint && i.cert == old.cert && i.key == old.key
            }) {
                return Err("Client identity changed. Save settings and restart Canvas Desktop to clear cached TLS sessions.".into());
            }
            reuse = true;
        }
    }
    #[cfg(target_os = "windows")]
    if !reuse {
        if let Some(identity) = &loaded {
            windows::import(&app, identity, allow_import)?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (allow_import, reuse);
    #[cfg(target_os = "macos")]
    if !reuse {
        if let Some(identity) = &loaded {
            macos::prepare(&url, identity)?;
        }
    }
    let result = loaded
        .as_ref()
        .map(|i| json!({"fingerprint":i.fingerprint}))
        .unwrap_or(Value::Null);
    let mut identities = state.identities.lock().map_err(|e| e.to_string())?;
    if let Some(identity) = loaded {
        identities.insert(key, identity);
    } else {
        identities.remove(&key);
    }
    drop(identities);
    install(
        &app.get_webview_window("main")
            .ok_or("Main window unavailable")?,
    )?;
    Ok(result)
}

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let state = window.state::<TlsState>();
    let mut installed = state.installed.lock().map_err(|e| e.to_string())?;
    if installed.contains(window.label()) {
        return Ok(());
    }
    let identities = state.identities.clone();
    #[cfg(target_os = "linux")]
    {
        use glib::translate::ToGlibPtr;
        use webkit2gtk::{
            AuthenticationRequestExt, AuthenticationScheme, Credential, CredentialPersistence,
            WebViewExt,
        };
        window
            .with_webview(move |view| {
                view.inner().connect_authenticate(move |_, request| {
                    if !matches!(
                        request.scheme(),
                        AuthenticationScheme::ClientCertificateRequested
                            | AuthenticationScheme::ClientCertificatePinRequested
                    ) {
                        return false;
                    }
                    let key = (
                        request
                            .host()
                            .map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase())
                            .unwrap_or_default(),
                        request.port() as u16,
                    );
                    let identity = identities
                        .lock()
                        .ok()
                        .and_then(|map| map.get(&key).cloned());
                    if let Some(identity) = identity {
                        if let Ok(pem) = String::from_utf8(
                            [identity.cert.as_slice(), identity.key.as_slice()].concat(),
                        ) {
                            if let Ok(cert) = gio::TlsCertificate::from_pem(&pem) {
                                let credential = Credential::for_certificate(
                                    Some(&cert),
                                    CredentialPersistence::None,
                                );
                                unsafe {
                                    webkit2gtk_sys::webkit_authentication_request_authenticate(
                                        request.to_glib_none().0,
                                        credential.to_glib_none().0,
                                    );
                                }
                                return true;
                            }
                        }
                    }
                    request.cancel();
                    true
                });
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    windows::install(window, identities)?;
    #[cfg(target_os = "macos")]
    macos::install(window, identities)?;
    installed.insert(window.label().to_owned());
    Ok(())
}

#[tauri::command]
pub async fn save_remote_tls(id: String, url: String, tls: Option<TlsFiles>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::config::component(&id)?;
        if id.split('@').count() != 2 || id.split('@').any(|p| p.trim().is_empty()) {
            return Err("Remote name must be user@remote-name".into());
        }
        let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("Use an HTTP(S) URL without credentials, query or fragment".into());
        }
        let tls = tls
            .map(|mut files| -> Result<TlsFiles, String> {
                files.cert_file =
                    std::fs::canonicalize(files.cert_file).map_err(|e| e.to_string())?;
                files.key_file =
                    std::fs::canonicalize(files.key_file).map_err(|e| e.to_string())?;
                files
                    .load(&url)
                    .map_err(|e| format!("Client certificate: {e:#}"))?;
                Ok(files)
            })
            .transpose()?;
        let _guard = crate::config::CONFIG_LOCK
            .lock()
            .map_err(|e| e.to_string())?;
        let path = crate::config::user_home()?.join("config/remotes.json");
        let mut remotes = crate::config::read(&path)?;
        let obj = remotes
            .as_object_mut()
            .ok_or("Invalid remote configuration")?;
        let mut remote = obj.get(&id).cloned().unwrap_or(json!({}));
        if let Some(old) = remote.get("url").and_then(Value::as_str) {
            if old != url.trim_end_matches('/') {
                return Err("Changing a saved remote URL requires a new remote name".into());
            }
        }
        let remote_obj = remote.as_object_mut().ok_or("Invalid remote entry")?;
        remote_obj.insert("url".into(), json!(url.trim_end_matches('/')));
        if let Some(files) = tls {
            remote_obj.insert(
                "tls".into(),
                serde_json::to_value(files).map_err(|e| e.to_string())?,
            );
        } else {
            remote_obj.remove("tls");
        }
        obj.insert(id, remote);
        crate::config::write(&path, &remotes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn restart_connections(app: tauri::AppHandle) {
    app.request_restart();
}
#[tauri::command]
pub fn native_tls_status() -> Result<Value, String> {
    #[cfg(target_os = "windows")]
    return windows::status();
    #[cfg(not(target_os = "windows"))]
    Ok(json!({"persistentImports":false,"identities":[]}))
}
#[tauri::command]
pub fn remove_native_identity(app: tauri::AppHandle, fingerprint: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if app
            .state::<TlsState>()
            .identities
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .any(|i| i.fingerprint == fingerprint)
        {
            return Err("Restart Desktop after clearing this identity from remotes before removing its native import".into());
        }
        return windows::remove(&fingerprint);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, fingerprint);
        Err("This platform has no persistent user-store imports".into())
    }
}

#[tauri::command]
pub async fn prepare_tls_import(
    app: tauri::AppHandle,
    url: String,
    tls: TlsFiles,
    allow_import: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let identity = tls
            .load(&url)
            .map_err(|e| format!("Client certificate: {e:#}"))?;
        #[cfg(target_os = "windows")]
        windows::import(&app, &identity, allow_import)?;
        #[cfg(not(target_os = "windows"))]
        let _ = (app, identity, allow_import);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
