// ResumeDialog.tsx — "Continue from where you stopped?" dialog

import type { PlayerState } from '../types';

interface ResumeDialogProps {
    state: PlayerState;
    onResume: () => void;
    onDismiss: () => void;
}

function formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function getFileName(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

export default function ResumeDialog({ state, onResume, onDismiss }: ResumeDialogProps) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-in">
                {/* Header */}
                <div className="px-6 pt-6 pb-2">
                    <h2 className="text-lg font-semibold text-zinc-100">Resume Playback?</h2>
                    <p className="text-sm text-zinc-400 mt-1">
                        You were watching something last time. Pick up where you left off?
                    </p>
                </div>

                {/* File info */}
                <div className="mx-6 my-4 p-4 bg-zinc-800/60 rounded-lg border border-zinc-700/50">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-indigo-600/20 flex items-center justify-center shrink-0">
                            <span className="text-xl">🎬</span>
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-zinc-200 truncate">
                                {getFileName(state.lastFile)}
                            </p>
                            <p className="text-xs text-zinc-500 truncate mt-0.5">
                                {state.lastFile}
                            </p>
                            <p className="text-xs text-indigo-400 mt-1">
                                at {formatTime(state.lastPosition)}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Settings preview */}
                <div className="mx-6 mb-4 flex items-center gap-3 text-xs text-zinc-500">
                    <span>🔊 {Math.round(state.settings.volume * 100)}%</span>
                    <span>⏩ {state.settings.playbackRate}x</span>
                    {state.settings.shuffle && <span>🔀 Shuffle</span>}
                    {state.settings.loop && <span>🔁 Loop</span>}
                </div>

                {/* Actions */}
                <div className="px-6 pb-6 flex gap-3">
                    <button
                        onClick={onDismiss}
                        className="flex-1 px-4 py-2.5 text-sm font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors cursor-pointer"
                    >
                        Start Fresh
                    </button>
                    <button
                        onClick={onResume}
                        className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors cursor-pointer shadow-lg shadow-indigo-500/20"
                    >
                        Resume
                    </button>
                </div>
            </div>
        </div>
    );
}
