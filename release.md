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

- **Host-coupled libraries are moved to `usr/lib/dphost/<group>/`** instead of sitting in
  `usr/lib/`. linuxdeploy bundles every transitive dependency it finds, and a few of those share
  an ABI with code *outside* the AppImage, where an Ubuntu 22.04 copy is actively harmful:
  - `wayland` — the **host's** `libEGL_mesa.so.0` links `libwayland-client`, and Mesa ≥ 25 needs
    `wl_fixes_interface` (wayland 1.23+). Shadowing it with the bundled 1.20 made glvnd fail to
    load the Mesa EGL vendor, so **every** `eglGetPlatformDisplay` returned `EGL_BAD_PARAMETER`
    and WebKit's WebProcess aborted with `Could not create default EGL display` — a live window
    with a dead page, on a machine with a perfectly good GPU. This was the v1.0.19 AMD/Arch bug;
    NVIDIA hosts were unaffected only because `libEGL_nvidia.so.0` does not link wayland.
  - readline/ncurses/tinfo/edit (dragged in by gstreamer's aalib, libcaca and fluidsynth
    plugins) — these break any host shell or CLI tool the app spawns
    (`bash: undefined symbol: rl_trim_arg_from_keyseq`).

  `dp-run` puts a directory back on `LD_LIBRARY_PATH` only when the host cannot satisfy it, and
  **one directory is one decision**: the wayland family shares a directory and is restored as a
  set, every other library gets a directory of its own (so an Arch host, which ships
  `libncursesw.so.6` but no `libncurses.so.6`, gets exactly the one it is missing).

- **A software Mesa (llvmpipe) stack is bundled** into `usr/lib/dpsoftgl/` as the *floor*. It
  keeps its own self-consistent copies of everything, including wayland, so software mode
  depends on nothing from the host.

- **The GL tier is proposed per host, then verified.** Forcing software rendering
  unconditionally costs roughly a full CPU core — even for 480p — on machines whose GPU works
  fine, so the AppImage picks one of three tiers:

  | Tier | What it sets |
  | --- | --- |
  | `gpu` | host GL + WebKit's DMABuf renderer |
  | `gpu-nodmabuf` | host GL for GTK, `WEBKIT_DISABLE_DMABUF_RENDERER=1` so the WebProcess never needs an EGL display of its own |
  | `software` | the bundled llvmpipe stack, DMABuf off |

  - **Proposed** by `dp-glprobe` (`scripts/dp-glprobe.c`, compiled into `AppDir/usr/bin/`).
    "Does the host have a GPU?" is not a usable test — the hosts that break have good GPUs — so
    it really initialises EGL, creates a GLES2 context and reads `GL_RENDERER`, for **both**
    stacks that have to work: the platform GTK uses (`GDK_BACKEND`, pinned to x11 by the gtk
    hook) *and* the ladder WebKit's WebProcess uses (GBM → surfaceless → default, first hit
    wins, as WebKit does it). Testing only the former is what shipped v1.0.19 as `gpu` on a host
    where the WebProcess could not start.
  - Each candidate runs in its **own forked child** with a deadline, so a driver that aborts,
    segfaults or hangs only rules out that candidate. `timeout(1)` wraps the probe on top.
  - Exit codes: `0` → `gpu` · `1` → `gpu-nodmabuf` · `2` unusable EGL and `3` host is
    software-only → `software` (for `3`, ours is newer and self-contained). stdout carries
    `tier=… ui=… web=…`, which is what the info overlay shows as "Decided by".
  - **Verified** by `dp-run` (`scripts/dp-run.sh`, *sourced* by AppRun — a fresh `bash` under
    the AppDir's `LD_LIBRARY_PATH` is itself unreliable). The first launch on a given host is
    supervised: WebKit's fatal EGL banner kills only the WebProcess, so an exit code is not
    enough to notice, and stderr is watched for it (plus a crash inside the grace window). A
    tier that trips is torn down by process group and the next one down is launched instead.
  - Only a tier that survived is cached, in `${XDG_CACHE_HOME:-~/.cache}/diveplay/gl-mode`,
    keyed on the DivePlay build, session/backend, GPU set and host GL driver. Later launches
    skip both the probe and the supervision and `exec` straight into it.
  - The tier, the reason, and whether it came from a fallback are logged at startup (log viewer,
    `L`) and shown in the info overlay (`I`).

  Runtime overrides:
  | Variable | Effect |
  | --- | --- |
  | `DIVEPLAY_GPU=auto` | default — probe, verify, cache |
  | `DIVEPLAY_GPU=1` | force host hardware GL; no probe, no supervision |
  | `DIVEPLAY_GPU=0` | force the bundled software stack |
  | `DIVEPLAY_GL_START=<tier>` | start the supervised ladder at `gpu`/`gpu-nodmabuf`/`software` (testing) |
  | `DIVEPLAY_GL_NOWATCH=1` | never supervise |
  | `DIVEPLAY_GL_GRACE=<s>` | seconds a tier must survive to count as working (default 20) |
  | `DIVEPLAY_GPU_DEBUG=1` | print the decision and probe detail to stderr |
  | `DIVEPLAY_GPU_NOCACHE=1` | ignore the cached tier and re-probe |

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
