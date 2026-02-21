export interface MediaFile {
    name: string;
    relativePath: string;
    handle: FileSystemFileHandle;
    type: 'video' | 'audio';
    subtitleHandles?: FileSystemFileHandle[];
}

export interface SubtitleSettings {
    enabled: boolean;
    fontSize: number;
}

export interface Settings {
    volume: number;
    playbackRate: number;
    shuffle: boolean;
    loop: boolean;
    subtitles: SubtitleSettings;
}

export interface PlayerState {
    lastFile: string;
    lastPosition: number;
    settings: Settings;
}

export interface FileTypePreferences {
    video: string[];
    audio: string[];
    subtitles: string[];
}

export const DEFAULT_FILE_TYPES: FileTypePreferences = {
    video: ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'],
    audio: ['.mp3', '.flac', '.ogg', '.wav', '.aac', '.m4a'],
    subtitles: ['.srt', '.vtt', '.sub'],
};
