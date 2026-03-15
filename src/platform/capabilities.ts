// src/platform/capabilities.ts
import { isTauri } from '../services/tauri';

export interface PlatformCapabilities {
    /** Whether the platform can transcode media files (e.g., via FFmpeg) */
    canTranscode: boolean;
    /** Whether the platform has access to native log files */
    hasNativeLogs: boolean;
    /** Whether the platform supports selecting specific audio tracks */
    supportsAudioTracks: boolean;
    /** Whether the platform uses native file system paths vs web File/Directory System Handles */
    hasNativeFileSystem: boolean;
}

// In a more advanced setup, this could be determined dynamically or injected by the build process.
// For now, we derive it from the `isTauri()` check to avoid breaking existing logic during the transition.
export const capabilities: PlatformCapabilities = {
    canTranscode: isTauri(),
    hasNativeLogs: isTauri(),
    supportsAudioTracks: isTauri(),
    hasNativeFileSystem: isTauri(),
};
