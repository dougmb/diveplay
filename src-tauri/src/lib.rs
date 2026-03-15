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

fn get_sidecar_path(handle: &AppHandle, name: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let ext = ".exe";
    #[cfg(not(target_os = "windows"))]
    let ext = "";

    // In Tauri v2, sidecars are usually in the resources folder in production
    // and handled automatically by the shell plugin, but here we need the path for Command::new
    
    // 1. Try resolving via Resource directory (standard for bundled files)
    let resource_path = format!("binaries/{}{}", name, ext);
    if let Ok(path) = handle.path().resolve(&resource_path, BaseDirectory::Resource) {
        if path.exists() {
            return Ok(path);
        }
    }

    // 2. Development fallbacks
    let paths_to_check = [
        std::env::current_dir().unwrap().join("binaries").join(format!("{}{}", name, ext)),
        std::env::current_dir().unwrap().join("src-tauri").join("binaries").join(format!("{}{}", name, ext)),
    ];

    for path in paths_to_check {
        if path.exists() {
            return Ok(path);
        }
    }

    Err(format!("Could not find binary '{}'. Checked resources/{} and dev paths.", name, resource_path))
}

#[tauri::command]
async fn get_media_info(handle: AppHandle, path: String) -> Result<MediaInfo, String> {
    let ffprobe_path = get_sidecar_path(&handle, "ffprobe")?;
    
    let mut cmd = Command::new(&ffprobe_path);
    
    #[cfg(windows)]
    {
        // On windows, we might need to handle raw paths or quoting, 
        // but Command::arg usually handles this.
    }

    let output = cmd.args([
            "-v", "error",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            &path // Removed -i for now to test if it's causing issues with some ffprobe versions
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run ffprobe at {:?}: {}", ffprobe_path, e))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe failed: {}", err_msg));
    }

    let info: MediaInfo = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    Ok(info)
}

#[tauri::command]
async fn get_streaming_url(handle: AppHandle, path: String) -> Result<String, String> {
    let port = handle.state::<u16>();
    let state = handle.state::<Arc<AppState>>();
    let encoded_path = urlencoding::encode(&path);
    Ok(format!("http://localhost:{}/stream/{}?token={}", *port, encoded_path, state.stream_token))
}

async fn stream_file(
    State(state): State<Arc<AppState>>,
    Path(path_str): Path<String>, // Axum already decodes the path from *path
    Query(params): Query<StreamParams>,
    req: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    // 1. Token validation
    if params.token != state.stream_token {
        eprintln!("Unauthorized access attempt with token: {}", params.token);
        return Err(StatusCode::UNAUTHORIZED);
    }

    let path = PathBuf::from(&path_str);

    // 2. Path safety check
    if !path.exists() || !path.is_file() {
        eprintln!("File not found or not a file: {}", path_str);
        return Err(StatusCode::NOT_FOUND);
    }

    // Check if we need to transcode
    let should_transcode = params.transcode.unwrap_or(false);
    
    if should_transcode {
        let audio_idx = params.audio_track.unwrap_or(0);
        let start_time = params.ss.unwrap_or(0.0);
        
        let ffmpeg_path = get_sidecar_path(&state.handle, "ffmpeg")
            .map_err(|e| {
                eprintln!("Sidecar resolution error: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR
            })?;
        
        println!("--- Spawning FFmpeg ---");
        println!("Input: {}", path_str);
        println!("Seek: {}s", start_time);
        
        let mut cmd = Command::new(&ffmpeg_path);
        
        // Don't use kill_on_drop for a moment to see if it changes anything
        // cmd.kill_on_drop(true); 

        cmd.arg("-y")
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
                eprintln!("CRITICAL: Failed to spawn FFmpeg: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR
            })?;

        let stdout = child.stdout.take().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        
        // Log stderr more aggressively
        if let Some(mut stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 { break; }
                    let msg = String::from_utf8_lossy(&buf[..n]);
                    eprint!("{}", msg);
                }
            });
        }

        let stream = ReaderStream::new(stdout);
        let body = Body::from_stream(stream);

        println!("Streaming started...");

        return Response::builder()
            .header(header::CONTENT_TYPE, "video/mp4")
            .header(header::CACHE_CONTROL, "no-cache")
            .header(header::TRANSFER_ENCODING, "chunked")
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
