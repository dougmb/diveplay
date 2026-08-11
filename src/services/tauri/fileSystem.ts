// src/services/tauri/fileSystem.ts
import type { MediaFile, PlayerState, FileTypePreferences } from '../../types';
import type { IFileSystem } from '../core/interfaces';
import { getTauriAPI } from '../tauri';
import { getExtension, getBaseName, getDirectory, parsePlayerState } from '../core/utils';

export const tauriFileSystem: IFileSystem = {
    async pickFolder(): Promise<string> {
        const api = await getTauriAPI();
        if (api) {
            const selected = await api.open({
                directory: true,
                multiple: false,
                recursive: true,
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
            lastModified?: number;
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

                    if (supportedVideo.has(ext) || supportedAudio.has(ext) || subtitleExts.has(ext)) {
                        let lastModified: number | undefined;
                        try {
                            const fileStat = await api.stat(entryPath);
                            lastModified = fileStat.mtime ? fileStat.mtime.getTime() : undefined;
                        } catch { /* non-fatal */ }

                        const type = supportedVideo.has(ext) ? 'video' : supportedAudio.has(ext) ? 'audio' : 'subtitle';
                        allFiles.push({ name: entry.name || '', path: entryPath, type, baseName, directory, lastModified });
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
                const relativePath = (file.path.startsWith(baseDir)
                    ? file.path.slice(baseDir.length).replace(/^[\\/]/, '')
                    : file.path).replace(/\\/g, '/');

                files.push({
                    name: file.name,
                    relativePath,
                    nativePath: file.path,
                    type: file.type,
                    subtitleHandles: subtitlesByMedia[key] || [],
                    lastModified: file.lastModified,
                });
            }
        }

        return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    },

    // Both sides go through our own Rust commands rather than tauri-plugin-fs:
    // the plugin's scope rejected the user's media folder with "forbidden path"
    // even with `**` allow-entries, which silently broke resume — writes threw and
    // reads returned null, so last file, position and settings were all lost.
    async readState(dir: FileSystemDirectoryHandle | string): Promise<PlayerState | null> {
        const api = await getTauriAPI();
        if (!api) return null;
        try {
            const text = await api.invoke<string | null>('read_player_state', { dir: dir as string });
            return text ? parsePlayerState(text) : null;
        } catch {
            return null;
        }
    },

    // Errors propagate: App.tsx logs them to the native ring buffer, so a folder
    // that cannot be written to is visible in the L viewer instead of silent.
    async writeState(dir: FileSystemDirectoryHandle | string, state: PlayerState): Promise<void> {
        const api = await getTauriAPI();
        if (!api) return;
        await api.invoke('write_player_state', {
            dir: dir as string,
            contents: JSON.stringify(state, null, 2),
        });
    }
};
