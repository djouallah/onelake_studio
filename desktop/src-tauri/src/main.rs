#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The desktop app's window. All it does is start the app's Node process (desktop/node/main.js), show a
// splash until that says where it is, and then open that page. Everything else is the extension's.
// After its first line, each line the Node process says is something only the window can do: exit, zoom.
// When it ends, the splash comes back with Restart. A file the app is started with (a double-click on a
// .fabricapp, "Open with" on a model) is a line on the Node process's stdin: {"open":"<path>"}.

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
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
    // Files asked for before the Node process runs: opened once it does.
    pending: Mutex<Vec<String>>,
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn is_yaml(p: &Path) -> bool {
    matches!(ext_of(p).as_str(), "yaml" | "yml")
}

// Whether a YAML file is an Ossie model: named *.ossie.yaml as Ossie's tools name one, or its top level
// has the spec's version and datasets (page/semantic.js isOssie). A dbt schema.yml has neither.
fn is_model_yaml(p: &Path) -> bool {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
    if name.ends_with(".ossie.yaml") || name.ends_with(".ossie.yml") {
        return true;
    }
    let Ok(f) = File::open(p) else { return false };
    let mut head = Vec::new();
    let _ = std::io::Read::read_to_end(&mut std::io::Read::take(f, 1 << 20), &mut head);
    let text = String::from_utf8_lossy(&head);
    let text = text.trim_start_matches('\u{feff}');
    text.lines().any(|l| l.starts_with("datasets:")) && text.lines().any(|l| l.starts_with("version:"))
}

// The files among a start's arguments that the app opens: a .fabricapp, a .bim, a model .yaml or .yml.
fn files_in(args: &[String]) -> Vec<String> {
    args.iter().skip(1)
        .filter(|a| {
            let p = Path::new(a.as_str());
            p.is_file() && match ext_of(p).as_str() {
                "fabricapp" | "bim" => true,
                "yaml" | "yml" => is_model_yaml(p),
                _ => false,
            }
        })
        .cloned()
        .collect()
}

// The YAML files among a start's arguments that are not models: when the app is .yaml's default
// program, a double-click on any YAML starts it, and these go on to the program that opens YAML
// otherwise, before a window shows.
fn other_yaml_in(args: &[String]) -> Vec<String> {
    args.iter().skip(1)
        .filter(|a| { let p = Path::new(a.as_str()); is_yaml(p) && p.is_file() && !is_model_yaml(p) })
        .cloned()
        .collect()
}

// A key's values as reg.exe prints them, (name, text after its type); `default`: its default value alone.
fn reg_values(key: &str, default: bool) -> Vec<(String, String)> {
    let mut cmd = Command::new("reg.exe");
    cmd.arg("query").arg(key).creation_flags(CREATE_NO_WINDOW);
    if default { cmd.arg("/ve"); }
    let Ok(out) = cmd.output() else { return vec![] };
    String::from_utf8_lossy(&out.stdout).lines()
        .filter_map(|l| {
            let l = l.trim_start();
            ["REG_EXPAND_SZ", "REG_SZ"].iter().find_map(|t| {
                let at = l.find(&format!("    {t}"))?;
                Some((l[..at].trim().to_string(), l[at + 4 + t.len()..].trim().to_string()))
            })
        })
        .collect()
}

// %NAME% from the environment, as an REG_EXPAND_SZ command has it. %1, %L and %* are not names.
fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let value = after.find('%').and_then(|j| {
            let name = &after[..j];
            let named = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || "_()".contains(c));
            if named { std::env::var(name).ok().map(|v| (v, j)) } else { None }
        });
        match value {
            Some((v, j)) => { out.push_str(&v); rest = &after[j + 1..]; }
            None => { out.push('%'); rest = after; }
        }
    }
    out.push_str(rest);
    out
}

// The other program that opens this extension: its ProgIds in "Open with", VS Code's first, and
// each one's open command. Started with the file as Explorer would, else Windows' own "Open with".
fn open_elsewhere(path: &str) {
    let ext = format!(".{}", ext_of(Path::new(path)));
    let mut ids: Vec<String> = reg_values(&format!(r"HKCR\{ext}\OpenWithProgids"), false).into_iter()
        .map(|(name, _)| name)
        .chain(reg_values(&format!(r"HKCR\{ext}"), true).into_iter().map(|(_, v)| v))
        .filter(|id| !id.is_empty() && !id.eq_ignore_ascii_case("OneLakeStudio.Model"))
        .collect();
    ids.sort_by_key(|id| !id.to_ascii_lowercase().starts_with("vscode"));
    for id in ids {
        let Some((_, command)) = reg_values(&format!(r"HKCR\{id}\shell\open\command"), true).into_iter().next() else { continue };
        let command = expand_env(&command);
        let (exe, rest) = match command.strip_prefix('"').and_then(|c| c.split_once('"')) {
            Some((exe, rest)) => (exe.to_string(), rest.to_string()),
            None => match command.split_once(' ') {
                Some((exe, rest)) => (exe.to_string(), format!(" {rest}")),
                None => (command.clone(), String::new()),
            },
        };
        if !Path::new(&exe).is_file() { continue; }
        let rest = rest.replace("%1", path).replace("%L", path).replace("%l", path).replace("%*", "");
        let rest = if rest.contains(path) { rest } else { format!("{rest} \"{path}\"") };
        if Command::new(&exe).raw_arg(rest.trim()).spawn().is_ok() {
            return;
        }
    }
    let _ = Command::new("rundll32.exe").arg("shell32.dll,OpenAs_RunDLL").arg(path).spawn();
}

// A file to open: a line on the Node process's stdin, or kept until it runs.
fn open_file(app: &AppHandle, path: String) {
    let state = app.state::<App>();
    let mut child = state.child.lock().unwrap();
    if let Some(stdin) = child.as_mut().and_then(|c| c.stdin.as_mut()) {
        let _ = writeln!(stdin, "{}", serde_json::json!({ "open": path }));
        let _ = stdin.flush();
    } else {
        state.pending.lock().unwrap().push(path);
    }
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
        let waiting: Vec<String> = handle.state::<App>().pending.lock().unwrap().drain(..).collect();
        for path in waiting {
            open_file(&handle, path);
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
    // YAML that is not a model goes on to its own program; started with nothing else, the app is not shown.
    let others = other_yaml_in(&args);
    for path in &others {
        open_elsewhere(path);
    }
    if !others.is_empty() && files_in(&args).is_empty() {
        return;
    }
    let mut builder = tauri::Builder::default();
    if smoke.is_none() {
        // A second start shows the first window: two would run two engines on the same cache.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
                for path in files_in(&argv) {
                    open_file(app, path);
                }
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
        .manage(App { child: Mutex::new(None), splash: OnceLock::new(), pending: Mutex::new(files_in(&args)) })
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
