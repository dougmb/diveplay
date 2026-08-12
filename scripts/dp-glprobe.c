/*
 * dp-glprobe — DivePlay hardware-GL capability probe.
 *
 * The AppImage bundles a software Mesa (llvmpipe) stack because the WebKitGTK it
 * ships cannot talk to every host GL driver — on some hosts EGL initialisation
 * fails hard (EGL_BAD_PARAMETER) or segfaults, and no WEBKIT_DISABLE_* env var
 * works around it. That failure mode is why the software stack exists.
 *
 * Crucially, "does this machine have a GPU?" is the WRONG question: the hosts
 * that break have perfectly good GPUs and a populated /dev/dri. The only
 * reliable test is to actually initialise EGL, create a context and read back
 * GL_RENDERER — which is what this program does.
 *
 * It runs as a short-lived subprocess from AppRun BEFORE the player starts, so
 * a host stack that aborts or segfaults kills THIS process and AppRun simply
 * falls back to the bundled software stack. Hangs are handled twice over: each
 * candidate runs in its own fork()ed child with a deadline, and the caller also
 * wraps us in timeout(1).
 *
 * TWO different EGL stacks have to work, and they are not the same test:
 *
 *   1. The UI process (GTK + WebKit's UI side) uses the window-system platform —
 *      x11 or wayland, whichever GDK_BACKEND selects. The AppImage's gtk hook
 *      forces GDK_BACKEND=x11, so that is normally the one that matters.
 *
 *   2. The WebProcess, which is the one that actually renders the page, does NOT
 *      use the window system at all. WebKit's initializePlatformDisplayIfNeeded()
 *      tries GBM -> surfaceless -> default and calls CRASH() if all three fail:
 *          "Could not create default EGL display: EGL_BAD_PARAMETER. Aborting..."
 *      The UI process survives that, so the symptom is a dead/blank window.
 *
 * v1.0.19 only tested (1), accepted a hardware renderer from ANY platform, and
 * inferred the DMABuf renderer from "is /dev/dri/renderD* openable" — which is
 * why an AMD/Mesa host that passes (1) and fails (2) shipped as "gpu" and died.
 * Both ladders are now probed, each candidate in its own child so one aborting
 * driver path only rules out that path.
 *
 * Everything is loaded with dlopen(): the probe has no link-time dependency on
 * libEGL/libX11/libgbm, so a host missing them fails cleanly instead of failing
 * to start.
 *
 * Exit codes (contract shared with AppRun / dp-run):
 *   0  host GL works and the WebProcess ladder works  -> tier "gpu"
 *   1  host GL works, WebProcess ladder unusable      -> tier "gpu-nodmabuf"
 *   2  no usable EGL at all / probe failed            -> tier "software"
 *   3  host itself only offers software rendering     -> tier "software"
 *                                                        (ours is newer and self-contained)
 *
 * stdout carries one machine-readable line: "tier=<t> ui=<plat>:<renderer> web=<plat>:<detail>".
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* ---- Minimal EGL/GL ABI decls (avoids needing EGL headers at build time) ---- */
typedef void *EGLDisplay;
typedef void *EGLConfig;
typedef void *EGLContext;
typedef void *EGLSurface;
typedef void *EGLNativeDisplayType;
typedef int32_t EGLint;
typedef unsigned int EGLBoolean;
typedef unsigned int EGLenum;

#define EGL_NONE 0x3038
#define EGL_NO_DISPLAY ((EGLDisplay)0)
#define EGL_NO_CONTEXT ((EGLContext)0)
#define EGL_NO_SURFACE ((EGLSurface)0)
#define EGL_DEFAULT_DISPLAY ((EGLNativeDisplayType)0)
#define EGL_EXTENSIONS 0x3055
#define EGL_OPENGL_ES_API 0x30A0
#define EGL_CONTEXT_CLIENT_VERSION 0x3098
#define EGL_SURFACE_TYPE 0x3033
#define EGL_PBUFFER_BIT 0x0001
#define EGL_RENDERABLE_TYPE 0x3040
#define EGL_OPENGL_ES2_BIT 0x0004
#define EGL_WIDTH 0x3057
#define EGL_HEIGHT 0x3056
#define EGL_PLATFORM_X11_KHR 0x31D5
#define EGL_PLATFORM_GBM_KHR 0x31D7 /* == EGL_PLATFORM_GBM_MESA */
#define EGL_PLATFORM_WAYLAND_KHR 0x31D8
#define EGL_PLATFORM_SURFACELESS_MESA 0x31DD

#define GL_VENDOR 0x1F00
#define GL_RENDERER 0x1F01

typedef void *(*PFN_GETPROC)(const char *);
typedef EGLDisplay (*PFN_GETDISPLAY)(EGLNativeDisplayType);
typedef EGLDisplay (*PFN_GETPLATFORMDISPLAY)(EGLenum, void *, const EGLint *);
typedef EGLBoolean (*PFN_INITIALIZE)(EGLDisplay, EGLint *, EGLint *);
typedef EGLBoolean (*PFN_TERMINATE)(EGLDisplay);
typedef EGLBoolean (*PFN_BINDAPI)(EGLenum);
typedef EGLBoolean (*PFN_CHOOSECONFIG)(EGLDisplay, const EGLint *, EGLConfig *, EGLint, EGLint *);
typedef EGLContext (*PFN_CREATECONTEXT)(EGLDisplay, EGLConfig, EGLContext, const EGLint *);
typedef EGLSurface (*PFN_CREATEPBUFFER)(EGLDisplay, EGLConfig, const EGLint *);
typedef EGLBoolean (*PFN_MAKECURRENT)(EGLDisplay, EGLSurface, EGLSurface, EGLContext);
typedef const char *(*PFN_QUERYSTRING)(EGLDisplay, EGLint);
typedef const unsigned char *(*PFN_GLGETSTRING)(unsigned int);

static PFN_GETPROC p_getproc;
static PFN_GETDISPLAY p_getdisplay;
static PFN_GETPLATFORMDISPLAY p_getplatform;
static PFN_INITIALIZE p_initialize;
static PFN_TERMINATE p_terminate;
static PFN_BINDAPI p_bindapi;
static PFN_CHOOSECONFIG p_chooseconfig;
static PFN_CREATECONTEXT p_createcontext;
static PFN_CREATEPBUFFER p_createpbuffer;
static PFN_MAKECURRENT p_makecurrent;
static PFN_QUERYSTRING p_querystring;

/* Client (display-independent) extension string, used exactly like WebKit uses
 * it: a platform is only attempted when EGL advertises support for it. */
static const char *client_ext = "";

static int verbose;

static void note(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void note(const char *fmt, ...) {
    if (!verbose) return;
    va_list ap;
    va_start(ap, fmt);
    fputs("  probe: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}

static int has_ext(const char *haystack, const char *ext) {
    if (!haystack || !*haystack) return 0;
    size_t n = strlen(ext);
    for (const char *p = strstr(haystack, ext); p; p = strstr(p + n, ext)) {
        char before = (p == haystack) ? ' ' : p[-1];
        char after = p[n];
        if ((before == ' ' || before == '\0') && (after == ' ' || after == '\0')) return 1;
    }
    return 0;
}

/* A platform is attempted when EGL advertises it — but a host that reports no
 * client extensions at all (very old glvnd) must not be locked out, so an empty
 * string means "try anyway". */
static int platform_supported(const char *a, const char *b) {
    if (!*client_ext) return 1;
    return has_ext(client_ext, a) || (b && has_ext(client_ext, b));
}

/* Renderer names that mean "this is running on the CPU". If the host can only
 * give us software rendering we prefer our own bundled llvmpipe: it is newer
 * and, unlike the host's, guaranteed present and self-consistent. */
static int is_software_renderer(const char *r) {
    static const char *soft[] = {"llvmpipe", "softpipe",  "swrast", "software rasterizer",
                                 "mesa offscreen", "lavapipe", "osmesa", NULL};
    for (int i = 0; soft[i]; i++)
        if (strcasestr(r, soft[i])) return 1;
    return 0;
}

static void *sym(void *lib, const char *name) {
    void *s = dlsym(lib, name);
    if (!s && p_getproc) s = p_getproc(name);
    return s;
}

/* ---- Candidate displays ---------------------------------------------------- */

static EGLDisplay open_x11(void) {
    if (!p_getplatform || !getenv("DISPLAY")) return EGL_NO_DISPLAY;
    if (!platform_supported("EGL_KHR_platform_x11", "EGL_EXT_platform_x11")) return EGL_NO_DISPLAY;
    void *x = dlopen("libX11.so.6", RTLD_NOW | RTLD_LOCAL);
    if (!x) return EGL_NO_DISPLAY;
    void *(*xopen)(const char *) = (void *(*)(const char *))dlsym(x, "XOpenDisplay");
    if (!xopen) return EGL_NO_DISPLAY;
    void *xd = xopen(NULL);
    if (!xd) return EGL_NO_DISPLAY;
    return p_getplatform(EGL_PLATFORM_X11_KHR, xd, NULL);
}

static EGLDisplay open_wayland(void) {
    if (!p_getplatform || !getenv("WAYLAND_DISPLAY")) return EGL_NO_DISPLAY;
    if (!platform_supported("EGL_KHR_platform_wayland", "EGL_EXT_platform_wayland"))
        return EGL_NO_DISPLAY;
    void *w = dlopen("libwayland-client.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!w) return EGL_NO_DISPLAY;
    void *(*wconnect)(const char *) = (void *(*)(const char *))dlsym(w, "wl_display_connect");
    if (!wconnect) return EGL_NO_DISPLAY;
    void *wd = wconnect(NULL);
    if (!wd) return EGL_NO_DISPLAY;
    return p_getplatform(EGL_PLATFORM_WAYLAND_KHR, wd, NULL);
}

/* WebKit's first choice for the WebProcess: a GBM device on a DRM render node.
 * Mirrors WEBKIT_DMABUF_RENDERER_DISABLE_GBM, which turns this step off. */
static EGLDisplay open_gbm(void) {
    const char *off = getenv("WEBKIT_DMABUF_RENDERER_DISABLE_GBM");
    if (off && *off && strcmp(off, "0") != 0) {
        note("    GBM disabled by WEBKIT_DMABUF_RENDERER_DISABLE_GBM");
        return EGL_NO_DISPLAY;
    }
    if (!p_getplatform) return EGL_NO_DISPLAY;
    if (!platform_supported("EGL_KHR_platform_gbm", "EGL_MESA_platform_gbm")) return EGL_NO_DISPLAY;

    void *g = dlopen("libgbm.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!g) {
        note("    libgbm.so.1 not loadable");
        return EGL_NO_DISPLAY;
    }
    void *(*gbm_create_device)(int) = (void *(*)(int))dlsym(g, "gbm_create_device");
    if (!gbm_create_device) return EGL_NO_DISPLAY;

    DIR *d = opendir("/dev/dri");
    if (!d) return EGL_NO_DISPLAY;
    struct dirent *e;
    EGLDisplay dpy = EGL_NO_DISPLAY;
    while (dpy == EGL_NO_DISPLAY && (e = readdir(d))) {
        if (strncmp(e->d_name, "renderD", 7) != 0) continue;
        char path[288];
        snprintf(path, sizeof(path), "/dev/dri/%s", e->d_name);
        int fd = open(path, O_RDWR | O_CLOEXEC);
        if (fd < 0) {
            note("    %s present but not openable", path);
            continue;
        }
        void *dev = gbm_create_device(fd);
        if (!dev) {
            note("    gbm_create_device failed on %s", path);
            close(fd);
            continue;
        }
        note("    gbm device on %s", path);
        dpy = p_getplatform(EGL_PLATFORM_GBM_KHR, dev, NULL);
        /* fd/device deliberately leak: this candidate runs in a throwaway child. */
    }
    closedir(d);
    return dpy;
}

static EGLDisplay open_surfaceless(void) {
    if (!p_getplatform) return EGL_NO_DISPLAY;
    if (!platform_supported("EGL_MESA_platform_surfaceless", NULL)) return EGL_NO_DISPLAY;
    return p_getplatform(EGL_PLATFORM_SURFACELESS_MESA, NULL, NULL);
}

static EGLDisplay open_default(void) {
    if (!p_getdisplay) return EGL_NO_DISPLAY;
    return p_getdisplay(EGL_DEFAULT_DISPLAY);
}

typedef struct {
    const char *name;
    EGLDisplay (*open)(void);
} Candidate;

typedef struct {
    int ok;        /* reached a current GLES2 context */
    int dmabuf;    /* display advertises EGL_EXT_image_dma_buf_import */
    char renderer[192];
} Probe;

/* Take one candidate display all the way to a current GLES2 context and a
 * GL_RENDERER string. Runs inside the forked child. */
static void probe_display(EGLDisplay dpy, Probe *out) {
    EGLint maj, min;
    if (!p_initialize(dpy, &maj, &min)) {
        note("    eglInitialize failed");
        return;
    }
    note("    EGL %d.%d initialised", maj, min);

    const char *ext = p_querystring ? p_querystring(dpy, EGL_EXTENSIONS) : NULL;
    int surfaceless = has_ext(ext, "EGL_KHR_surfaceless_context");
    out->dmabuf = has_ext(ext, "EGL_EXT_image_dma_buf_import");

    if (p_bindapi) p_bindapi(EGL_OPENGL_ES_API);

    /* Ask for a pbuffer config only when we actually need a surface. A GBM
     * display offers no pbuffer configs at all, so demanding one would reject a
     * display WebKit is perfectly happy with. */
    EGLint any_attr[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE};
    EGLint pbuf_attr[] = {EGL_SURFACE_TYPE,    EGL_PBUFFER_BIT,
                          EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
                          EGL_NONE};
    EGLConfig cfg;
    EGLint n = 0;
    int need_pbuffer = !surfaceless;
    if (surfaceless) {
        if (!p_chooseconfig(dpy, any_attr, &cfg, 1, &n) || n < 1) {
            note("    no usable config");
            return;
        }
    } else if (!p_chooseconfig(dpy, pbuf_attr, &cfg, 1, &n) || n < 1) {
        /* No pbuffer either: try a bare context and hope the driver tolerates
         * being made current without a surface. */
        n = 0;
        need_pbuffer = 0;
        if (!p_chooseconfig(dpy, any_attr, &cfg, 1, &n) || n < 1) {
            note("    no usable config");
            return;
        }
    }

    EGLint ctx_attr[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    EGLContext ctx = p_createcontext(dpy, cfg, EGL_NO_CONTEXT, ctx_attr);
    if (ctx == EGL_NO_CONTEXT) {
        note("    no GLES2 context");
        return;
    }

    EGLSurface surf = EGL_NO_SURFACE;
    if (need_pbuffer && p_createpbuffer) {
        EGLint pb[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
        surf = p_createpbuffer(dpy, cfg, pb);
    }
    if (!p_makecurrent(dpy, surf, surf, ctx)) {
        note("    eglMakeCurrent failed");
        return;
    }

    PFN_GLGETSTRING glGetString_ = p_getproc ? (PFN_GLGETSTRING)p_getproc("glGetString") : NULL;
    if (!glGetString_) {
        void *g = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_LOCAL);
        if (!g) g = dlopen("libGL.so.1", RTLD_NOW | RTLD_LOCAL);
        if (g) glGetString_ = (PFN_GLGETSTRING)dlsym(g, "glGetString");
    }
    if (!glGetString_) {
        note("    glGetString unavailable");
        return;
    }

    const unsigned char *r = glGetString_(GL_RENDERER);
    const unsigned char *v = glGetString_(GL_VENDOR);
    if (!r) {
        note("    GL_RENDERER was NULL");
        return;
    }
    note("    vendor=%s", v ? (const char *)v : "?");
    snprintf(out->renderer, sizeof(out->renderer), "%s", (const char *)r);
    out->ok = 1;
}

/* Run one candidate in its own process. A driver that aborts, segfaults or hangs
 * then costs us that candidate and nothing else — which is the whole point: the
 * hosts this program exists for are the ones whose GL stack dies on contact. */
static int run_candidate(const Candidate *c, Probe *out, int timeout_ms) {
    int fds[2];
    memset(out, 0, sizeof *out);
    if (pipe(fds) != 0) return 0;

    fflush(NULL);
    pid_t pid = fork();
    if (pid < 0) {
        close(fds[0]);
        close(fds[1]);
        return 0;
    }
    if (pid == 0) {
        close(fds[0]);
        Probe p;
        memset(&p, 0, sizeof p);
        EGLDisplay dpy = c->open();
        if (dpy == EGL_NO_DISPLAY)
            note("    unavailable");
        else
            probe_display(dpy, &p);
        ssize_t w = write(fds[1], &p, sizeof p);
        (void)w;
        _exit(p.ok ? 0 : 1);
    }

    close(fds[1]);
    int status = 0, waited = 0, reaped = 0;
    while (waited < timeout_ms) {
        if (waitpid(pid, &status, WNOHANG) == pid) {
            reaped = 1;
            break;
        }
        struct timespec ts = {0, 20L * 1000 * 1000};
        nanosleep(&ts, NULL);
        waited += 20;
    }
    if (!reaped) {
        note("    %s timed out after %d ms", c->name, timeout_ms);
        kill(pid, SIGKILL);
        waitpid(pid, &status, 0);
    }

    Probe p;
    memset(&p, 0, sizeof p);
    ssize_t n = read(fds[0], &p, sizeof p);
    close(fds[0]);

    if (reaped && WIFSIGNALED(status))
        note("    %s died on signal %d", c->name, WTERMSIG(status));
    if (!reaped || n != (ssize_t)sizeof p || !p.ok) return 0;
    *out = p;
    return 1;
}

/* Per-candidate deadline. Worst case (2 UI + 3 WebProcess candidates) stays well
 * inside the timeout(1) budget AppRun wraps us in; a healthy host takes ~0.2 s. */
#define CANDIDATE_TIMEOUT_MS 2500

int main(int argc, char **argv) {
    verbose = (argc > 1 && strcmp(argv[1], "-v") == 0) || getenv("DIVEPLAY_GPU_DEBUG");

    void *egl = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!egl) {
        note("libEGL.so.1 not loadable: %s", dlerror());
        printf("tier=software ui=no-egl web=none\n");
        return 2;
    }

    p_getproc = (PFN_GETPROC)dlsym(egl, "eglGetProcAddress");
    p_getdisplay = (PFN_GETDISPLAY)sym(egl, "eglGetDisplay");
    p_getplatform = (PFN_GETPLATFORMDISPLAY)(p_getproc ? p_getproc("eglGetPlatformDisplayEXT") : NULL);
    p_initialize = (PFN_INITIALIZE)sym(egl, "eglInitialize");
    p_terminate = (PFN_TERMINATE)sym(egl, "eglTerminate");
    p_bindapi = (PFN_BINDAPI)sym(egl, "eglBindAPI");
    p_chooseconfig = (PFN_CHOOSECONFIG)sym(egl, "eglChooseConfig");
    p_createcontext = (PFN_CREATECONTEXT)sym(egl, "eglCreateContext");
    p_createpbuffer = (PFN_CREATEPBUFFER)sym(egl, "eglCreatePbufferSurface");
    p_makecurrent = (PFN_MAKECURRENT)sym(egl, "eglMakeCurrent");
    p_querystring = (PFN_QUERYSTRING)sym(egl, "eglQueryString");
    (void)p_terminate;

    if (!p_initialize || !p_chooseconfig || !p_createcontext || !p_makecurrent) {
        note("libEGL is missing core entry points");
        printf("tier=software ui=incomplete-egl web=none\n");
        return 2;
    }
    if (p_querystring) {
        const char *ce = p_querystring(EGL_NO_DISPLAY, EGL_EXTENSIONS);
        if (ce) client_ext = ce;
    }
    note("client extensions: %s", *client_ext ? client_ext : "<none>");

    /* ---- 1. The platform the UI process will really use --------------------- */
    /* GDK_BACKEND is authoritative here: the AppImage's gtk hook pins it to x11.
     * The other platform is kept as a second chance only for the case where the
     * pinned one cannot even be opened (GTK falls back the same way). */
    const char *gdk = getenv("GDK_BACKEND");
    Candidate ui[2];
    int nui = 0;
    int prefer_wayland = gdk ? (strstr(gdk, "wayland") != NULL)
                             : (getenv("WAYLAND_DISPLAY") != NULL && !getenv("DISPLAY"));
    if (prefer_wayland) {
        ui[nui++] = (Candidate){"wayland", open_wayland};
        ui[nui++] = (Candidate){"x11", open_x11};
    } else {
        ui[nui++] = (Candidate){"x11", open_x11};
        ui[nui++] = (Candidate){"wayland", open_wayland};
    }

    Probe uip;
    const char *ui_plat = NULL;
    for (int i = 0; i < nui && !ui_plat; i++) {
        note("UI: trying %s platform", ui[i].name);
        if (run_candidate(&ui[i], &uip, CANDIDATE_TIMEOUT_MS)) {
            ui_plat = ui[i].name;
            note("UI: %s -> %s", ui_plat, uip.renderer);
        }
    }

    if (!ui_plat) {
        printf("tier=software ui=none web=none\n");
        return 2;
    }
    if (is_software_renderer(uip.renderer)) {
        printf("tier=software ui=%s:%s web=skipped\n", ui_plat, uip.renderer);
        return 3;
    }

    /* ---- 2. The ladder the WebProcess will really use ----------------------- */
    /* WebKit takes the FIRST display that opens, so we must too: a later
     * candidate working is no consolation if the earlier one wedges WebKit. */
    Candidate web[3] = {
        {"gbm", open_gbm},
        {"surfaceless", open_surfaceless},
        {"default", open_default},
    };
    Probe wp;
    const char *web_plat = NULL;
    for (int i = 0; i < 3 && !web_plat; i++) {
        note("WebProcess: trying %s platform", web[i].name);
        if (run_candidate(&web[i], &wp, CANDIDATE_TIMEOUT_MS)) {
            web_plat = web[i].name;
            note("WebProcess: %s -> %s (dma_buf_import=%d)", web_plat, wp.renderer, wp.dmabuf);
        }
    }

    if (!web_plat) {
        /* This is the v1.0.19 AMD failure: hardware EGL for GTK, nothing the
         * WebProcess can use -> it would CRASH() on startup. */
        printf("tier=gpu-nodmabuf ui=%s:%s web=none\n", ui_plat, uip.renderer);
        return 1;
    }
    if (!wp.dmabuf) {
        printf("tier=gpu-nodmabuf ui=%s:%s web=%s:no-dma_buf_import\n", ui_plat, uip.renderer, web_plat);
        return 1;
    }
    printf("tier=gpu ui=%s:%s web=%s:%s\n", ui_plat, uip.renderer, web_plat,
           wp.renderer[0] ? wp.renderer : "?");
    return 0;
}
