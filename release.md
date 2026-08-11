# Release Process

A release is **split by artifact** so platform-specific fixes do not force unrelated validation:

- **Windows installer** is built manually from GitHub Actions → `Release Windows`.
- **Portable web HTML** is built manually from GitHub Actions → `Release Web HTML`.
- **The Linux AppImage is built manually** with `scripts/build-appimage.sh` (Docker) and uploaded to the same Release by hand.

> The release workflow used to run a Windows + Ubuntu matrix that also produced the
> `.deb` and `.AppImage`, then a Windows-only tag workflow. As of v1.0.12, pushing a tag
> does **not** build any artifact automatically. Publish only the artifact that changed
> and was validated.

## What gets produced

| Artifact | Platform | Built by | Automatic? |
|----------|----------|----------|------------|
| `diveplay_<ver>_x64-setup.exe` | Windows installer (NSIS) | `Release Windows` workflow | ❌ manual dispatch |
| `diveplay-web.html` | Single-file portable web player | `Release Web HTML` workflow | ❌ manual dispatch |
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

5. **Tag with the same version prefixed by `v`** and push:
   ```bash
   git push origin main
   git tag -a v1.0.9 -m "Release v1.0.9"
   git push origin v1.0.9
   ```
   A hyphenated tag (`v1.0.9-rc1`) should be treated as a prerelease in manual workflows.

6. **Build only the artifacts that changed and were validated:**
   - Windows: Actions → `Release Windows` → Run workflow → `tag_name=vX.Y.Z`
   - Web HTML: Actions → `Release Web HTML` → Run workflow → `tag_name=vX.Y.Z`
   - Linux AppImage: build locally with `./scripts/build-appimage.sh`

7. **Create/update the GitHub Release and upload the Linux AppImage manually** when shipping Linux:
   ```bash
   ./scripts/build-appimage.sh
   gh release create v1.0.9 release-artifacts/diveplay_1.0.9_amd64.AppImage \
     --title "DivePlay v1.0.9" \
     --notes-file CHANGELOG-v1.0.9.md
   # If the release already exists:
   gh release upload v1.0.9 release-artifacts/diveplay_1.0.9_amd64.AppImage --clobber
   ```

8. **Verify the Release** at <https://github.com/dougmb/diveplay/releases>: only the intended artifacts are attached; prerelease flag matches intent.

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

- **The AppImage bundles a static ffmpeg/ffprobe 7.x**, downloaded from
  johnvansickle.com during the build (GPL static builds). `bundle.resources` still contains
  development/Windows binaries, so the script removes those from the AppDir first. Do not
  rely on the host `/usr/bin/ffmpeg` from inside the AppImage: AppRun's bundled library path can
  break host FFmpeg binaries, especially on Arch/newer distros.
  - Ubuntu 22.04's own ffmpeg (4.4) was used until v1.0.19. It had to go because its only
    pacing control is `-re`, a hard 1x, which starves the player's buffer and stutters —
    see the transcode pacing note below. 7.x adds `-readrate` / `-readrate_initial_burst`.
  - Being static, they need no shared libraries, so they are no longer passed to
    `linuxdeploy --executable`.
  - The build asserts the download still provides `-readrate_initial_burst`, `libx264` and
    `aac`, and that `ffprobe` runs — the URL tracks the latest release, so a future rolling
    update must fail the build rather than ship a player that cannot transcode.

- **On-the-fly transcodes are paced.** Unpaced, `libx264` transcodes the entire file as fast
  as the machine allows: every core saturated for ~a minute on each file switch (measured
  380% of a core, vs 13% paced). The backend probes what the available ffmpeg supports and
  picks the best option, so old system ffmpeg on `.deb` installs still works:
  | ffmpeg | Flags used | Behaviour |
  | --- | --- | --- |
  | >= 7.0 | `-readrate 1.5 -readrate_initial_burst 30` (+ `-readrate_catchup 4` on >= 7.1) | bursts ~3 s to build a 30 s cushion, then settles at ~22% of a core |
  | 5.1–6.x | `-readrate 1.5` | no initial burst, so the cushion builds as it plays |
  | < 5.1 | `-re` + shorter GOP (`-g 12`) | 1x only; shorter fragments keep delivery smooth without a buffer |

  Threads are deliberately **not** capped — a `-threads` limit barely helped (380% → 334%,
  it just saturates fewer threads) and only slows the burst down. `DIVEPLAY_TRANSCODE_PACE=0`
  disables pacing at runtime.

- **`tauri build` can't run `linuxdeploy` itself inside Docker** (it fails with a silent
  "failed to run linuxdeploy"). The script lets `tauri build` create the AppDir, then runs
  `linuxdeploy --plugin gtk --plugin gstreamer` and `appimagetool` manually.

- **A software Mesa (llvmpipe) stack is bundled** into `usr/lib/dpsoftgl/` as a *fallback*.
  It exists because the bundled (older) WebKitGTK cannot talk to every host GL driver: on some
  hosts it aborts with `Could not create default EGL display: EGL_BAD_PARAMETER` (e.g. Mesa
  26.x) and **no `WEBKIT_DISABLE_*` env var works around it**.

- **The GL backend is chosen per host at startup** by `dp-glprobe` (`scripts/dp-glprobe.c`,
  compiled into `AppDir/usr/bin/`). Forcing software rendering unconditionally costs roughly a
  full CPU core — even for 480p — on machines whose GPU works fine, so AppRun probes first.
  - "Does the host have a GPU?" is **not** a usable test: the hosts that break have perfectly
    good GPUs and a populated `/dev/dri`. The probe therefore really initialises EGL, creates a
    GLES2 context and reads back `GL_RENDERER`.
  - It runs as a **separate short-lived process**, so a host stack that aborts or segfaults
    kills the *probe* and AppRun falls back to software. `timeout(1)` covers drivers that hang.
  - It tries several EGL platforms (the `GDK_BACKEND` one first, then Wayland/X11, default,
    surfaceless) and only stops on a *hardware* renderer. This matters: on a glvnd host with
    both Mesa and a vendor driver, `EGL_DEFAULT_DISPLAY` often resolves to Mesa and silently
    falls back to llvmpipe, while the X11 platform reaches the real GPU.
  - Exit codes: `0` hardware + usable DRM render node (DMABuf renderer on) · `1` hardware, no
    render node (DMABuf off) · `2` unusable EGL · `3` host is software-only. `2` and `3` both
    select the bundled stack — for `3`, ours is newer and self-contained.
  - The verdict is cached in `${XDG_CACHE_HOME:-~/.cache}/diveplay/gl-mode`, keyed on the
    DivePlay build, session/backend, GPU set and host GL driver, so it re-probes only when one
    of those changes. The probe itself takes ~0.15 s.
  - The selected mode is logged at startup and visible in the in-app log viewer (press `L`).

  Runtime overrides:
  | Variable | Effect |
  | --- | --- |
  | `DIVEPLAY_GPU=auto` | default — probe, use the GPU only if it actually works |
  | `DIVEPLAY_GPU=1` | force host hardware GL, skip the probe |
  | `DIVEPLAY_GPU=0` | force the bundled software stack, skip the probe |
  | `DIVEPLAY_GPU_DEBUG=1` | print the decision and probe detail to stderr |
  | `DIVEPLAY_GPU_NOCACHE=1` | ignore the cached verdict and re-probe |

  `DIVEPLAY_FORCE_GPU=1` is still honoured as an alias for `DIVEPLAY_GPU=1`.

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

## What the manual workflows do

```
Release Windows workflow
  └── checkout tag → npm install → tauri-action → .exe uploaded to Release

Release Web HTML workflow
  └── checkout tag → npm install → npm run build → diveplay-web.html uploaded to Release
```

Both workflows are `workflow_dispatch` only. Pushing a tag does not publish anything by itself.
`NO_STRIP: "true"` is kept because it is also required by the manual Linux build and is harmless
on Windows.

## Why certain things are the way they are

- **FFmpeg lookup on Linux** — at runtime `get_sidecar_path` in `src-tauri/src/lib.rs` walks:
  bundled resources → XDG/AppImage dirs → exe-relative → dev paths → `/usr/bin`, `/usr/local/bin`,
  `/opt/homebrew/bin` → bare name (`PATH`). The AppImage should find its bundled Ubuntu
  `AppDir/usr/bin/ffmpeg` first; the system-binary fallback is mainly for `.deb` and development.

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
