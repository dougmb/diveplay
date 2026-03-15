// src/services/codecService.ts — Factory for Media Service

import { capabilities } from '../platform/capabilities';
import { webMediaService } from './web/mediaService';
import { tauriMediaService } from './tauri/mediaService';
import type { IMediaService, PlaybackOptions } from './core/interfaces';
import type { MediaFile, MediaInfo } from '../types';

const getMediaService = (): IMediaService => {
    return capabilities.canTranscode ? tauriMediaService : webMediaService;
};

export async function ensurePlayable(
    file: File | MediaFile,
    options?: PlaybackOptions
): Promise<{ url: string; transcoded: boolean }> {
    return getMediaService().ensurePlayable(file, options);
}

export async function getMediaInfo(path: string): Promise<MediaInfo | null> {
    return getMediaService().getMediaInfo(path);
}

export function mightNeedTranscoding(filename: string): boolean {
    const SCAN_EXTS = new Set(['mkv', 'hevc', 'ac3', 'dts']);
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    return SCAN_EXTS.has(ext);
}

export function isHttpContext(): boolean {
    return window.location.protocol === 'http:' || window.location.protocol === 'https:';
}
