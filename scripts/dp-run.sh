#!/usr/bin/env bash
#
# dp-run — DivePlay AppImage launcher: picks the GL tier, then makes sure the
# tier it picked actually renders.
#
# SOURCED by the generated AppRun (not executed): a fresh `bash` started after
# AppRun has exported LD_LIBRARY_PATH would load the AppDir's own libraries, and
# on hosts whose bash is newer than Ubuntu 22.04's that fails outright
# ("undefined symbol: rl_trim_arg_from_keyseq"). Staying in the AppRun process
# side-steps the whole class of problem. It defines dp_main and nothing else runs
# at source time.
#
# Tiers, in descending order of GPU use:
#
#   gpu           host GL + WebKit's DMABuf renderer
#   gpu-nodmabuf  host GL for GTK, WEBKIT_DISABLE_DMABUF_RENDERER=1 so the
#                 WebProcess never needs an EGL display of its own
#   software      the bundled llvmpipe stack in usr/lib/dpsoftgl — the floor,
#                 slow but hardware-independent
#
# dp-glprobe picks the starting tier. It cannot be perfect — it is not WebKit —
# so the FIRST launch on a given host is supervised: WebKit's fatal EGL banner
# ("Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...") kills
# only the WebProcess, leaving a live window with a dead page, so an exit code is
# not enough to notice. We watch stderr for it, drop a tier and relaunch. The
# tier that survives is cached, and later launches exec straight into it.

# Library directories under usr/lib/dphost/<group>/ hold copies of libraries that
# are ABI-coupled to things OUTSIDE the AppImage — the host's EGL driver, the
# host's bash. Shadowing those with Ubuntu 22.04 copies is what broke v1.0.19 on
# Mesa hosts (host libEGL_mesa.so.0 needs wl_fixes_interface, added in wayland
# 1.23; the bundled libwayland-client is 1.20, so EVERY eglGetPlatformDisplay
# returned EGL_BAD_PARAMETER). So they are only put on the path when the host
# does not provide them at all.
dp_host_lib_dirs="/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib64 /usr/lib64 /lib /usr/lib /usr/local/lib /usr/local/lib/x86_64-linux-gnu"

# AppRun defines this before sourcing us; keep a copy so the script also works
# when sourced from a test harness.
declare -F dp_dbg >/dev/null 2>&1 || dp_dbg() {
    if [ "${DIVEPLAY_GPU_DEBUG:-0}" = "1" ]; then printf 'diveplay/gl: %s\n' "$*" >&2; fi
}

dp_host_has_lib() {
    local so="$1" d
    for d in $dp_host_lib_dirs; do
        [ -e "$d/$so" ] && return 0
    done
    local ldc=""
    if command -v ldconfig >/dev/null 2>&1; then ldc=ldconfig
    elif [ -x /sbin/ldconfig ]; then ldc=/sbin/ldconfig
    elif [ -x /usr/sbin/ldconfig ]; then ldc=/usr/sbin/ldconfig
    fi
    [ -n "$ldc" ] && "$ldc" -p 2>/dev/null | awk -v s="$so" '$1 == s { found = 1 } END { exit !found }'
}

# Append every dphost directory the host cannot satisfy on its own. One directory
# is one all-or-nothing decision — which is why the build puts the wayland family
# in a shared directory (libwayland-cursor from one release against
# libwayland-client from another is exactly the mismatch we are avoiding) and
# every other library in a directory of its own.
dp_host_first_path() {
    local base="$1" group so keep out=""
    for group in "$base"/usr/lib/dphost/*/; do
        [ -d "$group" ] || continue
        keep=0
        for so in "$group"*.so*; do
            [ -e "$so" ] || continue
            dp_host_has_lib "$(basename "$so")" || keep=1
        done
        if [ "$keep" = 1 ]; then
            out="${out:+$out:}${group%/}"
            dp_dbg "host does not provide $(basename "${group%/}") — using the bundled copy"
        fi
    done
    printf '%s' "$out"
}

# Signal the app's whole process group (job control put it in one of its own),
# falling back to the bare pid if the group is already gone.
dp_kill_group() {
    kill "-$2" "-$1" 2>/dev/null || kill "-$2" "$1" 2>/dev/null || true
}

dp_apply_tier() {
    local tier="$1"
    # Always rebuild from the pristine path so a relaunch cannot stack dpsoftgl
    # entries or keep a previous tier's overrides.
    LD_LIBRARY_PATH="$DP_BASE_LDPATH"
    unset LIBGL_ALWAYS_SOFTWARE GALLIUM_DRIVER MESA_LOADER_DRIVER_OVERRIDE
    unset __EGL_VENDOR_LIBRARY_DIRS __EGL_VENDOR_LIBRARY_FILENAMES LIBGL_DRIVERS_PATH
    unset WEBKIT_DISABLE_DMABUF_RENDERER

    case "$tier" in
        gpu) ;;
        gpu-nodmabuf)
            export WEBKIT_DISABLE_DMABUF_RENDERER=1
            ;;
        software)
            LD_LIBRARY_PATH="$DP_APPDIR/usr/lib/dpsoftgl${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            export __EGL_VENDOR_LIBRARY_DIRS="$DP_APPDIR/usr/lib/dpsoftgl/glvnd"
            export LIBGL_DRIVERS_PATH="$DP_APPDIR/usr/lib/dpsoftgl/dri"
            export LIBGL_ALWAYS_SOFTWARE=1
            export GALLIUM_DRIVER=llvmpipe
            export MESA_LOADER_DRIVER_OVERRIDE=swrast
            export WEBKIT_DISABLE_DMABUF_RENDERER=1
            ;;
    esac
    export LD_LIBRARY_PATH
    export DIVEPLAY_GL_MODE="$tier"
}

# Ask dp-glprobe for a starting tier. Runs with the same LD_LIBRARY_PATH the app
# will get — probing against a different library set than the one WebKit loads is
# how v1.0.19 came to advertise a GPU that WebKit could not use — and with the
# user's software-forcing variables stripped, so "can this host do hardware GL?"
# is answered honestly.
dp_probe_tier() {
    local probe="$DP_APPDIR/usr/bin/dp-glprobe" to="" out rc
    if [ ! -x "$probe" ]; then
        DP_GL_START=software
        DP_GL_WHY="dp-glprobe missing"
        return
    fi
    command -v timeout >/dev/null 2>&1 && to="timeout -k 2 25"
    out=$(LD_LIBRARY_PATH="$DP_BASE_LDPATH" \
          env -u LIBGL_ALWAYS_SOFTWARE -u GALLIUM_DRIVER -u MESA_LOADER_DRIVER_OVERRIDE \
              -u __EGL_VENDOR_LIBRARY_DIRS -u __EGL_VENDOR_LIBRARY_FILENAMES \
              -u LIBGL_DRIVERS_PATH -u WEBKIT_DISABLE_DMABUF_RENDERER \
              $to "$probe" 2>/dev/null)
    rc=$?
    DP_GL_WHY="probe: ${out:-<no output>} (exit $rc)"
    case "$rc" in
        0) DP_GL_START=gpu ;;
        1) DP_GL_START=gpu-nodmabuf ;;
        *) DP_GL_START=software ;;
    esac
}

dp_next_tier() {
    case "$1" in
        gpu) printf 'gpu-nodmabuf' ;;
        gpu-nodmabuf) printf 'software' ;;
        *) printf '' ;;
    esac
}

dp_cache_tier() {
    [ -n "${DP_GL_KEY:-}" ] && [ -n "${DP_GL_CACHE:-}" ] || return 0
    mkdir -p "${DP_GL_CACHE%/*}" 2>/dev/null || return 0
    printf '%s %s\n' "$DP_GL_KEY" "$1" > "$DP_GL_CACHE" 2>/dev/null || true
}

# Run one tier under supervision. Returns 0 if the tier looks good (the app is
# then already finished and DP_STATUS holds its exit code), 1 if it tripped.
dp_supervise() {
    local tier="$1"
    shift
    local grace="${DIVEPLAY_GL_GRACE:-20}"
    local tmpd fifo trip app scanner status=0 exited=0 tripped=0 state deadline

    tmpd=$(mktemp -d "${TMPDIR:-/tmp}/diveplay-gl.XXXXXX" 2>/dev/null) || {
        "$DP_APP" "$@"
        DP_STATUS=$?
        return 0
    }
    fifo="$tmpd/err"
    trip="$tmpd/trip"
    mkfifo "$fifo" 2>/dev/null || {
        rm -rf "$tmpd"
        "$DP_APP" "$@"
        DP_STATUS=$?
        return 0
    }

    # Forward every line through untouched; trip on the banners that mean "this
    # process cannot render and is about to die or has already died".
    (
        while IFS= read -r line; do
            printf '%s\n' "$line" >&2
            case "$line" in
                *"Could not create default EGL display"* | *"Could not create EGL display"* | \
                *"Cannot get default EGL display"* | *"EGLDisplay Initialization failed"* | \
                *"Could not create EGL context"* | *"Aborting..."*)
                    : > "$trip" 2>/dev/null || true
                    ;;
            esac
        done < "$fifo"
    ) &
    scanner=$!

    # Job control gives the app its own process group, so a tier that has to be
    # abandoned can be torn down whole. WebKit's helper processes inherit this
    # stderr; if any of them outlived the kill they would hold the pipe open and
    # the scanner would never see EOF.
    set -m
    "$DP_APP" "$@" 2> "$fifo" &
    app=$!
    set +m
    deadline=$((SECONDS + grace))

    # Ctrl-C during the calibration run is the user quitting, not a broken tier:
    # without this the 130 exit status would look like a crash and we would
    # helpfully relaunch the app they just closed.
    dp_interrupted=0
    trap 'dp_interrupted=1; dp_kill_group "$app" TERM' INT TERM HUP
    while :; do
        # /proc/PID/stat is "pid (comm) state ..." — strip through the comm so a
        # space in the process name cannot shift the field we want.
        state=""
        if [ -r "/proc/$app/stat" ]; then
            state=$(< "/proc/$app/stat")
            state=${state#*") "}
            state=${state%% *}
        fi
        if [ -z "$state" ] || [ "$state" = "Z" ]; then
            exited=1
            break
        fi
        [ -e "$trip" ] && { tripped=1; break; }
        [ "$SECONDS" -ge "$deadline" ] && break
        sleep 0.25
    done

    if [ "$exited" = 1 ]; then
        # 2>/dev/null: with job control on, bash would otherwise announce the
        # death itself ("Aborted (core dumped)") on top of our own message.
        wait "$app" 2>/dev/null
        status=$?
        # A crash inside the grace window is a failed tier even when nothing
        # recognisable reached stderr.
        [ "$status" -ge 128 ] && [ "$SECONDS" -lt "$deadline" ] && tripped=1
        [ "$dp_interrupted" = 1 ] && tripped=0
    elif [ "$tripped" = 1 ]; then
        dp_kill_group "$app" TERM
        local n=0
        while [ $n -lt 20 ] && kill -0 "$app" 2>/dev/null; do
            sleep 0.1
            n=$((n + 1))
        done
        dp_kill_group "$app" KILL
        wait "$app" 2>/dev/null
        status=1
    else
        # Survived the window: this tier renders. Record it, then just wait.
        dp_cache_tier "$tier"
        wait "$app"
        status=$?
    fi
    trap - INT TERM HUP

    # Give the scanner a moment to drain what is left in the pipe, but never
    # block on it: a stray grandchild still holding the write end would hang the
    # launcher forever.
    local drain=0
    while [ $drain -lt 8 ] && kill -0 "$scanner" 2>/dev/null; do
        sleep 0.1
        drain=$((drain + 1))
    done
    kill -KILL "$scanner" 2>/dev/null
    wait "$scanner" 2>/dev/null
    rm -rf "$tmpd"
    DP_STATUS=$status
    [ "$tripped" = 1 ] && return 1
    [ "$exited" = 1 ] && dp_cache_tier "$tier"
    return 0
}

dp_main() {
    set +e
    DP_BASE_LDPATH="${LD_LIBRARY_PATH:-}"
    local host_first
    host_first="$(dp_host_first_path "$DP_APPDIR")"
    [ -n "$host_first" ] && DP_BASE_LDPATH="${DP_BASE_LDPATH:+$DP_BASE_LDPATH:}$host_first"

    local supervise="${DP_GL_SUPERVISE:-0}"
    if [ -z "${DP_GL_START:-}" ]; then
        # No override and nothing cached: probe, and verify what it proposes.
        dp_probe_tier
        supervise=1
    fi
    local tier="${DP_GL_START:-software}"
    local why="${DP_GL_WHY:-}"
    [ "${DIVEPLAY_GL_NOWATCH:-0}" = "1" ] && supervise=0

    if [ "$supervise" != "1" ]; then
        dp_apply_tier "$tier"
        export DIVEPLAY_GL_WHY="$why"
        dp_dbg "mode=$DIVEPLAY_GL_MODE ($why)"
        exec "$DP_APP" "$@"
    fi

    local fell_back=0
    while :; do
        dp_apply_tier "$tier"
        export DIVEPLAY_GL_WHY="$why"
        export DIVEPLAY_GL_FALLBACK="$fell_back"
        dp_dbg "mode=$DIVEPLAY_GL_MODE ($why) — supervised"

        DP_STATUS=0
        dp_supervise "$tier" "$@" && return $DP_STATUS

        local next
        next="$(dp_next_tier "$tier")"
        if [ -z "$next" ]; then
            dp_dbg "$tier failed too — nothing left below it"
            return $DP_STATUS
        fi
        printf '[DivePlay] %s rendering failed to start; retrying with %s\n' "$tier" "$next" >&2
        why="fell back from $tier after a GL failure (was: $why)"
        tier="$next"
        fell_back=1
    done
}
