# Release Process

A release is **part automated, part manual**:

- **Windows installer + portable web HTML** are built automatically by `.github/workflows/release.yml` when a `v*` tag is pushed.
- **The Linux AppImage is built manually** with `scripts/build-appimage.sh` (Docker) and uploaded to the same Release by hand.

> The release workflow used to run a Windows + Ubuntu matrix that also produced the
> `.deb` and `.AppImage`. As of v1.0.9 the matrix is **Windows-only** (commit `77ada76`),
> so any Linux artifact has to be produced locally — see *Building the Linux AppImage* below.

## What gets produced

| Artifact | Platform | Built by | Automatic? |
|----------|----------|----------|------------|
| `diveplay_<ver>_x64-setup.exe` | Windows installer (NSIS) | `tauri-action` on `windows-latest` | ✅ CI (tag push) |
| `diveplay-web.html` | Single-file portable web player | `Copy-Item dist/index.html` step on the Windows runner | ✅ CI (tag push) |
| `diveplay_<ver>_amd64.AppImage` | Portable Linux | `scripts/build-appimage.sh` (Docker `ubuntu:22.04`) | ❌ manual |
| `diveplay_<ver>_amd64.deb` | Debian/Ubuntu package | not currently produced (see *Building the .deb*) | ❌ manual / skipped |

`bundle.targets` in `src-tauri/tauri.conf.json` is still `["nsis", "deb", "appimage"]`. On the
Windows CI runner `tauri-action` only emits the targets valid for that OS (`nsis`); the
`deb`/`appimage` targets are Linux-only and simply don't run there.

## Cutting a release — step by step

1. **Make sure `main` is green** locally. The release workflow only builds/bundles — there's no separate test gate.

2. **Bump the version in three files** to the same value (semver, plus optional prerelease suffix like `-rc1` / `-beta2`):
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`
   - `src-tauri/tauri.conf.json` → `"version"`

3. **Refresh the lockfiles** so they match the manifests (otherwise builds rebuild them and the diff drifts):
   ```bash
   cd src-tauri && cargo update -p diveplay
   cd ..       && npm install --package-lock-only
   ```
   > Heads-up: as of this writing `src-tauri/Cargo.lock` and `package-lock.json` on `main`
   > are stale at `1.0.8-rc2` while the project is `1.0.9`. Re-running the commands above fixes it.

4. **Commit** the bump together with the feature/fix commits for the release (conventional-commit style).

5. **Tag with the same version prefixed by `v`** and push — the tag is the trigger:
   ```bash
   git push origin main
   git tag -a v1.0.9 -m "Release v1.0.9"
   git push origin v1.0.9
   ```
   A hyphenated tag (`v1.0.9-rc1`) is auto-marked **prerelease** via `contains(github.ref_name, '-')`.

6. **Wait for CI** at <https://github.com/dougmb/diveplay/actions> (~5-8 min, Windows only now).
   It attaches `diveplay_<ver>_x64-setup.exe` and `diveplay-web.html` to the Release.

7. **Build and upload the Linux AppImage manually** (see next section):
   ```bash
   ./scripts/build-appimage.sh
   gh release upload v1.0.9 release-artifacts/diveplay_*_amd64.AppImage --clobber
   ```

8. **Verify the Release** at <https://github.com/dougmb/diveplay/releases>: `.exe`, `diveplay-web.html`, and `.AppImage` attached; prerelease flag matches intent.

## Building the Linux AppImage (manual)

Run `./scripts/build-appimage.sh` from the repo root. It runs the whole build inside an
**Ubuntu 22.04 Docker container** and drops `diveplay_<ver>_amd64.AppImage` into `release-artifacts/`.

Requirements: Docker with access to `/dev/fuse` (the script passes `--device /dev/fuse
--cap-add SYS_ADMIN`). First run pulls `ubuntu:22.04` and compiles Rust from scratch
(~15-25 min); later runs reuse the `dp_node_modules` / `dp_cargo_target` / `dp_cargo_registry`
named volumes and are much faster.

The script (and this design) exist because of several hard constraints:

- **Why Docker `ubuntu:22.04`, never the host distro.** Building on a bleeding-edge distro
  (e.g. Arch) produces an AppImage linked against very new glibc that won't start on older
  distros — the opposite of portable. Ubuntu 22.04 = glibc 2.35. Also, `linuxdeploy`'s gtk
  plugin assumes the Debian `gdk-pixbuf` loader layout and fails on Arch.

- **The bundled ffmpeg/ffprobe are removed from the AppDir.** `bundle.resources` ships dynamic
  Arch `ffmpeg`/`ffprobe` (which need `libavdevice.so.62`, absent on Ubuntu) plus 99 MB Windows
  `.exe` files. They break `linuxdeploy`'s dependency resolution and bloat the image. On Linux
  the app uses the **system** ffmpeg (`get_sidecar_path` → `/usr/bin/ffmpeg`), so dropping them
  is correct.

- **`tauri build` can't run `linuxdeploy` itself inside Docker** (it fails with a silent
  "failed to run linuxdeploy"). The script lets `tauri build` create the AppDir, then runs
  `linuxdeploy --plugin gtk --plugin gstreamer` and `appimagetool` manually.

- **A software Mesa (llvmpipe) stack is bundled** into `usr/lib/dpsoftgl/`, and the AppRun
  routes GL/EGL through it by default. This is the key to *true* OS-independence: the
  WebKitGTK in the AppImage talks to a self-contained software GL stack instead of the host's
  GPU driver. Without it, the bundled (older) WebKitGTK aborts with
  `Could not create default EGL display: EGL_BAD_PARAMETER` on hosts with a very new Mesa
  (e.g. Mesa 26.x), and **no `WEBKIT_DISABLE_*` env var works around it**.
  - Trade-off: software rendering (no GPU-accelerated compositing). Video decode still goes
    through GStreamer.
  - **`DIVEPLAY_FORCE_GPU=1`** at runtime skips the software stack and uses the host's
    hardware OpenGL/EGL — fine on mainstream distros, faster, but will crash on hosts whose
    GPU stack the bundled WebKit can't talk to.

After building, the in-container step rewrites `dist/` and may touch the lockfiles; discard
them if you're not committing:
```bash
git checkout -- dist package-lock.json src-tauri/Cargo.lock
```

## Building the `.deb` (manual, if needed)

CI no longer emits the `.deb`. To produce one, build on a Debian/Ubuntu host (or container)
with the Tauri Linux deps installed:
```bash
NO_STRIP=true npm run tauri build -- --bundles deb
# Output: src-tauri/target/release/bundle/deb/diveplay_<ver>_amd64.deb
```
The `.deb` declares `ffmpeg` as a dependency (`bundle.linux.deb.depends`) and relies on the
system ffmpeg at runtime — it does **not** need the software-Mesa workaround the AppImage uses,
because it runs against the host's matching WebKitGTK/GL stack.

## What the CI workflow does

```
v1.0.9 tag pushed
  │
  └── windows-latest runner ────────────────────────┐
        1. checkout                                  │
        2. setup-node@v4 (node 20)                   │
        3. dtolnay/rust-toolchain@stable             │
        4. npm install                               │
        5. tauri-action (NO_STRIP=true) ──► .exe (NSIS) → uploaded to Release
        6. Copy-Item dist/index.html dist/diveplay-web.html   (pwsh)
        7. softprops/action-gh-release ──► diveplay-web.html → uploaded to Release
                                                     │
                                  GitHub Release ────┘
```

`tauri-action` creates/edits the Release keyed by `tagName`; the second step appends the web
HTML to the same Release. `NO_STRIP: "true"` is kept because `linuxdeploy`'s embedded `strip`
chokes on the `.relr.dyn` ELF section emitted by newer toolchains (harmless on Windows, but the
same flag is needed for the manual Linux build).

## Why certain things are the way they are

- **System `ffmpeg` on Linux** — at runtime `get_sidecar_path` in `src-tauri/src/lib.rs` walks:
  bundled resources → XDG/AppImage dirs → exe-relative → dev paths → `/usr/bin`, `/usr/local/bin`,
  `/opt/homebrew/bin` → bare name (`PATH`). The system-binary fallback is what lets both the
  `.deb` and the AppImage work without shipping a (broken, platform-specific) ffmpeg.

- **Single-file web HTML** — Vite's `viteSingleFile` plugin inlines the whole frontend into
  `dist/index.html`; the workflow just renames it so it's an obvious download on the Release page.

## Hotfixing a botched release

If a tag goes out wrong:

1. Delete the GitHub Release (Releases page → ⋮ → Delete).
2. Delete the tag locally and remotely (**destructive — confirm before running**):
   ```bash
   git tag -d v1.0.9
   git push origin :refs/tags/v1.0.9
   ```
3. Fix the issue, bump to the next patch, and tag again — don't re-use a version number.
   For prereleases, bump the suffix (`-rc1` → `-rc2`) instead of overwriting.

## Local sanity check before tagging

```bash
npm run build                 # tsc -b + vite build (type/lint gate)
cd src-tauri && cargo check   # fast Rust check, no full release build
```

Don't try to build the AppImage directly on the host (`npm run tauri build -- --bundles appimage`):
on Arch and other newer distros it fails at `linuxdeploy` (gdk-pixbuf layout, ffmpeg deps) and,
even when it packages, hits the WebKit EGL issue described above. Always use
`./scripts/build-appimage.sh`, which handles all of it in a clean Ubuntu 22.04 container.
