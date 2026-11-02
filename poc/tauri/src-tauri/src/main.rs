#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Manager, State, WebviewWindow};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// The Node process holding DuckDB and the sign-in. It exits when its stdin closes, with this app.
struct Sidecar {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

struct Holder(Mutex<Result<Sidecar, String>>);

struct Run {
    started: Instant,
    smoke: Option<PathBuf>,
}

fn sidecar_log() -> PathBuf {
    std::env::temp_dir().join("onelake-poc-sidecar.log")
}

fn start_sidecar(app: &AppHandle) -> Result<Sidecar, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    // Node can't take a path with the \\?\ prefix as its working directory.
    let dir = PathBuf::from(resources.to_string_lossy().trim_start_matches(r"\\?\").to_string()).join("sidecar");
    let log = File::create(sidecar_log()).map_err(|e| e.to_string())?;
    let mut child = Command::new(dir.join("node.exe"))
        .arg("server.mjs")
        .current_dir(&dir)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", dir.join("node.exe").display()))?;
    let stdin = child.stdin.take().ok_or("the sidecar has no stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("the sidecar has no stdout")?);
    Ok(Sidecar { _child: child, stdin, stdout })
}

// One request at a time, off the main thread: a sign-in can wait for minutes.
#[tauri::command]
async fn rpc(app: AppHandle, request: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let state = app.state::<Holder>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let sidecar = guard.as_mut().map_err(|e| e.clone())?;
        writeln!(sidecar.stdin, "{request}").map_err(|e| e.to_string())?;
        sidecar.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        let read = sidecar.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
        if read == 0 {
            return Err(format!("the sidecar exited, see {}", sidecar_log().display()));
        }
        Ok(line)
    })
    .await
    .map_err(|e| e.to_string())?
}

// The broker parents its sign-in dialog to this window.
#[tauri::command]
fn window_handle(window: WebviewWindow) -> Result<String, String> {
    window.hwnd().map(|h| (h.0 as isize).to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn since_start_ms(run: State<Run>) -> u128 {
    run.started.elapsed().as_millis()
}

#[tauri::command]
fn is_smoke(run: State<Run>) -> bool {
    run.smoke.is_some()
}

#[tauri::command]
fn smoke_done(app: AppHandle, run: State<Run>, result: String, ok: bool) -> Result<(), String> {
    let path = run.smoke.as_ref().ok_or("not a smoke run")?;
    std::fs::write(path, result).map_err(|e| e.to_string())?;
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let smoke = args.iter().position(|a| a == "--smoke").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    tauri::Builder::default()
        .manage(Holder(Mutex::new(Err("the sidecar has not started".into()))))
        .manage(Run { started: Instant::now(), smoke })
        .setup(|app| {
            let started = start_sidecar(app.handle());
            *app.state::<Holder>().0.lock().unwrap() = started;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc, window_handle, since_start_ms, is_smoke, smoke_done])
        .run(tauri::generate_context!())
        .expect("the app failed to run");
}
