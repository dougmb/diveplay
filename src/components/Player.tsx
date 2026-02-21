// Player.tsx — Video/audio player with custom controls

import { useRef, useEffect, useCallback, useState } from 'react';
import { usePlayer } from '../store/playerStore';

export default function Player() {
    const player = usePlayer();
    const mediaRef = useRef<HTMLVideoElement>(null);
    const [blobUrl, setBlobUrl] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const hideTimerRef = useRef<number | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);
    const progressRef = useRef<HTMLDivElement>(null);

    const { currentFile, isPlaying, settings, duration } = player;

    // Load file as blob URL when currentFile changes
    useEffect(() => {
        let cancelled = false;

        if (!currentFile) {
            setBlobUrl(null);
            return;
        }

        (async () => {
            try {
                const file = await currentFile.handle.getFile();
                const url = URL.createObjectURL(file);
                if (!cancelled) setBlobUrl(url);
            } catch (err) {
                console.error('Failed to load file:', err);
            }
        })();

        return () => {
            cancelled = true;
            setBlobUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return null;
            });
        };
    }, [currentFile]);

    // Sync play/pause state
    useEffect(() => {
        const el = mediaRef.current;
        if (!el || !blobUrl) return;

        if (isPlaying) {
            el.play().catch(() => { /* autoplay blocked is ok */ });
        } else {
            el.pause();
        }
    }, [isPlaying, blobUrl]);

    // Sync volume & playback rate
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        el.volume = settings.volume;
        el.playbackRate = settings.playbackRate;
    }, [settings.volume, settings.playbackRate]);

    // Auto-hide controls on mouse inactivity
    const resetHideTimer = useCallback(() => {
        setShowControls(true);
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
            if (isPlaying) setShowControls(false);
        }, 3000);
    }, [isPlaying]);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            // Don't capture keys when typing in inputs
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            const el = mediaRef.current;

            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    player.setIsPlaying(!isPlaying);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    if (el) el.currentTime = Math.max(0, el.currentTime - 10);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    if (el) el.currentTime = Math.min(el.duration || 0, el.currentTime + 10);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    player.setVolume(Math.min(1, settings.volume + 0.05));
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    player.setVolume(Math.max(0, settings.volume - 0.05));
                    break;
                case 'KeyF':
                    e.preventDefault();
                    toggleFullscreen();
                    break;
                case 'KeyM':
                    e.preventDefault();
                    toggleMute();
                    break;
            }
        };

        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [isPlaying, settings.volume]); // eslint-disable-line react-hooks/exhaustive-deps

    const toggleMute = () => {
        const el = mediaRef.current;
        if (!el) return;
        el.muted = !el.muted;
        setIsMuted(!isMuted);
    };

    const toggleFullscreen = async () => {
        const container = containerRef.current;
        if (!container) return;

        if (document.fullscreenElement) {
            await document.exitFullscreen();
            setIsFullscreen(false);
        } else {
            await container.requestFullscreen();
            setIsFullscreen(true);
        }
    };

    const handleTimeUpdate = () => {
        const el = mediaRef.current;
        if (!el) return;
        player.setPosition(el.currentTime);
    };

    const handleLoadedMetadata = () => {
        const el = mediaRef.current;
        if (!el) return;
        player.setDuration(el.duration);
        el.volume = settings.volume;
        el.playbackRate = settings.playbackRate;
    };

    const handleEnded = () => {
        player.setIsPlaying(false);
        if (settings.loop) {
            const el = mediaRef.current;
            if (el) {
                el.currentTime = 0;
                player.setIsPlaying(true);
            }
        } else {
            player.next();
        }
    };

    const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const el = mediaRef.current;
        const bar = progressRef.current;
        if (!el || !bar) return;

        const rect = bar.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        el.currentTime = pct * (el.duration || 0);
    };

    // Speed options
    const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

    const cycleSpeed = () => {
        const currentIdx = speeds.indexOf(settings.playbackRate);
        const nextIdx = (currentIdx + 1) % speeds.length;
        player.setSpeed(speeds[nextIdx]);
    };

    if (!currentFile || !blobUrl) {
        return (
            <div className="flex-1 flex items-center justify-center text-zinc-600">
                <div className="text-center">
                    <svg className="w-16 h-16 mx-auto mb-4 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                    </svg>
                    <p className="text-lg">Select a file to play</p>
                </div>
            </div>
        );
    }

    const progress = duration > 0 ? (player.position / duration) * 100 : 0;
    const isVideo = currentFile.type === 'video';

    return (
        <div
            ref={containerRef}
            className="flex-1 flex flex-col bg-black relative"
            onMouseMove={resetHideTimer}
            onMouseLeave={() => { if (isPlaying) setShowControls(false); }}
        >
            {/* Media element */}
            <div className="flex-1 flex items-center justify-center overflow-hidden"
                onClick={() => player.setIsPlaying(!isPlaying)}
            >
                {isVideo ? (
                    <video
                        ref={mediaRef}
                        src={blobUrl}
                        className="max-w-full max-h-full w-full h-full object-contain"
                        onTimeUpdate={handleTimeUpdate}
                        onLoadedMetadata={handleLoadedMetadata}
                        onEnded={handleEnded}
                        onPlay={() => player.setIsPlaying(true)}
                        onPause={() => player.setIsPlaying(false)}
                    />
                ) : (
                    <>
                        {/* Audio visualizer placeholder */}
                        <div className="flex flex-col items-center gap-4 text-zinc-400">
                            <div className="w-32 h-32 rounded-2xl bg-zinc-800 flex items-center justify-center shadow-xl">
                                <span className="text-6xl">🎵</span>
                            </div>
                            <p className="text-lg font-medium text-zinc-300">{currentFile.name}</p>
                            <p className="text-sm text-zinc-500">{currentFile.relativePath}</p>
                        </div>
                        <audio
                            ref={mediaRef as React.RefObject<HTMLAudioElement>}
                            src={blobUrl}
                            onTimeUpdate={handleTimeUpdate}
                            onLoadedMetadata={handleLoadedMetadata}
                            onEnded={handleEnded}
                            onPlay={() => player.setIsPlaying(true)}
                            onPause={() => player.setIsPlaying(false)}
                        />
                    </>
                )}
            </div>

            {/* Controls overlay */}
            <div className={`
        absolute bottom-0 left-0 right-0
        bg-gradient-to-t from-black/90 via-black/60 to-transparent
        transition-opacity duration-300 pt-12 pb-3 px-4
        ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}
      `}>
                {/* Progress bar */}
                <div
                    ref={progressRef}
                    className="w-full h-1.5 bg-zinc-700 rounded-full cursor-pointer mb-3 group hover:h-2.5 transition-all"
                    onClick={handleProgressClick}
                >
                    <div
                        className="h-full bg-indigo-500 rounded-full relative transition-all"
                        style={{ width: `${progress}%` }}
                    >
                        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                    {/* Left controls */}
                    <div className="flex items-center gap-2">
                        {/* Prev */}
                        <button onClick={() => player.prev()} className="p-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer" title="Previous">
                            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                            </svg>
                        </button>

                        {/* Play/Pause */}
                        <button
                            onClick={() => player.setIsPlaying(!isPlaying)}
                            className="p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors cursor-pointer"
                            title={isPlaying ? 'Pause' : 'Play'}
                        >
                            {isPlaying ? (
                                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                                </svg>
                            ) : (
                                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M8 5v14l11-7z" />
                                </svg>
                            )}
                        </button>

                        {/* Next */}
                        <button onClick={() => player.next()} className="p-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer" title="Next">
                            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z" />
                            </svg>
                        </button>

                        {/* Time */}
                        <span className="text-xs text-zinc-400 ml-2 font-mono tabular-nums">
                            {formatTime(player.position)} / {formatTime(duration)}
                        </span>
                    </div>

                    {/* Right controls */}
                    <div className="flex items-center gap-2">
                        {/* Speed */}
                        <button
                            onClick={cycleSpeed}
                            className="px-2 py-1 text-xs text-zinc-300 hover:text-white bg-white/5 hover:bg-white/10 rounded transition-colors cursor-pointer font-mono"
                            title="Playback speed"
                        >
                            {settings.playbackRate}x
                        </button>

                        {/* Volume */}
                        <div className="flex items-center gap-1 group/vol">
                            <button onClick={toggleMute} className="p-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer" title={isMuted ? 'Unmute' : 'Mute'}>
                                {isMuted || settings.volume === 0 ? (
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.21.05-.43.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                                    </svg>
                                ) : settings.volume < 0.5 ? (
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-3.02zM5 9v6h4l5 5V4L9 9H5z" />
                                    </svg>
                                ) : (
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-3.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77S18.01 4.14 14 3.23z" />
                                    </svg>
                                )}
                            </button>
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={isMuted ? 0 : settings.volume}
                                onChange={(e) => {
                                    player.setVolume(parseFloat(e.target.value));
                                    if (isMuted) setIsMuted(false);
                                }}
                                className="w-20 h-1 accent-indigo-500 cursor-pointer opacity-0 group-hover/vol:opacity-100 transition-opacity"
                            />
                        </div>

                        {/* Shuffle */}
                        <button
                            onClick={() => player.toggleShuffle()}
                            className={`p-1.5 transition-colors cursor-pointer ${settings.shuffle ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                            title="Shuffle"
                        >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
                            </svg>
                        </button>

                        {/* Loop */}
                        <button
                            onClick={() => player.toggleLoop()}
                            className={`p-1.5 transition-colors cursor-pointer ${settings.loop ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                            title="Loop"
                        >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
                            </svg>
                        </button>

                        {/* Fullscreen */}
                        {isVideo && (
                            <button onClick={toggleFullscreen} className="p-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer" title="Fullscreen">
                                {isFullscreen ? (
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                                    </svg>
                                ) : (
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                                    </svg>
                                )}
                            </button>
                        )}
                    </div>
                </div>

                {/* Now playing label */}
                <p className="text-xs text-zinc-500 mt-2 truncate">
                    {currentFile.relativePath}
                </p>
            </div>
        </div>
    );
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
