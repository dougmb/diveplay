// SettingsDialog.tsx — File type preferences dialog

import { useState } from 'react';
import type { FileTypePreferences, AppSettings } from '../types';
import { ALL_VIDEO_EXTENSIONS, ALL_AUDIO_EXTENSIONS, ALL_SUBTITLE_EXTENSIONS } from '../services/fileSystem';

interface SettingsDialogProps {
    prefs: FileTypePreferences;
    appSettings: AppSettings;
    onSave: (prefs: FileTypePreferences, appSettings: AppSettings) => void;
    onClose: () => void;
}

export default function SettingsDialog({ prefs, appSettings, onSave, onClose }: SettingsDialogProps) {
    const [video, setVideo] = useState<string[]>(prefs.video);
    const [audio, setAudio] = useState<string[]>(prefs.audio);
    const [subtitles, setSubtitles] = useState<string[]>(prefs.subtitles);
    const [apiKey, setApiKey] = useState(appSettings.openSubtitlesApiKey ?? '');
    const [subLang, setSubLang] = useState(appSettings.subtitleLanguage ?? 'en');

    const toggleExtension = (ext: string, current: string[], setFn: (v: string[]) => void) => {
        if (current.includes(ext)) {
            setFn(current.filter(e => e !== ext));
        } else {
            setFn([...current, ext]);
        }
    };

    const handleSave = () => {
        onSave(
            { video, audio, subtitles },
            { openSubtitlesApiKey: apiKey.trim() || undefined, subtitleLanguage: subLang.trim() || 'en' }
        );
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

                    {/* Subtitle extensions */}
                    <div>
                        <h3 className="text-sm font-medium text-zinc-300 mb-2">Subtitles</h3>
                        <div className="flex flex-wrap gap-2">
                            {ALL_SUBTITLE_EXTENSIONS.map(ext => (
                                <button
                                    key={ext}
                                    onClick={() => toggleExtension(ext, subtitles, setSubtitles)}
                                    className={`px-2 py-1 text-xs rounded transition-colors cursor-pointer ${
                                        subtitles.includes(ext)
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

                {/* OpenSubtitles */}
                <div className="px-6 pb-4 space-y-3 border-t border-zinc-800 pt-4">
                    <div>
                        <h3 className="text-sm font-medium text-zinc-300 mb-1">Auto Subtitles (OpenSubtitles)</h3>
                        <p className="text-xs text-zinc-500 mb-3">
                            Automatically searches for subtitles when a file is opened.{' '}
                            <a href="https://www.opensubtitles.com/consumers" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
                                Get a free API key
                            </a>
                        </p>
                        <div className="space-y-2">
                            <div>
                                <label className="text-xs text-zinc-400 block mb-1">API Key</label>
                                <input
                                    type="password"
                                    placeholder="Your OpenSubtitles API key"
                                    value={apiKey}
                                    onChange={e => setApiKey(e.target.value)}
                                    className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-zinc-400 block mb-1">Preferred language</label>
                                <input
                                    type="text"
                                    placeholder="pt, en, es, fr..."
                                    value={subLang}
                                    onChange={e => setSubLang(e.target.value)}
                                    maxLength={10}
                                    className="w-32 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50"
                                />
                            </div>
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
