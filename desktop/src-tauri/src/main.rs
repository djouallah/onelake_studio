#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The desktop app's window. All it does is start the app's Node process (src/desktop/main.js), show a
// splash until that says where it is, and then open that page. Everything else is the extension's.
// After its first line, each line the Node process says is something only the window can do: exit, zoom.
// When it ends, the splash comes back with Restart.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// The Node process, and the splash's address. Its stdin is held here and closes with this process, which
// is how it knows to go.
struct App {
    child: Mutex<Option<Child>>,
    splash: OnceLock<Url>,
}

fn log_file() -> PathBuf {
    std::env::temp_dir().join("onelake-studio-app.log")
}

fn said(line: &str) -> serde_json::Value {
    serde_json::from_str(line.trim()).unwrap_or_default()
}

// The one line the Node process says when it's ready: {"url":"..."} or {"error":"..."}.
fn start(app: &AppHandle) -> Result<(Child, String, BufReader<ChildStdout>), String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    // Node can't take a path with the \\?\ prefix as its working directory.
    let dir = PathBuf::from(resources.to_string_lossy().trim_start_matches(r"\\?\").to_string()).join("app");
    let log = File::create(log_file()).map_err(|e| e.to_string())?;
    let mut child = Command::new(dir.join("node.exe"))
        .args(["--no-warnings", "dist/desktop.js"])
        .current_dir(&dir)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", dir.join("node.exe").display()))?;
    let mut out = BufReader::new(child.stdout.take().ok_or("no stdout")?);
    let mut line = String::new();
    out.read_line(&mut line).map_err(|e| e.to_string())?;
    let first = said(&line);
    if let Some(url) = first["url"].as_str() {
        return Ok((child, url.to_string(), out));
    }
    let _ = child.kill();
    Err(first["error"].as_str().map(String::from)
        .unwrap_or_else(|| format!("OneLake Studio stopped as it started: see {}", log_file().display())))
}

// The splash again, saying why: ?failed=<why> or ?stopped.
fn splash(window: &WebviewWindow, key: &str, value: &str) {
    if let Some(home) = window.state::<App>().splash.get() {
        let mut url = home.clone();
        url.query_pairs_mut().clear().append_pair(key, value);
        let _ = window.navigate(url);
    }
}

// Start the Node process, show its page, and do what it asks until it ends.
fn launch(window: WebviewWindow) {
    std::thread::spawn(move || {
        let handle = window.app_handle().clone();
        let (child, url, out) = match start(&handle) {
            Ok(started) => started,
            Err(e) => return splash(&window, "failed", &e),
        };
        *handle.state::<App>().child.lock().unwrap() = Some(child);
        if let Ok(parsed) = url.parse() {
            let _ = window.navigate(parsed);
        }
        for line in out.lines() {
            let Ok(line) = line else { break };
            let asked = said(&line);
            match asked["do"].as_str() {
                Some("exit") => handle.exit(0),
                Some("zoom") => {
                    if let Some(factor) = asked["factor"].as_f64() {
                        let _ = window.set_zoom(factor);
                    }
                }
                _ => {}
            }
        }
        // Its stdout ended, so the Node process is gone.
        if let Some(mut child) = handle.state::<App>().child.lock().unwrap().take() {
            let _ = child.kill();
        }
        splash(&window, "stopped", "1");
    });
}

#[tauri::command]
fn restart(window: WebviewWindow) {
    launch(window);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // --smoke <file>: start, write what the Node process said, and exit. For CI.
    let smoke = args.iter().position(|a| a == "--smoke").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    let mut builder = tauri::Builder::default();
    if smoke.is_none() {
        // A second start shows the first window: two would run two engines on the same cache.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build());
    }
    builder
        .manage(App { child: Mutex::new(None), splash: OnceLock::new() })
        .invoke_handler(tauri::generate_handler![restart])
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("OneLake Studio")
                .inner_size(1360.0, 860.0)
                .min_inner_size(640.0, 420.0)
                .theme(Some(tauri::Theme::Dark))
                // Tauri's own file drop takes every drag on Windows, so a page's drag and drop (the pivot's
                // fields, the tree's tables) would never get its drop.
                .disable_drag_drop_handler()
                .visible(smoke.is_none())
                .build()?;
            let _ = app.state::<App>().splash.set(window.url()?);
            let Some(path) = smoke.clone() else {
                launch(window);
                return Ok(());
            };
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let started = start(&handle);
                let (said, code) = match &started {
                    Ok((_, url, _)) => (format!("{{\"ok\":true,\"origin\":\"{}\"}}", url.split("/?").next().unwrap_or("")), 0),
                    Err(e) => (format!("{{\"ok\":false,\"error\":{:?}}}", e), 1),
                };
                let _ = std::fs::write(path, said);
                if let Ok((mut child, _, _)) = started {
                    let _ = child.kill();
                }
                handle.exit(code);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the app failed to run");
}
