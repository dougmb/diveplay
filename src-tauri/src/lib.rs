use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri::path::BaseDirectory;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, Request, Response, StatusCode},
    routing::get,
    Router,
};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tokio_util::io::ReaderStream;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tokio::process::Command;
use tokio::fs::File;

static LOG_BUFFER: Mutex<Vec<String>> = Mutex::new(Vec::new());

macro_rules! app_log {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        eprintln!("[DivePlay] {}", msg);
        if let Ok(mut buf) = LOG_BUFFER.lock() {
            let timestamp = chrono_lite_timestamp();
            buf.push(format!("[{}] {}", timestamp, msg));
            if buf.len() > 1000 {
                buf.remove(0);
            }
        }
    }};
}

fn chrono_lite_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs();
    let hours = (secs / 3600) % 24;
    let mins = (secs / 60) % 60;
    let secs = secs % 60;
    format!("{:02}:{:02}:{:02}", hours, mins, secs)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MediaInfo {
    pub streams: Vec<MediaStream>,
    pub format: MediaFormat,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MediaStream {
    pub index: usize,
    pub codec_type: String,
    pub codec_name: String,
    pub tags: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MediaFormat {
    pub duration: String,
}

#[derive(Deserialize)]
struct StreamParams {
    token: String,
    audio_track: Option<usize>,
    transcode: Option<bool>,
    ss: Option<f64>,
}

struct AppState {
    handle: AppHandle,
    stream_token: String,
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
fn get_logs() -> Vec<String> {
    LOG_BUFFER.lock().map(|buf| buf.clone()).unwrap_or_default()
}

#[tauri::command]
fn clear_logs() {
    if let Ok(mut buf) = LOG_BUFFER.lock() {
        buf.clear();
    }
}

fn get_sidecar_path(handle: &AppHandle, name: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let ext = ".exe";
    #[cfg(not(target_os = "windows"))]
    let ext = "";

    let binary_name = format!("{}{}", name, ext);
    app_log!("Looking for binary: {}", binary_name);

    // 1. Try standard Resource directory (Tauri v2)
    if let Ok(path) = handle.path().resolve(format!("binaries/{}", binary_name), BaseDirectory::Resource) {
        app_log!("  Try 1 - Resource: {:?}", path);
        if path.exists() {
            app_log!("  Found at: {:?}", path);
            return Ok(path);
        }
    }

    // 2. Try resources/binaries/ folder (alternative location)
    if let Ok(path) = handle.path().resolve(format!("resources/binaries/{}", binary_name), BaseDirectory::Resource) {
        app_log!("  Try 2 - Resources: {:?}", path);
        if path.exists() {
            app_log!("  Found at: {:?}", path);
            return Ok(path);
        }
    }

    // 3. Try AppData path directly (Windows installed apps)
    if let Ok(app_data) = std::env::var("APPDATA") {
        let app_data_path = PathBuf::from(app_data).join("com.diveplay.app").join("resources").join("binaries").join(&binary_name);
        app_log!("  Try 3 - AppData: {:?}", app_data_path);
        if app_data_path.exists() {
            app_log!("  Found at: {:?}", app_data_path);
            return Ok(app_data_path);
        }
    }

    // 3b. Linux/macOS XDG and AppImage paths
    {
        let candidates = [
            std::env::var("APPDIR").ok().map(|d| PathBuf::from(d).join("usr/bin").join(&binary_name)),
            std::env::var("APPDIR").ok().map(|d| PathBuf::from(d).join("resources/binaries").join(&binary_name)),
            std::env::var("XDG_DATA_HOME").ok().map(|d| PathBuf::from(d).join("com.diveplay.app/resources/binaries").join(&binary_name)),
            std::env::var("HOME").ok().map(|d| PathBuf::from(d).join(".local/share/com.diveplay.app/resources/binaries").join(&binary_name)),
            Some(PathBuf::from("/usr/lib/diveplay/resources/binaries").join(&binary_name)),
            Some(PathBuf::from("/usr/share/diveplay/resources/binaries").join(&binary_name)),
        ];
        for path in candidates.into_iter().flatten() {
            app_log!("  Try 3b - XDG/AppImage: {:?}", path);
            if path.exists() {
                app_log!("  Found at: {:?}", path);
                return Ok(path);
            }
        }
    }

    // 4. Try relative to the executable (common for portable and NSIS side-by-side)
    if let Ok(exe_path) = std::env::current_exe() {
        app_log!("  Try 4 - Exe dir: {:?}", exe_path);
        if let Some(exe_dir) = exe_path.parent() {
            // Check in ./resources/binaries/
            let path = exe_dir.join("resources").join("binaries").join(&binary_name);
            app_log!("    Check: {:?}", path);
            if path.exists() {
                app_log!("  Found at: {:?}", path);
                return Ok(path);
            }
            // Check in ./binaries/
            let path = exe_dir.join("binaries").join(&binary_name);
            app_log!("    Check: {:?}", path);
            if path.exists() {
                app_log!("  Found at: {:?}", path);
                return Ok(path);
            }
            // Check in ./
            let path = exe_dir.join(&binary_name);
            app_log!("    Check: {:?}", path);
            if path.exists() {
                app_log!("  Found at: {:?}", path);
                return Ok(path);
            }
        }
    }

    // 5. Development fallbacks - check relative to current working directory
    let dev_base = std::env::current_dir().unwrap_or_default();
    app_log!("  Try 5 - Dev paths from: {:?}", dev_base);
    let dev_paths = [
        dev_base.join("binaries").join(&binary_name),
        dev_base.join("src-tauri").join("binaries").join(&binary_name),
        dev_base.join("target").join("release").join("binaries").join(&binary_name),
        dev_base.join("target").join("debug").join("binaries").join(&binary_name),
    ];

    for path in dev_paths {
        app_log!("    Check: {:?}", path);
        if path.exists() {
            app_log!("  Found at: {:?}", path);
            return Ok(path);
        }
    }

    // 6. Linux/macOS: check well-known system paths (apt `ffmpeg` installs to /usr/bin)
    #[cfg(not(target_os = "windows"))]
    {
        let system_paths = [
            PathBuf::from("/usr/bin").join(&binary_name),
            PathBuf::from("/usr/local/bin").join(&binary_name),
            PathBuf::from("/opt/homebrew/bin").join(&binary_name),
        ];
        for path in system_paths {
            app_log!("  Try 6 - System path: {:?}", path);
            if path.exists() {
                app_log!("  Found at: {:?}", path);
                return Ok(path);
            }
        }
    }

    // 7. Last resort: hand off bare name and let the OS resolve via PATH
    app_log!("  Try 7 - Falling back to system PATH lookup for: {}", binary_name);
    Ok(PathBuf::from(&binary_name))
}

#[tauri::command]
async fn get_streaming_url(handle: AppHandle, path: String) -> Result<String, String> {
    let port = handle.state::<u16>();
    let state = handle.state::<Arc<AppState>>();
    let encoded_path = urlencoding::encode(&path);
    Ok(format!("http://localhost:{}/stream/{}?token={}", *port, encoded_path, state.stream_token))
}

#[tauri::command]
async fn get_media_info(handle: AppHandle, path: String) -> Result<MediaInfo, String> {
    app_log!("get_media_info called for: {}", path);
    
    let ffprobe_path = match get_sidecar_path(&handle, "ffprobe") {
        Ok(p) => p,
        Err(e) => {
            app_log!("ERROR: ffprobe not found: {}", e);
            return Err(format!("ffprobe not found: {}", e));
        }
    };
    
    app_log!("Using ffprobe: {:?}", ffprobe_path);
    
    let mut cmd = Command::new(&ffprobe_path);
    
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.args([
            "-v", "error",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            &path
        ])
        .output()
        .await
        .map_err(|e| {
            app_log!("ERROR: Failed to execute ffprobe: {}", e);
            format!("Failed to execute ffprobe: {}", e)
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        app_log!("ERROR: ffprobe failed: {}", stderr);
        return Err(format!("ffprobe failed: {}", stderr));
    }

    let info: MediaInfo = serde_json::from_slice(&output.stdout)
        .map_err(|e| {
            app_log!("ERROR: Failed to parse ffprobe output: {}", e);
            format!("Failed to parse ffprobe output: {}", e)
        })?;

    app_log!("Successfully got media info for: {}", path);
    Ok(info)
}

async fn stream_file(
    State(state): State<Arc<AppState>>,
    Path(path_str): Path<String>,
    Query(params): Query<StreamParams>,
    req: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    if params.token != state.stream_token {
        app_log!("Stream request: UNAUTHORIZED token");
        return Err(StatusCode::UNAUTHORIZED);
    }

    // path_str from axum Path might be URL encoded
    let path_str = urlencoding::decode(&path_str).map(|s| s.into_owned()).unwrap_or(path_str);
    let path = PathBuf::from(&path_str);
    
    app_log!("Streaming request for: {}", path_str);

    if !path.exists() {
        app_log!("Stream error: File not found: {}", path_str);
        return Err(StatusCode::NOT_FOUND);
    }
    if !path.is_file() {
        app_log!("Stream error: Not a file: {}", path_str);
        return Err(StatusCode::NOT_FOUND);
    }

    let should_transcode = params.transcode.unwrap_or(false);
    
    if should_transcode {
        let audio_idx = params.audio_track.unwrap_or(0);
        let start_time = params.ss.unwrap_or(0.0);
        
        app_log!("Transcoding requested for: {} (audio_track: {}, start: {})", path_str, audio_idx, start_time);
        
        let ffmpeg_path = match get_sidecar_path(&state.handle, "ffmpeg") {
            Ok(p) => p,
            Err(e) => {
                app_log!("ERROR: ffmpeg not found: {}", e);
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
        };
        
        app_log!("Using ffmpeg: {:?}", ffmpeg_path);
        
        let mut cmd = Command::new(&ffmpeg_path);
        
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        
        cmd.kill_on_drop(true); 

        cmd.arg("-y")
           .arg("-hide_banner")
           .arg("-loglevel").arg("info");

        if start_time > 0.0 {
            cmd.arg("-ss").arg(start_time.to_string());
        }

        cmd.arg("-i").arg(&path_str)
           .arg("-map").arg("0:v:0")
           .arg("-map").arg(format!("0:a:{}", audio_idx))
           .arg("-c:v").arg("libx264")
           .arg("-pix_fmt").arg("yuv420p")
           .arg("-preset").arg("ultrafast")
           .arg("-tune").arg("zerolatency")
           .arg("-crf").arg("26")
           .arg("-g").arg("48")
           .arg("-sn")
           .arg("-c:a").arg("aac")
           .arg("-ac").arg("2")
           .arg("-b:a").arg("128k")
           .arg("-f").arg("mp4")
           .arg("-movflags").arg("frag_keyframe+empty_moov+default_base_moof")
           .arg("pipe:1");

        cmd.stdout(Stdio::piped())
           .stderr(Stdio::piped());

        let mut child = cmd.spawn()
            .map_err(|e| {
                app_log!("ERROR: Failed to spawn FFmpeg: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR
            })?;

        app_log!("FFmpeg process spawned with PID: {:?}", child.id());

        let stdout = child.stdout.take().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        let stderr = child.stderr.take();
        
        // Handle stderr in a separate task
        if let Some(s) = stderr {
            tauri::async_runtime::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut reader = BufReader::new(s).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if !line.trim().is_empty() {
                        app_log!("FFmpeg: {}", line);
                    }
                }
            });
        }

        // Wait for child to exit in a separate task to keep it alive
        // and log the exit status.
        tauri::async_runtime::spawn(async move {
            match child.wait().await {
                Ok(status) => app_log!("FFmpeg process exited with status: {:?}", status),
                Err(e) => app_log!("FFmpeg process wait error: {}", e),
            }
        });

        let stream = ReaderStream::new(stdout);
        let body = Body::from_stream(stream);

        app_log!("Returning transcoding response for: {}", path_str);

        return Response::builder()
            .header(header::CONTENT_TYPE, "video/mp4")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(body)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }

    // Direct streaming for supported formats
    let file = File::open(&path).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let metadata = file.metadata().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let size = metadata.len();
    let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();

    let range = req.headers().get(header::RANGE).and_then(|h| h.to_str().ok());

    if let Some(range) = range {
        if let Some(r) = range.strip_prefix("bytes=") {
            let parts: Vec<&str> = r.split('-').collect();
            if parts.len() == 2 {
                let start = parts[0].parse::<u64>().unwrap_or(0);
                let end = parts[1].parse::<u64>().unwrap_or(size - 1);
                let end = if end >= size { size - 1 } else { end };

                if start < size {
                    let content_length = end - start + 1;
                    use std::io::SeekFrom;
                    use tokio::io::AsyncSeekExt;
                    
                    let mut file = file;
                    file.seek(SeekFrom::Start(start)).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                    
                    let stream = ReaderStream::with_capacity(file, 64 * 1024);
                    let body = Body::from_stream(stream);

                    return Response::builder()
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(header::CONTENT_TYPE, mime)
                        .header(header::CONTENT_LENGTH, content_length)
                        .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, size))
                        .header(header::ACCEPT_RANGES, "bytes")
                        .body(body)
                        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
                }
            }
        }
    }

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, size)
        .header(header::ACCEPT_RANGES, "bytes")
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Force dark GTK file dialogs for the AppImage. Other Linux packages still
    // respect a host-set GTK theme.
    #[cfg(target_os = "linux")]
    {
        let is_appimage = std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some();
        if is_appimage {
            unsafe { std::env::set_var("APPIMAGE_GTK_THEME", "Adwaita:dark") };
            unsafe { std::env::set_var("GTK_USE_PORTAL", "0") };
        }
        if is_appimage || std::env::var_os("GTK_THEME").is_none() {
            // SAFETY: single-threaded at process start, before other threads read env.
            unsafe { std::env::set_var("GTK_THEME", "Adwaita:dark") };
        }
        if is_appimage || std::env::var_os("GTK_APPLICATION_PREFER_DARK_THEME").is_none() {
            unsafe { std::env::set_var("GTK_APPLICATION_PREFER_DARK_THEME", "1") };
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            
            // Generate a cryptographically random session token
            use rand::Rng;
            let stream_token: String = rand::thread_rng()
                .sample_iter(&rand::distributions::Alphanumeric)
                .take(32)
                .map(char::from)
                .collect();
            
            let state = Arc::new(AppState { 
                handle: handle.clone(),
                stream_token: stream_token.clone(),
            });

            app.manage(state.clone());

            let (tx, mut rx) = tokio::sync::mpsc::channel(1);
            
            tauri::async_runtime::spawn(async move {
                let router = Router::new()
                    .route("/stream/*path", get(stream_file))
                    .with_state(state)
                    .layer(CorsLayer::new()); // no CORS headers — blocks cross-origin fetch

                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let port = listener.local_addr().unwrap().port();
                
                let _ = tx.send(port).await;
                
                axum::serve(listener, router).await.unwrap();
            });

            let port = tauri::async_runtime::block_on(async { rx.recv().await.unwrap() });
            app.manage(port);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_streaming_url, get_media_info, get_logs, clear_logs])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
