// FolderPicker.tsx — Open folder button and permission logic

import { useEffect, useState } from 'react';
import { saveHandle, loadHandle, requestPermission, savePreferences, loadPreferences } from '../services/db';
import { pickFolder, scanDirectory } from '../services/fileSystem';
import { DEFAULT_FILE_TYPES, type FileTypePreferences, type MediaFile } from '../types';
import SettingsDialog from './SettingsDialog';

interface FolderPickerProps {
    onFolderReady: (handle: FileSystemDirectoryHandle, files: MediaFile[]) => void;
}

export default function FolderPicker({ onFolderReady }: FolderPickerProps) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [prefs, setPrefs] = useState<FileTypePreferences>(DEFAULT_FILE_TYPES);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                // Load prefs FIRST so scanDirectory uses them (avoids stale closure)
                const storedPrefs = await loadPreferences();
                const effectivePrefs = storedPrefs ?? DEFAULT_FILE_TYPES;
                if (storedPrefs && active) setPrefs(storedPrefs);

                const storedHandle = await loadHandle();
                if (storedHandle && active) {
                    const granted = await requestPermission(storedHandle);
                    if (granted && active) {
                        const files = await scanDirectory(storedHandle, effectivePrefs);
                        if (active) onFolderReady(storedHandle, files);
                    }
                }
            } catch {
                // Couldn't restore — user will pick manually
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => { active = false; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handlePickFolder = async () => {
        setError(null);
        try {
            const handle = await pickFolder();
            const files = await scanDirectory(handle, prefs);
            await saveHandle(handle);
            onFolderReady(handle, files);
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                return;
            }
            setError('Could not access the folder. Please try again.');
            console.error(err);
        }
    };

    const handleSavePreferences = async (newPrefs: FileTypePreferences) => {
        setPrefs(newPrefs);
        await savePreferences(newPrefs);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

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
                <p><span className="text-indigo-400 font-medium">How it works:</span></p>
                <ul className="list-disc list-inside space-y-1">
                    <li>Select a folder with your videos and audio files</li>
                    <li>The app scans all subfolders for media</li>
                    <li>Your progress is saved directly in the folder</li>
                    <li>Copy the app anywhere - your data travels with you</li>
                </ul>
            </div>

            <div className="flex gap-3">
                <button
                    onClick={() => setShowSettings(true)}
                    className="px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg font-medium transition-colors cursor-pointer"
                >
                    Settings
                </button>
                <button
                    onClick={handlePickFolder}
                    className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-lg font-medium transition-colors cursor-pointer shadow-lg shadow-indigo-500/20"
                >
                    Open Folder
                </button>
            </div>

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

            {error && (
                <p className="text-red-400 text-sm mt-2">{error}</p>
            )}

            {showSettings && (
                <SettingsDialog
                    prefs={prefs}
                    onSave={handleSavePreferences}
                    onClose={() => setShowSettings(false)}
                />
            )}
        </div>
    );
}
