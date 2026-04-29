// src/services/web/fileSystem.ts
import type { MediaFile, PlayerState, FileTypePreferences } from '../../types';
import type { IFileSystem } from '../core/interfaces';
import { STATE_FILE_NAME, getExtension, getBaseName, getDirectory } from '../core/utils';

export const webFileSystem: IFileSystem = {
    async pickFolder(): Promise<FileSystemDirectoryHandle> {
        return await window.showDirectoryPicker({ mode: 'readwrite' });
    },

    async scanDirectory(
        dir: FileSystemDirectoryHandle | string,
        prefs: FileTypePreferences
    ): Promise<MediaFile[]> {
        const dirHandle = dir as FileSystemDirectoryHandle;
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
            lastModified?: number;
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

                    if (supportedVideo.has(ext) || supportedAudio.has(ext) || subtitleExts.has(ext)) {
                        const fileHandle = entry as FileSystemFileHandle;
                        let lastModified: number | undefined;
                        try {
                            const fileObj = await fileHandle.getFile();
                            lastModified = fileObj.lastModified;
                        } catch { /* non-fatal */ }

                        const type = supportedVideo.has(ext) ? 'video' : supportedAudio.has(ext) ? 'audio' : 'subtitle';
                        allFiles.push({ name: entry.name, path: entryPath, handle: fileHandle, type, baseName, directory, lastModified });
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
                    lastModified: file.lastModified,
                });
            }
        }

        return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    },

    async readState(dir: FileSystemDirectoryHandle | string): Promise<PlayerState | null> {
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
    },

    async writeState(dir: FileSystemDirectoryHandle | string, state: PlayerState): Promise<void> {
        const dirHandle = dir as FileSystemDirectoryHandle;
        const fileHandle = await dirHandle.getFileHandle(STATE_FILE_NAME, { create: true });
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(JSON.stringify(state, null, 2));
        } finally {
            await writable.close();
        }
    }
};
