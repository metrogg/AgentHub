use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    utils::config::Color, Manager, RunEvent, UserAttentionType, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

type ServerProcess = Arc<Mutex<Option<Child>>>;

#[derive(Clone)]
struct DesktopState {
    server: ServerProcess,
}

#[derive(Serialize)]
struct DesktopInfo {
    app_data_dir: String,
    config_dir: String,
    log_dir: String,
}

#[tauri::command]
fn pick_workspace_folder() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("选择项目文件夹")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn open_in_editor(path: String, line: Option<u32>) -> Result<(), String> {
    let target = if let Some(line) = line {
        format!("{path}:{line}")
    } else {
        path.clone()
    };

    for command in ["code", "cursor", "windsurf"] {
        let status = Command::new(command)
            .arg("--goto")
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if status.is_ok() {
            return Ok(());
        }
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("无法打开文件: {err}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|err| format!("无法打开文件: {err}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|err| format!("无法打开文件: {err}"))?;
        Ok(())
    }
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("无法打开路径: {err}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|err| format!("无法打开路径: {err}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|err| format!("无法打开路径: {err}"))?;
        Ok(())
    }
}

#[tauri::command]
fn notify_user(window: WebviewWindow, title: String, body: Option<String>) -> Result<(), String> {
    let message = body.unwrap_or_default();
    let script = format!(
        "window.dispatchEvent(new CustomEvent('agenthub:native-notification', {{ detail: {} }}));",
        serde_json::json!({ "title": title, "body": message })
    );
    let _ = window.eval(script);
    window
        .request_user_attention(Some(UserAttentionType::Informational))
        .map_err(|err| format!("无法发送通知: {err}"))
}

#[tauri::command]
fn desktop_info(app: tauri::AppHandle) -> Result<DesktopInfo, String> {
    let paths = desktop_paths(&app)?;
    Ok(DesktopInfo {
        app_data_dir: paths.app_data_dir.to_string_lossy().to_string(),
        config_dir: paths.config_dir.to_string_lossy().to_string(),
        log_dir: paths.log_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn check_for_updates() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "status": "not_configured",
        "message": "自动更新通道尚未配置。需要发布 update.json endpoint 和签名公钥后启用。"
    }))
}

#[tauri::command]
fn close_desktop_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|err| format!("无法关闭窗口: {err}"))
}

#[tauri::command]
fn open_desktop_window(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|err| format!("无法读取当前窗口地址: {err}"))?;
    let label = format!(
        "main-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default()
    );

    let new_window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title("AgentHub")
        .inner_size(1280.0, 820.0)
        .min_inner_size(980.0, 680.0)
        .decorations(true)
        .transparent(false)
        .background_color(Color(255, 255, 255, 255))
        .shadow(true)
        .center()
        .build()
        .map_err(|err| format!("无法打开新窗口: {err}"))?;

    apply_window_chrome_style(&new_window);
    Ok(())
}

#[derive(Clone)]
struct DesktopPaths {
    app_data_dir: PathBuf,
    config_dir: PathBuf,
    log_dir: PathBuf,
    data_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = DesktopState {
        server: Arc::new(Mutex::new(None)),
    };

    let app = tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            pick_workspace_folder,
            open_in_editor,
            open_path,
            notify_user,
            desktop_info,
            check_for_updates,
            close_desktop_window,
            open_desktop_window
        ])
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("desktop-startup.html".into()),
            )
            .title("AgentHub")
            .inner_size(1280.0, 820.0)
            .min_inner_size(980.0, 680.0)
            .decorations(true)
            .transparent(false)
            .background_color(Color(255, 255, 255, 255))
            .shadow(true)
            .center()
            .build()?;

            apply_window_chrome_style(&window);

            let app_handle = app.handle().clone();
            let server_state = state.server.clone();
            thread::spawn(move || {
                start_desktop_server(app_handle, window, server_state);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AgentHub desktop shell");

    app.run(move |app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_server(app_handle.state::<DesktopState>().server.clone());
        }
    });
}

#[cfg(windows)]
fn apply_window_chrome_style(window: &WebviewWindow) {
    use std::{ffi::c_void, mem::size_of};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    // COLORREF is 0x00BBGGRR. #F7F7F4 becomes 0x00F4F7F7.
    let caption_color: u32 = 0x00F4F7F7;
    let border_color: u32 = 0x00F4F7F7;
    let text_color: u32 = 0x00232323;

    unsafe {
        let hwnd = hwnd.0;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR as u32,
            &caption_color as *const _ as *const c_void,
            size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            &border_color as *const _ as *const c_void,
            size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR as u32,
            &text_color as *const _ as *const c_void,
            size_of::<u32>() as u32,
        );
    }
}

#[cfg(not(windows))]
fn apply_window_chrome_style(_window: &WebviewWindow) {}

fn start_desktop_server(app: tauri::AppHandle, window: WebviewWindow, server_state: ServerProcess) {
    set_startup_status(
        &window,
        "starting",
        "正在准备本机数据目录",
        "AgentHub 会把数据库、配置和日志放到系统 App Data。",
    );

    let paths = match desktop_paths(&app) {
        Ok(paths) => paths,
        Err(err) => {
            set_startup_status(&window, "failed", "无法创建 App Data 目录", &err);
            return;
        }
    };

    for path in [
        &paths.app_data_dir,
        &paths.config_dir,
        &paths.log_dir,
        &paths.data_dir,
    ] {
        if let Err(err) = fs::create_dir_all(path) {
            set_startup_status(
                &window,
                "failed",
                "无法创建本机目录",
                &format!("{}: {err}", path.display()),
            );
            return;
        }
    }

    set_startup_status(
        &window,
        "starting",
        "正在检查端口",
        "如果默认端口被占用，会自动切换到下一个可用端口。",
    );
    let port = match find_available_port(8000, 80) {
        Some(port) => port,
        None => {
            set_startup_status(
                &window,
                "failed",
                "没有可用端口",
                "8000-8079 都已被占用，请关闭占用端口的程序后重试。",
            );
            return;
        }
    };

    let server_bin = match resolve_resource(
        &app,
        &[
            "resources/binaries/agenthub-server.exe",
            "binaries/agenthub-server.exe",
            "agenthub-server.exe",
        ],
    ) {
        Some(path) => path,
        None => {
            set_startup_status(
                &window,
                "failed",
                "找不到 server sidecar",
                "请先运行 bun --filter @agenthub/desktop prepare:sidecar 生成 apps/desktop/src-tauri/resources/binaries/agenthub-server.exe。",
            );
            return;
        }
    };

    let web_dist = match resolve_resource(&app, &["resources/web-dist", "web-dist"]) {
        Some(path) => path,
        None => {
            set_startup_status(
                &window,
                "failed",
                "找不到 Web 构建产物",
                "请先构建 apps/web/dist 并复制到桌面端 resources/web-dist。",
            );
            return;
        }
    };

    set_startup_status(
        &window,
        "starting",
        "正在启动 AgentHub 服务",
        &format!("端口: {port}\n日志: {}", paths.log_dir.display()),
    );

    let log_path = paths.log_dir.join("agenthub-sidecar.log");
    let log_file = match OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(file) => file,
        Err(err) => {
            set_startup_status(
                &window,
                "failed",
                "无法写入日志文件",
                &format!("{}: {err}", log_path.display()),
            );
            return;
        }
    };
    let log_file_err = match log_file.try_clone() {
        Ok(file) => file,
        Err(err) => {
            set_startup_status(&window, "failed", "无法初始化日志输出", &err.to_string());
            return;
        }
    };

    let mut command = Command::new(&server_bin);
    command
        .current_dir(&paths.app_data_dir)
        .env("NODE_ENV", "production")
        .env("PORT", port.to_string())
        .env("CORS_ORIGIN", "*")
        .env("AGENTHUB_APP_DATA_DIR", &paths.app_data_dir)
        .env("AGENTHUB_CONFIG_DIR", &paths.config_dir)
        .env("AGENTHUB_LOG_DIR", &paths.log_dir)
        .env("AGENTHUB_WEB_DIST", &web_dist)
        .env("DATABASE_URL", paths.data_dir.join("agenthub.db"))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    let child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            set_startup_status(
                &window,
                "failed",
                "服务启动失败",
                &format!("{}: {err}", server_bin.display()),
            );
            return;
        }
    };

    {
        let mut guard = server_state.lock().expect("server state poisoned");
        *guard = Some(child);
    }

    let url = format!("http://127.0.0.1:{port}");
    if wait_for_health(port, Duration::from_secs(20)) {
        set_startup_status(&window, "ready", "服务已启动", "正在进入 AgentHub...");
        if let Ok(url) = tauri::Url::parse(&url) {
            let _ = window.navigate(url);
        }
    } else {
        let tail = read_log_tail(&log_path);
        set_startup_status(
            &window,
            "failed",
            "服务没有在预期时间内就绪",
            &format!("请查看日志: {}\n\n{}", log_path.display(), tail),
        );
    }
}

fn desktop_paths(app: &tauri::AppHandle) -> Result<DesktopPaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("无法定位 App Data: {err}"))?;
    Ok(DesktopPaths {
        config_dir: app_data_dir.join("config"),
        log_dir: app_data_dir.join("logs"),
        data_dir: app_data_dir.join("data"),
        app_data_dir,
    })
}

fn resolve_resource(app: &tauri::AppHandle, candidates: &[&str]) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir);
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    for root in roots {
        for candidate in candidates {
            let path = root.join(candidate);
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

fn find_available_port(start: u16, count: u16) -> Option<u16> {
    (start..start.saturating_add(count))
        .find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

fn wait_for_health(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if health_check(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(300));
    }
    false
}

fn health_check(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && response.starts_with("HTTP/1.1 200")
}

fn set_startup_status(window: &WebviewWindow, state: &str, title: &str, detail: &str) {
    let payload = serde_json::json!({
        "state": state,
        "title": title,
        "detail": detail,
    });
    let _ = window.eval(format!(
        "window.AgentHubDesktopStartup?.setStatus({payload});"
    ));
}

fn read_log_tail(path: &Path) -> String {
    match fs::read_to_string(path) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().rev().take(24).collect();
            lines.into_iter().rev().collect::<Vec<_>>().join("\n")
        }
        Err(_) => String::new(),
    }
}

fn stop_server(server_state: ServerProcess) {
    let mut guard = server_state.lock().expect("server state poisoned");
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
