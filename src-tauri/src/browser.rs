use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{WebviewUrl, WebviewWindowBuilder};
static NEXT_BROWSER: AtomicU64 = AtomicU64::new(1);
fn browser_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Browser addresses must use HTTP or HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Browser addresses cannot contain credentials".into());
    }
    Ok(url)
}
// Browser windows have no main-window capabilities or Canvas credentials.
#[tauri::command]
pub fn open_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = browser_url(&url)?;
    let label = format!("browser-{}", NEXT_BROWSER.fetch_add(1, Ordering::Relaxed));
    let window = WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("Canvas Browser")
    .inner_size(1100.0, 800.0)
    .on_navigation(|url| matches!(url.scheme(), "http" | "https"))
    .build()
    .map_err(|e| e.to_string())?;
    crate::tls::install(&window)?;
    window.navigate(url).map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::browser_url;
    #[test]
    fn allows_web_addresses_only() {
        assert!(browser_url("https://example.com/task/1").is_ok());
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "https://user:password@example.com",
            "not a url",
        ] {
            assert!(browser_url(url).is_err(), "{url}");
        }
    }
}
