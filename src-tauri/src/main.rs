// Daily brief for macOS: a small shell around the local Next.js server.
//
// On start it reuses a Daily brief server already on 127.0.0.1:4242 (say, the old launchd agent
// or `npm start`). Otherwise it starts the bundled Next standalone server with the system Node,
// waits for /api/health, and then shows the window. Closing the window hides it to the menu bar.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

const PORT: u16 = 4242;
/// The window uses localhost (not 127.0.0.1) because the server's links and the Wispr Flow
/// sign-in callback use http://localhost:4242, and cookies are per host.
const APP_URL: &str = "http://localhost:4242";
/// Passed by the login item, so a launch at login stays in the menu bar.
const HIDDEN_ARG: &str = "--hidden";
const WINDOW: &str = "main";

#[derive(Default)]
struct Server {
    /// The server process this app started. None when it reused one that was already running.
    child: Mutex<Option<Child>>,
    node: Mutex<Option<PathBuf>>,
    quitting: AtomicBool,
    /// Open was pressed before the window existed.
    want_show: AtomicBool,
}

// ---------- a tiny HTTP client for 127.0.0.1 (no extra crates) ----------

fn http(method: &str, path: &str, timeout: Duration) -> std::io::Result<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut s = TcpStream::connect_timeout(&addr, timeout)?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nX-Daily-Brief: tray\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    Ok((status, text))
}

enum Port {
    DailyBrief,
    Free,
    /// Something answers on the port, but not with Daily brief's /api/health.
    Other(u16),
}

fn probe() -> Port {
    match http("GET", "/api/health", Duration::from_secs(3)) {
        Ok((200, body)) if body.contains("\"app\":\"daily-brief\"") => Port::DailyBrief,
        Ok((status, _)) => Port::Other(status),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => Port::Free,
        Err(_) => Port::Other(0),
    }
}

fn wait_healthy(limit: Duration, alive: impl Fn() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < limit {
        if matches!(probe(), Port::DailyBrief) {
            return true;
        }
        if !alive() {
            return false;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

// ---------- finding Node and starting the server ----------

fn node_version(node: &Path) -> Option<(u32, u32)> {
    let out = Command::new(node).arg("-v").output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout);
    let mut it = v.trim().trim_start_matches('v').split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

/// Apps opened from Finder get a bare PATH, so look in the usual places, then ask a login shell.
fn find_node() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        "/opt/homebrew/bin/node".into(),
        "/usr/local/bin/node".into(),
    ];
    if let Ok(out) = Command::new("/bin/zsh")
        .args(["-lc", "command -v node"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if p.starts_with('/') {
            candidates.push(p.into());
        }
    }
    // Next 15 needs Node 18.18 or later.
    candidates.into_iter().filter(|p| p.is_file()).find(|p| {
        matches!(node_version(p), Some((major, minor)) if major > 18 || (major == 18 && minor >= 18))
    })
}

fn log_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Library/Logs/daily-brief.log")
}

fn spawn_server(app: &AppHandle, node: &Path) -> Result<Child, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Couldn't find the app's resources: {e}"))?
        .join("server");
    let script = dir.join("server.js");
    if !script.is_file() {
        return Err(format!(
            "The server is missing from the app ({}). Rebuild it with npm run mac:build.",
            script.display()
        ));
    }
    let log = log_path();
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|e| format!("Couldn't open {}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    Command::new(node)
        .arg(&script)
        .current_dir(&dir)
        .env("PORT", PORT.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("APP_URL", APP_URL)
        // Secrets come from the macOS Keychain (see src/server/local/secrets.ts), never from here.
        .env("DAILY_BRIEF_KEYCHAIN", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("Couldn't start Node ({}): {e}", node.display()))
}

fn child_alive(app: &AppHandle) -> bool {
    let state = app.state::<Server>();
    let mut guard = state.child.lock().unwrap();
    match guard.as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => false,
    }
}

/// Reuses a running server, or starts ours. On failure returns (title, detail) for the error page.
fn ensure_server(app: &AppHandle) -> Result<(), (String, String)> {
    match probe() {
        Port::DailyBrief => return Ok(()),
        Port::Other(status) => {
            return Err((
                "Port 4242 is taken".into(),
                format!(
                    "Something other than this version of Daily brief answers on port 4242 (HTTP {status}). If it's an older Daily brief started at login, run npm run uninstall-login in the project folder, then open the app again."
                ),
            ))
        }
        Port::Free => {}
    }
    let node = find_node().ok_or_else(|| {
        (
            "Daily brief needs Node.js".to_string(),
            "No Node.js 18.18 or later was found in /opt/homebrew/bin, /usr/local/bin or your shell's PATH. Install it (brew install node), then open the app again.".to_string(),
        )
    })?;
    let child =
        spawn_server(app, &node).map_err(|e| ("Daily brief couldn't start".to_string(), e))?;
    let state = app.state::<Server>();
    *state.node.lock().unwrap() = Some(node);
    *state.child.lock().unwrap() = Some(child);
    if wait_healthy(Duration::from_secs(60), || child_alive(app)) {
        Ok(())
    } else {
        stop_server(app);
        Err((
            "Daily brief couldn't start".into(),
            format!(
                "The server didn't come up. Details are in {}.",
                log_path().display()
            ),
        ))
    }
}

/// Stops the server this app started (never one it reused).
fn stop_server(app: &AppHandle) {
    let state = app.state::<Server>();
    let Some(mut child) = state.child.lock().unwrap().take() else {
        return;
    };
    // SIGTERM first so the server can finish writing state.json; SIGKILL after 5 s.
    let _ = Command::new("/bin/kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Restarts the server we started if it stops (at most 5 times in 10 minutes).
fn watch_server(app: AppHandle) {
    thread::spawn(move || {
        let mut restarts: Vec<Instant> = Vec::new();
        loop {
            thread::sleep(Duration::from_secs(5));
            let state = app.state::<Server>();
            if state.quitting.load(Ordering::SeqCst) {
                return;
            }
            let exited = {
                let mut guard = state.child.lock().unwrap();
                match guard.as_mut() {
                    Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                    None => return, // reusing a server someone else runs
                }
            };
            if !exited {
                continue;
            }
            restarts.retain(|t| t.elapsed() < Duration::from_secs(600));
            if restarts.len() >= 5 {
                eprintln!(
                    "[daily-brief] the server keeps stopping; see {}",
                    log_path().display()
                );
                return;
            }
            restarts.push(Instant::now());
            let node = state.node.lock().unwrap().clone();
            let Some(node) = node else { return };
            match spawn_server(&app, &node) {
                Ok(child) => {
                    *state.child.lock().unwrap() = Some(child);
                    if wait_healthy(Duration::from_secs(60), || child_alive(&app)) {
                        if let Some(w) = app.get_webview_window(WINDOW) {
                            let _ = w.eval("location.reload()");
                        }
                    }
                }
                Err(e) => eprintln!("[daily-brief] restart failed: {e}"),
            }
        }
    });
}

// ---------- window ----------

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn open_in_browser(url: &str) {
    let _ = Command::new("/usr/bin/open").arg(url).spawn();
}

fn show_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window(WINDOW) else {
        app.state::<Server>()
            .want_show
            .store(true, Ordering::SeqCst);
        return;
    };
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn hide_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.hide();
    }
    // No Dock icon while only the menu bar item is showing.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Starts or reuses the server off the main thread, then opens the window (hidden at login).
fn start(app: AppHandle, start_hidden: bool) {
    thread::spawn(move || {
        let result = ensure_server(&app);
        let url = match &result {
            Ok(()) => WebviewUrl::External(APP_URL.parse().expect("valid url")),
            Err((title, detail)) => WebviewUrl::App(
                format!(
                    "index.html?title={}&detail={}",
                    percent_encode(title),
                    percent_encode(detail)
                )
                .into(),
            ),
        };
        let built = WebviewWindowBuilder::new(&app, WINDOW, url)
            .title("Daily brief")
            .inner_size(1120.0, 800.0)
            .min_inner_size(420.0, 480.0)
            .visible(false)
            // Links that open a new window (target=_blank) go to the default browser.
            .on_new_window(|url, _| {
                open_in_browser(url.as_str());
                NewWindowResponse::Deny
            })
            .build();
        if let Err(e) = built {
            eprintln!("[daily-brief] couldn't open the window: {e}");
            return;
        }
        // Errors always show, even at login, so a broken setup isn't silent.
        let want = app.state::<Server>().want_show.load(Ordering::SeqCst);
        if !start_hidden || want || result.is_err() {
            show_window(&app);
        }
        if result.is_ok() {
            watch_server(app.clone());
        }
    });
}

// ---------- menu bar ----------

fn check_meetings_now() {
    thread::spawn(
        || match http("POST", "/api/check-now", Duration::from_secs(10)) {
            Ok((202, _)) => {}
            Ok((status, _)) => eprintln!("[daily-brief] check-now returned HTTP {status}"),
            Err(e) => eprintln!("[daily-brief] check-now failed: {e}"),
        },
    );
}

fn quit(app: &AppHandle) {
    app.state::<Server>().quitting.store(true, Ordering::SeqCst);
    stop_server(app);
    app.exit(0);
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let open = MenuItem::with_id(app, "open", "Open Daily brief", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", "Open in browser", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Check meetings now", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "login",
        "Launch at login",
        true,
        at_login,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Daily brief", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&open, &browser, &check, &sep1, &login, &sep2, &quit_item],
    )?;

    let login_item = login.clone();
    TrayIconBuilder::with_id("tray")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Daily brief")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "browser" => open_in_browser(APP_URL),
            "check" => check_meetings_now(),
            "login" => {
                let al = app.autolaunch();
                let res = if al.is_enabled().unwrap_or(false) {
                    al.disable()
                } else {
                    al.enable()
                };
                if let Err(e) = res {
                    eprintln!("[daily-brief] launch at login: {e}");
                }
                let _ = login_item.set_checked(al.is_enabled().unwrap_or(false));
            }
            "quit" => quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let start_hidden = std::env::args().any(|a| a == HIDDEN_ARG);
    let app = tauri::Builder::default()
        .plugin(
            // A per-user LaunchAgent (the plugin's default on macOS), toggled from the menu bar.
            tauri_plugin_autostart::Builder::new()
                .args([HIDDEN_ARG])
                .build(),
        )
        .manage(Server::default())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            if start_hidden {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            setup_tray(app.handle())?;
            start(app.handle().clone(), start_hidden);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_window(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Daily brief");

    app.run(|app, event| match event {
        // Clicking the Dock icon (or opening the app again) brings the window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_window(app),
        // Cmd-Q or Quit: stop the server we started.
        RunEvent::Exit => {
            app.state::<Server>().quitting.store(true, Ordering::SeqCst);
            stop_server(app);
        }
        _ => {}
    });
}
