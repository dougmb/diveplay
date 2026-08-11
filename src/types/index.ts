export type SortOrder = 'name-asc' | 'name-desc' | 'date-desc' | 'date-asc' | 'type';

export interface MediaFile {
    name: string;
    relativePath: string;
    handle?: FileSystemFileHandle;
    nativePath?: string;
    type: 'video' | 'audio';
    subtitleHandles?: Array<FileSystemFileHandle | string>;
    lastModified?: number;
}

export interface SubtitleSettings {
    enabled: boolean;
    fontSize: number;
    offset: number; // in seconds
    color: string;      // hex color, default '#ffffff'
    bgOpacity: number;  // 0–1, default 0.75
}

export interface AppSettings {
    openSubtitlesApiKey?: string;
    subtitleLanguage?: string; // ISO 639-1, e.g. 'pt', 'en'
}

export type AspectRatio = 'auto' | 'contain' | 'cover' | 'fill' | '16/9' | '4/3';

export interface Settings {
    volume: number;
    playbackRate: number;
    shuffle: boolean;
    loop: boolean;
    subtitles: SubtitleSettings;
    aspectRatio: AspectRatio;
    sortOrder?: SortOrder;
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

// Tauri Media Info types
export interface MediaStream {
    index: number;
    codec_type: string;
    codec_name: string;
    tags?: Record<string, string>;
    // Optional ffprobe extras, surfaced by the info overlay (I key). Presence
    // depends on codec/container, so every one is optional.
    profile?: string | null;
    width?: number | null;
    height?: number | null;
    pix_fmt?: string | null;
    r_frame_rate?: string | null;
    channels?: number | null;
    sample_rate?: string | null;
    bit_rate?: string | null;
}

export interface MediaFormat {
    duration: string;
    format_name?: string | null;
    size?: string | null;
    bit_rate?: string | null;
}

export interface MediaInfo {
    streams: MediaStream[];
    format: MediaFormat;
}
