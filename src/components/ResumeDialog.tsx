// ResumeDialog.tsx — "Continue from where you stopped?" dialog
import { useState, useEffect } from 'react';
import type { PlayerState } from '../types';

interface ResumeDialogProps {
    state: PlayerState;
    onResume: () => void;
    onDismiss: () => void;
    onSelectNewFolder: () => void;
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

function getFolderPath(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash === -1 ? '' : path.slice(0, lastSlash);
}

function isVideo(path: string): boolean {
    return /\.(mp4|mkv|webm|avi|mov|m4v)$/i.test(path);
}

const RESUME_COUNTDOWN = 15;

export default function ResumeDialog({ state, onResume, onDismiss, onSelectNewFolder }: ResumeDialogProps) {
    const [countdown, setCountdown] = useState(RESUME_COUNTDOWN);

    const fillPercent = ((RESUME_COUNTDOWN - countdown) / RESUME_COUNTDOWN) * 100;
    const folderPath = getFolderPath(state.lastFile);
    const fileName = getFileName(state.lastFile);
    const fileIsVideo = isVideo(state.lastFile);

    useEffect(() => {
        const timer = setInterval(() => {
            setCountdown((prev) => {
                if (prev <= 1) {
                    clearInterval(timer);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (countdown === 0) onResume();
    }, [countdown, onResume]);

    // Atalhos de teclado: Enter = resume, Escape = dismiss
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter') onResume();
            if (e.key === 'Escape') onDismiss();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [onResume, onDismiss]);

    return (
        // Overlay com backdrop blur
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">

            {/* Card */}
            <div className="w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-2xl overflow-hidden">

                {/* Header */}
                <div className="px-6 pt-6 pb-4 border-b border-zinc-800">
                    <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-1">
                        Welcome back
                    </p>
                    <h2 className="text-lg font-bold text-white leading-snug">
                        Continue from where you left off?
                    </h2>
                </div>

                {/* File info */}
                <div className="px-6 py-5 flex items-start gap-4">

                    {/* Ícone do tipo de arquivo */}
                    <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-center">
                        {fileIsVideo ? (
                            <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0118 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0 5.25C6 5.754 6.496 5.25 7.125 5.25h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0118 18.375M20.625 4.5c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h1.5m1.5 0c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M12 14.625v-1.5c0-.621.504-1.125 1.125-1.125m-2.25 0c.621 0 1.125.504 1.125 1.125v1.5m0-5.25c0 .621-.504 1.125-1.125 1.125M9.75 9.375c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-9.75 0V7.125c0-.621.504-1.125 1.125-1.125M6 12.75c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-9.75 0v-1.5c0-.621-.504-1.125-1.125-1.125M9 12.75h.008v.008H9V12.75z" />
                            </svg>
                        ) : (
                            <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.479l.653-.315a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.479l.653-.315a2.25 2.25 0 001.632-2.163z" />
                            </svg>
                        )}
                    </div>

                    <div className="flex flex-col gap-0.5 min-w-0">
                        {/* Nome do arquivo */}
                        <span className="text-sm font-semibold text-white truncate" title={fileName}>
                            {fileName}
                        </span>

                        {/* Pasta */}
                        {folderPath && (
                            <span className="text-xs text-zinc-500 truncate" title={folderPath}>
                                <span className="inline-flex items-center gap-1">
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.06-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                                    </svg>
                                    {folderPath}
                                </span>
                            </span>
                        )}

                        {/* Posição */}
                        <span className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2.5 py-0.5 w-fit">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            at {formatTime(state.lastPosition)}
                        </span>
                    </div>
                </div>

                {/* Botões */}
                <div className="px-6 pb-6 flex flex-col gap-3">

                    {/* Botão Resume com fill progressivo */}
                    <button
                        onClick={onResume}
                        className="relative w-full overflow-hidden rounded-xl border border-blue-500/60 bg-transparent px-5 py-3 font-semibold text-white transition-colors hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-zinc-900"
                    >
                        {/* Fill que cresce da esquerda para direita */}
                        <span
                            className="absolute inset-0 bg-blue-600 transition-[width] duration-1000 ease-linear"
                            style={{ width: `${fillPercent}%` }}
                        />
                        {/* Texto sobre o fill */}
                        <span className="relative z-10 flex items-center justify-center gap-2 text-sm">
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                            <span>Resume</span>
                            <span className="opacity-60 font-normal text-xs">({countdown}s)</span>
                        </span>
                    </button>

                    {/* Linha divisória com label */}
                    <div className="flex items-center gap-3">
                        <div className="flex-1 h-px bg-zinc-800" />
                        <span className="text-xs text-zinc-600">or</span>
                        <div className="flex-1 h-px bg-zinc-800" />
                    </div>

                    {/* Botões secundários lado a lado */}
                    <div className="flex gap-3">
                        <button
                            onClick={onDismiss}
                            className="flex-1 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:ring-offset-zinc-900"
                        >
                            Start fresh
                        </button>
                        <button
                            onClick={onSelectNewFolder}
                            className="flex-1 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:ring-offset-zinc-900"
                        >
                            <span className="flex items-center justify-center gap-2">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.06-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                                </svg>
                                New folder
                            </span>
                        </button>
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-3 border-t border-zinc-800 flex items-center justify-between">
                    <span className="text-xs text-zinc-600">
                        Developed by{' '}
                        <a
                            href="https://github.com/dougmb"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                            @dougmb
                        </a>
                    </span>
                    <span className="text-xs text-zinc-700">GPLv2</span>
                </div>

            </div>
        </div>
    );
}
