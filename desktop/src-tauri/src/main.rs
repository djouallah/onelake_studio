#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The desktop app's window. All it does is start the app's Node process (src/desktop/main.js), show a
// splash until that says where it is, and then open that page. Everything else is the extension's.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// The Node process. Its stdin is held here and closes with this process, which is how it knows to go.
struct App(Mutex<Option<Child>>);

fn log_file() -> PathBuf {
    std::env::temp_dir().join("onelake-studio-app.log")
}

// The one line the Node process says when it's ready: {"url":"..."} or {"error":"..."}.
fn field(line: &str, name: &str) -> Option<String> {
    let key = format!("\"{name}\":\"");
    let start = line.find(&key)? + key.len();
    let end = line[start..].find('"')? + start;
    Some(line[start..end].replace("\\u0026", "&"))
}

fn start(app: &AppHandle) -> Result<(Child, String), String> {
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
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).map_err(|e| e.to_string())?;
    if let Some(url) = field(&line, "url") {
        return Ok((child, url));
    }
    let _ = child.kill();
    Err(field(&line, "error").unwrap_or_else(|| format!("OneLake Studio stopped as it started: see {}", log_file().display())))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // --smoke <file>: start, write what the Node process said, and exit. For CI.
    let smoke = args.iter().position(|a| a == "--smoke").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    tauri::Builder::default()
        .manage(App(Mutex::new(None)))
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("OneLake Studio")
                .inner_size(1360.0, 860.0)
                .min_inner_size(640.0, 420.0)
                // Tauri's own file drop takes every drag on Windows, so a page's drag and drop (the pivot's
                // fields, the tree's tables) would never get its drop.
                .disable_drag_drop_handler()
                .visible(smoke.is_none())
                .build()?;
            let handle = app.handle().clone();
            let smoke = smoke.clone();
            std::thread::spawn(move || {
                let started = start(&handle);
                if let Some(path) = smoke {
                    let (said, code) = match &started {
                        Ok((_, url)) => (format!("{{\"ok\":true,\"origin\":\"{}\"}}", url.split("/?").next().unwrap_or("")), 0),
                        Err(e) => (format!("{{\"ok\":false,\"error\":{:?}}}", e), 1),
                    };
                    let _ = std::fs::write(path, said);
                    if let Ok((mut child, _)) = started { let _ = child.kill(); }
                    handle.exit(code);
                    return;
                }
                match started {
                    Ok((child, url)) => {
                        *handle.state::<App>().0.lock().unwrap() = Some(child);
                        if let Ok(parsed) = url.parse() {
                            let _ = window.navigate(parsed);
                        }
                    }
                    Err(e) => {
                        let _ = window.eval(&format!("window.failed({:?})", e));
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the app failed to run");
}
