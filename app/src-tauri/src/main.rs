// No console window in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The desktop shell of codex-audio.
//!
//! The Bun sidecar does the work: microphone, shortcut, transcription and
//! settings. This file only starts the sidecar, forwards its events to the
//! windows, shows the recording pill, adds the tray icon, and starts the app
//! with Windows when the user asks for it.

use std::sync::Mutex;

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, State, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// The running sidecar. Its stdin takes one JSON command per line.
struct Sidecar(Mutex<Option<CommandChild>>);

/// The argument that Windows gives the app when it starts at sign-in.
const AUTOSTART_ARG: &str = "--autostart";

/// Distance from the bottom of the screen to the pill, in logical pixels.
const PILL_BOTTOM_GAP: f64 = 96.0;

#[tauri::command]
fn send(line: String, sidecar: State<Sidecar>) -> Result<(), String> {
    let mut guard = sidecar.0.lock().map_err(|e| e.to_string())?;
    let child = guard.as_mut().ok_or("the background process is not running")?;
    child
        .write(format!("{line}\n").as_bytes())
        .map_err(|e| e.to_string())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Show the pill at the bottom center of the screen. The pill window cannot
/// take focus, so the text still goes to the window the user works in.
fn show_pill(app: &AppHandle) {
    let Some(pill) = app.get_webview_window("overlay") else {
        return;
    };
    if let (Ok(Some(monitor)), Ok(size)) = (pill.primary_monitor(), pill.outer_size()) {
        let area = monitor.size();
        let origin = monitor.position();
        let x = origin.x + (area.width as i32 - size.width as i32) / 2;
        let y = origin.y + area.height as i32
            - size.height as i32
            - (PILL_BOTTOM_GAP * monitor.scale_factor()) as i32;
        let _ = pill.set_position(PhysicalPosition::new(x, y));
    }
    let _ = pill.show();
}

fn hide_pill(app: &AppHandle) {
    if let Some(pill) = app.get_webview_window("overlay") {
        let _ = pill.hide();
    }
}

fn on_sidecar_line(app: &AppHandle, line: &str) {
    let Ok(event) = serde_json::from_str::<Value>(line) else {
        eprintln!("sidecar: {line}");
        return;
    };
    if event["ev"] == "state" {
        match event["state"].as_str() {
            Some("opening") | Some("recording") | Some("transcribing") => show_pill(app),
            _ => hide_pill(app),
        }
    }
    let _ = app.emit("sidecar", event);
}

fn start_sidecar(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;

    // A dev build runs the sidecar from its source, so a restart always uses
    // the latest code. (`tauri dev` restarts the app without a new sidecar exe.)
    #[cfg(debug_assertions)]
    let command = app.shell().command("bun").args([
        "run",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../ts/src/sidecar.ts"),
    ]);
    #[cfg(not(debug_assertions))]
    let command = app.shell().sidecar("codex-audio-sidecar")?;

    let (mut events, child) = command
        .args(["--data-dir", &data_dir.to_string_lossy()])
        .spawn()?;
    app.manage(Sidecar(Mutex::new(Some(child))));

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        on_sidecar_line(&app, line);
                    }
                }
                CommandEvent::Stderr(bytes) => eprint!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Terminated(status) => {
                    hide_pill(&app);
                    let message = format!(
                        "The background process stopped (exit code {:?}). Restart the app.",
                        status.code
                    );
                    let _ = app.emit(
                        "sidecar",
                        serde_json::json!({ "ev": "state", "state": "error", "message": message }),
                    );
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Close the sidecar's stdin, so it stops the microphone and exits, then quit.
fn quit(app: &AppHandle) {
    if let Some(sidecar) = app.try_state::<Sidecar>() {
        if let Ok(mut guard) = sidecar.0.lock() {
            drop(guard.take());
        }
    }
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .invoke_handler(tauri::generate_handler![send])
        .setup(|app| {
            start_sidecar(app.handle())?;

            // The main window starts hidden. Show it, except when Windows
            // starts the app at sign-in: then only the tray icon shows.
            if !std::env::args().any(|arg| arg == AUTOSTART_ARG) {
                show_main(app.handle());
            }

            // The pill has no buttons. Clicks go through it to the app below.
            if let Some(pill) = app.get_webview_window("overlay") {
                pill.set_ignore_cursor_events(true)?;
            }

            let open = MenuItem::with_id(app, "open", "Open codex-audio", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &exit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .tooltip("codex-audio")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window only hides it. The tray menu quits.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running codex-audio");
}
