//! Non-Linux stand-in for the KWin bridge: no virtual desktops, native placement.
use super::Rect;
use serde::{Deserialize, Serialize};
use tauri::Window;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct VirtualDesktop {
    pub id: String,
    pub number: u32,
    pub name: String,
}
pub(super) struct Info {
    pub rect: Rect,
    pub output: Option<String>,
    pub output_origin: Option<(f64, f64)>,
    pub minimized: bool,
    pub desktops: Option<Vec<VirtualDesktop>>,
}
pub(super) fn init() {}
pub(super) fn managed() -> bool {
    false
}
pub(super) fn wayland_managed() -> bool {
    false
}
pub(super) fn forget(_label: &str) {}
pub(super) fn info(_window: &Window) -> Result<Option<Info>, String> {
    Ok(None)
}
pub(super) fn desktops() -> Result<Vec<VirtualDesktop>, String> {
    Ok(Vec::new())
}
pub(super) fn resolve_desktops(_saved: &[VirtualDesktop], _available: &[VirtualDesktop]) -> Vec<String> {
    Vec::new()
}
pub(super) fn place(_window: &Window, _rect: Rect) -> Result<(), String> {
    Ok(())
}
pub(super) fn set_state(
    _window: &Window,
    _desktops: Option<Vec<String>>,
    _maximized: Option<bool>,
) -> Result<(), String> {
    Ok(())
}
pub(super) fn flush(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}
