use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Typescript;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_log::{Target, TargetKind};
use tauri_specta::{Builder, Event, collect_commands, collect_events};

#[tauri::command]
#[specta::specta]
fn set_overlay_interactive(app: AppHandle, interactive: bool) {
    if let Some(window) = app.get_webview_window("main") {
        // let _ = window.set_ignore_cursor_events(!interactive);
        if interactive {
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            let _ = window.hide();
        }
        let _ = OverlayModeEvent(interactive).emit(&app);
    }
}

#[derive(Serialize, Deserialize, Clone, Type, Event)]
pub struct OverlayModeEvent(pub bool);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![set_overlay_interactive])
        .events(collect_events![OverlayModeEvent])
        .error_handling(tauri_specta::ErrorHandlingMode::Result);

    #[cfg(debug_assertions)]
    builder
        .export(Typescript::default(), "../src/lib/bindings.ts")
        .expect("Failed to export typescript bindings");

    let toggle_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyK);

    tauri::Builder::default()
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
                    if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                        set_overlay_interactive(app.clone(), true);
                    }
                })
                .build(),
        )
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            app.global_shortcut().register(toggle_shortcut)?;

            if let Some(main_win) = app.get_webview_window("main") {
                // #[cfg(debug_assertions)]
                // main_win.open_devtools();

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

                if let Ok(hwnd) = main_win.hwnd() {
                    use windows::Win32::Foundation::HWND;
                    use windows::Win32::Graphics::Dwm::{
                        DWMWA_TRANSITIONS_FORCEDISABLED, DwmSetWindowAttribute,
                    };
                    let disable = 1;
                    unsafe {
                        let _ = DwmSetWindowAttribute(
                            HWND(hwnd.0),
                            DWMWA_TRANSITIONS_FORCEDISABLED,
                            &disable as *const _ as *const _,
                            std::mem::size_of::<i32>() as u32,
                        );
                    }
                }

                if let Ok(Some(main_monitor)) = main_win.primary_monitor() {
                    let scale = main_monitor.scale_factor();
                    let pos = main_monitor.position().to_logical::<f64>(scale);
                    let size = main_monitor.size().to_logical::<f64>(scale);

                    let _ = main_win.set_position(tauri::Position::Logical(pos));
                    let _ = main_win.set_size(tauri::Size::Logical(size));
                }
                // let _ = main_win.set_ignore_cursor_events(true);
                let _ = main_win.hide();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
