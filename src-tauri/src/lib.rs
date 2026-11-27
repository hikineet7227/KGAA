mod context;

use context::ContextPulse;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Typescript;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_log::{Target, TargetKind};
use tauri_specta::{Builder, Event, collect_commands, collect_events};

static IS_WORKSPACE_OPEN: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub enum OverlayState {
    Passive,
    Workspace,
}

#[derive(Serialize, Deserialize, Clone, Type, Event)]
pub struct OverlayStateEvent(pub OverlayState);

#[derive(Serialize, Deserialize, Clone, Type, Event)]
pub struct ContextPulseEvent(pub ContextPulse);

fn apply_overlay_state(app: &AppHandle, state: OverlayState) {
    if let Some(window) = app.get_webview_window("main") {
        let interactive = state == OverlayState::Workspace;
        IS_WORKSPACE_OPEN.store(interactive, Ordering::SeqCst);
        let _ = window.set_ignore_cursor_events(!interactive);
        if interactive {
            let _ = window.set_focus();
        } else {
            context::restore_last_external_focus();
        }
        let _ = OverlayStateEvent(state).emit(app);
    }
}

#[tauri::command]
#[specta::specta]
fn set_overlay_state(app: AppHandle, state: OverlayState) {
    apply_overlay_state(&app, state);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![set_overlay_state])
        .events(collect_events![OverlayStateEvent, ContextPulseEvent])
        .error_handling(tauri_specta::ErrorHandlingMode::Result);

    #[cfg(debug_assertions)]
    builder
        .export(Typescript::default(), "../src/lib/bindings.ts")
        .expect("Failed to export typescript bindings");

    let snap_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyK);

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_x::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &snap_shortcut && event.state() == ShortcutState::Pressed {
                        if IS_WORKSPACE_OPEN.load(Ordering::SeqCst) {
                            apply_overlay_state(app, OverlayState::Passive);
                            return;
                        }

                        // PHA 1 (< 1ms): Khóa HWND/PID và mở Workspace NGAY LẬP TỨC (0ms latency)
                        let locked_target = context::lock_foreground_target();
                        apply_overlay_state(app, OverlayState::Workspace);

                        // PHA 2 (Luồng nền): Bóc UI Automation + Clipboard rồi đẩy thẻ vào sau
                        if let Some(target) = locked_target {
                            let app_handle = app.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                let pulse =
                                    context::resolve_pulse_background(app_handle.clone(), target);
                                let _ = ContextPulseEvent(pulse).emit(&app_handle);
                            });
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            app.global_shortcut().register(snap_shortcut)?;

            if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.with_webview(|webview| {
                    #[cfg(target_os = "windows")]
                    unsafe {
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                        use windows::core::{IUnknown, Interface};

                        if let Ok(core) = webview.controller().CoreWebView2()
                            && let Ok(settings) = core.Settings()
                        {
                            let unknown = IUnknown::from_raw(std::mem::transmute_copy(&settings));
                            if let Ok(settings3) = unknown.cast::<ICoreWebView2Settings3>() {
                                let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
                            }
                            std::mem::forget(unknown);
                        }
                    }
                });

                if let Ok(Some(main_monitor)) = main_win.primary_monitor() {
                    let scale = main_monitor.scale_factor();
                    let pos = main_monitor.position().to_logical::<f64>(scale);
                    let size = main_monitor.size().to_logical::<f64>(scale);

                    let _ = main_win.set_position(tauri::Position::Logical(pos));
                    let _ = main_win.set_size(tauri::Size::Logical(size));
                }
                let _ = main_win.set_ignore_cursor_events(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
