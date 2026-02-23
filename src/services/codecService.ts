// codecService.ts — Automatic codec support via ffmpeg.wasm
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ PROTOCOL BEHAVIOUR                                                      │
// │  file://  → CDN fetch is CORS-blocked by modern Chrome (null origin).  │
// │             Files are returned as direct blob URLs. Unsupported codecs │
// │             (HEVC, AC3, DTS) will not play — the browser simply lacks  │
// │             the decoder. This is a hard browser limitation.            │
// │  http(s)  → FFmpeg.wasm is loaded from CDN and used for transcoding.   │
// └─────────────────────────────────────────────────────────────────────────┘

const CDN_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
const FFMPEG_JS = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/umd/ffmpeg.js';
const UTIL_JS = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/util.js';

// ── Protocol check ───────────────────────────────────────────────────────────

/** Returns true when the app is served over HTTP/S (CDN fetches will work). */
export function isHttpContext(): boolean {
    return window.location.protocol === 'http:' || window.location.protocol === 'https:';
}

// ── CDN script loader ────────────────────────────────────────────────────────

function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[data-ffmpeg-src="${CSS.escape(src)}"]`)) {
            return resolve();
        }
        const s = document.createElement('script');
        s.setAttribute('data-ffmpeg-src', src);
        s.src = src;
        s.crossOrigin = 'anonymous';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`CDN load failed: ${src}`));
        document.head.appendChild(s);
    });
}

// ── CDN lib types ────────────────────────────────────────────────────────────

interface FFmpegInstance {
    loaded: boolean;
    load(opts: { coreURL: string; wasmURL: string }): Promise<void>;
    writeFile(name: string, data: Uint8Array): Promise<void>;
    readFile(name: string): Promise<Uint8Array | string>;
    deleteFile(name: string): Promise<void>;
    exec(args: string[]): Promise<number>;
    on(event: 'log', handler: (e: { message: string }) => void): void;
    on(event: 'progress', handler: (e: { progress: number }) => void): void;
    off(event: 'log', handler: (e: { message: string }) => void): void;
    off(event: 'progress', handler: (e: { progress: number }) => void): void;
}

interface FFmpegUtil {
    toBlobURL(url: string, mimeType: string): Promise<string>;
    fetchFile(data: File): Promise<Uint8Array>;
}

// ── Singleton ────────────────────────────────────────────────────────────────

let instance: FFmpegInstance | null = null;
let loadPromise: Promise<{ ff: FFmpegInstance; util: FFmpegUtil }> | null = null;

async function getFFmpeg(): Promise<{ ff: FFmpegInstance; util: FFmpegUtil }> {
    if (instance?.loaded) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { ff: instance, util: (window as any).FFmpegUtil as FFmpegUtil };
    }
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        // Load CDN UMD builds — the UMD build has its worker inline (blob URL),
        // so it works without emitting a separate file.
        await Promise.all([loadScript(FFMPEG_JS), loadScript(UTIL_JS)]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        if (!w.FFmpeg || !w.FFmpegUtil) throw new Error('FFmpeg globals not found');

        const util = w.FFmpegUtil as FFmpegUtil;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ff: FFmpegInstance = new (w.FFmpeg as any).FFmpeg();

        const coreURL = await util.toBlobURL(`${CDN_BASE}/ffmpeg-core.js`, 'text/javascript');
        const wasmURL = await util.toBlobURL(`${CDN_BASE}/ffmpeg-core.wasm`, 'application/wasm');

        await ff.load({ coreURL, wasmURL });
        instance = ff;
        return { ff, util };
    })();

    try {
        return await loadPromise;
    } catch (err) {
        loadPromise = null;
        instance = null;
        throw err;
    }
}

// ── Codec detection ──────────────────────────────────────────────────────────

/** Extensions that may carry HEVC video or AC3/DTS audio. */
const SCAN_EXTS = new Set(['mkv', 'mp4', 'm4v', 'avi', 'mov']);

export function mightNeedTranscoding(filename: string): boolean {
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    return SCAN_EXTS.has(ext);
}

interface ProbeResult {
    hasHevc: boolean;
    hasAc3OrDts: boolean;
}

async function probeFile(ff: FFmpegInstance, inputName: string): Promise<ProbeResult> {
    let log = '';
    const handler = ({ message }: { message: string }) => { log += message + '\n'; };
    ff.on('log', handler);
    try { await ff.exec(['-i', inputName, '-hide_banner']); } catch { /* expected */ }
    ff.off('log', handler);

    return {
        hasHevc: /Video:.*?(hevc|h265|h\.265)/i.test(log),
        hasAc3OrDts: /Audio:.*?(ac3|a52|eac3|e-ac-3|dts(?!-hd\s+MA))/i.test(log),
    };
}

// ── Public API ───────────────────────────────────────────────────────────────

export type ProgressCallback = (percent: number) => void;

/**
 * Returns a playable URL for `file`.
 *
 * Over http(s): probes for unsupported codecs and transcodes if needed.
 * Over file://: returns a direct blob URL immediately (CDN is unavailable).
 */
export async function ensurePlayable(
    file: File,
    onProgress?: ProgressCallback,
): Promise<{ url: string; transcoded: boolean }> {
    // Fast-path 1: protocol doesn't support CDN → play directly
    if (!isHttpContext()) {
        return { url: URL.createObjectURL(file), transcoded: false };
    }

    // Fast-path 2: extension can't have problematic codecs
    if (!mightNeedTranscoding(file.name)) {
        return { url: URL.createObjectURL(file), transcoded: false };
    }

    try {
        const { ff, util } = await getFFmpeg();

        const ext = file.name.toLowerCase().split('.').pop() ?? 'mkv';
        const inputName = `input.${ext}`;
        const outputName = 'output.mp4';

        await ff.writeFile(inputName, await util.fetchFile(file));

        const { hasHevc, hasAc3OrDts } = await probeFile(ff, inputName);

        if (!hasHevc && !hasAc3OrDts) {
            await ff.deleteFile(inputName);
            return { url: URL.createObjectURL(file), transcoded: false };
        }

        const progressHandler = ({ progress }: { progress: number }) => {
            onProgress?.(Math.min(99, Math.round(progress * 100)));
        };
        ff.on('progress', progressHandler);

        const args = ['-i', inputName];
        args.push(hasHevc ? '-c:v' : '-c:v', hasHevc ? 'libx264' : 'copy');
        if (hasHevc) args.push('-preset', 'ultrafast', '-crf', '23');
        args.push(hasAc3OrDts ? '-c:a' : '-c:a', hasAc3OrDts ? 'aac' : 'copy');
        if (hasAc3OrDts) args.push('-b:a', '192k');
        args.push('-movflags', '+faststart', '-y', outputName);

        await ff.exec(args);
        ff.off('progress', progressHandler);

        const raw = await ff.readFile(outputName);
        const src = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw as string);
        const buf = new Uint8Array(src.length);
        buf.set(src); // copy into plain ArrayBuffer for Blob compatibility
        const blob = new Blob([buf], { type: 'video/mp4' });

        await ff.deleteFile(inputName);
        await ff.deleteFile(outputName);

        onProgress?.(100);
        return { url: URL.createObjectURL(blob), transcoded: true };

    } catch (err) {
        console.warn('[DivePlay] Transcode failed, using direct URL:', err);
        return { url: URL.createObjectURL(file), transcoded: false };
    }
}
