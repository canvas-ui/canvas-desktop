//! Window-level accelerators also cover focused, untrusted website webviews.
#[cfg(target_os = "linux")]
pub(super) fn install(window: &tauri::Window) {
    if window.label() == "toolbox" {
        return;
    }
    use gtk::prelude::*;
    use tauri::{Emitter, Manager};
    let Ok(gtk) = window.gtk_window() else {
        return;
    };
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    gtk.connect_key_press_event(move |_, event| {
        use gdk::{keys::constants as key, ModifierType as M};
        let mods = event.state();
        let ctrl = mods.contains(M::CONTROL_MASK);
        let shift = mods.contains(M::SHIFT_MASK);
        let alt = mods.contains(M::MOD1_MASK);
        let k = event.keyval();
        let browser = app
            .state::<super::DesktopState>()
            .request
            .lock()
            .ok()
            .and_then(|request| {
                request.as_ref().map(|request| {
                    request.frames.iter().any(|frame| {
                        frame.kind == "browser" && super::label(request, &frame.id) == label
                    })
                })
            })
            .unwrap_or(false);
        let action = if ctrl && !alt {
            match k {
                key::t | key::T if shift => Some("reopen-tab".to_string()),
                key::t | key::T if !shift => Some("new-tab".to_string()),
                key::n | key::N if !shift => Some("new-window".to_string()),
                key::w | key::W if !shift => Some("close-tab".to_string()),
                key::l | key::L if browser => Some("address".to_string()),
                key::r | key::R if browser => Some("reload".to_string()),
                key::Tab | key::ISO_Left_Tab => {
                    Some(if shift { "previous-tab" } else { "next-tab" }.to_string())
                }
                key::Page_Up => Some("previous-tab".to_string()),
                key::Page_Down => Some("next-tab".to_string()),
                _ => k
                    .to_unicode()
                    .filter(|c| ('1'..='9').contains(c))
                    .map(|c| format!("select-{c}")),
            }
        } else if alt && !ctrl && browser {
            if k == key::Left {
                Some("back".into())
            } else if k == key::Right {
                Some("forward".into())
            } else {
                None
            }
        } else if k == key::F5 && browser {
            Some("reload".into())
        } else {
            None
        };
        if let Some(action) = action {
            let _ = app.emit_to(&label, "desktop:tab-action", action);
            glib::Propagation::Stop
        } else {
            glib::Propagation::Proceed
        }
    });
}
#[cfg(not(target_os = "linux"))]
pub(super) fn install(_window: &tauri::Window) {}
