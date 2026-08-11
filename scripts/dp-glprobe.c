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
 * falls back to the bundled software stack. Hangs are handled by the caller
 * wrapping us in timeout(1).
 *
 * Several EGL platforms are tried in turn, because "an EGL display initialised"
 * does NOT mean "we got the GPU": on a glvnd host with both Mesa and a vendor
 * driver installed, the default display frequently resolves to Mesa and silently
 * falls back to llvmpipe while the vendor driver would have given real hardware.
 * So every candidate is taken all the way to a GL_RENDERER string and the search
 * only stops on a hardware renderer.
 *
 * Everything is loaded with dlopen(): the probe has no link-time dependency on
 * libEGL/libX11, so a host missing them fails cleanly instead of failing to start.
 *
 * Exit codes (contract shared with AppRun):
 *   0  hardware renderer + usable DRM render node -> GPU mode, DMABuf renderer on
 *   1  hardware renderer, no usable render node   -> GPU mode, DMABuf renderer off
 *   2  no usable EGL / no context / probe failed  -> bundled software stack
 *   3  host itself only offers software rendering -> bundled software stack
 *                                                    (ours is newer and self-contained)
 *
 * On success stdout carries "<mode>:<renderer>" and, when a platform other than
 * the default was needed, AppRun re-runs the probe per glvnd vendor to find one
 * that yields hardware.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
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
#define EGL_PLATFORM_GBM_MESA 0x31D7
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

/* WebKit's DMABuf renderer needs a DRM render node it can actually open. */
static int has_usable_render_node(void) {
    DIR *d = opendir("/dev/dri");
    if (!d) return 0;
    struct dirent *e;
    int ok = 0;
    while (!ok && (e = readdir(d))) {
        if (strncmp(e->d_name, "renderD", 7) != 0) continue;
        char path[9 + sizeof(e->d_name) + 1];
        snprintf(path, sizeof(path), "/dev/dri/%s", e->d_name);
        int fd = open(path, O_RDWR | O_CLOEXEC);
        if (fd >= 0) {
            note("render node %s is openable", path);
            close(fd);
            ok = 1;
        } else {
            note("render node %s present but not openable", path);
        }
    }
    closedir(d);
    return ok;
}

static void *sym(void *lib, const char *name) {
    void *s = dlsym(lib, name);
    if (!s && p_getproc) s = p_getproc(name);
    return s;
}

/* ---- Candidate EGL displays ------------------------------------------------ */

typedef struct {
    const char *name;
    EGLDisplay (*open)(void);
} Candidate;

static EGLDisplay open_x11(void) {
    if (!p_getplatform || !getenv("DISPLAY")) return EGL_NO_DISPLAY;
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
    void *w = dlopen("libwayland-client.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!w) return EGL_NO_DISPLAY;
    void *(*wconnect)(const char *) = (void *(*)(const char *))dlsym(w, "wl_display_connect");
    if (!wconnect) return EGL_NO_DISPLAY;
    void *wd = wconnect(NULL);
    if (!wd) return EGL_NO_DISPLAY;
    return p_getplatform(EGL_PLATFORM_WAYLAND_KHR, wd, NULL);
}

static EGLDisplay open_surfaceless(void) {
    if (!p_getplatform) return EGL_NO_DISPLAY;
    return p_getplatform(EGL_PLATFORM_SURFACELESS_MESA, NULL, NULL);
}

static EGLDisplay open_default(void) {
    if (!p_getdisplay) return EGL_NO_DISPLAY;
    return p_getdisplay(EGL_DEFAULT_DISPLAY);
}

/* Take one candidate display all the way to a GL_RENDERER string.
 * Returns 1 and fills `out` on success. */
static int renderer_for(EGLDisplay dpy, char *out, size_t outsz) {
    EGLint maj, min;
    if (!p_initialize(dpy, &maj, &min)) return 0;
    note("    EGL %d.%d initialised", maj, min);

    const char *ext = p_querystring ? p_querystring(dpy, EGL_EXTENSIONS) : NULL;
    int surfaceless = ext && strstr(ext, "EGL_KHR_surfaceless_context");

    if (p_bindapi) p_bindapi(EGL_OPENGL_ES_API);

    EGLint cfg_attr[] = {EGL_SURFACE_TYPE,    EGL_PBUFFER_BIT,
                         EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
                         EGL_NONE};
    EGLConfig cfg;
    EGLint n = 0;
    if (!p_chooseconfig(dpy, cfg_attr, &cfg, 1, &n) || n < 1) {
        note("    no usable config");
        return 0;
    }

    EGLint ctx_attr[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    EGLContext ctx = p_createcontext(dpy, cfg, EGL_NO_CONTEXT, ctx_attr);
    if (ctx == EGL_NO_CONTEXT) {
        note("    no GLES2 context");
        return 0;
    }

    EGLSurface surf = EGL_NO_SURFACE;
    if (!surfaceless && p_createpbuffer) {
        EGLint pb[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
        surf = p_createpbuffer(dpy, cfg, pb);
    }
    if (!p_makecurrent(dpy, surf, surf, ctx)) {
        note("    eglMakeCurrent failed");
        return 0;
    }

    PFN_GLGETSTRING glGetString_ = p_getproc ? (PFN_GLGETSTRING)p_getproc("glGetString") : NULL;
    if (!glGetString_) {
        void *g = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_LOCAL);
        if (!g) g = dlopen("libGL.so.1", RTLD_NOW | RTLD_LOCAL);
        if (g) glGetString_ = (PFN_GLGETSTRING)dlsym(g, "glGetString");
    }
    if (!glGetString_) {
        note("    glGetString unavailable");
        return 0;
    }

    const unsigned char *r = glGetString_(GL_RENDERER);
    const unsigned char *v = glGetString_(GL_VENDOR);
    if (!r) {
        note("    GL_RENDERER was NULL");
        return 0;
    }
    note("    vendor=%s", v ? (const char *)v : "?");
    snprintf(out, outsz, "%s", (const char *)r);

    /* Release so the next candidate starts from a clean slate. */
    p_makecurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    return 1;
}

int main(int argc, char **argv) {
    verbose = (argc > 1 && strcmp(argv[1], "-v") == 0) || getenv("DIVEPLAY_GPU_DEBUG");

    void *egl = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!egl) {
        note("libEGL.so.1 not loadable: %s", dlerror());
        printf("no-egl\n");
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

    if (!p_initialize || !p_chooseconfig || !p_createcontext || !p_makecurrent) {
        note("libEGL is missing core entry points");
        printf("incomplete-egl\n");
        return 2;
    }

    Candidate cands[4];
    int nc = 0;

    /* Probe the window-system platform the app will actually run on first: that
     * is the one whose result predicts WebKit's behaviour. */
    const char *gdk = getenv("GDK_BACKEND");
    if (gdk && strstr(gdk, "wayland")) {
        cands[nc++] = (Candidate){"wayland", open_wayland};
        cands[nc++] = (Candidate){"x11", open_x11};
    } else {
        cands[nc++] = (Candidate){"x11", open_x11};
        cands[nc++] = (Candidate){"wayland", open_wayland};
    }
    cands[nc++] = (Candidate){"default", open_default};
    cands[nc++] = (Candidate){"surfaceless", open_surfaceless};

    char soft[256] = "";
    for (int i = 0; i < nc; i++) {
        note("trying %s platform", cands[i].name);
        EGLDisplay dpy = cands[i].open();
        if (dpy == EGL_NO_DISPLAY) {
            note("    unavailable");
            continue;
        }
        char r[256];
        if (!renderer_for(dpy, r, sizeof(r))) {
            if (p_terminate) p_terminate(dpy);
            continue;
        }
        note("    GL_RENDERER = %s", r);

        if (is_software_renderer(r)) {
            /* Keep looking: another platform may reach the real GPU. */
            if (!soft[0]) snprintf(soft, sizeof(soft), "%s", r);
            if (p_terminate) p_terminate(dpy);
            continue;
        }

        int dmabuf = has_usable_render_node();
        printf("%s:%s:%s\n", dmabuf ? "gpu" : "gpu-nodmabuf", cands[i].name, r);
        return dmabuf ? 0 : 1;
    }

    if (soft[0]) {
        printf("software:%s\n", soft);
        return 3;
    }
    printf("no-hardware\n");
    return 2;
}
