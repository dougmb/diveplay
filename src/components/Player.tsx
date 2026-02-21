// Player.tsx — Video/audio player with custom controls
import { useRef, useEffect, useCallback, useState } from 'react';
import { usePlayer } from '../store/playerStore';

export default function Player() {
    const player = usePlayer();
    const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
    const [blobUrl, setBlobUrl] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [subtitleTracks, setSubtitleTracks] = useState<Array<{ name: string; url: string }>>([]);
    const [hasAudioTrack, setHasAudioTrack] = useState(true);
    const [showNoAudioAlert, setShowNoAudioAlert] = useState(false);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const progressRef = useRef<HTMLDivElement | null>(null);
    // ✅ FIX 1: Ref para ignorar o onPause disparado automaticamente após ended
    const isEndedRef = useRef(false);

    const { currentFile, isPlaying, settings, duration, position } = player;

    // Carrega o arquivo como blob URL quando currentFile muda
    useEffect(() => {
        let cancelled = false;
        // Clean up when currentFile becomes null
        if (!currentFile) {
            setBlobUrl(null);
            setSubtitleTracks([]);
            return;
        }

        (async () => {
            try {
                const file = await currentFile.handle.getFile();
                const url = URL.createObjectURL(file);
                if (!cancelled) setBlobUrl(url);

                const tracks: Array<{ name: string; url: string }> = [];
                if (currentFile.subtitleHandles && currentFile.subtitleHandles.length > 0) {
                    for (const subtitleHandle of currentFile.subtitleHandles) {
                        const subtitleFile = await subtitleHandle.getFile();
                        const subtitleUrl = URL.createObjectURL(subtitleFile);
                        tracks.push({ name: subtitleHandle.name, url: subtitleUrl });
                    }
                }
                if (!cancelled) setSubtitleTracks(tracks);
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
            setSubtitleTracks((prev) => {
                prev.forEach(t => URL.revokeObjectURL(t.url));
                return [];
            });
        };
    }, [currentFile]);

    // Sync play/pause state
    useEffect(() => {
        const el = mediaRef.current;
        if (!el || !blobUrl) return;
        if (isPlaying) {
            el.play().catch(() => {
                player.setIsPlaying(false);
            });
        } else {
            el.pause();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPlaying, blobUrl]);

    // ✅ FIX 2: Effect duplicado de auto-play removido (causava race condition)

    // Sync volume & playback rate
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        el.volume = settings.volume;
        el.playbackRate = settings.playbackRate;
    }, [settings.volume, settings.playbackRate]);

    // Sync posição externa (para resume)
    useEffect(() => {
        const el = mediaRef.current;
        if (!el || !blobUrl) return;
        if (position > 0 && Math.abs(el.currentTime - position) > 1) {
            el.currentTime = position;
            if (isPlaying) {
                el.play().catch(() => { /* autoplay bloqueado */ });
            }
        }
    }, [position, blobUrl, isPlaying]);

    // Auto-hide controls
    const resetHideTimer = useCallback(() => {
        setShowControls(true);
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
            if (isPlaying) setShowControls(false);
        }, 3000);
    }, [isPlaying]);

    // Toggle functions
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

    // Sync play/pause state
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPlaying, settings.volume]);

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

        // Check if video has an audio track
        const audioTracks = (el as HTMLMediaElement & { audioTracks?: { length: number } }).audioTracks;
        if (audioTracks && audioTracks.length > 0) {
            setHasAudioTrack(true);
            setShowNoAudioAlert(false);
        } else if (audioTracks !== undefined) {
            setHasAudioTrack(false);
            setShowNoAudioAlert(true);
        }

        if (position > 0) {
            el.currentTime = position;
        }
        if (isPlaying) {
            el.play().catch(() => {
                player.setIsPlaying(false);
            });
        }
    };

    // ✅ FIX 3: handleEnded — sempre avança; loop/shuffle tratados no store
    const handleEnded = () => {
        isEndedRef.current = true;
        player.next();
    };

    // ✅ FIX 4: handlePause — ignora o pause automático do browser após ended
    const handlePause = () => {
        if (!isEndedRef.current) {
            player.setIsPlaying(false);
        }
        isEndedRef.current = false;
    };

    const handleProgressClick = (e: React.MouseEvent) => {
        const el = mediaRef.current;
        const bar = progressRef.current;
        if (!el || !bar) return;
        const rect = bar.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        el.currentTime = pct * (el.duration || 0);
    };

    const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    const cycleSpeed = () => {
        const currentIdx = speeds.indexOf(settings.playbackRate);
        const nextIdx = (currentIdx + 1) % speeds.length;
        player.setSpeed(speeds[nextIdx]);
    };

    if (!currentFile || !blobUrl) {
        return (
            <div className="flex items-center justify-center h-full text-zinc-500">
                Select a file to play
            </div>
        );
    }

    const progress = duration > 0 ? (player.position / duration) * 100 : 0;
    const isVideo = currentFile.type === 'video';

    const aspectRatioClass = {
        'auto': 'object-contain',
        'contain': 'object-contain',
        'cover': 'object-cover',
        'fill': 'object-fill',
        '16/9': 'aspect-video w-auto h-full',
        '4/3': 'aspect-[4/3] w-auto h-full',
    }[settings.aspectRatio] || 'object-contain';

    const cycleAspectRatio = () => {
        const ratios: Array<'auto' | 'contain' | 'cover' | 'fill' | '16/9' | '4/3'> = ['auto', 'contain', 'cover', 'fill', '16/9', '4/3'];
        const currentIdx = ratios.indexOf(settings.aspectRatio);
        const nextIdx = (currentIdx + 1) % ratios.length;
        player.setAspectRatio(ratios[nextIdx]);
    };

    return (
        <div
            ref={containerRef}
            className="relative w-full h-full bg-black flex flex-col select-none"
            onMouseMove={resetHideTimer}
            onMouseLeave={() => { if (isPlaying) setShowControls(false); }}
        >
            {/* Media element */}
            <div
                className="flex-1 flex items-center justify-center cursor-pointer"
                onClick={() => player.setIsPlaying(!isPlaying)}
            >
                {isVideo ? (
                    <video
                        key={currentFile.handle.name}
                        ref={mediaRef as React.RefObject<HTMLVideoElement>}
                        src={blobUrl}
                        className={`w-full h-full ${aspectRatioClass}`}
                        onTimeUpdate={handleTimeUpdate}
                        onLoadedMetadata={handleLoadedMetadata}
                        onEnded={handleEnded}
                        onPlay={() => player.setIsPlaying(true)}
                        onPause={handlePause}
                    >
                        {subtitleTracks.map((track, index) => (
                            <track
                                key={track.name}
                                kind="subtitles"
                                src={track.url}
                                label={track.name}
                                default={index === 0}
                            />
                        ))}
                    </video>
                ) : (
                    <>
                        {/* Audio visualizer placeholder */}
                        <div className="flex flex-col items-center gap-3 text-zinc-400 pointer-events-none">
                            <div className="w-32 h-32 rounded-2xl bg-zinc-800 flex items-center justify-center text-5xl">🎵</div>
                            <span className="text-lg font-semibold text-white">{currentFile.name}</span>
                            <span className="text-sm text-zinc-500">{currentFile.relativePath}</span>
                        </div>
                        <audio
                            ref={mediaRef as React.RefObject<HTMLAudioElement>}
                            src={blobUrl}
                            onTimeUpdate={handleTimeUpdate}
                            onLoadedMetadata={handleLoadedMetadata}
                            onEnded={handleEnded}
                            onPlay={() => player.setIsPlaying(true)}
                            onPause={handlePause}
                        />
                    </>
                )}
            </div>

            {/* Controls overlay */}
            <div
                className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-8 transition-opacity duration-300 ${showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
                    }`}
            >
                {/* No audio alert */}
                {showNoAudioAlert && (
                    <div className="absolute -top-12 left-0 right-0 px-4 py-2 bg-amber-900/80 text-amber-200 text-xs text-center">
                        ⚠️ Este vídeo não possui faixa de áudio suportada pelo navegador
                    </div>
                )}

                {/* Progress bar */}
                <div
                    ref={progressRef}
                    className="w-full h-1.5 bg-zinc-700 rounded-full mb-3 cursor-pointer hover:h-2.5 transition-all"
                    onClick={handleProgressClick}
                >
                    <div
                        className="h-full bg-indigo-500 rounded-full"
                        style={{ width: `${progress}%` }}
                    />
                </div>

                {/* All controls in one row - centered */}
                <div className="flex items-center justify-center gap-3 flex-wrap">

                    {/* Speed */}
                    <button
                        onClick={cycleSpeed}
                        className="px-2 py-1 text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer rounded hover:bg-white/10"
                        title="Playback speed"
                    >
                        {settings.playbackRate}x
                    </button>

                    {/* Prev */}
                    <button
                        onClick={() => player.prev()}
                        className="p-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                        title="Previous"
                    >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
                        </svg>
                    </button>

                    {/* Play/Pause */}
                    <button
                        onClick={() => player.setIsPlaying(!isPlaying)}
                        className="p-2 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                        title={isPlaying ? 'Pause' : 'Play'}
                    >
                        {isPlaying ? (
                            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                            </svg>
                        ) : (
                            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                        )}
                    </button>

                    {/* Next */}
                    <button
                        onClick={() => player.next()}
                        className="p-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                        title="Next"
                    >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 4V8l-5.5 4zM16 6h2v12h-2z" />
                        </svg>
                    </button>

                    {/* Volume */}
                    <div className="flex items-center gap-1 group/vol">
                        {!isVideo ? (
                            <button onClick={toggleMute} className="p-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer">
                                {isMuted || settings.volume === 0 ? (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
                                    </svg>
                                ) : settings.volume < 0.5 ? (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                                    </svg>
                                ) : (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                                    </svg>
                                )}
                            </button>
                        ) : !hasAudioTrack ? (
                            <span className="p-1.5 text-zinc-500" title="No audio track">
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M12 4L9.91 6.09 12 8.18V4zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9-4.73-4.73z" />
                                </svg>
                            </span>
                        ) : null}
                        {isVideo && hasAudioTrack && (
                            <button onClick={toggleMute} className="p-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer">
                                {isMuted || settings.volume === 0 ? (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
                                    </svg>
                                ) : settings.volume < 0.5 ? (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                                    </svg>
                                ) : (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                                    </svg>
                                )}
                            </button>
                        )}
                        {(isVideo && hasAudioTrack) && (
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={isMuted ? 0 : settings.volume}
                                onChange={(e) => {
                                    player.setVolume(parseFloat(e.target.value));
                                    if (isMuted) setIsMuted(false);
                                }}
                                className="w-20 h-1 accent-indigo-500 cursor-pointer opacity-0 group-hover/vol:opacity-100 transition-opacity"
                            />
                        )}
                    </div>

                    {/* Shuffle */}
                    <button
                        onClick={() => player.toggleShuffle()}
                        className={`p-1.5 transition-colors cursor-pointer ${settings.shuffle ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        title="Shuffle"
                    >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
                        </svg>
                    </button>

                    {/* Loop */}
                    <button
                        onClick={() => player.toggleLoop()}
                        className={`p-1.5 transition-colors cursor-pointer ${settings.loop ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        title="Loop playlist"
                    >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
                        </svg>
                    </button>

                    {/* Aspect Ratio */}
                    {isVideo && (
                        <button
                            onClick={cycleAspectRatio}
                            className="px-2 py-1 text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer rounded hover:bg-white/10"
                            title="Aspect ratio"
                        >
                            {settings.aspectRatio}
                        </button>
                    )}

                    {/* Fullscreen */}
                    {isVideo && (
                        <button
                            onClick={toggleFullscreen}
                            className="p-1.5 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                            title="Fullscreen"
                        >
                            {isFullscreen ? (
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                                </svg>
                            ) : (
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                                </svg>
                            )}
                        </button>
                    )}
                </div>

                {/* Time display */}
                <div className="flex items-center justify-center mt-2">
                    <span className="text-xs text-zinc-400 tabular-nums">
                        {formatTime(player.position)} / {formatTime(duration)}
                    </span>
                </div>

                {/* Now playing label */}
                <p className="text-xs text-zinc-500 truncate mt-2" title={currentFile.relativePath}>
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
