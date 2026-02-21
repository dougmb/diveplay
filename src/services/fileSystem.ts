// fileSystem.ts — File System Access API utilities

import type { MediaFile, PlayerState, FileTypePreferences } from '../types';

const STATE_FILE_NAME = '.player-state.json';

export const ALL_VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
export const ALL_AUDIO_EXTENSIONS = ['.mp3', '.flac', '.ogg', '.wav', '.aac', '.m4a'];

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
 * Recursively scans a directory and returns a flat list of supported media files.
 */
export async function scanDirectory(
    dirHandle: FileSystemDirectoryHandle,
    prefs: FileTypePreferences,
    basePath = ''
): Promise<MediaFile[]> {
    const files: MediaFile[] = [];
    const supportedVideo = new Set(prefs.video.map(e => e.toLowerCase()));
    const supportedAudio = new Set(prefs.audio.map(e => e.toLowerCase()));

    for await (const entry of dirHandle.values()) {
        const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

        if (entry.kind === 'directory') {
            const subFiles = await scanDirectory(entry as FileSystemDirectoryHandle, prefs, entryPath);
            files.push(...subFiles);
        } else if (entry.kind === 'file') {
            const ext = getExtension(entry.name);
            if (!ext) continue;

            if (supportedVideo.has(ext)) {
                files.push({
                    name: entry.name,
                    relativePath: entryPath,
                    handle: entry as FileSystemFileHandle,
                    type: 'video',
                });
            } else if (supportedAudio.has(ext)) {
                files.push({
                    name: entry.name,
                    relativePath: entryPath,
                    handle: entry as FileSystemFileHandle,
                    type: 'audio',
                });
            }
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
    } catch {
        // File doesn't exist or is invalid — that's fine
        return null;
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
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();
}

function getExtension(filename: string): string | null {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return null;
    return filename.slice(lastDot).toLowerCase();
}

export { STATE_FILE_NAME };
