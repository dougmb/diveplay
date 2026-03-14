// codecService.ts — Simplified media handling
//
// In the single-HTML / file:// context, we cannot use ffmpeg.wasm due to 
// CORS and CSP limitations. The desktop version (Tauri) will handle 
// transcoding/streaming via a native Rust backend.

/**
 * Returns a playable URL for the given file.
 * In this web-only version, we always return a direct blob URL.
 */
export async function ensurePlayable(
    file: File
): Promise<{ url: string; transcoded: boolean }> {
    return { 
        url: URL.createObjectURL(file), 
        transcoded: false 
    };
}

/**
 * Helper to check if a filename might have codec issues in the browser.
 */
export function mightNeedTranscoding(filename: string): boolean {
    const SCAN_EXTS = new Set(['mkv', 'hevc', 'ac3', 'dts']);
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    return SCAN_EXTS.has(ext);
}

/**
 * Returns true if the app is served via HTTP/S.
 */
export function isHttpContext(): boolean {
    return window.location.protocol === 'http:' || window.location.protocol === 'https:';
}
