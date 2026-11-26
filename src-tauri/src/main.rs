// Daily brief for macOS, Windows and Linux: a small shell around the local Next.js server.
//
// On start it reuses a Daily brief server already on 127.0.0.1:4242 (say, the old launchd agent
// or `npm start`). Otherwise it starts the bundled Next standalone server with the Node runtime
// bundled in the app (Resources/node-runtime, see scripts/node-runtime.mjs), or the system Node
// when the build has none.
// The window shows a starting page until /api/health answers. A watchdog keeps checking: if the
// server goes away (ours crashed, or the reused one was stopped), it starts ours again.
// Closing the window hides it to the menu bar (the tray on Windows and Linux), whose title shows
// how many things you owe today ("3"), refreshed every minute from /api/widget.

// No console window next to the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    /// What the window shows now (None before it exists).
    page: Mutex<Option<Page>>,
    /// Quick add was pressed before the app page loaded: open it with the capture input.
    want_capture: AtomicBool,
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

/// "v22.23.5" → (22, 23).
fn parse_node_version(v: &str) -> Option<(u32, u32)> {
    let mut it = v.trim().trim_start_matches('v').split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

/// Next 15 needs Node 18.18 or later.
fn node_version_ok(v: Option<(u32, u32)>) -> bool {
    matches!(v, Some((major, minor)) if major > 18 || (major == 18 && minor >= 18))
}

fn node_version(node: &Path) -> Option<(u32, u32)> {
    let mut cmd = Command::new(node);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .arg("-v")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    parse_node_version(&String::from_utf8_lossy(&out.stdout))
}

/// Where the build puts the bundled Node runtime, relative to the app's resources.
fn bundled_node_path(resource_dir: &Path) -> PathBuf {
    resource_dir
        .join("node-runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" })
}

/// The Node runtime bundled in the app, when the build put one there and it runs.
fn bundled_node(app: &AppHandle) -> Option<PathBuf> {
    let p = bundled_node_path(&app.path().resource_dir().ok()?);
    (p.is_file() && node_version_ok(node_version(&p))).then_some(p)
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// Where Node usually lives on this system, before asking the shell.
fn node_candidates() -> Vec<PathBuf> {
    let mut c: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        c.push("/opt/homebrew/bin/node".into());
        c.push("/usr/local/bin/node".into());
    } else if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(p) = std::env::var_os(var) {
                c.push(PathBuf::from(p).join("nodejs").join("node.exe"));
            }
        }
        if let Some(p) = std::env::var_os("NVM_SYMLINK") {
            c.push(PathBuf::from(p).join("node.exe"));
        }
        if let Some(p) = std::env::var_os("LOCALAPPDATA") {
            c.push(PathBuf::from(p).join("Volta").join("bin").join("node.exe"));
        }
    } else {
        c.push("/usr/bin/node".into());
        c.push("/usr/local/bin/node".into());
        c.push(home().join(".volta/bin/node"));
        c.push(home().join(".local/bin/node"));
        c.push("/snap/bin/node".into());
    }
    c
}

/// Asks the user's shell where node is: apps opened from Finder or a desktop launcher get a bare
/// PATH, and nvm/fnm only set it up in a login shell. On Windows, `where node`.
fn node_from_shell() -> Option<PathBuf> {
    #[cfg(windows)]
    let out = {
        use std::os::windows::process::CommandExt;
        Command::new("where")
            .arg("node")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?
    };
    #[cfg(not(windows))]
    let out = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/sh".into()
            }
        });
        Command::new(shell)
            .args(["-lc", "command -v node"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let p = text.lines().next()?.trim();
    let path = PathBuf::from(p);
    path.is_absolute().then_some(path)
}

fn find_node() -> Option<PathBuf> {
    let mut candidates = node_candidates();
    if let Some(p) = node_from_shell() {
        candidates.push(p);
    }
    candidates
        .into_iter()
        .filter(|p| p.is_file())
        .find(|p| node_version_ok(node_version(p)))
}

/// How to get Node, for the error page.
fn node_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "This copy of the app has no Node.js inside, and no Node.js 18.18 or later was found in /opt/homebrew/bin, /usr/local/bin or your shell's PATH. Install it (brew install node), then open the app again."
    } else if cfg!(windows) {
        "This copy of the app has no Node.js inside, and no Node.js 18.18 or later was found in Program Files or your PATH. Install the LTS from nodejs.org (or winget install OpenJS.NodeJS.LTS), then open the app again."
    } else {
        "This copy of the app has no Node.js inside, and no Node.js 18.18 or later was found in /usr/bin, /usr/local/bin or your shell's PATH. Install it (your package manager, nvm, or nodejs.org), then open the app again."
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The server's log. The same places as src/server/local/log.ts (and passed to it as DAILY_BRIEF_LOG).
fn log_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library/Logs/daily-brief.log")
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData").join("Local"))
            .join("Daily Brief")
            .join("daily-brief.log")
    } else {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/state"))
            .join("daily-brief")
            .join("daily-brief.log")
    }
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
            "The server is missing from the app ({}). Rebuild the app (see the README).",
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
    let mut cmd = Command::new(node);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.arg(&script)
        .current_dir(&dir)
        .env("PORT", PORT.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("APP_URL", APP_URL)
        .env("DAILY_BRIEF_LOG", &log)
        // Secrets come from the system's secret store (macOS Keychain, Windows Credential Manager,
        // the Linux keyring; see src/server/local/keychain.ts), never from here.
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
    let node = bundled_node(app).or_else(find_node).ok_or_else(|| {
        (
            "Daily brief needs Node.js".to_string(),
            node_hint().to_string(),
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
    // SIGTERM first so the server can finish writing state.json; SIGKILL after 5 s. Windows has no
    // SIGTERM for a console process, so it is stopped at once (state.json is written by rename,
    // so a stop never leaves half a file).
    #[cfg(unix)]
    let _ = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    #[cfg(windows)]
    let _ = child.kill();
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
    // Only ever our own http(s) URLs or ones a page opened; never passed through a shell.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(target_os = "macos")]
    let _ = Command::new("/usr/bin/open").arg(url).spawn();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(url).spawn();
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

/// What the window shows. The watchdog only navigates when this changes.
#[derive(Clone, PartialEq, Eq)]
enum Page {
    Starting,
    App,
    Error(String, String),
}

/// The bundled pages in src-tauri/ui (the starting and error page).
fn local_page(query: &str) -> tauri::Url {
    #[cfg(windows)]
    let base = "http://tauri.localhost/index.html";
    #[cfg(not(windows))]
    let base = "tauri://localhost/index.html";
    format!("{base}{query}").parse().expect("valid local url")
}

/// Points the window at `page` unless it already shows it. Returns true when it changed.
fn set_page(app: &AppHandle, page: &Page) -> bool {
    let state = app.state::<Server>();
    let mut current = state.page.lock().unwrap();
    if current.as_ref() == Some(page) {
        return false;
    }
    let url = match page {
        Page::Starting => local_page(""),
        Page::App if state.want_capture.swap(false, Ordering::SeqCst) => {
            format!("{APP_URL}/?capture=1").parse().expect("valid url")
        }
        Page::App => APP_URL.parse().expect("valid url"),
        Page::Error(title, detail) => local_page(&format!(
            "?title={}&detail={}",
            percent_encode(title),
            percent_encode(detail)
        )),
    };
    if let Some(w) = app.get_webview_window(WINDOW) {
        if let Err(e) = w.navigate(url) {
            eprintln!("[daily-brief] couldn't load the page: {e}");
            return false;
        }
    }
    *current = Some(page.clone());
    true
}

/// Shows an error page. Brings the window forward when the error is new, so a server that
/// stopped while the app sat in the menu bar isn't silent.
fn set_error(app: &AppHandle, title: &str, detail: String) {
    if set_page(app, &Page::Error(title.into(), detail)) {
        show_window(app);
    }
}

/// How long the server may stay unreachable before the app acts on it.
const GRACE: Duration = Duration::from_secs(10);
/// A server that answers too slowly (rather than refusing) gets longer: it may just be busy.
const SLOW_GRACE: Duration = Duration::from_secs(60);
const MAX_STARTS: usize = 5;
const START_WINDOW: Duration = Duration::from_secs(600);

/// Opens the window on the starting page, then watches the server for as long as the app runs:
/// - Daily brief answers: show it (and reload it after a restart).
/// - Nobody answers for 10 s (our server stopped, or the reused launchd server was unloaded):
///   start our own server, the same way as on first launch, at most 5 times in 10 minutes.
/// - Something else holds the port: show the error page.
fn start(app: AppHandle, start_hidden: bool) {
    thread::spawn(move || {
        let built = WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::App("index.html".into()))
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
        *app.state::<Server>().page.lock().unwrap() = Some(Page::Starting);
        let want = app.state::<Server>().want_show.load(Ordering::SeqCst);
        if !start_hidden || want {
            show_window(&app);
        }

        let mut starts: Vec<Instant> = Vec::new();
        let mut down_since: Option<Instant> = None;
        let mut first = true;
        let mut last_error: Option<(String, String)> = None;
        let mut ticks: u32 = 0;
        loop {
            let state = app.state::<Server>();
            if state.quitting.load(Ordering::SeqCst) {
                return;
            }
            let port = probe();
            if matches!(port, Port::DailyBrief) {
                down_since = None;
                set_page(&app, &Page::App);
                if ticks.is_multiple_of(COUNT_EVERY) {
                    update_count(&app);
                }
                ticks = ticks.wrapping_add(1);
            } else {
                let since = *down_since.get_or_insert_with(Instant::now);
                let (ours, ours_alive) = {
                    let mut guard = state.child.lock().unwrap();
                    match guard.as_mut() {
                        Some(c) => (true, matches!(c.try_wait(), Ok(None))),
                        None => (false, false),
                    }
                };
                let grace = if matches!(port, Port::Other(0)) {
                    SLOW_GRACE
                } else {
                    GRACE
                };
                if ours && ours_alive {
                    // Our server is still starting (or busy). Give it time; it is not killed.
                } else if first || (ours && !ours_alive) || since.elapsed() >= grace {
                    if ours {
                        stop_server(&app); // reap the process that stopped
                    }
                    match port {
                        Port::Other(status) if status != 0 || !first => {
                            let answer = if status == 0 {
                                "doesn't answer in time".to_string()
                            } else {
                                format!("answers with HTTP {status}")
                            };
                            set_error(
                                &app,
                                "Port 4242 is taken",
                                format!(
                                    "Something other than this version of Daily brief is on port 4242 and {answer}. If it's an older Daily brief started at login, run npm run uninstall-login in the project folder. The app keeps checking and connects once the port is free."
                                ),
                            )
                        }
                        Port::Other(_) => {} // first look, slow answer: wait for the grace period
                        _ => {
                            starts.retain(|t| t.elapsed() < START_WINDOW);
                            if starts.len() >= MAX_STARTS {
                                // Keep showing why the last start failed, if it did.
                                if let Some((title, detail)) = last_error.clone() {
                                    set_error(&app, &title, detail);
                                } else {
                                    set_error(
                                    &app,
                                    "Daily brief keeps stopping",
                                    format!(
                                        "The server stopped {MAX_STARTS} times in 10 minutes, so the app has stopped restarting it for now. Details are in {}.",
                                        log_path().display()
                                    ),
                                );
                                }
                            } else {
                                starts.push(Instant::now());
                                set_page(&app, &Page::Starting);
                                match ensure_server(&app) {
                                    Ok(()) => {
                                        down_since = None;
                                        last_error = None;
                                        set_page(&app, &Page::App);
                                    }
                                    Err((title, detail)) => {
                                        // Try again after another grace period (say, once
                                        // Node is installed), within the start budget.
                                        down_since = Some(Instant::now());
                                        set_error(&app, &title, detail.clone());
                                        last_error = Some((title, detail));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            first = false;
            thread::sleep(Duration::from_secs(3));
        }
    });
}

// ---------- menu bar count ----------

/// What the tray shows: ("3", "3 you owe today · 1 overdue"), from /api/widget's JSON body.
/// The body may come chunked, so the JSON is taken from the first '{' to the last '}'.
fn parse_widget(response: &str) -> Option<(String, String)> {
    let body = response.split_once("\r\n\r\n")?.1;
    let json = &body[body.find('{')?..=body.rfind('}')?];
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let title = v.get("title")?.as_str()?.to_string();
    let text = v.get("text")?.as_str()?.to_string();
    Some((title, text))
}

const COUNT_EVERY: u32 = 20; // watchdog ticks of 3 s: once a minute

/// Puts the count in the menu bar title (macOS; the label on Linux) and the line in the tooltip.
fn update_count(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("tray") else {
        return;
    };
    match http("GET", "/api/widget", Duration::from_secs(10)) {
        Ok((200, resp)) => {
            if let Some((title, text)) = parse_widget(&resp) {
                let _ = tray.set_title((!title.is_empty()).then_some(title.as_str()));
                let _ = tray.set_tooltip(Some(format!("Daily brief: {text}").as_str()));
            }
        }
        _ => {
            let _ = tray.set_title(None::<&str>);
        }
    }
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

/// Quick add: bring the window forward on the one-line capture input (src/components/QuickCapture.tsx).
fn quick_add(app: &AppHandle) {
    show_window(app);
    let on_app = *app.state::<Server>().page.lock().unwrap() == Some(Page::App);
    match app.get_webview_window(WINDOW) {
        Some(w) if on_app => {
            if let Err(e) = w.eval("window.dispatchEvent(new CustomEvent('db:capture'))") {
                eprintln!("[daily-brief] quick add: {e}");
            }
        }
        // Still starting: the app page opens with the input once the server answers.
        _ => app
            .state::<Server>()
            .want_capture
            .store(true, Ordering::SeqCst),
    }
}

fn quit(app: &AppHandle) {
    app.state::<Server>().quitting.store(true, Ordering::SeqCst);
    stop_server(app);
    app.exit(0);
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let open = MenuItem::with_id(app, "open", "Open Daily brief", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick add…", true, None::<&str>)?;
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
        &[
            &open, &quick, &browser, &check, &sep1, &login, &sep2, &quit_item,
        ],
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
            "quick" => quick_add(app),
            "browser" => open_in_browser(APP_URL),
            "check" => {
                check_meetings_now();
                let app = app.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(20));
                    update_count(&app);
                });
            }
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
            // Launch at login, toggled from the menu bar: a per-user LaunchAgent on macOS, the Run
            // registry key on Windows, an XDG autostart .desktop file on Linux.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_node_versions() {
        assert_eq!(parse_node_version("v22.23.5\n"), Some((22, 23)));
        assert_eq!(parse_node_version("18.17.0"), Some((18, 17)));
        assert_eq!(parse_node_version("not node"), None);
        assert!(node_version_ok(Some((22, 0))));
        assert!(node_version_ok(Some((18, 18))));
        assert!(!node_version_ok(Some((18, 17))));
        assert!(!node_version_ok(None));
    }

    #[test]
    fn bundled_node_lives_in_the_resources() {
        let p = bundled_node_path(Path::new("res"));
        assert!(p.starts_with(Path::new("res").join("node-runtime")));
        let name = p.file_name().unwrap().to_str().unwrap();
        assert_eq!(name, if cfg!(windows) { "node.exe" } else { "node" });
    }

    #[test]
    fn reads_the_count_from_a_plain_or_chunked_response() {
        let plain = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"text\":\"3 you owe today · 1 overdue\",\"owe\":3,\"title\":\"3\"}";
        assert_eq!(
            parse_widget(plain),
            Some(("3".into(), "3 you owe today · 1 overdue".into()))
        );
        let chunked = "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3a\r\n{\"text\":\"Nothing owed today\",\"title\":\"\"}\r\n0\r\n\r\n";
        assert_eq!(
            parse_widget(chunked),
            Some(("".into(), "Nothing owed today".into()))
        );
        assert_eq!(parse_widget("HTTP/1.1 500 x\r\n\r\noops"), None);
    }

    #[test]
    fn logs_where_the_server_does() {
        let p = log_path();
        assert!(p.ends_with("daily-brief.log"));
    }
}
