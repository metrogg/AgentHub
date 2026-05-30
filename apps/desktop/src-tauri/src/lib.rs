use serde::Serialize;
use std::{
    env,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedFile {
    file_name: String,
    path: String,
    folder: String,
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
fn open_external_url(url: String) -> Result<(), String> {
    let parsed_url = tauri::Url::parse(&url).map_err(|err| format!("无法解析浏览器地址: {err}"))?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("不支持的浏览器地址协议: {scheme}")),
    }

    open_browser_window(parsed_url.as_str())
}

#[tauri::command]
fn download_external_url(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
) -> Result<DownloadedFile, String> {
    let parsed_url = tauri::Url::parse(&url).map_err(|err| format!("无法解析下载地址: {err}"))?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("不支持的下载地址协议: {scheme}")),
    }

    let download_dir = default_download_dir(&app)?;
    fs::create_dir_all(&download_dir)
        .map_err(|err| format!("无法创建下载目录 {}: {err}", download_dir.display()))?;

    let safe_name = sanitize_download_file_name(&file_name);
    let target = unique_download_path(&download_dir, &safe_name);
    download_to_path(parsed_url.as_str(), &target)?;

    Ok(DownloadedFile {
        file_name: target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&safe_name)
            .to_string(),
        path: target.to_string_lossy().to_string(),
        folder: download_dir.to_string_lossy().to_string(),
    })
}

fn open_browser_window(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        for browser in windows_browser_candidates(url) {
            if browser.exists() {
                let status = Command::new(&browser)
                    .arg("--new-window")
                    .arg(url)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
                if status.is_ok() {
                    return Ok(());
                }
            }
        }

        let shell =
            env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string());
        Command::new(shell)
            .args(["/C", "start", "", url])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("无法打开浏览器窗口: {err}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-n")
            .arg(url)
            .spawn()
            .map_err(|err| format!("无法打开浏览器窗口: {err}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for browser in ["google-chrome", "chromium", "microsoft-edge", "firefox"] {
            let status = Command::new(browser)
                .arg("--new-window")
                .arg(url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            if status.is_ok() {
                return Ok(());
            }
        }
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|err| format!("无法打开浏览器窗口: {err}"))?;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn windows_browser_candidates(url: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(default_browser) = windows_default_browser_path(url) {
        candidates.push(default_browser);
    }
    for base in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
        if let Some(root) = env_path(base) {
            candidates.extend([
                root.join("Microsoft\\Edge\\Application\\msedge.exe"),
                root.join("Google\\Chrome\\Application\\chrome.exe"),
                root.join("BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
                root.join("Mozilla Firefox\\firefox.exe"),
            ]);
        }
    }
    candidates
}

#[cfg(target_os = "windows")]
fn windows_default_browser_path(url: &str) -> Option<PathBuf> {
    let scheme = tauri::Url::parse(url).ok()?.scheme().to_string();
    let user_choice_key = format!(
        r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\{}\UserChoice",
        scheme
    );
    let user_choice_output = Command::new("reg")
        .args(["query", &user_choice_key, "/v", "ProgId"])
        .output()
        .ok()?;
    let user_choice_text = String::from_utf8_lossy(&user_choice_output.stdout);
    let prog_id = parse_reg_value(&user_choice_text, "ProgId")?;
    let command_key = format!(r"HKCR\{}\shell\open\command", prog_id);
    let command_output = Command::new("reg")
        .args(["query", &command_key, "/ve"])
        .output()
        .ok()?;
    let command_text = String::from_utf8_lossy(&command_output.stdout);
    let command = parse_reg_default_value(&command_text)?;
    browser_path_from_command(&command)
}

#[cfg(target_os = "windows")]
fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name).map(PathBuf::from)
}

#[cfg(target_os = "windows")]
fn parse_reg_value(output: &str, name: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with(name) {
            return None;
        }
        trimmed
            .split_once("REG_SZ")
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

#[cfg(target_os = "windows")]
fn parse_reg_default_value(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with("(Default)")
            && !trimmed.starts_with("(默认)")
            && !trimmed.starts_with("默认")
        {
            return None;
        }
        trimmed
            .split_once("REG_SZ")
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

#[cfg(target_os = "windows")]
fn browser_path_from_command(command: &str) -> Option<PathBuf> {
    let trimmed = command.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some(PathBuf::from(&rest[..end]));
    }
    let exe_end = trimmed.to_ascii_lowercase().find(".exe")?;
    Some(PathBuf::from(&trimmed[..exe_end + 4]))
}

fn default_download_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"));
    if let Some(home) = home {
        let downloads = PathBuf::from(home).join("Downloads");
        if downloads.exists() {
            return Ok(downloads);
        }
    }

    let fallback = desktop_paths(app)?.app_data_dir.join("downloads");
    Ok(fallback)
}

fn sanitize_download_file_name(value: &str) -> String {
    let trimmed = value.trim();
    let sanitized: String = trimmed
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control()
            {
                '-'
            } else {
                ch
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches(|ch| ch == ' ' || ch == '.').trim();
    if sanitized.is_empty() {
        "preview.html".to_string()
    } else {
        sanitized.chars().take(160).collect()
    }
}

fn unique_download_path(folder: &Path, file_name: &str) -> PathBuf {
    let initial = folder.join(file_name);
    if !initial.exists() {
        return initial;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..1000 {
        let candidate_name = if let Some(extension) = extension {
            format!("{stem} ({index}).{extension}")
        } else {
            format!("{stem} ({index})")
        };
        let candidate = folder.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    folder.join(format!("{stem}-{}.download", unix_timestamp_millis()))
}

fn download_to_path(url: &str, target: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let powershell = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $args[0] -OutFile $args[1] -UseBasicParsing",
            ])
            .arg(url)
            .arg(target)
            .output();

        if let Ok(output) = powershell {
            if output.status.success() {
                return Ok(());
            }
        }

        let curl = Command::new("curl.exe")
            .args(["-L", "--fail", "--silent", "--show-error", "-o"])
            .arg(target)
            .arg(url)
            .output()
            .map_err(|err| format!("无法启动下载工具: {err}"))?;
        if curl.status.success() {
            return Ok(());
        }
        return Err(String::from_utf8_lossy(&curl.stderr).trim().to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let curl = Command::new("curl")
            .args(["-L", "--fail", "--silent", "--show-error", "-o"])
            .arg(target)
            .arg(url)
            .output()
            .map_err(|err| format!("无法启动下载工具: {err}"))?;
        if curl.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&curl.stderr).trim().to_string())
        }
    }
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
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
fn minimize_desktop_window(window: WebviewWindow) -> Result<(), String> {
    window
        .minimize()
        .map_err(|err| format!("minimize window failed: {err}"))
}

#[tauri::command]
fn toggle_maximize_desktop_window(window: WebviewWindow) -> Result<(), String> {
    let maximized = window
        .is_maximized()
        .map_err(|err| format!("read maximize state failed: {err}"))?;
    if maximized {
        window
            .unmaximize()
            .map_err(|err| format!("unmaximize window failed: {err}"))
    } else {
        window
            .maximize()
            .map_err(|err| format!("maximize window failed: {err}"))
    }
}

#[tauri::command]
fn start_desktop_window_drag(window: WebviewWindow) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|err| format!("start window drag failed: {err}"))
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
        .inner_size(1570.0, 1013.0)
        .min_inner_size(980.0, 680.0)
        .decorations(false)
        .transparent(false)
        .background_color(Color(255, 255, 255, 255))
        .shadow(true)
        .focused(true)
        .center()
        .build()
        .map_err(|err| format!("无法打开新窗口: {err}"))?;

    apply_window_chrome_style(&new_window);
    let _ = new_window.show();
    let _ = new_window.set_focus();
    Ok(())
}

#[tauri::command]
fn open_url_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed_url = tauri::Url::parse(&url).map_err(|err| format!("无法解析窗口地址: {err}"))?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("不支持的窗口地址协议: {scheme}")),
    }

    let label = format!(
        "preview-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default()
    );

    let new_window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed_url))
        .title("AgentHub Preview")
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 520.0)
        .decorations(false)
        .transparent(false)
        .background_color(Color(255, 255, 255, 255))
        .shadow(true)
        .focused(true)
        .center()
        .build()
        .map_err(|err| format!("无法打开预览窗口: {err}"))?;

    apply_window_chrome_style(&new_window);
    let _ = new_window.show();
    let _ = new_window.set_focus();
    Ok(())
}

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    let current_url = window
        .url()
        .map_err(|err| format!("无法读取当前窗口地址: {err}"))?;
    let settings_url = current_url
        .join("/settings")
        .map_err(|err| format!("无法构造设置窗口地址: {err}"))?;

    let settings_window =
        WebviewWindowBuilder::new(&app, "settings", WebviewUrl::External(settings_url))
            .title("AgentHub 设置")
            .inner_size(1280.0, 880.0)
            .min_inner_size(980.0, 700.0)
            .decorations(false)
            .transparent(false)
            .background_color(Color(255, 255, 255, 255))
            .shadow(true)
            .always_on_top(true)
            .focused(true)
            .center()
            .build()
            .map_err(|err| format!("无法打开设置窗口: {err}"))?;

    apply_window_chrome_style(&settings_window);
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
            open_external_url,
            download_external_url,
            notify_user,
            desktop_info,
            check_for_updates,
            close_desktop_window,
            minimize_desktop_window,
            toggle_maximize_desktop_window,
            start_desktop_window_drag,
            open_desktop_window,
            open_url_window,
            open_settings_window
        ])
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("desktop-startup.html".into()),
            )
            .title("AgentHub")
            .inner_size(1570.0, 1013.0)
            .min_inner_size(980.0, 680.0)
            .decorations(false)
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

    if cfg!(debug_assertions) {
        let dev_port_file = workspace_root_from_manifest().map(|root| root.join(".agenthub-port"));
        let reusable_dev_port = dev_port_file
            .as_ref()
            .and_then(|port_file| read_dev_port_file(port_file))
            .or_else(|| health_check(8000).then_some(8000));

        if let Some(port) = reusable_dev_port {
            let detail = format!("正在连接本地 AgentHub dev server...\n端口: {port}");
            set_startup_status(&window, "ready", "开发服务已就绪", &detail);
            if let Ok(url) = tauri::Url::parse(&frontend_launch_url(port)) {
                let _ = window.navigate(url);
            }
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

    let workspace_root = workspace_root_from_manifest();
    let dev_port_file = workspace_root
        .as_ref()
        .map(|root| root.join(".agenthub-port"));
    if let Some(port_file) = dev_port_file.as_ref() {
        let _ = fs::write(
            port_file,
            format!(
                r#"{{"port":{},"pid":{},"updatedAt":"desktop-startup"}}"#,
                port,
                std::process::id()
            ),
        );
    }

    let star_office_root = workspace_root
        .as_ref()
        .map(|root| root.join("storage").join("Star-Office-UI"))
        .filter(|root| root.join("backend").join("app.py").exists());

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
        .env("DATABASE_URL", paths.data_dir.join("agenthub.db"));

    if let Some(root) = workspace_root.as_ref() {
        command.env("PROJECT_ROOT", root);
    }
    if let Some(port_file) = dev_port_file.as_ref() {
        command.env("AGENTHUB_PORT_FILE", port_file);
    }
    if let Some(root) = star_office_root.as_ref() {
        command.env("AGENTHUB_STAR_OFFICE_ROOT", root);
    }

    command
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

    if wait_for_health(port, Duration::from_secs(20)) {
        set_startup_status(&window, "ready", "服务已启动", "正在进入 AgentHub...");
        let target_url = frontend_launch_url(port);
        if let Ok(url) = tauri::Url::parse(&target_url) {
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

fn workspace_root_from_manifest() -> Option<PathBuf> {
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..3 {
        root = root.parent()?.to_path_buf();
    }
    if root.join("package.json").exists() && root.join("apps").exists() {
        Some(root)
    } else {
        None
    }
}

fn find_available_port(start: u16, count: u16) -> Option<u16> {
    (start..start.saturating_add(count))
        .find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

fn read_dev_port_file(path: &Path) -> Option<u16> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let port = parsed.get("port")?.as_u64()?;
    if port == 0 || port > u16::MAX as u64 {
        return None;
    }
    let port = port as u16;
    health_check(port).then_some(port)
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

fn frontend_launch_url(port: u16) -> String {
    if cfg!(debug_assertions) {
        "http://127.0.0.1:5173".to_string()
    } else {
        format!("http://127.0.0.1:{port}")
    }
}
