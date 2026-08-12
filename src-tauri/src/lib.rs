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

// ffprobe reports far more than this; the extra fields below feed the info
// overlay (I key). All optional — they vary by codec and container, and a
// missing one must never fail the whole probe.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MediaStream {
    pub index: usize,
    pub codec_type: String,
    pub codec_name: String,
    pub tags: Option<serde_json::Value>,
    pub profile: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub pix_fmt: Option<String>,
    pub r_frame_rate: Option<String>,
    pub channels: Option<u32>,
    pub sample_rate: Option<String>,
    pub bit_rate: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MediaFormat {
    pub duration: String,
    pub format_name: Option<String>,
    pub size: Option<String>,
    pub bit_rate: Option<String>,
}

#[derive(Deserialize)]
struct StreamParams {
    token: String,
    audio_track: Option<usize>,
    transcode: Option<bool>,
    mode: Option<String>,
    ss: Option<f64>,
}

struct AppState {
    handle: AppHandle,
    stream_token: String,
}

fn parse_byte_range(range: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }

    let spec = range.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start_raw, end_raw) = spec.split_once('-')?;

    if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<u64>().ok()?;
        if suffix_len == 0 {
            return None;
        }
        let start = size.saturating_sub(suffix_len);
        return Some((start, size - 1));
    }

    let start = start_raw.parse::<u64>().ok()?;
    if start >= size {
        return None;
    }

    let end = if end_raw.is_empty() {
        size - 1
    } else {
        end_raw.parse::<u64>().ok()?.min(size - 1)
    };

    if end < start {
        return None;
    }

    Some((start, end))
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
fn get_logs() -> Vec<String> {
    LOG_BUFFER.lock().map(|buf| buf.clone()).unwrap_or_default()
}

/// How this session is rendering. AppRun probes the host GL stack at startup and
/// exports the verdict; surface it so the info overlay can show whether we are on
/// the GPU or on the bundled llvmpipe fallback.
#[derive(Serialize, Debug, Clone)]
struct RenderInfo {
    gl_mode: String,
    gl_why: String,
    gl_fallback: bool,
    is_appimage: bool,
}

#[tauri::command]
fn get_render_info() -> RenderInfo {
    RenderInfo {
        // Set only by the AppImage's AppRun; other packagings render via the host stack.
        gl_mode: std::env::var("DIVEPLAY_GL_MODE").unwrap_or_else(|_| "host-default".into()),
        gl_why: std::env::var("DIVEPLAY_GL_WHY").unwrap_or_default(),
        // dp-run sets this when it had to drop a tier to get anything on screen.
        gl_fallback: std::env::var("DIVEPLAY_GL_FALLBACK").as_deref() == Ok("1"),
        is_appimage: std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some(),
    }
}

/// Which pacing flags this ffmpeg understands. Probed once and cached: the
/// bundled AppImage build is old (Ubuntu 22.04 ships 4.4, which only has `-re`),
/// while .deb installs use the host's, which is usually much newer.
#[derive(Debug, Clone, Copy)]
struct FfmpegPacing {
    readrate: bool,        // ffmpeg >= 5.1
    initial_burst: bool,   // ffmpeg >= 7.0
    catchup: bool,         // ffmpeg >= 7.1
}

static FFMPEG_PACING: std::sync::OnceLock<FfmpegPacing> = std::sync::OnceLock::new();

fn ffmpeg_pacing(ffmpeg_path: &PathBuf) -> FfmpegPacing {
    *FFMPEG_PACING.get_or_init(|| {
        let help = std::process::Command::new(ffmpeg_path)
            .args(["-hide_banner", "-h", "full"])
            .output()
            .map(|o| {
                let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
                s.push_str(&String::from_utf8_lossy(&o.stderr));
                s
            })
            .unwrap_or_default();
        let caps = FfmpegPacing {
            readrate: help.contains("-readrate "),
            initial_burst: help.contains("-readrate_initial_burst"),
            catchup: help.contains("-readrate_catchup"),
        };
        app_log!("ffmpeg pacing support: {:?}", caps);
        caps
    })
}

const STATE_FILE_NAME: &str = ".player-state.json";

/// Per-folder playback state lives next to the media, as `.player-state.json`.
///
/// This deliberately does NOT go through tauri-plugin-fs: its scope rejected
/// writes to the user's media folder with "forbidden path" even with `**`
/// allow-entries in the capability, which silently broke resume (position, last
/// file and settings were never persisted, and reads returned null). The backend
/// already reads arbitrary media paths off disk to stream them, so serving this
/// one small file from Rust adds no new reach — and the command builds the
/// filename itself, so the frontend cannot use it to touch anything else.
fn state_path(dir: &str) -> PathBuf {
    PathBuf::from(dir).join(STATE_FILE_NAME)
}

#[tauri::command]
fn read_player_state(dir: String) -> Option<String> {
    let path = state_path(&dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) => {
            // A folder with no state file yet is the normal first-run case.
            if e.kind() != std::io::ErrorKind::NotFound {
                app_log!("read_player_state failed for {:?}: {}", path, e);
            }
            None
        }
    }
}

#[tauri::command]
fn write_player_state(dir: String, contents: String) -> Result<(), String> {
    let path = state_path(&dir);
    // Write-then-rename so an interrupted save can't leave truncated JSON behind
    // and cost the user their resume point.
    let tmp = path.with_extension("json.tmp");
    let atomic = std::fs::write(&tmp, contents.as_bytes()).and_then(|_| {
        // Windows rename fails when the destination exists; clear it first.
        #[cfg(windows)]
        let _ = std::fs::remove_file(&path);
        std::fs::rename(&tmp, &path)
    });

    if let Err(e) = atomic {
        let _ = std::fs::remove_file(&tmp);
        // Fall back to a plain write: a non-atomic save beats no save at all.
        if let Err(e2) = std::fs::write(&path, contents.as_bytes()) {
            app_log!("write_player_state failed for {:?}: {} (atomic path: {})", path, e2, e);
            return Err(e2.to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn log_event(message: String) {
    app_log!("UI: {}", message);
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
        let mode = params.mode.as_deref().unwrap_or("full");

        app_log!("Transcoding requested for: {} (audio_track: {}, start: {}, mode: {})", path_str, audio_idx, start_time, mode);
        
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
           .arg("-loglevel").arg("warning")
           .arg("-fflags").arg("+genpts+igndts+discardcorrupt")
           .arg("-err_detect").arg("ignore_err");

        if start_time > 0.0 {
            cmd.arg("-ss").arg(start_time.to_string());
        }

        // Pace the encode. Unpaced, libx264 runs flat out and transcodes the whole
        // file as fast as the machine allows — the spike seen when switching files.
        //
        // Plain `-re` (all ffmpeg versions) pins output to exactly 1x, which fixes
        // the CPU but leaves the client with no buffer: fragments arrive one GOP at
        // a time with zero margin, which stutters. So prefer burst-then-pace where
        // the ffmpeg supports it — burst enough to fill a real cushion, then settle
        // just above realtime, and allow a faster catch-up rate if it falls behind.
        // Threads are deliberately NOT capped: the burst should finish quickly.
        //
        // DIVEPLAY_TRANSCODE_PACE=0 disables pacing entirely.
        let pacing_enabled = std::env::var("DIVEPLAY_TRANSCODE_PACE")
            .map(|v| v != "0")
            .unwrap_or(true);
        let is_reencode = mode != "remux" && mode != "audio";
        let mut pacing_desc = "off";
        // Fragments are emitted per GOP, so GOP length is the granularity the
        // client receives data in. 2s chunks are fine when there is a real buffer;
        // on the 1x `-re` fallback there isn't one, so use shorter GOPs there to
        // keep the delivery smooth (costs a little compression efficiency).
        let mut gop = "48";
        if is_reencode && pacing_enabled {
            let caps = ffmpeg_pacing(&ffmpeg_path);
            if caps.readrate {
                cmd.arg("-readrate").arg("1.5");
                pacing_desc = "readrate 1.5";
                if caps.initial_burst {
                    // Seconds of media to produce at full speed before throttling.
                    cmd.arg("-readrate_initial_burst").arg("30");
                    pacing_desc = "readrate 1.5 + 30s burst";
                }
                if caps.catchup {
                    cmd.arg("-readrate_catchup").arg("4");
                }
            } else {
                // ffmpeg 4.x: 1x is all we have, so soften the delivery instead.
                cmd.arg("-re");
                gop = "12";
                pacing_desc = "-re (1x; ffmpeg too old for -readrate)";
            }
        }

        cmd.arg("-i").arg(&path_str)
           .arg("-map").arg("0:v:0?")
           .arg("-map").arg(format!("0:a:{}?", audio_idx))
           .arg("-sn")
           .arg("-dn");

        match mode {
            "remux" => {
                cmd.arg("-c:v").arg("copy")
                   .arg("-c:a").arg("copy");
            }
            "audio" => {
                cmd.arg("-c:v").arg("copy")
                   .arg("-c:a").arg("aac")
                   .arg("-ac").arg("2")
                   .arg("-b:a").arg("160k");
            }
            _ => {
                // No -threads cap: pacing is what bounds sustained CPU, and letting
                // x264 use the machine keeps the initial burst short.
                app_log!("Transcode: mode={} pacing={}", mode, pacing_desc);
                cmd.arg("-c:v").arg("libx264")
                   .arg("-pix_fmt").arg("yuv420p")
                   .arg("-preset").arg("ultrafast")
                   .arg("-tune").arg("zerolatency")
                   .arg("-crf").arg("26")
                   .arg("-g").arg(gop)
                   .arg("-c:a").arg("aac")
                   .arg("-ac").arg("2")
                   .arg("-b:a").arg("160k");
            }
        }

        cmd.arg("-f").arg("mp4")
           .arg("-avoid_negative_ts").arg("make_zero")
           .arg("-muxdelay").arg("0")
           .arg("-flush_packets").arg("1")
           .arg("-max_muxing_queue_size").arg("2048")
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
        if let Some((start, end)) = parse_byte_range(range, size) {
            let content_length = end - start + 1;
            use std::io::SeekFrom;
            use tokio::io::{AsyncReadExt, AsyncSeekExt};

            let mut file = file;
            file.seek(SeekFrom::Start(start)).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

            let stream = ReaderStream::with_capacity(file.take(content_length), 64 * 1024);
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

        if range.starts_with("bytes=") {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{}", size))
                .header(header::ACCEPT_RANGES, "bytes")
                .body(Body::empty())
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
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
        // AppRun probes the host GL stack and picks gpu / gpu-nodmabuf / software
        // before we start. Surface its verdict here so the in-app log viewer (L)
        // shows whether this session is GPU-accelerated or on llvmpipe.
        if let Ok(mode) = std::env::var("DIVEPLAY_GL_MODE") {
            let why = std::env::var("DIVEPLAY_GL_WHY").unwrap_or_default();
            app_log!("Rendering mode: {} ({})", mode, why);
            if std::env::var("DIVEPLAY_GL_FALLBACK").as_deref() == Ok("1") {
                app_log!("  a higher tier failed to render on this host and was dropped automatically");
            }
            if mode == "software" {
                app_log!("  software rendering uses substantially more CPU; \
                          run with DIVEPLAY_GPU_DEBUG=1 to see why the GPU was rejected");
            }
        }
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
        .invoke_handler(tauri::generate_handler![
            get_streaming_url, get_media_info, get_logs, clear_logs, log_event,
            get_render_info, read_player_state, write_player_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
