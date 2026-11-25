use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Typescript;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_log::{Target, TargetKind};
use tauri_specta::{Builder, collect_commands};

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: u32,
    pub username: String,
}

#[tauri::command]
#[specta::specta]
fn set_overlay_interactive(app: AppHandle, interactive: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_ignore_cursor_events(!interactive);
        if interactive {
            let _ = window.set_focus();
        }
        let _ = app.emit("overlay-mode", interactive);
    }
}

#[tauri::command]
#[specta::specta]
fn get_user() -> UserInfo {
    UserInfo {
        id: 1,
        username: "dev_svelte".into(),
    }
}

#[tauri::command]
#[specta::specta]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![greet, get_user, set_overlay_interactive])
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
                let _ = main_win.set_ignore_cursor_events(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
