use super::identity::ClientIdentity;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::WebviewWindow;
unsafe extern "C" {
    fn canvas_tls_prepare(
        host: *const std::ffi::c_char,
        port: u16,
        pfx: *const u8,
        len: usize,
        directory: *const std::ffi::c_char,
    ) -> i32;
    fn canvas_tls_install(webview: *mut std::ffi::c_void);
}
pub fn prepare(url: &str, identity: &ClientIdentity) -> Result<(), String> {
    let (host, port) = super::endpoint(url)?;
    let directory = crate::config::user_home()?.join("var/desktop-tls");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let directory = std::ffi::CString::new(directory.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;
    let host = std::ffi::CString::new(host).map_err(|e| e.to_string())?;
    let pfx = identity.pkcs12().map_err(|e| e.to_string())?;
    let code = unsafe {
        canvas_tls_prepare(
            host.as_ptr(),
            port,
            pfx.as_ptr(),
            pfx.len(),
            directory.as_ptr(),
        )
    };
    if code != 0 {
        return Err(format!(
            "Cannot prepare macOS client identity (Security status {code})"
        ));
    }
    Ok(())
}
pub fn install(
    window: &WebviewWindow,
    _identities: Arc<Mutex<HashMap<(String, u16), Arc<ClientIdentity>>>>,
) -> Result<(), String> {
    window
        .with_webview(|view| unsafe {
            canvas_tls_install(view.inner());
        })
        .map_err(|e| e.to_string())
}

#[cfg(feature = "tls-smoke-test")]
pub fn test_anchor(path: &std::path::Path) -> Result<(), String> {
    unsafe extern "C" {
        fn canvas_tls_test_anchor(data: *const u8, len: usize) -> i32;
    }
    let pem = std::fs::read(path).map_err(|e| e.to_string())?;
    let der = openssl::x509::X509::from_pem(&pem)
        .and_then(|c| c.to_der())
        .map_err(|e| e.to_string())?;
    if unsafe { canvas_tls_test_anchor(der.as_ptr(), der.len()) } != 0 {
        return Err("Invalid test anchor".into());
    }
    Ok(())
}
