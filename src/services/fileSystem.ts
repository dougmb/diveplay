// fileSystem.ts — File System Access API utilities

import type { MediaFile, PlayerState, FileTypePreferences } from '../types';

const STATE_FILE_NAME = '.player-state.json';

export const ALL_VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
export const ALL_AUDIO_EXTENSIONS = ['.mp3', '.flac', '.ogg', '.wav', '.aac', '.m4a'];
export const ALL_SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.sub'];

export function getSupportedExtensions(prefs: FileTypePreferences): string[] {
    return [...prefs.video, ...prefs.audio];
}

/**
 * Opens the native directory picker dialog with readwrite access.
 */
export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
}

/**
 * Get base filename without extension
 */
function getBaseName(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return filename;
    return filename.slice(0, lastDot);
}

/**
 * Get directory path from file path
 */
function getDirectory(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) return '';
    return path.slice(0, lastSlash);
}

/**
 * Recursively scans a directory and returns a flat list of supported media files.
 * Also finds matching subtitle files for each media file.
 */
export async function scanDirectory(
    dirHandle: FileSystemDirectoryHandle,
    prefs: FileTypePreferences,
    basePath = ''
): Promise<MediaFile[]> {
    const files: MediaFile[] = [];
    const subtitleExts = new Set(prefs.subtitles.map(e => e.toLowerCase()));
    const supportedVideo = new Set(prefs.video.map(e => e.toLowerCase()));
    const supportedAudio = new Set(prefs.audio.map(e => e.toLowerCase()));

    // First pass: collect all media files and subtitle files
    const allFiles: Array<{
        name: string;
        path: string;
        handle: FileSystemFileHandle;
        type: 'video' | 'audio' | 'subtitle';
        baseName: string;
        directory: string;
    }> = [];

    const scanDir = async (handle: FileSystemDirectoryHandle, path: string) => {
        for await (const entry of handle.values()) {
            const entryPath = path ? `${path}/${entry.name}` : entry.name;

            if (entry.kind === 'directory') {
                await scanDir(entry as FileSystemDirectoryHandle, entryPath);
            } else if (entry.kind === 'file') {
                const ext = getExtension(entry.name);
                if (!ext) continue;

                const baseName = getBaseName(entry.name);
                const directory = getDirectory(entryPath);

                if (supportedVideo.has(ext)) {
                    allFiles.push({
                        name: entry.name,
                        path: entryPath,
                        handle: entry as FileSystemFileHandle,
                        type: 'video',
                        baseName,
                        directory,
                    });
                } else if (supportedAudio.has(ext)) {
                    allFiles.push({
                        name: entry.name,
                        path: entryPath,
                        handle: entry as FileSystemFileHandle,
                        type: 'audio',
                        baseName,
                        directory,
                    });
                } else if (subtitleExts.has(ext)) {
                    allFiles.push({
                        name: entry.name,
                        path: entryPath,
                        handle: entry as FileSystemFileHandle,
                        type: 'subtitle',
                        baseName,
                        directory,
                    });
                }
            }
        }
    };

    await scanDir(dirHandle, basePath);

    // Group subtitle files by their base name and directory
    const subtitlesByMedia: Record<string, FileSystemFileHandle[]> = {};
    for (const file of allFiles) {
        if (file.type === 'subtitle') {
            const key = `${file.directory}/${file.baseName}`;
            if (!subtitlesByMedia[key]) {
                subtitlesByMedia[key] = [];
            }
            subtitlesByMedia[key].push(file.handle);
        }
    }

    // Build media files with their subtitles
    for (const file of allFiles) {
        if (file.type === 'video' || file.type === 'audio') {
            const key = `${file.directory}/${file.baseName}`;
            files.push({
                name: file.name,
                relativePath: file.path,
                handle: file.handle,
                type: file.type,
                subtitleHandles: subtitlesByMedia[key] || [],
            });
        }
    }

    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Reads .player-state.json from the folder root if it exists.
 */
export async function readState(
    dirHandle: FileSystemDirectoryHandle
): Promise<PlayerState | null> {
    try {
        const fileHandle = await dirHandle.getFileHandle(STATE_FILE_NAME);
        const file = await fileHandle.getFile();
        const text = await file.text();
        return JSON.parse(text) as PlayerState;
    } catch (err) {
        // File doesn't exist or JSON is malformed — expected, return null
        if (err instanceof DOMException && err.name === 'NotFoundError') return null;
        if (err instanceof SyntaxError) return null;
        // Any other error (permission, I/O) — propagate so callers can handle it
        throw err;
    }
}

/**
 * Writes .player-state.json to the folder root.
 */
export async function writeState(
    dirHandle: FileSystemDirectoryHandle,
    state: PlayerState
): Promise<void> {
    const fileHandle = await dirHandle.getFileHandle(STATE_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    try {
        await writable.write(JSON.stringify(state, null, 2));
    } finally {
        // Always close the stream — even if write() throws — to avoid a locked file
        await writable.close();
    }
}

function getExtension(filename: string): string | null {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return null;
    return filename.slice(lastDot).toLowerCase();
}

export { STATE_FILE_NAME };
