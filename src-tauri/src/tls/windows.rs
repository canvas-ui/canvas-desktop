//! WebView2 uses CurrentUser\\My identities. Imports are explicit and ownership is tracked.
use super::identity::ClientIdentity;
use ::windows::core::{Interface, PWSTR};
use ::windows::Win32::System::Com::CoTaskMemFree;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, WebviewWindow};
use webview2_com::{
    ClientCertificateRequestedEventHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2_5,
};

fn manifest() -> Result<std::path::PathBuf, String> {
    Ok(crate::config::user_home()?.join("config/desktop-tls-imports.json"))
}
fn powershell(script: &str, input: &[u8], thumbprint: &str, allow: bool) -> Result<Value, String> {
    let mut command = Command::new("powershell.exe");
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
    let mut child = command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("CANVAS_CERT_THUMBPRINT", thumbprint)
        .env("CANVAS_ALLOW_IMPORT", if allow { "1" } else { "0" })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // PFX travels over stdin, never through arguments, environment, or a temporary file.
    let written = child.stdin.take().unwrap().write_all(input);
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Windows certificate store: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if let Err(e) = written {
        if e.kind() != std::io::ErrorKind::BrokenPipe {
            return Err(e.to_string());
        }
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}
const IMPORT: &str = r#"
$ErrorActionPreference='Stop'
$store=New-Object System.Security.Cryptography.X509Certificates.X509Store('My','CurrentUser')
$store.Open('ReadWrite')
try {
  $existing=@($store.Certificates | Where-Object {$_.Thumbprint -eq $env:CANVAS_CERT_THUMBPRINT})
  if ($existing.Count -gt 0 -and -not $existing[0].HasPrivateKey) { throw 'Existing certificate has no private key. Resolve it in the user certificate store before importing.' }
  if ($existing.Count -eq 0 -and $env:CANVAS_ALLOW_IMPORT -ne '1') { throw 'Select Allow Windows certificate import to install this client identity in CurrentUser/My.' }
  $ms=New-Object IO.MemoryStream
  [Console]::OpenStandardInput().CopyTo($ms)
  $certs=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
  $flags=if($existing.Count -gt 0){[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet}else{[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet}
  $certs.Import($ms.ToArray(),'', $flags)
  $missing=@($certs | Where-Object {$thumb=$_.Thumbprint; @($store.Certificates | Where-Object {$_.Thumbprint -eq $thumb}).Count -eq 0})
  if ($missing.Count -gt 0 -and $env:CANVAS_ALLOW_IMPORT -ne '1') { throw 'Select Allow Windows certificate import to install missing issuing certificates.' }
  $owned=@();$used=@()
  try {
    foreach($c in $certs) {
      $used+= $c.Thumbprint
      if (@($store.Certificates | Where-Object {$_.Thumbprint -eq $c.Thumbprint}).Count -eq 0) { $store.Add($c);$owned+=$c.Thumbprint }
    }
  } catch {
    foreach($thumb in $owned) {$p='Cert:\CurrentUser\My\'+$thumb;$c=Get-Item -LiteralPath $p;if($c.HasPrivateKey){Remove-Item -LiteralPath $p -DeleteKey}else{Remove-Item -LiteralPath $p}}
    throw
  }
  @{used=$used;owned=$owned} | ConvertTo-Json -Compress
} finally { $store.Close() }
"#;
pub fn import(_app: &AppHandle, identity: &ClientIdentity, allow: bool) -> Result<(), String> {
    let _guard = crate::config::CONFIG_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let path = manifest()?;
    let mut data = crate::config::read(&path)?;
    let result = powershell(
        IMPORT,
        &identity.pkcs12().map_err(|e| e.to_string())?,
        &identity.thumbprint,
        allow,
    )?;
    let mut record = result.clone();
    if let Some(existing) = data.get(&identity.fingerprint) {
        for owned in existing["owned"]
            .as_array()
            .ok_or("Invalid native import manifest")?
        {
            if !record["owned"]
                .as_array()
                .is_some_and(|a| a.contains(owned))
            {
                record["owned"]
                    .as_array_mut()
                    .ok_or("Invalid native import result")?
                    .push(owned.clone());
            }
        }
    }
    data.as_object_mut()
        .ok_or("Invalid native import manifest")?
        .insert(identity.fingerprint.clone(), record);
    crate::config::write(&path, &data)?;
    Ok(())
}
pub fn status() -> Result<Value, String> {
    let data = crate::config::read(&manifest()?)?;
    Ok(json!({"persistentImports":true,"identities":data}))
}
pub fn remove(fingerprint: &str) -> Result<(), String> {
    let _guard = crate::config::CONFIG_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let remotes = crate::config::read(&crate::config::user_home()?.join("config/remotes.json"))?;
    for remote in remotes.as_object().ok_or("Invalid remote store")?.values() {
        if let Some(tls) = remote.get("tls").filter(|v| !v.is_null()) {
            let files: super::TlsFiles =
                serde_json::from_value(tls.clone()).map_err(|e| e.to_string())?;
            let identity = files
                .load(remote["url"].as_str().ok_or("Remote has no URL")?)
                .map_err(|e| format!("Cannot verify certificate references: {e:#}"))?;
            if identity.fingerprint == fingerprint {
                return Err("Remove this certificate from all configured remotes, then restart Desktop before removing its native import.".into());
            }
        }
    }
    let path = manifest()?;
    let mut data = crate::config::read(&path)?;
    let record = data
        .get(fingerprint)
        .cloned()
        .ok_or("Identity is not tracked by this application")?;
    // Never remove imports used by another registered identity, or pre-existing user imports.
    for owned in record["owned"]
        .as_array()
        .ok_or("Invalid import ownership record")?
    {
        let thumb = owned.as_str().ok_or("Invalid certificate thumbprint")?;
        if thumb.len() != 40 || !thumb.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid certificate thumbprint".into());
        }
        let shared = data.as_object().unwrap().iter().any(|(fp, r)| {
            fp != fingerprint
                && r["used"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(thumb)))
        });
        if shared {
            continue;
        }
        powershell(
            r#"$ErrorActionPreference='Stop'; $p='Cert:\CurrentUser\My\'+$env:CANVAS_CERT_THUMBPRINT; if(Test-Path -LiteralPath $p){$c=Get-Item -LiteralPath $p;if($c.HasPrivateKey){Remove-Item -LiteralPath $p -DeleteKey}else{Remove-Item -LiteralPath $p}}; '{}'"#,
            &[],
            thumb,
            false,
        )?;
    }
    // Transfer ownership of shared intermediates so their eventual removal remains possible.
    let obj = data.as_object_mut().unwrap();
    for (fp, r) in obj.iter_mut() {
        if fp == fingerprint {
            continue;
        }
        for thumb in record["owned"].as_array().unwrap() {
            if r["used"].as_array().is_some_and(|a| a.contains(thumb))
                && !r["owned"].as_array().is_some_and(|a| a.contains(thumb))
            {
                r["owned"]
                    .as_array_mut()
                    .ok_or("Invalid ownership manifest")?
                    .push(thumb.clone());
            }
        }
    }
    obj.remove(fingerprint);
    crate::config::write(&path, &data)
}

pub fn install(
    window: &WebviewWindow,
    identities: Arc<Mutex<HashMap<(String, u16), Arc<ClientIdentity>>>>,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |view| unsafe {
            let result = (|| -> ::windows::core::Result<()> {
                let webview: ICoreWebView2_5 = view.controller().CoreWebView2()?.cast()?;
                let handler =
                    ClientCertificateRequestedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        // Suppress the automatic certificate chooser, including for unconfigured origins.
                        args.SetHandled(true)?;
                        args.SetCancel(true)?;
                        let mut host = PWSTR::null();
                        let mut port = 0;
                        args.Host(&mut host)?;
                        let hostname = host.to_string()?;
                        CoTaskMemFree(Some(host.0.cast()));
                        args.Port(&mut port)?;
                        let identity = identities.lock().ok().and_then(|m| {
                            m.get(&(
                                hostname.trim_matches(['[', ']']).to_ascii_lowercase(),
                                port as u16,
                            ))
                            .cloned()
                        });
                        let Some(identity) = identity else {
                            return Ok(());
                        };
                        let candidates = args.MutuallyTrustedCertificates()?;
                        let mut count = 0;
                        candidates.Count(&mut count)?;
                        for i in 0..count {
                            let candidate = candidates.GetValueAtIndex(i)?;
                            let mut pem = PWSTR::null();
                            candidate.ToPemEncoding(&mut pem)?;
                            let text = pem.to_string()?;
                            CoTaskMemFree(Some(pem.0.cast()));
                            let matches = openssl::x509::X509::from_pem(text.as_bytes())
                                .ok()
                                .and_then(|c| c.digest(openssl::hash::MessageDigest::sha256()).ok())
                                .map(|d| {
                                    d.iter().map(|b| format!("{b:02X}")).collect::<String>()
                                        == identity.fingerprint
                                })
                                .unwrap_or(false);
                            if matches {
                                args.SetSelectedCertificate(&candidate)?;
                                args.SetCancel(false)?;
                                break;
                            }
                        }
                        Ok(())
                    }));
                let mut token = 0;
                webview.add_ClientCertificateRequested(&handler, &mut token)?;
                Ok(())
            })();
            let _ =
                tx.send(result.map_err(|e| {
                    format!("Cannot install WebView2 client certificate handler: {e}")
                }));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| format!("WebView2 handler installation: {e}"))?
}
