// src/services/core/utils.ts

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
