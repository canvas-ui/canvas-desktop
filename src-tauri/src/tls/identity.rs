//! Per-endpoint client identity. Secrets are never included in Debug output.
use anyhow::{bail, Context, Result};
use openssl::{asn1::Asn1Time, pkey::PKey, x509::X509};
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, path::PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsFiles {
    pub cert_file: PathBuf,
    pub key_file: PathBuf,
}
#[derive(Clone)]
pub struct ClientIdentity {
    pub cert: Vec<u8>,
    pub key: Vec<u8>,
    pub fingerprint: String,
    #[cfg(target_os = "windows")]
    pub thumbprint: String,
}
impl std::fmt::Debug for ClientIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClientIdentity([redacted])")
    }
}
impl TlsFiles {
    pub fn load(&self, server: &str) -> Result<ClientIdentity> {
        let url = tauri::Url::parse(server)?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            bail!("client certificates require an HTTPS remote without URL credentials");
        }
        let cert = std::fs::read(&self.cert_file).context("cannot read client certificate file")?;
        let key = std::fs::read(&self.key_file).context("cannot read client private key file")?;
        if String::from_utf8_lossy(&key).contains("ENCRYPTED") {
            bail!("encrypted client keys are unsupported; use a protected unencrypted PEM key");
        }
        let chain = X509::stack_from_pem(&cert).context("invalid PEM certificate chain")?;
        let leaf = chain.first().context("empty client certificate chain")?;
        let key =
            PKey::private_key_from_pem(&key).context("invalid unencrypted PEM private key")?;
        if !leaf.public_key()?.public_eq(&key) {
            bail!("client certificate and key do not match");
        }
        let now = Asn1Time::days_from_now(0)?;
        for (i, c) in chain.iter().enumerate() {
            if c.not_before().compare(&now)? == Ordering::Greater
                || c.not_after().compare(&now)? != Ordering::Greater
            {
                bail!("client certificate chain contains an expired or not-yet-valid certificate");
            }
            if let Some(issuer) = chain.get(i + 1) {
                let public = issuer.public_key()?;
                if !c.verify(&public)? {
                    bail!("client chain must be leaf first followed by issuing intermediates");
                }
            }
        }
        Ok(ClientIdentity {
            cert,
            key: key.private_key_to_pem_pkcs8()?,
            fingerprint: hex(&leaf.digest(openssl::hash::MessageDigest::sha256())?),
            #[cfg(target_os = "windows")]
            thumbprint: hex(&leaf.digest(openssl::hash::MessageDigest::sha1())?),
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}
impl ClientIdentity {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    pub fn pkcs12(&self) -> anyhow::Result<Vec<u8>> {
        let chain = X509::stack_from_pem(&self.cert)?;
        let key = PKey::private_key_from_pem(&self.key)?;
        let mut extra = openssl::stack::Stack::new()?;
        for c in chain.iter().skip(1) {
            extra.push(c.clone())?;
        }
        Ok(openssl::pkcs12::Pkcs12::builder()
            .name("Canvas client identity")
            .pkey(&key)
            .cert(&chain[0])
            .ca(extra)
            .key_algorithm(openssl::nid::Nid::PBE_WITHSHA1AND3_KEY_TRIPLEDES_CBC)
            .cert_algorithm(openssl::nid::Nid::PBE_WITHSHA1AND3_KEY_TRIPLEDES_CBC)
            .build2("")?
            .to_der()?)
    }
}
