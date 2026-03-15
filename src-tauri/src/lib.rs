use std::path::PathBuf;
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
use tokio::fs::File;
use tokio_util::io::ReaderStream;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tokio::process::Command;

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

const CREATE_NO_WINDOW: u32 = 0x08000000;

fn get_sidecar_path(handle: &AppHandle, name: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let ext = ".exe";
    #[cfg(not(target_os = "windows"))]
    let ext = "";

    let binary_name = format!("{}{}", name, ext);

    // 1. Try standard Resource directory (Tauri v2)
    if let Ok(path) = handle.path().resolve(format!("binaries/{}", binary_name), BaseDirectory::Resource) {
        if path.exists() {
            return Ok(path);
        }
    }

    // 2. Try relative to the executable (common for portable and NSIS side-by-side)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // Check in ./binaries/
            let path = exe_dir.join("binaries").join(&binary_name);
            if path.exists() {
                return Ok(path);
            }
            // Check in ./
            let path = exe_dir.join(&binary_name);
            if path.exists() {
                return Ok(path);
            }
        }
    }

    // 3. Development fallbacks
    let dev_paths = [
        std::env::current_dir().unwrap_or_default().join("binaries").join(&binary_name),
        std::env::current_dir().unwrap_or_default().join("src-tauri").join("binaries").join(&binary_name),
    ];

    for path in dev_paths {
        if path.exists() {
            return Ok(path);
        }
    }

    // 4. Last resort: check system PATH
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
    let ffprobe_path = get_sidecar_path(&handle, "ffprobe")?;
    
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
        .map_err(|e| format!("Failed to execute ffprobe: {}", e))?;

    if !output.status.success() {
        return Err("ffprobe failed to read file".to_string());
    }

    let info: MediaInfo = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    Ok(info)
}

async fn stream_file(
    State(state): State<Arc<AppState>>,
    Path(path_str): Path<String>,
    Query(params): Query<StreamParams>,
    req: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    if params.token != state.stream_token {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let path = PathBuf::from(&path_str);
    if !path.exists() || !path.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }

    let should_transcode = params.transcode.unwrap_or(false);
    
    if should_transcode {
        let audio_idx = params.audio_track.unwrap_or(0);
        let start_time = params.ss.unwrap_or(0.0);
        
        let ffmpeg_path = get_sidecar_path(&state.handle, "ffmpeg")
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        
        let mut cmd = Command::new(&ffmpeg_path);
        
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        
        cmd.kill_on_drop(true); 

        cmd.arg("-y")
           .arg("-hide_banner")
           .arg("-loglevel").arg("error");

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
           .stderr(Stdio::null()); // Silencing stderr for production performance

        let mut child = cmd.spawn()
            .map_err(|e| {
                eprintln!("Failed to spawn FFmpeg: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR
            })?;

        let stdout = child.stdout.take().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        let stream = ReaderStream::new(stdout);
        let body = Body::from_stream(stream);

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
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            
            // Generate a simple session token
            let stream_token = format!("{:x}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos());
            
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
                    .layer(CorsLayer::permissive());

                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let port = listener.local_addr().unwrap().port();
                
                let _ = tx.send(port).await;
                
                axum::serve(listener, router).await.unwrap();
            });

            let port = tauri::async_runtime::block_on(async { rx.recv().await.unwrap() });
            app.manage(port);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_streaming_url, get_media_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
