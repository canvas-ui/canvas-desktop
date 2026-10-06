//! Test-only entry point: the private fixture CA is pinned only to the test webview.
use super::*;
pub fn run() {
    let url = std::env::var("CANVAS_TLS_URL").expect("CANVAS_TLS_URL");
    let dir =
        std::path::PathBuf::from(std::env::var("CANVAS_TLS_FIXTURE").expect("CANVAS_TLS_FIXTURE"));
    let identity = Arc::new(
        TlsFiles {
            cert_file: dir.join("client.chain.crt"),
            key_file: dir.join("client.key"),
        }
        .load(&url)
        .expect("valid fixture identity"),
    );
    let key = endpoint(&url).unwrap();
    let state = TlsState::default();
    state
        .identities
        .lock()
        .unwrap()
        .insert(key.clone(), identity.clone());
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .manage(state)
        .setup(move |app| {
            let handle = app.handle().clone();
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External("about:blank".parse()?),
            )
            .on_navigation(move |url| {
                if url.scheme() == "canvas-tls-result" {
                    handle.exit(0);
                    false
                } else {
                    true
                }
            })
            .build()?;
            #[cfg(target_os = "windows")]
            windows::import(app.handle(), &identity, true)?;
            #[cfg(target_os = "macos")]
            {
                macos::prepare(&url, &identity)?;
                macos::test_anchor(&dir.join("root.crt"))?;
            }
            #[cfg(target_os = "linux")]
            {
                use webkit2gtk::{WebContextExt, WebViewExt};
                let cert_file = dir.join("server.crt");
                window.with_webview(move |view| {
                    let cert = gio::TlsCertificate::from_file(cert_file)
                        .expect("fixture server certificate");
                    let context = view.inner().context().expect("WebKit context");
                    context.allow_tls_certificate_for_host(&cert, &key.0);
                    context.allow_tls_certificate_for_host(&cert, "localhost");
                })?;
            }
            install(&window)?;
            window.navigate(format!("{url}/native-page").parse()?)?;
            Ok(())
        })
        .run(context)
        .expect("native TLS test webview");
}
