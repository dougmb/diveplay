// playerStore.ts — Global state via React Context

import { createContext, useContext } from 'react';
import type { MediaFile, Settings } from '../types';

export interface PlayerStoreState {
    // Playlist
    playlist: MediaFile[];
    currentIndex: number;
    currentFile: MediaFile | null;
    dirHandle: FileSystemDirectoryHandle | null;

    // Playback
    isPlaying: boolean;
    position: number;
    duration: number;

    // Settings
    settings: Settings;
}

export interface PlayerStoreActions {
    setPlaylist: (files: MediaFile[]) => void;
    setDirHandle: (handle: FileSystemDirectoryHandle | null) => void;
    play: (file: MediaFile) => void;
    next: () => void;
    prev: () => void;
    setIsPlaying: (playing: boolean) => void;
    setPosition: (pos: number) => void;
    setDuration: (dur: number) => void;
    setVolume: (vol: number) => void;
    setSpeed: (rate: number) => void;
    toggleShuffle: () => void;
    toggleLoop: () => void;
    toggleSubtitles: () => void;
    setSubtitleFontSize: (size: number) => void;
    reset: () => void;
}

export const defaultSettings: Settings = {
    volume: 1.0,
    playbackRate: 1.0,
    shuffle: false,
    loop: false,
    subtitles: {
        enabled: true,
        fontSize: 18,
    },
};

export const initialState: PlayerStoreState = {
    playlist: [],
    currentIndex: -1,
    currentFile: null,
    dirHandle: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    settings: { ...defaultSettings },
};

export const PlayerContext = createContext<(PlayerStoreState & PlayerStoreActions) | null>(null);

export function usePlayer() {
    const ctx = useContext(PlayerContext);
    if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
    return ctx;
}
