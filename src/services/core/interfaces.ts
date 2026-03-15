// src/services/core/interfaces.ts
import type { MediaFile, PlayerState, FileTypePreferences, MediaInfo } from '../../types';

export interface IFileSystem {
    pickFolder(): Promise<FileSystemDirectoryHandle | string>;
    scanDirectory(dir: FileSystemDirectoryHandle | string, prefs: FileTypePreferences): Promise<MediaFile[]>;
    readState(dir: FileSystemDirectoryHandle | string): Promise<PlayerState | null>;
    writeState(dir: FileSystemDirectoryHandle | string, state: PlayerState): Promise<void>;
}

export interface PlaybackOptions {
    audioTrack?: number;
    transcode?: boolean;
    startTime?: number;
}

export interface IMediaService {
    ensurePlayable(file: File | MediaFile, options?: PlaybackOptions): Promise<{ url: string; transcoded: boolean }>;
    getMediaInfo(path: string): Promise<MediaInfo | null>;
}
