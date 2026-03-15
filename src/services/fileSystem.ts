// fileSystem.ts — Abstraction for File System Access (Web & Tauri)

import type { MediaFile, PlayerState, FileTypePreferences } from '../types';
import { isTauri, getTauriAPI } from './tauri';

const STATE_FILE_NAME = '.player-state.json';

export const ALL_VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
export const ALL_AUDIO_EXTENSIONS = ['.mp3', '.flac', '.ogg', '.wav', '.aac', '.m4a'];
export const ALL_SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.sub'];

export function getSupportedExtensions(prefs: FileTypePreferences): string[] {
    return [...prefs.video, ...prefs.audio];
}

/**
 * Opens the native directory picker dialog.
 */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | string> {
    if (isTauri()) {
        const api = await getTauriAPI();
        if (api) {
            const selected = await api.open({
                directory: true,
                multiple: false,
                title: 'Select Media Folder'
            });
            if (selected) return selected as string;
            throw new Error('User cancelled folder selection');
        }
    }
    return await window.showDirectoryPicker({ mode: 'readwrite' });
}

/**
 * Get extension from filename
 */
function getExtension(filename: string): string | null {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return null;
    return filename.slice(lastDot).toLowerCase();
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
    const lastBackslash = path.lastIndexOf('\\');
    const separatorIndex = Math.max(lastSlash, lastBackslash);
    if (separatorIndex === -1) return '';
    return path.slice(0, separatorIndex);
}

/**
 * Scans a directory for media and subtitle files.
 */
export async function scanDirectory(
    dir: FileSystemDirectoryHandle | string,
    prefs: FileTypePreferences
): Promise<MediaFile[]> {
    if (isTauri() && typeof dir === 'string') {
        return scanDirectoryTauri(dir, prefs);
    } else {
        return scanDirectoryWeb(dir as FileSystemDirectoryHandle, prefs);
    }
}

async function scanDirectoryTauri(
    baseDir: string,
    prefs: FileTypePreferences
): Promise<MediaFile[]> {
    const api = await getTauriAPI();
    if (!api) return [];

    const files: MediaFile[] = [];
    const subtitleExts = new Set(prefs.subtitles.map(e => e.toLowerCase()));
    const supportedVideo = new Set(prefs.video.map(e => e.toLowerCase()));
    const supportedAudio = new Set(prefs.audio.map(e => e.toLowerCase()));

    const allFiles: Array<{
        name: string;
        path: string;
        type: 'video' | 'audio' | 'subtitle';
        baseName: string;
        directory: string;
    }> = [];

    const scanDir = async (path: string) => {
        const entries = await api.readDir(path);
        const sep = path.includes('\\') ? '\\' : '/';
        for (const entry of entries) {
            const entryPath = `${path}${sep}${entry.name}`;
            
            if (entry.isDirectory) {
                await scanDir(entryPath);
            } else if (entry.isFile) {
                const ext = getExtension(entry.name || '');
                if (!ext) continue;

                const baseName = getBaseName(entry.name || '');
                const directory = getDirectory(entryPath);

                if (supportedVideo.has(ext)) {
                    allFiles.push({ name: entry.name || '', path: entryPath, type: 'video', baseName, directory });
                } else if (supportedAudio.has(ext)) {
                    allFiles.push({ name: entry.name || '', path: entryPath, type: 'audio', baseName, directory });
                } else if (subtitleExts.has(ext)) {
                    allFiles.push({ name: entry.name || '', path: entryPath, type: 'subtitle', baseName, directory });
                }
            }
        }
    };

    await scanDir(baseDir);

    // Group subtitles
    const subtitlesByMedia: Record<string, string[]> = {};
    for (const file of allFiles) {
        if (file.type === 'subtitle') {
            const key = `${file.directory}/${file.baseName}`;
            if (!subtitlesByMedia[key]) subtitlesByMedia[key] = [];
            subtitlesByMedia[key].push(file.path);
        }
    }

    for (const file of allFiles) {
        if (file.type === 'video' || file.type === 'audio') {
            const key = `${file.directory}/${file.baseName}`;
            const relativePath = file.path.startsWith(baseDir) 
                ? file.path.slice(baseDir.length).replace(/^[\\\/]/, '') 
                : file.path;

            files.push({
                name: file.name,
                relativePath,
                nativePath: file.path,
                type: file.type,
                subtitleHandles: subtitlesByMedia[key] || [],
            });
        }
    }

    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function scanDirectoryWeb(
    dirHandle: FileSystemDirectoryHandle,
    prefs: FileTypePreferences
): Promise<MediaFile[]> {
    const files: MediaFile[] = [];
    const subtitleExts = new Set(prefs.subtitles.map(e => e.toLowerCase()));
    const supportedVideo = new Set(prefs.video.map(e => e.toLowerCase()));
    const supportedAudio = new Set(prefs.audio.map(e => e.toLowerCase()));

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
                    allFiles.push({ name: entry.name, path: entryPath, handle: entry as FileSystemFileHandle, type: 'video', baseName, directory });
                } else if (supportedAudio.has(ext)) {
                    allFiles.push({ name: entry.name, path: entryPath, handle: entry as FileSystemFileHandle, type: 'audio', baseName, directory });
                } else if (subtitleExts.has(ext)) {
                    allFiles.push({ name: entry.name, path: entryPath, handle: entry as FileSystemFileHandle, type: 'subtitle', baseName, directory });
                }
            }
        }
    };

    await scanDir(dirHandle, '');

    const subtitlesByMedia: Record<string, FileSystemFileHandle[]> = {};
    for (const file of allFiles) {
        if (file.type === 'subtitle') {
            const key = `${file.directory}/${file.baseName}`;
            if (!subtitlesByMedia[key]) subtitlesByMedia[key] = [];
            subtitlesByMedia[key].push(file.handle);
        }
    }

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
 * Reads state from the folder.
 */
export async function readState(
    dir: FileSystemDirectoryHandle | string
): Promise<PlayerState | null> {
    if (isTauri() && typeof dir === 'string') {
        const api = await getTauriAPI();
        if (!api) return null;
        try {
            const sep = dir.includes('\\') ? '\\' : '/';
            const path = `${dir}${sep}${STATE_FILE_NAME}`;
            const contents = await api.readFile(path);
            const text = new TextDecoder().decode(contents);
            return JSON.parse(text) as PlayerState;
        } catch {
            return null;
        }
    } else {
        try {
            const dirHandle = dir as FileSystemDirectoryHandle;
            const fileHandle = await dirHandle.getFileHandle(STATE_FILE_NAME);
            const file = await fileHandle.getFile();
            const text = await file.text();
            return JSON.parse(text) as PlayerState;
        } catch (err) {
            if (err instanceof DOMException && err.name === 'NotFoundError') return null;
            if (err instanceof SyntaxError) return null;
            throw err;
        }
    }
}

/**
 * Writes state to the folder.
 */
export async function writeState(
    dir: FileSystemDirectoryHandle | string,
    state: PlayerState
): Promise<void> {
    if (isTauri() && typeof dir === 'string') {
        const api = await getTauriAPI();
        if (!api) return;
        const sep = dir.includes('\\') ? '\\' : '/';
        const path = `${dir}${sep}${STATE_FILE_NAME}`;
        const text = JSON.stringify(state, null, 2);
        const contents = new TextEncoder().encode(text);
        // Using dynamic import for writeTextFile if needed, but we have api.readFile
        // We'll use tauri-plugin-fs write
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(path, contents);
    } else {
        const dirHandle = dir as FileSystemDirectoryHandle;
        const fileHandle = await dirHandle.getFileHandle(STATE_FILE_NAME, { create: true });
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(JSON.stringify(state, null, 2));
        } finally {
            await writable.close();
        }
    }
}

export { STATE_FILE_NAME };
