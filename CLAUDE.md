# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server (browser, http://localhost:5173)
npm run build        # tsc -b && vite build  →  single inlined HTML in dist/
npm run lint         # ESLint over **/*.{ts,tsx} (ignores dist, src-tauri)
npm run preview      # Preview built bundle
npm run tauri dev    # Run desktop shell against the dev server
npm run tauri build  # Build desktop app (NSIS installer on Windows)
```

There are no tests. The build script's `tsc -b` is the primary type/lint gate.

The Vite config uses `vite-plugin-singlefile` — the entire web app ships as one self-contained `index.html`. Do not introduce code-split chunks or external asset URLs; they will break the portable web distribution.

## Two-platform architecture

DivePlay ships as two artifacts from one React codebase:

- **Web** — single portable HTML file. Limited by browser codec support; uses the File System Access API for folder access. State persists to `.player-state.json` *inside the user's media folder*.
- **Desktop (Tauri v2)** — same frontend wrapped in a Rust shell that bundles `ffmpeg`/`ffprobe` as sidecar binaries and runs a local axum HTTP server for streaming + on-the-fly transcoding.

The frontend never imports Tauri APIs statically. Runtime detection (`isTauri()` in `src/services/tauri.ts`, which checks `window.__TAURI_INTERNALS__`) gates dynamic imports so the same bundle works in both contexts. `@tauri-apps/api/*` and the Tauri plugins must only be loaded behind that check.

### Platform capability gating

`src/platform/capabilities.ts` exports a single `capabilities` object (`canTranscode`, `hasNativeLogs`, `supportsAudioTracks`, `hasNativeFileSystem`) — all currently derived from `isTauri()`. New platform-specific behavior should branch on one of these flags rather than calling `isTauri()` directly, so the abstraction stays in one place.

### Service factory pattern

Two factories pick the right backend based on `capabilities`:

- `src/services/fileSystem.ts` → `web/fileSystem.ts` (File System Access API) or `tauri/fileSystem.ts` (native paths via `@tauri-apps/plugin-fs`). Implementations satisfy `IFileSystem` from `src/services/core/interfaces.ts`.
- `src/services/codecService.ts` → `web/mediaService.ts` (object URLs) or `tauri/mediaService.ts` (HTTP stream URL from the Rust backend, with optional transcode/audio-track/start-time query params). Implementations satisfy `IMediaService`.

When adding a feature that touches files or media playback, add it to the `IFileSystem` / `IMediaService` interface first, then implement in both `web/` and `tauri/`. Callers should import from the factory module, never directly from `web/` or `tauri/` subfolders.

`MediaFile` (`src/types/index.ts`) carries both a web `handle?: FileSystemFileHandle` and a Tauri `nativePath?: string`; exactly one is populated depending on origin.

### Rust backend (`src-tauri/src/lib.rs`)

On startup, the Tauri app:
1. Generates a per-session `stream_token` (nanosecond timestamp).
2. Binds an axum server to `127.0.0.1:0` (random free port) and stores the port in Tauri's managed state.
3. Exposes commands: `get_streaming_url`, `get_media_info` (ffprobe JSON), `get_logs`, `clear_logs`.

The `/stream/*path` route validates the token, then either:
- **Direct stream** with HTTP `Range` support for natively playable files, or
- **Transcode** via ffmpeg piped to stdout as fragmented MP4 (`libx264` ultrafast/zerolatency CRF 26, AAC 128k, `frag_keyframe+empty_moov+default_base_moof`) when `?transcode=true`. `kill_on_drop(true)` cleans up ffmpeg when the client disconnects.

`get_sidecar_path` walks six fallback locations (Tauri Resource dir, `%APPDATA%`, exe-relative, dev cwd) — keep all six when modifying; they each cover a different installer/dev scenario. The `app_log!` macro mirrors to stderr and an in-memory ring buffer (1000 lines) surfaced by `get_logs` and rendered in `LogViewer` (toggle with `L` key in the UI).

Sidecar binaries live at `src-tauri/binaries/ffmpeg.exe` and `src-tauri/binaries/ffprobe.exe` and are listed under `bundle.resources` in `src-tauri/tauri.conf.json`. Desktop builds will fail without them.

## State and persistence

- React Context (`src/store/playerStore.ts`) is the only state container — no Redux/Zustand. All actions live on `App.tsx` and flow through `PlayerContext.Provider`.
- **Per-folder state** (`.player-state.json` inside the media folder): last played file, position, settings. Written via `writeState` on pause, every 5 s during playback (throttled), on volume/speed/sort/subtitle changes, and on `beforeunload`.
- **Per-browser state** (IndexedDB `folderplayer` DB, `handles` store in `src/services/db.ts`): the last `FileSystemDirectoryHandle` (web only — handles are structured-cloneable), file-type preferences, and app settings.

When adding new persisted settings, extend the `Settings` interface in `src/types/index.ts`, add a default in `defaultSettings` (`src/store/playerStore.ts`), and remember the merge in `App.tsx:handleFolderReady` reads them back into the live state — including the nested `subtitles` spread.

## Release

Tagging `v*` triggers `.github/workflows/release.yml`, which runs a matrix on `windows-latest` and `ubuntu-22.04`. `tauri-action` builds per-OS artifacts (NSIS on Windows; `.deb` + AppImage on Linux — driven by `bundle.targets` in `tauri.conf.json`) and creates/updates the same GitHub Release. The Linux runner also handles the portable web HTML: it renames `dist/index.html` to `diveplay-web.html` and uploads it via `softprops/action-gh-release` (gated to one runner to avoid duplicate uploads).

On Linux, the `.deb` declares `ffmpeg` as a system dependency and `get_sidecar_path` falls back to `/usr/bin/ffmpeg` etc., so the app uses the system FFmpeg rather than a bundled sidecar — the `binaries/ffmpeg` and `binaries/ffprobe` files in `src-tauri/binaries/` are dev-only and not relied on at runtime in installed builds.
