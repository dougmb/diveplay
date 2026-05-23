// src/services/core/utils.ts
import type { PlayerState, Settings, AspectRatio, SortOrder } from '../../types';

export const STATE_FILE_NAME = '.player-state.json';
export const ALL_VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
export const ALL_AUDIO_EXTENSIONS = ['.mp3', '.flac', '.ogg', '.wav', '.aac', '.m4a'];
export const ALL_SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.sub'];

export function getExtension(filename: string): string | null {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return null;
    return filename.slice(lastDot).toLowerCase();
}

export function getBaseName(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return filename;
    return filename.slice(0, lastDot);
}

export function getDirectory(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    const lastBackslash = path.lastIndexOf('\\');
    const separatorIndex = Math.max(lastSlash, lastBackslash);
    if (separatorIndex === -1) return '';
    return path.slice(0, separatorIndex);
}

function clamp(val: number, min: number, max: number, fallback: number): number {
    return isFinite(val) ? Math.max(min, Math.min(max, val)) : fallback;
}

function isHexColor(v: unknown): v is string {
    return typeof v === 'string' && /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(v);
}

function isValidAspectRatio(v: unknown): v is AspectRatio {
    return ['auto', 'contain', 'cover', 'fill', '16/9', '4/3'].includes(v as string);
}

function isValidSortOrder(v: unknown): v is SortOrder {
    return ['name-asc', 'name-desc', 'date-asc', 'date-desc', 'type'].includes(v as string);
}

export function parsePlayerState(text: string): PlayerState | null {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return null; }
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    if (typeof obj.lastFile !== 'string' || !obj.lastFile) return null;

    const lastPosition = Number(obj.lastPosition);

    const rawSettings = (obj.settings && typeof obj.settings === 'object')
        ? obj.settings as Record<string, unknown>
        : {};
    const rawSubs = (rawSettings.subtitles && typeof rawSettings.subtitles === 'object')
        ? rawSettings.subtitles as Record<string, unknown>
        : {};

    const safeSettings: Settings = {
        volume:       clamp(Number(rawSettings.volume), 0, 1, 1),
        playbackRate: clamp(Number(rawSettings.playbackRate), 0.25, 4, 1),
        shuffle:      Boolean(rawSettings.shuffle),
        loop:         Boolean(rawSettings.loop),
        aspectRatio:  isValidAspectRatio(rawSettings.aspectRatio) ? rawSettings.aspectRatio : 'auto',
        sortOrder:    isValidSortOrder(rawSettings.sortOrder) ? rawSettings.sortOrder : 'name-asc',
        subtitles: {
            enabled:   Boolean(rawSubs.enabled),
            fontSize:  clamp(Number(rawSubs.fontSize), 12, 96, 18),
            offset:    clamp(Number(rawSubs.offset), -30, 30, 0),
            color:     isHexColor(rawSubs.color) ? rawSubs.color : '#ffffff',
            bgOpacity: clamp(Number(rawSubs.bgOpacity), 0, 1, 0.75),
        },
    };

    return {
        lastFile: obj.lastFile,
        lastPosition: isFinite(lastPosition) && lastPosition >= 0 ? lastPosition : 0,
        settings: safeSettings,
    };
}
