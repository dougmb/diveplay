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
# The resulting AppImage uses the host's hardware GL when that actually works and
# falls back to a bundled software Mesa (llvmpipe) stack when it does not, so it
# runs on ANY distro. The tier is probed (dp-glprobe), then verified by
# supervising the first launch (dp-run); DIVEPLAY_GPU=1/0 pins it by hand.
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

echo "::STEP:: build dp-glprobe (hardware-GL detector) + install dp-run (launcher)"
# Built AFTER linuxdeploy on purpose: the probe must resolve libEGL from the HOST
# at runtime (it dlopen()s it), so it must not have host libs bundled next to it.
gcc -O2 -Wall -Wextra -o "$APPDIR/usr/bin/dp-glprobe" /work/scripts/dp-glprobe.c -ldl
test -x "$APPDIR/usr/bin/dp-glprobe" || { echo "ERROR: dp-glprobe did not build"; exit 1; }
# dp-run is SOURCED by AppRun, never executed: spawning a host bash under the
# AppDir's LD_LIBRARY_PATH is itself one of the failure modes we fix below.
install -m644 /work/scripts/dp-run.sh "$APPDIR/usr/bin/dp-run"
bash -n "$APPDIR/usr/bin/dp-run" || { echo "ERROR: dp-run.sh is not valid bash"; exit 1; }

echo "::STEP:: move host-coupled libraries to usr/lib/dphost"
# linuxdeploy bundles every transitive dependency it can find, including some
# whose ABI is shared with code that lives OUTSIDE the AppImage. Two groups bit
# us, both invisible until you run on a rolling-release host:
#
#   wayland  the host's libEGL_mesa.so.0 links libwayland-client, and Mesa >= 25
#            needs wl_fixes_interface (wayland 1.23+). Shadowing it with Ubuntu
#            22.04's 1.20 made glvnd fail to load the Mesa EGL vendor, so every
#            eglGetPlatformDisplay returned EGL_BAD_PARAMETER and WebKit's
#            WebProcess aborted with "Could not create default EGL display" —
#            a live window with a dead page, on a machine with a working GPU.
#   term     bundled readline/ncurses break any host shell or CLI tool the app
#            spawns ("bash: undefined symbol: rl_trim_arg_from_keyseq").
#
# Neither can simply be deleted: a host that genuinely lacks them still needs a
# copy. They move to usr/lib/dphost/<group>/, which dp-run puts back on the path
# only for groups the host cannot satisfy itself.
# One directory = one decision. Libraries that must stay on the same release as
# each other (the wayland family: libwayland-cursor calls into libwayland-client)
# share a directory and are restored together; everything else gets a directory
# of its own, so a host that ships libncursesw but not libncurses only gets the
# bundled libncurses back.
mk_dphost() {
  group="$1"; shift
  dir="$APPDIR/usr/lib/dphost/$group"
  mkdir -p "$dir"
  for pat in "$@"; do
    for f in $APPDIR/usr/lib/$pat; do
      if [ -e "$f" ]; then mv "$f" "$dir/"; echo "   dphost/$group <- $(basename "$f")"; fi
    done
  done
  rmdir "$dir" 2>/dev/null || true
}
mk_dphost_each() {
  for pat in "$@"; do
    for f in $APPDIR/usr/lib/$pat; do
      if [ -e "$f" ]; then mk_dphost "$(basename "$f")" "$(basename "$f")"; fi
    done
  done
}
mk_dphost wayland 'libwayland-*.so.*'
# Pulled in by gstreamer's aalib/libcaca/fluidsynth plugins, and poisonous to any
# host CLI tool the app spawns when they are older than the host's.
mk_dphost_each 'libreadline.so.*' 'libhistory.so.*' 'libtinfo.so.*' \
               'libncurses.so.*' 'libncursesw.so.*' 'libedit.so.*'
test ! -e "$APPDIR/usr/lib/libwayland-client.so.0" \
  || { echo "ERROR: libwayland-client.so.0 still shadows the host's"; exit 1; }
test -e "$APPDIR/usr/lib/dphost/wayland/libwayland-client.so.0" \
  || { echo "ERROR: no bundled libwayland-client fallback was kept"; exit 1; }
# dpsoftgl keeps its own self-consistent copies; software mode must not depend
# on the host at all.
test -e "$APPDIR/usr/lib/dpsoftgl/libwayland-client.so.0" \
  || { echo "ERROR: dpsoftgl lost its libwayland-client"; exit 1; }

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

# === DivePlay: GL tier selection, verified at runtime ==========================
# usr/lib/dpsoftgl holds a software Mesa (llvmpipe) stack so the app can render on
# hosts whose GL driver the bundled WebKitGTK cannot talk to. Using it
# unconditionally costs ~a full CPU core on machines that DO have a working GPU,
# so a tier is chosen per host, at startup:
#
#   gpu | gpu-nodmabuf | software    (usr/bin/dp-run defines what each one sets)
#
# dp-glprobe PROPOSES a tier by really initialising EGL — once for the platform
# GTK will use, and once along the ladder WebKit's WebProcess uses (GBM ->
# surfaceless -> default). Probing only the first of those is what shipped
# v1.0.19 as "gpu" on hosts where the WebProcess then died with
# "Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...",
# leaving a live window with a dead page. It runs as a separate short-lived
# process, so a driver that aborts kills the PROBE, and timeout(1) covers
# drivers that hang.
#
# dp-run then VERIFIES it: the first launch on a given host is supervised, and a
# tier that cannot render is dropped for the next one down. Only a tier that
# survived gets cached, so this costs one relaunch, once, on affected hosts.
#
#   DIVEPLAY_GPU=auto        (default) probe, verify, cache
#   DIVEPLAY_GPU=1           force host hardware GL, no probe, no supervision
#   DIVEPLAY_GPU=0           force the bundled software stack
#   DIVEPLAY_GL_START=<tier> start the supervised ladder at <tier> (testing)
#   DIVEPLAY_GL_NOWATCH=1    never supervise
#   DIVEPLAY_GL_GRACE=<s>    seconds a tier must survive to count (default 20)
#   DIVEPLAY_GPU_DEBUG=1     report the decision (and probe detail) on stderr
#   DIVEPLAY_GPU_NOCACHE=1   ignore the cached tier and re-probe
# DIVEPLAY_FORCE_GPU=1 is still honoured, as an alias for DIVEPLAY_GPU=1.
dp_dbg() { if [ "${DIVEPLAY_GPU_DEBUG:-0}" = "1" ]; then printf 'diveplay/gl: %s\n' "$*" >&2; fi; }

dp_gl_mode="${DIVEPLAY_GPU:-auto}"
if [ "${DIVEPLAY_FORCE_GPU:-0}" = "1" ]; then dp_gl_mode=1; fi
DP_GL_START=""
DP_GL_WHY=""
DP_GL_SUPERVISE=0
DP_GL_KEY=""
DP_GL_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/diveplay/gl-mode"

case "$dp_gl_mode" in
  1|on|yes|true|gpu|force)
    DP_GL_START="gpu"; DP_GL_WHY="forced on by DIVEPLAY_GPU" ;;
  0|off|no|false|sw|software)
    DP_GL_START="software"; DP_GL_WHY="forced off by DIVEPLAY_GPU" ;;
  *)
    # Cache the verified tier, keyed on the things that can change it: the
    # DivePlay build, the session/backend, the set of GPUs, and the host GL
    # driver. An empty DP_GL_START tells dp-run to probe.
    dp_fp=$( set +e
             echo "@DP_BUILD_ID@"
             echo "${XDG_SESSION_TYPE:-}|${GDK_BACKEND:-}|${DISPLAY:-}|${WAYLAND_DISPLAY:-}"
             cat /sys/class/drm/card*/device/vendor /sys/class/drm/card*/device/device 2>/dev/null
             head -n1 /proc/driver/nvidia/version 2>/dev/null
             ls -lLn /usr/share/glvnd/egl_vendor.d/*.json 2>/dev/null )
    DP_GL_KEY=$(printf '%s' "$dp_fp" | md5sum 2>/dev/null | cut -d' ' -f1)
    if [ "${DIVEPLAY_GPU_NOCACHE:-0}" != "1" ] && [ -n "$DP_GL_KEY" ] && [ -r "$DP_GL_CACHE" ]; then
      dp_cached=$(awk -v k="$DP_GL_KEY" '$1==k {print $2; exit}' "$DP_GL_CACHE" 2>/dev/null)
      case "$dp_cached" in
        gpu|gpu-nodmabuf|software)
          DP_GL_START="$dp_cached"; DP_GL_WHY="cached: $dp_cached verified on this host" ;;
      esac
    fi
    ;;
esac

if [ -n "${DIVEPLAY_GL_START:-}" ]; then
  DP_GL_START="$DIVEPLAY_GL_START"
  DP_GL_WHY="start tier forced by DIVEPLAY_GL_START"
  DP_GL_SUPERVISE=1
fi

DP_APPDIR="$this_dir"
DP_APP="$this_dir/AppRun.wrapped"
# dp-run is sourced, not run: a bash started under the AppDir's LD_LIBRARY_PATH
# can itself fail to load on hosts newer than the one that built this image.
source "$this_dir/usr/bin/dp-run"
dp_main "$@"
# === end DivePlay GL tier selection ===
INJ

DP_BUILD_ID="$(grep -oP '"version":\s*"\K[^"]+' /work/src-tauri/tauri.conf.json)-$(date -u +%Y%m%d%H%M%S)"
sed -i "s/@DP_BUILD_ID@/$DP_BUILD_ID/" /tmp/inject-gl.txt

# The GL block REPLACES linuxdeploy's exec line — dp_main takes over from there,
# exec()ing the app itself once it knows which tier to use. Bail out loudly if a
# future linuxdeploy stops generating the line we are matching on.
grep -qE '^exec +"\$this_dir"/AppRun\.wrapped "\$@"' "$APPDIR/AppRun" \
  || { echo "ERROR: linuxdeploy's AppRun exec line is not what we expected"; exit 1; }

awk -v gtkf=/tmp/inject-gtk.txt -v glf=/tmp/inject-gl.txt '
  /^source .*linuxdeploy-plugin-gstreamer\.sh/ && !g {
    while ((getline line < gtkf) > 0) print line; g = 1
  }
  /^exec / && !x {
    while ((getline line < glf) > 0) print line; x = 1; next
  }
  { print }
' "$APPDIR/AppRun" > "$APPDIR/AppRun.new"
mv "$APPDIR/AppRun.new" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
grep -q "DIVEPLAY_GPU" "$APPDIR/AppRun"     || { echo "ERROR: GL-tier injection failed"; exit 1; }
grep -q "dp_main" "$APPDIR/AppRun"          || { echo "ERROR: dp-run wiring missing from AppRun"; exit 1; }
grep -q "dp-glprobe" "$APPDIR/usr/bin/dp-run" || { echo "ERROR: probe wiring missing from dp-run"; exit 1; }
grep -q "GTK_USE_PORTAL=0" "$APPDIR/AppRun" || { echo "ERROR: GTK dark-mode injection failed"; exit 1; }
# Nothing may exec the app behind dp_main's back, and the hooks (which set
# GDK_BACKEND, and thus which EGL platform the probe tests first) must run first.
! grep -q '^exec ' "$APPDIR/AppRun" || { echo "ERROR: a raw exec line survived in AppRun"; exit 1; }
awk '/linuxdeploy-plugin-gtk\.sh/{h=NR} /dp_main/{m=NR} END{exit !(h && m && h < m)}' "$APPDIR/AppRun" \
  || { echo "ERROR: dp_main does not run after the linuxdeploy hooks"; exit 1; }
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
