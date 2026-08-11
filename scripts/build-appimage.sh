#!/usr/bin/env bash
#
# Build the portable Linux AppImage for DivePlay.
#
# Release CI is Windows-only (.github/workflows/release.yml), so the Linux
# AppImage is built here, manually, and uploaded to the GitHub Release by hand.
#
# It MUST be built inside an Ubuntu 22.04 container, never on a bleeding-edge
# host distro:
#   * glibc 2.35 (Ubuntu 22.04) keeps the AppImage runnable on older distros.
#   * linuxdeploy's gtk plugin assumes the Debian gdk-pixbuf layout (breaks on Arch).
#
# The resulting AppImage bundles a software Mesa (llvmpipe) stack and routes
# GL/EGL through it by default, so it renders independently of the host GPU
# driver and runs on ANY distro. Set DIVEPLAY_FORCE_GPU=1 at runtime to use the
# host's hardware OpenGL/EGL instead.
#
# Usage:  ./scripts/build-appimage.sh
# Output: ./release-artifacts/diveplay_<ver>_amd64.AppImage
#
# Requirements: Docker (rootless or with access to /dev/fuse + SYS_ADMIN).
# Named volumes (dp_node_modules, dp_cargo_target, dp_cargo_registry) cache the
# Node/Rust builds across runs; remove them with `docker volume rm` to reclaim space.
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/release-artifacts"
mkdir -p "$OUT"

echo ">> Building DivePlay AppImage in ubuntu:22.04 (this can take a while on the first run)…"

docker run --rm -i \
  --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor=unconfined \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$REPO":/work \
  -v dp_node_modules:/work/node_modules \
  -v dp_cargo_target:/work/src-tauri/target-docker \
  -v dp_cargo_registry:/root/.cargo/registry \
  -v "$OUT":/out \
  -w /work \
  ubuntu:22.04 bash -euo pipefail -s <<'CONTAINER'

export DEBIAN_FRONTEND=noninteractive

echo "::STEP:: apt deps"
apt-get update -qq
apt-get install -y --no-install-recommends \
  curl wget file ca-certificates xz-utils \
  build-essential pkg-config \
  libwebkit2gtk-4.1-dev \
  libssl-dev libsoup-3.0-dev libgtk-3-dev librsvg2-dev \
  libayatana-appindicator3-dev libxdo-dev \
  ffmpeg \
  patchelf desktop-file-utils \
  libfuse2 fuse \
  librsvg2-common libgdk-pixbuf-2.0-0 libgdk-pixbuf2.0-bin libglib2.0-bin \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-libav gstreamer1.0-pulseaudio libgstreamer1.0-0 \
  libgstreamer-plugins-base1.0-0 \
  libgl1-mesa-dri libegl1 libglx-mesa0 libegl-mesa0 libglapi-mesa \
  libgbm1 libglvnd0 libopengl0 libgl1
GDK_QUERY=$(command -v gdk-pixbuf-query-loaders || echo /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders)
"$GDK_QUERY" --update-cache 2>/dev/null || true

echo "::STEP:: node 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
apt-get install -y nodejs

echo "::STEP:: rust"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable >/dev/null 2>&1
export PATH="$HOME/.cargo/bin:$PATH"

echo "::STEP:: npm install"
cd /work
npm install --no-audit --no-fund

echo "::STEP:: tauri build (creates the AppDir; tauri's own linuxdeploy step fails in docker — that's fine)"
export NO_STRIP=true
export CARGO_TARGET_DIR=/work/src-tauri/target-docker
set +e
npm run tauri build -- --bundles appimage
set -e

OUTDIR=/work/src-tauri/target-docker/release/bundle/appimage
APPDIR="$OUTDIR/diveplay.AppDir"
echo "::STEP:: verify AppDir + install static ffmpeg/ffprobe"
test -x "$APPDIR/usr/bin/diveplay" || { echo "ERROR: AppDir/usr/bin/diveplay missing"; exit 1; }
# bundle.resources ships dynamic Arch ffmpeg/ffprobe (need libav*.so.62, absent here)
# + 99 MB Windows .exe. They break linuxdeploy and bloat the image, so drop them.
rm -rf "$APPDIR/usr/lib/diveplay/binaries"
# Ubuntu 22.04's own ffmpeg is 4.4, whose only pacing control is `-re` (a hard 1x).
# That starves the player's buffer and stutters. 7.x adds -readrate /
# -readrate_initial_burst, which is what lets the transcoder burst a real cushion
# and then settle just above realtime. These builds are also fully static, so
# linuxdeploy no longer has to collect ffmpeg's shared libraries at all.
mkdir -p /opt/ff && cd /opt/ff
curl -fsSL --retry 3 -o ff.tar.xz \
  https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar xf ff.tar.xz --strip-components=1
install -m755 ffmpeg ffprobe "$APPDIR/usr/bin/"
cd "$OUTDIR"

# Fail loudly if a future rolling release ever drops something we depend on,
# rather than shipping an AppImage that cannot transcode.
FFV="$("$APPDIR/usr/bin/ffmpeg" -version 2>/dev/null | head -1)"
echo "::STEP:: bundled $FFV"
# Capture to files and grep those: `ffmpeg ... | grep -q` dies to SIGPIPE when grep
# exits on the first match, and `set -o pipefail` then reports the whole pipeline
# as failed — the assertion would fail on a perfectly good ffmpeg.
"$APPDIR/usr/bin/ffmpeg" -hide_banner -h full > /tmp/ffhelp.txt 2>&1 || true
"$APPDIR/usr/bin/ffmpeg" -hide_banner -encoders > /tmp/ffenc.txt 2>&1 || true
grep -q -- "-readrate_initial_burst" /tmp/ffhelp.txt \
  || { echo "ERROR: bundled ffmpeg lacks -readrate_initial_burst (transcode pacing)"; exit 1; }
grep -qw libx264 /tmp/ffenc.txt \
  || { echo "ERROR: bundled ffmpeg lacks the libx264 encoder"; exit 1; }
grep -qw aac /tmp/ffenc.txt \
  || { echo "ERROR: bundled ffmpeg lacks the aac encoder"; exit 1; }
"$APPDIR/usr/bin/ffprobe" -version >/dev/null 2>&1 \
  || { echo "ERROR: bundled ffprobe does not run"; exit 1; }
rm -f "$OUTDIR"/*.AppImage

echo "::STEP:: linuxdeploy (deploy libs + gtk/gstreamer plugins, generate AppRun)"
T=/opt/ld; mkdir -p "$T"; cd "$T"
dl() { wget -q "$1" -O "$2"; chmod +x "$2"; }
dl https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage linuxdeploy
dl https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh linuxdeploy-plugin-gtk.sh
dl https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/master/linuxdeploy-plugin-gstreamer.sh linuxdeploy-plugin-gstreamer.sh
dl https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage appimagetool
export PATH="$T:$PATH"
export APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1 ARCH=x86_64
cd "$OUTDIR"
# No --output: just populate the AppDir + generate AppRun; we package manually below.
# ffmpeg/ffprobe are static, so they are deliberately NOT passed as --executable:
# there are no shared libraries to collect for them.
linuxdeploy \
  --appdir "$APPDIR" \
  --plugin gtk \
  --plugin gstreamer

echo "::STEP:: bundle software Mesa (llvmpipe) into AppDir/usr/lib/dpsoftgl"
L=/usr/lib/x86_64-linux-gnu
SG="$APPDIR/usr/lib/dpsoftgl"
mkdir -p "$SG/dri" "$SG/glvnd"
for f in libEGL.so.1 libEGL_mesa.so.0 libGLX.so.0 libGLX_mesa.so.0 libGLdispatch.so.0 \
         libOpenGL.so.0 libGL.so.1 libglapi.so.0 libgbm.so.1 libdrm.so.2; do
  cp -L "$L/$f" "$SG/" 2>/dev/null || true
done
cp -L "$L/dri/swrast_dri.so" "$SG/dri/"
closure() { ldd "$1" 2>/dev/null | awk '/=>/{print $3}' | grep -E '^/'; }
{ closure "$L/dri/swrast_dri.so"; closure "$L/libEGL_mesa.so.0"; closure "$L/libGLX_mesa.so.0"; closure "$SG/libEGL.so.1"; } | sort -u > /tmp/deps
SKIP='libc\.so|libm\.so|libpthread|libdl\.so|librt\.so|ld-linux|libresolv|/libGL\.|/libEGL\.|/libGLX\.|/libGLdispatch|/libOpenGL|/libglapi|/libgbm|/libdrm'
while read -r so; do
  echo "$so" | grep -qE "$SKIP" && continue
  cp -L "$so" "$SG/" 2>/dev/null || true
done < /tmp/deps
printf '%s\n' '{ "file_format_version":"1.0.0", "ICD":{ "library_path":"libEGL_mesa.so.0" } }' > "$SG/glvnd/50_mesa.json"

echo "::STEP:: build dp-glprobe (hardware-GL detector)"
# Built AFTER linuxdeploy on purpose: the probe must resolve libEGL from the HOST
# at runtime (it dlopen()s it), so it must not have host libs bundled next to it.
gcc -O2 -Wall -Wextra -o "$APPDIR/usr/bin/dp-glprobe" /work/scripts/dp-glprobe.c -ldl
test -x "$APPDIR/usr/bin/dp-glprobe" || { echo "ERROR: dp-glprobe did not build"; exit 1; }

echo "::STEP:: inject GPU auto-detection into AppRun"
# Must run BEFORE linuxdeploy's gtk hook, which reads APPIMAGE_GTK_THEME.
cat > /tmp/inject-gtk.txt <<'INJ'

# Force dark GTK file dialogs (folder picker) in the AppImage. GTK_USE_PORTAL=0
# avoids host portals/kdialog overriding the bundled GTK theme.
export APPIMAGE_GTK_THEME="Adwaita:dark"
export GTK_APPLICATION_PREFER_DARK_THEME=1
export GTK_THEME="Adwaita:dark"
export GTK_USE_PORTAL=0
INJ

# Must run AFTER linuxdeploy's hooks (they set GDK_BACKEND, which decides which
# EGL platform the probe should test first) and immediately before exec.
cat > /tmp/inject-gl.txt <<'INJ'

# === DivePlay: automatic GPU detection with software-rendering fallback ========
# usr/lib/dpsoftgl holds a software Mesa (llvmpipe) stack so the app can render on
# hosts whose GL driver the bundled WebKitGTK cannot talk to. Using it
# unconditionally costs ~a full CPU core on machines that DO have a working GPU,
# so the choice is made per host, at startup.
#
# The decision comes from dp-glprobe, which actually initialises EGL, creates a
# context and reads GL_RENDERER — "is there a GPU?" is not a usable test, because
# the hosts that break have perfectly good GPUs. The probe is a separate
# short-lived process, so a host stack that aborts or segfaults takes down the
# PROBE and we fall back safely; timeout(1) covers drivers that hang instead.
#
#   DIVEPLAY_GPU=auto        (default) probe, then use the GPU only if it works
#   DIVEPLAY_GPU=1           force host hardware GL, skip the probe
#   DIVEPLAY_GPU=0           force the bundled software stack, skip the probe
#   DIVEPLAY_GPU_DEBUG=1     report the decision (and probe detail) on stderr
#   DIVEPLAY_GPU_NOCACHE=1   ignore the cached decision and re-probe
# DIVEPLAY_FORCE_GPU=1 is still honoured, as an alias for DIVEPLAY_GPU=1.
dp_dbg() { if [ "${DIVEPLAY_GPU_DEBUG:-0}" = "1" ]; then printf 'diveplay/gl: %s\n' "$*" >&2; fi; }

dp_gl_mode="${DIVEPLAY_GPU:-auto}"
if [ "${DIVEPLAY_FORCE_GPU:-0}" = "1" ]; then dp_gl_mode=1; fi
dp_use_gpu=0
dp_dmabuf=0
dp_why=""

case "$dp_gl_mode" in
  1|on|yes|true|gpu|force)
    dp_use_gpu=1; dp_dmabuf=1; dp_why="forced on by DIVEPLAY_GPU" ;;
  0|off|no|false|sw|software)
    dp_use_gpu=0; dp_why="forced off by DIVEPLAY_GPU" ;;
  *)
    # Cache the verdict, keyed on the things that can change it: the DivePlay
    # build, the session/backend, the set of GPUs, and the host GL driver.
    dp_fp=$( set +e
             echo "@DP_BUILD_ID@"
             echo "${XDG_SESSION_TYPE:-}|${GDK_BACKEND:-}|${DISPLAY:-}|${WAYLAND_DISPLAY:-}"
             cat /sys/class/drm/card*/device/vendor /sys/class/drm/card*/device/device 2>/dev/null
             head -n1 /proc/driver/nvidia/version 2>/dev/null
             ls -lLn /usr/share/glvnd/egl_vendor.d/*.json 2>/dev/null )
    dp_key=$(printf '%s' "$dp_fp" | md5sum 2>/dev/null | cut -d' ' -f1)
    dp_cache="${XDG_CACHE_HOME:-$HOME/.cache}/diveplay/gl-mode"
    dp_rc=""
    if [ "${DIVEPLAY_GPU_NOCACHE:-0}" != "1" ] && [ -n "$dp_key" ] && [ -r "$dp_cache" ]; then
      dp_rc=$(awk -v k="$dp_key" '$1==k {print $2; exit}' "$dp_cache" 2>/dev/null)
      if [ -n "$dp_rc" ]; then dp_why="cached probe result $dp_rc"; fi
    fi
    if [ -z "$dp_rc" ]; then
      dp_probe="$this_dir/usr/bin/dp-glprobe"
      dp_to=""
      if command -v timeout >/dev/null 2>&1; then dp_to="timeout -k 2 10"; fi
      if [ -x "$dp_probe" ]; then
        set +e
        dp_out=$(env -u LIBGL_ALWAYS_SOFTWARE -u GALLIUM_DRIVER -u MESA_LOADER_DRIVER_OVERRIDE \
                     -u __EGL_VENDOR_LIBRARY_DIRS -u __EGL_VENDOR_LIBRARY_FILENAMES \
                     -u LIBGL_DRIVERS_PATH -u WEBKIT_DISABLE_DMABUF_RENDERER \
                     $dp_to "$dp_probe" 2>/dev/null)
        dp_rc=$?
        set -e
        dp_why="probe: ${dp_out:-<no output>} (exit $dp_rc)"
        if [ -n "$dp_key" ]; then
          mkdir -p "${dp_cache%/*}" 2>/dev/null || true
          printf '%s %s\n' "$dp_key" "$dp_rc" > "$dp_cache" 2>/dev/null || true
        fi
      else
        dp_rc=2; dp_why="dp-glprobe missing"
      fi
    fi
    case "$dp_rc" in
      0) dp_use_gpu=1; dp_dmabuf=1 ;;   # hardware + usable render node
      1) dp_use_gpu=1; dp_dmabuf=0 ;;   # hardware, but no DMABuf-capable render node
      *) dp_use_gpu=0 ;;                # 2 = unusable EGL, 3 = host is software-only
    esac
    ;;
esac

if [ "$dp_use_gpu" = "1" ]; then
  # Drop any software-forcing variables inherited from the user's environment,
  # so "gpu" mode cannot be silently downgraded back to llvmpipe.
  unset LIBGL_ALWAYS_SOFTWARE GALLIUM_DRIVER MESA_LOADER_DRIVER_OVERRIDE
  unset __EGL_VENDOR_LIBRARY_DIRS __EGL_VENDOR_LIBRARY_FILENAMES LIBGL_DRIVERS_PATH
  unset WEBKIT_DISABLE_DMABUF_RENDERER
  export DIVEPLAY_GL_MODE="gpu"
  if [ "$dp_dmabuf" != "1" ]; then
    export WEBKIT_DISABLE_DMABUF_RENDERER=1
    export DIVEPLAY_GL_MODE="gpu-nodmabuf"
  fi
else
  export LD_LIBRARY_PATH="$this_dir/usr/lib/dpsoftgl${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export __EGL_VENDOR_LIBRARY_DIRS="$this_dir/usr/lib/dpsoftgl/glvnd"
  export LIBGL_DRIVERS_PATH="$this_dir/usr/lib/dpsoftgl/dri"
  export LIBGL_ALWAYS_SOFTWARE=1
  export GALLIUM_DRIVER=llvmpipe
  export MESA_LOADER_DRIVER_OVERRIDE=swrast
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
  export DIVEPLAY_GL_MODE="software"
fi
export DIVEPLAY_GL_WHY="$dp_why"
dp_dbg "mode=$DIVEPLAY_GL_MODE ($dp_why)"
# === end DivePlay GPU detection ===
INJ

DP_BUILD_ID="$(grep -oP '"version":\s*"\K[^"]+' /work/src-tauri/tauri.conf.json)-$(date -u +%Y%m%d%H%M%S)"
sed -i "s/@DP_BUILD_ID@/$DP_BUILD_ID/" /tmp/inject-gl.txt

awk -v gtkf=/tmp/inject-gtk.txt -v glf=/tmp/inject-gl.txt '
  /^source .*linuxdeploy-plugin-gstreamer\.sh/ && !g {
    while ((getline line < gtkf) > 0) print line; g = 1
  }
  /^exec / && !x {
    while ((getline line < glf) > 0) print line; x = 1
  }
  { print }
' "$APPDIR/AppRun" > "$APPDIR/AppRun.new"
mv "$APPDIR/AppRun.new" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
grep -q "DIVEPLAY_GPU" "$APPDIR/AppRun"    || { echo "ERROR: GPU-detection injection failed"; exit 1; }
grep -q "dp-glprobe" "$APPDIR/AppRun"      || { echo "ERROR: probe wiring missing from AppRun"; exit 1; }
grep -q "GTK_USE_PORTAL=0" "$APPDIR/AppRun" || { echo "ERROR: GTK dark-mode injection failed"; exit 1; }
# The GL block is only correct after the hooks (GDK_BACKEND) and before exec.
awk '/DIVEPLAY_GL_MODE/{gl=NR} /^exec /{ex=NR} END{exit !(gl && ex && gl < ex)}' "$APPDIR/AppRun" \
  || { echo "ERROR: GL block is not positioned before exec in AppRun"; exit 1; }
bash -n "$APPDIR/AppRun" || { echo "ERROR: generated AppRun is not valid bash"; exit 1; }

echo "::STEP:: package final AppImage"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 appimagetool "$APPDIR" "$OUTDIR/diveplay_amd64.AppImage"

VERSION=$(grep -oP '"version":\s*"\K[^"]+' /work/src-tauri/tauri.conf.json)
mv "$OUTDIR/diveplay_amd64.AppImage" "$OUTDIR/diveplay_${VERSION}_amd64.AppImage"

echo "::STEP:: export"
ls -lh "$OUTDIR"/*.AppImage
cp "$OUTDIR"/*.AppImage /out/
chown -R "${HOST_UID:-1000}:${HOST_GID:-1000}" /out 2>/dev/null || true
echo "::DONE:: appimage build succeeded"
CONTAINER

echo
echo ">> Done. AppImage(s) in: $OUT/"
ls -lh "$OUT"/*.AppImage 2>/dev/null || true
echo
echo ">> Note: the in-container build rewrites dist/ and may touch package-lock.json /"
echo "   src-tauri/Cargo.lock. Discard those if you are not committing them:"
echo "     git checkout -- dist package-lock.json src-tauri/Cargo.lock"
echo
echo ">> Upload to the existing GitHub Release with:"
echo "     gh release upload <tag> $OUT/diveplay_<ver>_amd64.AppImage --clobber"
