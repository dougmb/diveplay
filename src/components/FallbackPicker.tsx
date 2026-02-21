// FallbackPicker.tsx — File picker for browsers without File System Access API

import { useRef, useState } from 'react';
import type { MediaFile } from '../types';

interface FallbackPickerProps {
    onFilesSelected: (files: MediaFile[]) => void;
}

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.ogg', '.wav', '.aac', '.m4a'];

function getExtension(filename: string): string | null {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return null;
    return filename.slice(lastDot).toLowerCase();
}

function getFileType(filename: string): 'video' | 'audio' | null {
    const ext = getExtension(filename);
    if (!ext) return null;
    if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
    if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
    return null;
}

export default function FallbackPicker({ onFilesSelected }: FallbackPickerProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [loading, setLoading] = useState(false);

    const handleClick = () => {
        inputRef.current?.click();
    };

    const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setLoading(true);

        try {
            const mediaFiles: MediaFile[] = [];

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const type = getFileType(file.name);

                if (type) {
                    // Create a fake handle-like object for compatibility
                    // Note: We can't persist these handles, so state won't persist between sessions
                    mediaFiles.push({
                        name: file.name,
                        relativePath: file.name,
                        handle: file as unknown as FileSystemFileHandle,
                        type,
                    });
                }
            }

            // Sort alphabetically
            mediaFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
            onFilesSelected(mediaFiles);
        } catch (err) {
            console.error('Failed to load files:', err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center h-full gap-6 max-w-lg mx-auto px-4">
            <div className="flex flex-col items-center gap-2">
                <svg
                    className="w-20 h-20 text-zinc-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.06-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
                    />
                </svg>
                <h1 className="text-2xl font-bold text-zinc-100">DivePlay</h1>
                <p className="text-sm text-zinc-500 text-center">
                    Your portable media player that travels with your files
                </p>
            </div>

            <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400 space-y-2">
                <p><span className="text-yellow-400 font-medium">Limited browser support detected</span></p>
                <ul className="list-disc list-inside space-y-1">
                    <li>Select your media files below</li>
                    <li>State will not be saved between sessions</li>
                    <li>For full features, use Chrome or Edge</li>
                </ul>
            </div>

            <input
                ref={inputRef}
                type="file"
                multiple
                accept="video/*,audio/*"
                onChange={handleChange}
                className="hidden"
            />

            <button
                onClick={handleClick}
                disabled={loading}
                className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors cursor-pointer shadow-lg shadow-indigo-500/20"
            >
                {loading ? 'Loading...' : 'Select Files'}
            </button>

            <div className="mt-8 pt-4 border-t border-zinc-800 text-center">
                <p className="text-xs text-zinc-500">
                    Developed by{' '}
                    <a
                        href="https://github.com/dougmb/diveplay"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                        @dougmb
                    </a>
                </p>
                <p className="text-xs text-zinc-600 mt-1">
                    Licensed under GPLv2
                </p>
            </div>
        </div>
    );
}
