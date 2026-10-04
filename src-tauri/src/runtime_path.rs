//! GUI launchers do not inherit the interactive shell's Node/PM2/FUSE PATH.
use std::{
    ffi::OsString,
    process::{Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};
static PATH: OnceLock<OsString> = OnceLock::new();
pub fn path() -> OsString {
    PATH.get_or_init(|| {
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        #[cfg(unix)]
        {
            let shell = std::env::var_os("SHELL").unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    "/bin/zsh".into()
                } else {
                    "/bin/bash".into()
                }
            });
            // Capture to a temporary file rather than a pipe: noisy shell startup
            // must not fill a pipe and deadlock discovery. Never import shell secrets.
            let file =
                std::env::temp_dir().join(format!("canvas-shell-path-{}", std::process::id()));
            let mut options = std::fs::OpenOptions::new();
            use std::os::unix::fs::OpenOptionsExt;
            options.write(true).create_new(true).mode(0o600);
            if let Ok(output) = options.open(&file) {
                if let Ok(mut child) = Command::new(shell)
                    .args(["-ilc", "printf '\\0CANVAS_PATH\\0%s\\0' \"$PATH\""])
                    .stdin(Stdio::null())
                    .stdout(output)
                    .stderr(Stdio::null())
                    .spawn()
                {
                    let deadline = Instant::now() + Duration::from_secs(3);
                    loop {
                        match child.try_wait() {
                            Ok(Some(_)) => break,
                            Ok(None) if Instant::now() < deadline => {
                                std::thread::sleep(Duration::from_millis(25))
                            }
                            _ => {
                                let _ = child.kill();
                                let _ = child.wait();
                                break;
                            }
                        }
                    }
                    if let Ok(bytes) = std::fs::read(&file) {
                        if let Some(recovered) = parse(&bytes) {
                            let _ = std::fs::remove_file(&file);
                            return merge(recovered, &inherited);
                        }
                    }
                }
                let _ = std::fs::remove_file(&file);
            }
        }
        inherited
    })
    .clone()
}
#[cfg(unix)]
fn parse(bytes: &[u8]) -> Option<OsString> {
    use std::os::unix::ffi::OsStringExt;
    let marker = b"\0CANVAS_PATH\0";
    let start = bytes.windows(marker.len()).position(|w| w == marker)? + marker.len();
    let end = bytes[start..].iter().position(|b| *b == 0)? + start;
    (end > start).then(|| OsString::from_vec(bytes[start..end].to_vec()))
}
#[cfg(unix)]
fn merge(shell: OsString, inherited: &OsString) -> OsString {
    let mut paths = Vec::new();
    for p in std::env::split_paths(&shell).chain(std::env::split_paths(inherited)) {
        if !p.as_os_str().is_empty() && !paths.contains(&p) {
            paths.push(p);
        }
    }
    std::env::join_paths(paths).unwrap_or(shell)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn ignores_startup_noise_and_keeps_user_tools_first() {
        let p = parse(b"shell banner\n\0CANVAS_PATH\0/home/me/.local/bin:/usr/bin\0noise").unwrap();
        assert_eq!(
            merge(p, &OsString::from("/usr/bin:/bin")),
            "/home/me/.local/bin:/usr/bin:/bin"
        );
        assert!(parse(b"no marker").is_none());
    }
}
