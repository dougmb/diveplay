// src/services/fileSystem.ts — Factory for File System Access

import { capabilities } from '../platform/capabilities';
import { webFileSystem } from './web/fileSystem';
import { tauriFileSystem } from './tauri/fileSystem';
import type { IFileSystem } from './core/interfaces';
import type { FileTypePreferences, MediaFile, PlayerState } from '../types';

export {
    STATE_FILE_NAME,
    ALL_VIDEO_EXTENSIONS,
    ALL_AUDIO_EXTENSIONS,
    ALL_SUBTITLE_EXTENSIONS,
} from './core/utils';

export function getSupportedExtensions(prefs: FileTypePreferences): string[] {
    return [...prefs.video, ...prefs.audio];
}

const getFileSystem = (): IFileSystem => {
    return capabilities.hasNativeFileSystem ? tauriFileSystem : webFileSystem;
};

export async function pickFolder(): Promise<FileSystemDirectoryHandle | string> {
    return getFileSystem().pickFolder();
}

export async function scanDirectory(
    dir: FileSystemDirectoryHandle | string,
    prefs: FileTypePreferences
): Promise<MediaFile[]> {
    return getFileSystem().scanDirectory(dir, prefs);
}

export async function readState(
    dir: FileSystemDirectoryHandle | string
): Promise<PlayerState | null> {
    return getFileSystem().readState(dir);
}

export async function writeState(
    dir: FileSystemDirectoryHandle | string,
    state: PlayerState
): Promise<void> {
    return getFileSystem().writeState(dir, state);
}
