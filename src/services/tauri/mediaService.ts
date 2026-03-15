// src/services/tauri/mediaService.ts
import type { MediaFile, MediaInfo } from '../../types';
import type { IMediaService, PlaybackOptions } from '../core/interfaces';
import { getTauriAPI } from '../tauri';

export const tauriMediaService: IMediaService = {
    async ensurePlayable(
        file: File | MediaFile,
        options?: PlaybackOptions
    ): Promise<{ url: string; transcoded: boolean }> {
        const api = await getTauriAPI();
        if (api && !('handle' in file && file instanceof File) && 'nativePath' in file && file.nativePath) {
            try {
                let url = await api.invoke<string>('get_streaming_url', { path: file.nativePath });
                
                const params = new URLSearchParams();
                if (options?.audioTrack !== undefined) params.set('audio_track', options.audioTrack.toString());
                if (options?.transcode) params.set('transcode', 'true');
                if (options?.startTime !== undefined && options.startTime > 0) {
                    params.set('ss', options.startTime.toString());
                }
                
                const queryString = params.toString();
                if (queryString) {
                    url += (url.includes('?') ? '&' : '?') + queryString;
                }
                
                return { url, transcoded: options?.transcode || false };
            } catch (err) {
                console.error('Tauri streaming failed:', err);
            }
        }
        
        // Fallback
        const blobFile = file instanceof File ? file : await (file as unknown as { handle: FileSystemFileHandle }).handle.getFile();
        return { 
            url: URL.createObjectURL(blobFile), 
            transcoded: false 
        };
    },

    async getMediaInfo(path: string): Promise<MediaInfo | null> {
        const api = await getTauriAPI();
        if (!api) return null;
        try {
            return await api.invoke<MediaInfo>('get_media_info', { path });
        } catch (err) {
            console.error('Failed to get media info:', err);
            return null;
        }
    }
};
