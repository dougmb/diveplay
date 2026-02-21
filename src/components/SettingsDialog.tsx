// SettingsDialog.tsx — File type preferences dialog

import { useState } from 'react';
import type { FileTypePreferences } from '../types';
import { ALL_VIDEO_EXTENSIONS, ALL_AUDIO_EXTENSIONS } from '../services/fileSystem';

interface SettingsDialogProps {
    prefs: FileTypePreferences;
    onSave: (prefs: FileTypePreferences) => void;
    onClose: () => void;
}

export default function SettingsDialog({ prefs, onSave, onClose }: SettingsDialogProps) {
    const [video, setVideo] = useState<string[]>(prefs.video);
    const [audio, setAudio] = useState<string[]>(prefs.audio);

    const toggleExtension = (ext: string, current: string[], setFn: (v: string[]) => void) => {
        if (current.includes(ext)) {
            setFn(current.filter(e => e !== ext));
        } else {
            setFn([...current, ext]);
        }
    };

    const handleSave = () => {
        onSave({ video, audio });
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
                <div className="px-6 pt-6 pb-2">
                    <h2 className="text-lg font-semibold text-zinc-100">File Types</h2>
                    <p className="text-sm text-zinc-400 mt-1">
                        Choose which file types to include in the scan.
                    </p>
                </div>

                <div className="px-6 py-4 space-y-4">
                    {/* Video extensions */}
                    <div>
                        <h3 className="text-sm font-medium text-zinc-300 mb-2">Video</h3>
                        <div className="flex flex-wrap gap-2">
                            {ALL_VIDEO_EXTENSIONS.map(ext => (
                                <button
                                    key={ext}
                                    onClick={() => toggleExtension(ext, video, setVideo)}
                                    className={`px-2 py-1 text-xs rounded transition-colors cursor-pointer ${
                                        video.includes(ext)
                                            ? 'bg-indigo-600 text-white'
                                            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                                    }`}
                                >
                                    {ext}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Audio extensions */}
                    <div>
                        <h3 className="text-sm font-medium text-zinc-300 mb-2">Audio</h3>
                        <div className="flex flex-wrap gap-2">
                            {ALL_AUDIO_EXTENSIONS.map(ext => (
                                <button
                                    key={ext}
                                    onClick={() => toggleExtension(ext, audio, setAudio)}
                                    className={`px-2 py-1 text-xs rounded transition-colors cursor-pointer ${
                                        audio.includes(ext)
                                            ? 'bg-indigo-600 text-white'
                                            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                                    }`}
                                >
                                    {ext}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="px-6 pb-6 flex gap-3">
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-2.5 text-sm font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors cursor-pointer"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors cursor-pointer shadow-lg shadow-indigo-500/20"
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
