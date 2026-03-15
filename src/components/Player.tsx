// Player.tsx — Video/audio player with custom controls
import { useRef, useEffect, useCallback, useState } from 'react';
import { usePlayer } from '../store/playerStore';
import { ensurePlayable, getMediaInfo } from '../services/codecService';
import { getTauriAPI, isTauri } from '../services/tauri';
import type { MediaInfo } from '../types';

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
    const [mediaError, setMediaError] = useState<string | null>(null);
    const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
    const [selectedAudioTrack, setSelectedAudioTrack] = useState<number>(0);
    const [showTrackMenu, setShowTrackMenu] = useState(false);
    const [transcodeSeekTime, setTranscodeSeekTime] = useState<number>(0);
    
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const progressRef = useRef<HTMLDivElement | null>(null);
    const isEndedRef = useRef(false);

    const { currentFile, isPlaying, settings, duration, position } = player;

    // Sync duration from mediaInfo when it becomes available
    useEffect(() => {
        if (mediaInfo?.format.duration) {
            const dur = parseFloat(mediaInfo.format.duration);
            if (!isNaN(dur) && dur > 0) {
                player.setDuration(dur);
            }
        }
    }, [mediaInfo]);

    // Clear media error when file changes
    useEffect(() => { 
        setMediaError(null); 
        setMediaInfo(null);
        setSelectedAudioTrack(0);
        setShowTrackMenu(false);
        setTranscodeSeekTime(0);
    }, [currentFile]);

    // Called when the browser can't decode the file
    const handleMediaError = useCallback((e: React.SyntheticEvent<HTMLMediaElement>) => {
        const el = e.currentTarget;
        const code = el.error?.code;

        if (code) {
            console.error('Media error code:', code, 'Source:', el.src);
            if (isTauri()) {
                setMediaError(
                    'Failed to play this file. This usually happens if FFmpeg transcoding failed ' +
                    'or if the file is not accessible. Check the logs for details.'
                );
            } else {
                setMediaError(
                    'This codec or container (e.g. MKV, HEVC, AC3) is not supported by your browser directly. ' +
                    'Use the desktop version for full compatibility.'
                );
            }
        }
    }, []);

    // Load file
    useEffect(() => {
        let cancelled = false;

        if (!currentFile) {
            setBlobUrl(null);
            setSubtitleTracks([]);
            return;
        }

        (async () => {
            try {
                let info: MediaInfo | null = null;
                if (isTauri() && currentFile.nativePath) {
                    info = await getMediaInfo(currentFile.nativePath);
                    if (!cancelled) setMediaInfo(info);
                }

                // Check if we need transcoding (HEVC/AC3/DTS/TrueHD)
                const isHEVC = info?.streams.some(s => s.codec_name === 'hevc' || s.codec_name === 'h265');
                const isUnsupportedAudio = info?.streams.some(s => 
                    s.codec_type === 'audio' && 
                    ['ac3', 'eac3', 'dca', 'dts', 'mlp', 'truehd', 'a52'].includes(s.codec_name.toLowerCase())
                );
                
                // Also transcode if it's an MKV, as browsers have spotty support for MKV containers with certain streams
                const isMKV = currentFile.name.toLowerCase().endsWith('.mkv');
                
                const shouldTranscode = isTauri() && (isHEVC || isUnsupportedAudio || isMKV);

                const { url } = await ensurePlayable(currentFile, {
                    transcode: shouldTranscode,
                    audioTrack: selectedAudioTrack,
                    startTime: transcodeSeekTime
                });

                if (cancelled) {
                    URL.revokeObjectURL(url);
                    return;
                }

                setBlobUrl(url);

                // Load subtitles — use data: URLs so Chrome doesn't block blob:null on <track>
                const tracks: Array<{ name: string; url: string }> = [];
                if (currentFile.subtitleHandles && currentFile.subtitleHandles.length > 0) {
                    const api = await getTauriAPI();
                    for (const handleOrPath of currentFile.subtitleHandles) {
                        let text = '';
                        let name = '';
                        
                        if (typeof handleOrPath === 'string') {
                            if (api) {
                                const contents = await api.readFile(handleOrPath);
                                text = new TextDecoder().decode(contents);
                                const lastSlash = Math.max(handleOrPath.lastIndexOf('/'), handleOrPath.lastIndexOf('\\'));
                                name = handleOrPath.slice(lastSlash + 1);
                            }
                        } else {
                            const subtitleFile = await handleOrPath.getFile();
                            text = await subtitleFile.text();
                            name = handleOrPath.name;
                        }

                        if (text) {
                            const vtt = toVtt(text, name);
                            const url = `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;
                            tracks.push({ name, url });
                        }
                    }
                }
                if (!cancelled) setSubtitleTracks(tracks);
            } catch (err) {
                if (!cancelled) {
                    console.error('Failed to load file:', err);
                    setMediaError('Failed to load file. The format may be unsupported.');
                }
            }
        })();

        return () => {
            cancelled = true;
            setBlobUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return null;
            });
            setSubtitleTracks([]);
        };
    }, [currentFile, selectedAudioTrack, transcodeSeekTime]);

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

    // Sync volume & playback rate
    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;
        el.volume = settings.volume;
        el.playbackRate = settings.playbackRate;
    }, [settings.volume, settings.playbackRate]);

    // Sync position
    useEffect(() => {
        const el = mediaRef.current;
        if (!el || !blobUrl) return;

        // If transcoding, the element's 0 is actually transcodeSeekTime
        const targetTime = Math.max(0, position - transcodeSeekTime);

        if (position > 0 && Math.abs(el.currentTime - targetTime) > 1.5) {
            el.currentTime = targetTime;
            if (isPlaying) {
                el.play().catch(() => { /* autoplay blocked */ });
            }
        }
    }, [position, blobUrl, isPlaying, transcodeSeekTime]);

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
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else {
                await container.requestFullscreen();
            }
        } catch (err) {
            console.warn('Fullscreen toggle failed:', err);
        }
    };

    useEffect(() => {
        const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    // Key handlers
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
        
        // If we are transcoding, the actual position is the seek offset + current video time
        const actualPosition = transcodeSeekTime + el.currentTime;
        player.setPosition(actualPosition);
    };

    const handleLoadedMetadata = () => {
        const el = mediaRef.current;
        if (!el) return;
        
        // Use mediaInfo duration if available
        if (mediaInfo?.format.duration) {
            const dur = parseFloat(mediaInfo.format.duration);
            if (!isNaN(dur) && dur > 0) {
                player.setDuration(dur);
            } else {
                player.setDuration(el.duration);
            }
        } else {
            // If transcoding, the el.duration will only show the duration from the seek point to end
            // so we should only trust it if not transcoding or if we don't have mediaInfo
            const isTranscoding = transcodeSeekTime > 0;
            if (!isTranscoding) {
                player.setDuration(el.duration);
            }
        }

        el.volume = settings.volume;
        el.playbackRate = settings.playbackRate;

        // Simple audio track check
        const audioTracks = (el as HTMLMediaElement & { audioTracks?: { length: number } }).audioTracks;
        if (audioTracks && audioTracks.length > 0) {
            setHasAudioTrack(true);
            setShowNoAudioAlert(false);
        } else if (audioTracks !== undefined) {
            setHasAudioTrack(false);
            setShowNoAudioAlert(true);
        }

        if (position > 0) {
            el.currentTime = Math.max(0, position - transcodeSeekTime);
        }
        if (isPlaying) {
            el.play().catch(() => {
                player.setIsPlaying(false);
            });
        }
    };

    const handleEnded = () => {
        isEndedRef.current = true;
        player.next();
    };

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
        const newTime = pct * (duration || 0);

        // Check if we are currently transcoding
        const isHEVC = mediaInfo?.streams.some(s => s.codec_name === 'hevc' || s.codec_name === 'h265');
        const isUnsupportedAudio = mediaInfo?.streams.some(s => 
            s.codec_type === 'audio' && 
            ['ac3', 'eac3', 'dca', 'dts', 'mlp', 'truehd', 'a52'].includes(s.codec_name.toLowerCase())
        );
        const isMKV = currentFile?.name.toLowerCase().endsWith('.mkv');
        const shouldTranscode = isTauri() && (isHEVC || isUnsupportedAudio || isMKV);

        if (shouldTranscode) {
            // Stop current playback and clear source to prevent buffer loops
            if (el) {
                el.pause();
                el.src = '';
                el.load();
            }
            
            player.setPosition(newTime);
            setTranscodeSeekTime(newTime);
        } else {
            el.currentTime = newTime;
            player.setPosition(newTime);
        }
    };

    const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    const cycleSpeed = () => {
        const currentIdx = speeds.indexOf(settings.playbackRate);
        const nextIdx = (currentIdx + 1) % speeds.length;
        player.setSpeed(speeds[nextIdx]);
    };

    if (!currentFile) {
        return (
            <div className="flex items-center justify-center h-full text-zinc-500">
                Select a file to play
            </div>
        );
    }

    if (!blobUrl && !mediaError) {
        return (
            <div className="flex items-center justify-center h-full text-zinc-500">
                Loading...
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

    const audioStreams = mediaInfo?.streams.filter(s => s.codec_type === 'audio') || [];

    return (
        <div
            ref={containerRef}
            className="relative w-full h-full bg-black flex flex-col select-none"
            onMouseMove={resetHideTimer}
            onMouseLeave={() => { if (isPlaying) setShowControls(false); }}
        >
            {/* Top info overlay */}
            <div className={`absolute top-0 left-0 right-0 p-6 bg-gradient-to-b from-black/60 to-transparent pointer-events-none transition-opacity duration-300 z-10 ${showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
                }`}>
                <h1 className="text-sm font-medium text-zinc-100 drop-shadow-lg truncate max-w-2xl" title={currentFile.relativePath}>
                    {currentFile.name}
                </h1>
            </div>

            {/* Media element */}
            <div
                className="flex-1 flex items-center justify-center cursor-pointer"
                onClick={() => player.setIsPlaying(!isPlaying)}
            >
                {isVideo ? (
                    <>
                        <video
                            key={`${currentFile.nativePath || currentFile.relativePath}-${selectedAudioTrack}-${transcodeSeekTime}`}
                            ref={mediaRef as React.RefObject<HTMLVideoElement>}
                            src={blobUrl || ''}
                            className={`w-full h-full ${aspectRatioClass}`}
                            onTimeUpdate={handleTimeUpdate}
                            onLoadedMetadata={handleLoadedMetadata}
                            onEnded={handleEnded}
                            onPlay={() => player.setIsPlaying(true)}
                            onPause={handlePause}
                            onError={handleMediaError}
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
                        {mediaError && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 pointer-events-none">
                                <svg className="w-10 h-10 text-amber-500/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                                </svg>
                                <p className="text-sm text-zinc-300 text-center max-w-sm">{mediaError}</p>
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <div className="flex flex-col items-center gap-3 text-zinc-400 pointer-events-none">
                            <div className="w-32 h-32 rounded-2xl bg-zinc-800 flex items-center justify-center text-5xl">🎵</div>
                            <span className="text-lg font-semibold text-white">{currentFile.name}</span>
                            <span className="text-sm text-zinc-500">{currentFile.relativePath}</span>
                        </div>
                        <audio
                            ref={mediaRef as React.RefObject<HTMLAudioElement>}
                            src={blobUrl || ''}
                            onTimeUpdate={handleTimeUpdate}
                            onLoadedMetadata={handleLoadedMetadata}
                            onEnded={handleEnded}
                            onPlay={() => player.setIsPlaying(true)}
                            onPause={handlePause}
                            onError={handleMediaError}
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
                        ⚠️ No supported audio track detected in this video
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
                <div className="flex items-center justify-center gap-3">
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

                    {/* Time display */}
                    <span className="text-xs text-zinc-400 tabular-nums px-1">
                        {formatTime(player.position)} / {formatTime(duration)}
                    </span>

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

                    {/* Track Selection Menu Trigger */}
                    {isTauri() && audioStreams.length > 0 && (
                        <div className="relative">
                            <button
                                onClick={() => setShowTrackMenu(!showTrackMenu)}
                                className={`px-2 py-1 text-xs transition-colors cursor-pointer rounded hover:bg-white/10 ${showTrackMenu ? 'text-indigo-400' : 'text-zinc-400'}`}
                                title="Audio Tracks"
                            >
                                Track {selectedAudioTrack + 1}
                            </button>
                            
                            {showTrackMenu && (
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-20">
                                    <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-800/50">
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Audio Tracks</span>
                                    </div>
                                    <div className="max-h-48 overflow-y-auto">
                                        {audioStreams.map((stream, idx) => (
                                            <button
                                                key={stream.index}
                                                onClick={() => {
                                                    setSelectedAudioTrack(idx);
                                                    setShowTrackMenu(false);
                                                }}
                                                className={`w-full text-left px-3 py-2 text-xs transition-colors hover:bg-zinc-800 ${selectedAudioTrack === idx ? 'text-indigo-400 bg-indigo-500/10' : 'text-zinc-300'}`}
                                            >
                                                {stream.tags?.language || 'Unknown'} ({stream.codec_name})
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

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

function toVtt(content: string, filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'vtt') return content;
    if (ext === 'srt') {
        const normalised = content.trim().replace(/\r\n|\r/g, '\n');
        const fixed = normalised.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
        return 'WEBVTT\n\n' + fixed;
    }
    return content;
}
