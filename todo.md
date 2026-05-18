# TODO — Linux Build

Tracking the work to ship a Linux (.deb / .AppImage) build alongside the existing Windows installer and portable web HTML.

## 1. Sidecar binaries

- [x] Linux `ffmpeg` and `ffprobe` dropped at `src-tauri/binaries/` with executable bit set.
- [x] **Decision:** the committed binaries are the host (Arch) system's `ffmpeg`, dynamically linked against `libavcodec.so.62` etc. They will NOT work on Ubuntu/Debian or AppImage targets that have different `libav*` versions. **Strategy chosen:** depend on the system `ffmpeg` package for `.deb` installs and look it up via `/usr/bin/ffmpeg` at runtime, rather than ship our own. The bundled files now serve only as a `cargo run`/dev fallback on Arch.
- [ ] *(Optional follow-up)* If you want a self-contained AppImage, swap the bundled `ffmpeg`/`ffprobe` for a static build from <https://johnvansickle.com/ffmpeg/> or <https://github.com/BtbN/FFmpeg-Builds> and add a `linkdeps` step to AppImage. Not blocking the first Linux release.
- [ ] Note GPL-compatible build flags in README "Credits" once a static build is picked.

## 2. `src-tauri/tauri.conf.json`

- [x] `bundle.targets` now `["nsis", "deb", "appimage"]`.
- [x] `bundle.resources` keeps both `.exe` (Windows) and bare `ffmpeg`/`ffprobe` (Linux) entries. Tauri picks the right ones at build time.
- [x] Added `bundle.linux.deb.depends: ["ffmpeg"]` so installing the `.deb` pulls in the system FFmpeg.
- [ ] *(Not blocking)* `productName: "diveplay"` (lowercase) is fine as the Linux binary name; revisit if you want `DivePlay` casing on `.desktop` files.

## 3. `src-tauri/src/lib.rs` — `get_sidecar_path`

- [x] Added "Try 3b" XDG/AppImage branch covering `$APPDIR/usr/bin`, `$APPDIR/resources/binaries`, `$XDG_DATA_HOME/com.diveplay.app/...`, `$HOME/.local/share/com.diveplay.app/...`, `/usr/lib/diveplay/...`, `/usr/share/diveplay/...`.
- [x] Added "Try 6" system-binary branch (`/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`) gated `#[cfg(not(target_os = "windows"))]` — this is what catches the `apt-installed ffmpeg`.
- [x] Last-resort step 7 now returns `PathBuf::from(&binary_name)` so the OS resolves via `PATH` instead of erroring (matches the log message that already claimed to fall back to PATH).

## 4. `src-tauri/src/lib.rs` — ffmpeg invocation

- [x] `CREATE_NO_WINDOW` constant now `#[cfg(windows)]` — eliminates the "constant never used" warning on Linux.
- [x] `cargo check` clean on Linux (`Finished dev profile … target(s)`, no warnings).
- [ ] Real-world: spot-check `kill_on_drop(true)` actually reaps ffmpeg on Linux when the browser tab closes (manual run).

## 5. `src-tauri/src/main.rs`

- [x] `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` is conditional — left as-is. Will verify no stray terminal once a Linux release build runs.

## 6. Frontend (`src/`)

- [x] No code changes needed. Path handling is already separator-agnostic in `App.tsx`, `services/core/utils.ts`, `services/tauri/fileSystem.ts`, `Playlist.tsx`, `Player.tsx`. `capabilities/default.json` uses `"path": "**"`.

## 7. CI — `.github/workflows/release.yml`

- [x] Job is now a matrix on `windows-latest` and `ubuntu-22.04`.
- [x] Added a Linux-only `apt-get install` step for `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`, `libssl-dev` (`if: matrix.platform == 'linux'`).
- [x] `tauri-action` reads per-OS targets from `bundle.targets` — no `--target` flag needed.
- [x] Gated `Prepare Web Version` (now `cp` instead of PowerShell `Copy-Item`) and the `softprops/action-gh-release` step to the Linux runner only, so `diveplay-web.html` uploads once.
- [x] `permissions: contents: write` preserved (moved to job level).
- [ ] **Verify on a `v*-rc` tag** that both runners attach artifacts to the same Release (tauri-action deduplicates by tag, but worth a dry run before a real `v1.0.8`).

## 8. Verification

Local (this machine):
- [x] `cargo check` clean.
- [ ] `npm install && npm run tauri build` — confirm `.deb` and `.AppImage` appear under `src-tauri/target/release/bundle/`. Time-consuming (full Rust release build); run when ready.
- [ ] Manual `npm run tauri dev` smoke test:
  - Folder picker opens, playlist scans.
  - Direct play of H.264/AAC mp4 (no transcode path).
  - Drag-and-drop a folder onto the window (Tauri `onDragDropEvent`) — confirm native Linux paths reach `scanDirectory`.
  - Log viewer (`L` key) shows `[DivePlay]` lines with the new "Try 3b" / "Try 6" path attempts.

On a clean Debian/Ubuntu VM:
- [ ] `sudo apt install ./diveplay_*.deb` — confirm `ffmpeg` is pulled as a dependency.
- [ ] Open an HEVC + AC3 MKV; verify `/stream/...?transcode=true` streams fragmented MP4. Watch logs for which path resolved (`/usr/bin/ffmpeg` is expected).
- [ ] Same test inside the `.AppImage` — confirm `$APPDIR` fallbacks or `/usr/bin` (depending on host) work.

Release path:
- [ ] Tag `v1.0.8-rc1`; confirm workflow uploads `.deb`, `.AppImage`, `.exe`, and `diveplay-web.html` to the same release exactly once each.

## 9. Docs

- [x] README "Two Ways to Play" table now lists Windows NSIS and Linux `.deb`/AppImage separately.
- [x] CLAUDE.md "Release" section updated for the matrix workflow and the system-ffmpeg strategy on Linux.
