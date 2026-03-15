// codecService.ts — Simplified media handling

import { isTauri, getTauriAPI } from './tauri';
import type { MediaFile, MediaInfo } from '../types';

/**
 * Returns a playable URL for the given media file.
 * - On Web: returns a direct blob URL.
 * - On Tauri: returns a streaming URL from our local Rust server.
 */
export async function ensurePlayable(
    file: File | MediaFile,
    options?: { audioTrack?: number; transcode?: boolean; startTime?: number }
): Promise<{ url: string; transcoded: boolean }> {
    if (isTauri()) {
        const api = await getTauriAPI();
        if (api) {
            // If we have a MediaFile with nativePath, use it
            if ('nativePath' in file && file.nativePath) {
                try {
                    let url = await api.invoke<string>('get_streaming_url', { path: file.nativePath });
                    
                    // Add query params for transcoding/tracks/seek
                    const params = new URLSearchParams();
                    if (options?.audioTrack !== undefined) params.set('audio_track', options.audioTrack.toString());
                    if (options?.transcode) params.set('transcode', 'true');
                    if (options?.startTime !== undefined && options.startTime > 0) {
                        params.set('ss', options.startTime.toString());
                    }
                    
                    const queryString = params.toString();
                    if (queryString) {
                        // Correctly append parameters: use & if ? is already present
                        url += (url.includes('?') ? '&' : '?') + queryString;
                    }
                    
                    return { url, transcoded: options?.transcode || false };
                } catch (err) {
                    console.error('Tauri streaming failed:', err);
                }
            }
        }
    }

    // Fallback or Web: use the direct file blob
    const blobFile = file instanceof File ? file : await (file as any).handle.getFile();
    return { 
        url: URL.createObjectURL(blobFile), 
        transcoded: false 
    };
}

/**
 * Gets media info from Tauri backend.
 */
export async function getMediaInfo(path: string): Promise<MediaInfo | null> {
    if (!isTauri()) return null;
    const api = await getTauriAPI();
    if (!api) return null;
    try {
        return await api.invoke<MediaInfo>('get_media_info', { path });
    } catch (err) {
        console.error('Failed to get media info:', err);
        return null;
    }
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
