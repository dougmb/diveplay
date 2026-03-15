// src/services/tauri/fileSystem.ts
import type { MediaFile, PlayerState, FileTypePreferences } from '../../types';
import type { IFileSystem } from '../core/interfaces';
import { getTauriAPI } from '../tauri';
import { STATE_FILE_NAME, getExtension, getBaseName, getDirectory } from '../core/utils';

export const tauriFileSystem: IFileSystem = {
    async pickFolder(): Promise<string> {
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
        throw new Error('Tauri API not available');
    },

    async scanDirectory(
        dir: FileSystemDirectoryHandle | string,
        prefs: FileTypePreferences
    ): Promise<MediaFile[]> {
        const baseDir = dir as string;
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
                    ? file.path.slice(baseDir.length).replace(/^[\\/]/, '') 
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
    },

    async readState(dir: FileSystemDirectoryHandle | string): Promise<PlayerState | null> {
        const api = await getTauriAPI();
        if (!api) return null;
        try {
            const baseDir = dir as string;
            const sep = baseDir.includes('\\') ? '\\' : '/';
            const path = `${baseDir}${sep}${STATE_FILE_NAME}`;
            const contents = await api.readFile(path);
            const text = new TextDecoder().decode(contents);
            return JSON.parse(text) as PlayerState;
        } catch {
            return null;
        }
    },

    async writeState(dir: FileSystemDirectoryHandle | string, state: PlayerState): Promise<void> {
        const api = await getTauriAPI();
        if (!api) return;
        const baseDir = dir as string;
        const sep = baseDir.includes('\\') ? '\\' : '/';
        const path = `${baseDir}${sep}${STATE_FILE_NAME}`;
        const text = JSON.stringify(state, null, 2);
        const contents = new TextEncoder().encode(text);
        
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(path, contents);
    }
};
