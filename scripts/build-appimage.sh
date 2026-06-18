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
echo "::STEP:: verify AppDir + drop non-portable bundled ffmpeg/ffprobe"
test -x "$APPDIR/usr/bin/diveplay" || { echo "ERROR: AppDir/usr/bin/diveplay missing"; exit 1; }
# bundle.resources ships dynamic Arch ffmpeg/ffprobe (need libav*.so.62, absent here)
# + 99 MB Windows .exe. They break linuxdeploy and bloat the image; Linux uses the
# system ffmpeg (get_sidecar_path -> /usr/bin/ffmpeg), so drop them.
rm -rf "$APPDIR/usr/lib/diveplay/binaries"
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
linuxdeploy --appdir "$APPDIR" --plugin gtk --plugin gstreamer

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

echo "::STEP:: inject software-GL activation into AppRun"
cat > /tmp/inject.txt <<'INJ'

# === DivePlay: route GL/EGL through the bundled software Mesa (llvmpipe) so the  ===
# === app renders independently of the host GPU driver (works on any distro).     ===
# === Set DIVEPLAY_FORCE_GPU=1 to use the host's hardware OpenGL/EGL instead.      ===
if [ "${DIVEPLAY_FORCE_GPU:-0}" != "1" ]; then
  export LD_LIBRARY_PATH="$this_dir/usr/lib/dpsoftgl${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export __EGL_VENDOR_LIBRARY_DIRS="$this_dir/usr/lib/dpsoftgl/glvnd"
  export LIBGL_DRIVERS_PATH="$this_dir/usr/lib/dpsoftgl/dri"
  export LIBGL_ALWAYS_SOFTWARE=1
  export GALLIUM_DRIVER=llvmpipe
  export MESA_LOADER_DRIVER_OVERRIDE=swrast
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi
# === end DivePlay ===
INJ
awk '/^exec .*AppRun\.wrapped/ && !done { while((getline line < "/tmp/inject.txt")>0) print line; done=1 } {print}' \
  "$APPDIR/AppRun" > "$APPDIR/AppRun.new"
mv "$APPDIR/AppRun.new" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
grep -q "DIVEPLAY_FORCE_GPU" "$APPDIR/AppRun" || { echo "ERROR: AppRun injection failed"; exit 1; }

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
