//! Local PTY sessions belong to a context, independently of its rendered app.
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, Webview};
const CAPACITY: usize = 4 * 1024 * 1024;
static SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
}
struct Session {
    id: String,
    pid: Option<u32>,
    scope: String,
    cwd: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Mutex<Output>,
    running: AtomicBool,
}
#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    end: u64,
}
impl Output {
    fn append(&mut self, data: &[u8]) {
        self.end += data.len() as u64;
        self.bytes.extend(data);
        let excess = self.bytes.len().saturating_sub(CAPACITY);
        self.bytes.drain(..excess);
    }
    fn read(&self, offset: u64) -> ReadResult {
        let start = self.end - self.bytes.len() as u64;
        let offset = offset.max(start).min(self.end);
        let data: Vec<u8> = self
            .bytes
            .iter()
            .skip((offset - start) as usize)
            .take(65536)
            .copied()
            .collect();
        ReadResult {
            offset: offset + data.len() as u64,
            start,
            data,
            running: false,
        }
    }
}
#[derive(Serialize)]
pub struct SessionInfo {
    id: String,
    cwd: String,
    running: bool,
}
#[derive(Serialize)]
pub struct ReadResult {
    offset: u64,
    start: u64,
    data: Vec<u8>,
    running: bool,
}
fn trusted(view: &Webview) -> Result<(), String> {
    let label = view.label();
    if label == "main" || label == "toolbox" || label.starts_with("canvas-") {
        Ok(())
    } else {
        Err("Terminals are available only to the Canvas UI".into())
    }
}
fn terminate(session: &Session) {
    if !session.running.load(Ordering::SeqCst) {
        return;
    }
    // PTY children share the shell's process group. End its foreground jobs too.
    #[cfg(unix)]
    if let Some(pid) = session.pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGHUP);
        }
    }
    if let Ok(mut killer) = session.killer.lock() {
        let _ = killer.kill();
    }
}
fn info(session: &Session) -> SessionInfo {
    SessionInfo {
        id: session.id.clone(),
        cwd: session.cwd.clone(),
        running: session.running.load(Ordering::SeqCst),
    }
}
fn session(app: &tauri::AppHandle, id: &str) -> Result<Arc<Session>, String> {
    app.state::<TerminalState>()
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or("Terminal session has ended".into())
}
#[tauri::command]
pub async fn terminal_list(
    app: tauri::AppHandle,
    webview: Webview,
    scope: String,
) -> Result<Vec<SessionInfo>, String> {
    trusted(&webview)?;
    Ok(app
        .state::<TerminalState>()
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .filter(|s| s.scope == scope)
        .map(|s| info(s))
        .collect())
}
#[tauri::command]
pub async fn terminal_create(
    app: tauri::AppHandle,
    webview: Webview,
    scope: String,
    cwd: Option<String>,
) -> Result<SessionInfo, String> {
    trusted(&webview)?;
    if scope.is_empty() || scope.len() > 8192 {
        return Err("Invalid terminal context".into());
    }
    let cwd = cwd
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or("Home directory is unavailable")?;
    if !cwd.is_dir() {
        return Err("Choose an existing working directory".into());
    }
    let state = app.state::<TerminalState>();
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if sessions.len() >= 128 {
        return Err("Close a terminal before opening another (128 session limit)".into());
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell.exe"
        } else {
            "/bin/sh"
        }
        .into()
    });
    let mut command = CommandBuilder::new(shell);
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    let id = format!(
        "terminal-{}-{:016}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::SeqCst)
    );
    let session = Arc::new(Session {
        id: id.clone(),
        pid: child.process_id(),
        scope,
        cwd: cwd.to_string_lossy().into(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(child.clone_killer()),
        output: Mutex::new(Output::default()),
        running: AtomicBool::new(true),
    });
    drop(pair.slave);
    sessions.insert(id, session.clone());
    let output = session.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0u8; 16384];
        while let Ok(count) = reader.read(&mut chunk) {
            if count == 0 {
                break;
            }
            if let Ok(mut buffer) = output.output.lock() {
                buffer.append(&chunk[..count]);
            }
        }
        output.running.store(false, Ordering::SeqCst);
    });
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(info(&session))
}
#[tauri::command]
pub async fn terminal_read(
    app: tauri::AppHandle,
    webview: Webview,
    id: String,
    offset: u64,
) -> Result<ReadResult, String> {
    trusted(&webview)?;
    let session = session(&app, &id)?;
    let mut result = session
        .output
        .lock()
        .map_err(|e| e.to_string())?
        .read(offset);
    result.running = session.running.load(Ordering::SeqCst);
    Ok(result)
}
#[tauri::command]
pub async fn terminal_write(
    app: tauri::AppHandle,
    webview: Webview,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    trusted(&webview)?;
    if data.len() > 65536 {
        return Err("Paste at most 64 KiB at a time".into());
    }
    let session = session(&app, &id)?;
    let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(&data)
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn terminal_resize(
    app: tauri::AppHandle,
    webview: Webview,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    trusted(&webview)?;
    let session = session(&app, &id)?;
    let result = session
        .master
        .lock()
        .map_err(|e| e.to_string())?
        .resize(PtySize {
            cols: cols.clamp(2, 1000),
            rows: rows.clamp(1, 1000),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string());
    result
}
#[tauri::command]
pub async fn terminal_close(
    app: tauri::AppHandle,
    webview: Webview,
    id: String,
) -> Result<(), String> {
    trusted(&webview)?;
    if let Some(session) = app
        .state::<TerminalState>()
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
    {
        terminate(&session);
    }
    Ok(())
}
#[tauri::command]
pub async fn terminal_close_all(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    trusted(&webview)?;
    shutdown(&app);
    Ok(())
}
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<TerminalState>() {
        if let Ok(mut sessions) = state.sessions.lock() {
            for (_, session) in std::mem::take(&mut *sessions) {
                terminate(&session);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_uses_byte_offsets_and_bounds_scrollback() {
        let mut output = Output::default();
        output.append("hello 🐧".as_bytes());
        let first = output.read(0);
        assert_eq!(first.data, "hello 🐧".as_bytes());
        assert!(output.read(first.offset).data.is_empty());
        output.append(&vec![b'x'; CAPACITY + 10]);
        let next = output.read(0);
        assert!(next.start > 0);
        assert_eq!(output.bytes.len(), CAPACITY);
        assert!(next.data.len() <= 65536);
    }
}
