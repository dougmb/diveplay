// src/services/web/mediaService.ts
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { MediaFile, MediaInfo } from '../../types';
import type { IMediaService, PlaybackOptions } from '../core/interfaces';

export const webMediaService: IMediaService = {
    async ensurePlayable(
        file: File | MediaFile,
        _options?: PlaybackOptions
    ): Promise<{ url: string; transcoded: boolean }> {
        const blobFile = file instanceof File ? file : await (file as unknown as { handle: FileSystemFileHandle }).handle.getFile();
        return { 
            url: URL.createObjectURL(blobFile), 
            transcoded: false 
        };
    },

    async getMediaInfo(_path: string): Promise<MediaInfo | null> {
        // Browsers can't easily probe media files deeply without FFmpeg.wasm or similar.
        return null;
    }
};
