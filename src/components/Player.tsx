// Player.tsx — Video/audio player with custom controls
import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { usePlayer } from '../store/playerStore';
import { ensurePlayable, getMediaInfo } from '../services/codecService';
import { getTauriAPI, isTauri } from '../services/tauri';
import { capabilities } from '../platform/capabilities';
import { loadAppSettings } from '../services/db';
import { parseSubtitleCues, getActiveCue, decodeSubtitleBytes } from '../utils/subtitleParser';
import type { SubtitleCue } from '../utils/subtitleParser';
import type { MediaFile, MediaInfo, AppSettings } from '../types';

interface SubtitleTrack {
    name: string;
    cues: SubtitleCue[];
    source: 'local' | 'url' | 'opensub';
}

export default function Player() {
    const player = usePlayer();
    const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
    const [blobUrl, setBlobUrl] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
    const [selectedSubtitleTrack, setSelectedSubtitleTrack] = useState(0);
    const subtitleFileInputRef = useRef<HTMLInputElement | null>(null);
    const [isLoadingSubtitle, setIsLoadingSubtitle] = useState(false);
    const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
    const [hasAudioTrack, setHasAudioTrack] = useState(true);
    const [showNoAudioAlert, setShowNoAudioAlert] = useState(false);
    const [mediaError, setMediaError] = useState<string | null>(null);
    const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
    const [selectedAudioTrack, setSelectedAudioTrack] = useState<number>(0);
    const [showTrackMenu, setShowTrackMenu] = useState(false);
    const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
    const subtitleMenuRef = useRef<HTMLDivElement | null>(null);
    const [transcodeSeekTime, setTranscodeSeekTime] = useState<number>(0);
    const [skipCountdown, setSkipCountdown] = useState<number | null>(null);
    const [seekFeedback, setSeekFeedback] = useState<{ dir: 'fwd' | 'bwd'; seconds: number; n: number } | null>(null);
    const [volumeFeedback, setVolumeFeedback] = useState<{ pct: number; n: number } | null>(null);

    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const progressRef = useRef<HTMLDivElement | null>(null);
    const isEndedRef = useRef(false);
    const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const keyRepeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const seekFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const volumeFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const holdAccumRef = useRef(0);
    const holdFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const seekContextRef = useRef<{ mediaInfo: MediaInfo | null; transcodeSeekTime: number; currentFile: MediaFile | null; duration: number }>({
        mediaInfo: null, transcodeSeekTime: 0, currentFile: null, duration: 0,
    });
    // True while a file is loading (between effect start and loadedmetadata) — suppresses
    // spurious 'pause' DOM events that fire during src transitions.
    const isLoadingRef = useRef(false);

    const { currentFile, isPlaying, settings, duration, position } = player;

    // Load app settings (API keys, subtitle language) once on mount
    useEffect(() => {
        loadAppSettings().then(setAppSettings).catch(() => {});
    }, []);

    // Sync duration from mediaInfo when it becomes available
    useEffect(() => {
        if (mediaInfo?.format.duration) {
            const dur = parseFloat(mediaInfo.format.duration);
            if (!isNaN(dur) && dur > 0) {
                player.setDuration(dur);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaInfo]);

    // Clear media error and skip countdown when file changes
    useEffect(() => {
        setMediaError(null);
        setMediaInfo(null);
        setSelectedAudioTrack(0);
        setShowTrackMenu(false);
        setTranscodeSeekTime(0);
        setSkipCountdown(null);
        setHasAudioTrack(true);
        setShowNoAudioAlert(false);
        setSelectedSubtitleTrack(0);
        isEndedRef.current = false;
    }, [currentFile]);

    // Auto-skip countdown on media error
    useEffect(() => {
        if (skipCountdown === null) return;
        if (skipCountdown === 0) {
            player.next();
            return;
        }
        const timer = setTimeout(() => setSkipCountdown(c => c !== null ? c - 1 : null), 1000);
        return () => clearTimeout(timer);
    }, [skipCountdown, player]);

    // Called when the browser can't decode the file
    const handleMediaError = useCallback((e: React.SyntheticEvent<HTMLMediaElement>) => {
        const el = e.currentTarget;
        const code = el.error?.code;

        if (code) {
            console.error('Media error code:', code, 'Source:', el.src);
            if (capabilities.hasNativeLogs) {
                setMediaError(
                    'Failed to play this file. FFmpeg transcoding may have failed or the file is inaccessible.'
                );
            } else {
                setMediaError(
                    'Format not supported by your browser. Supported: .mp4, .webm (video) · .mp3, .aac, .flac, .wav, .ogg, .m4a (audio).'
                );
            }
            setSkipCountdown(8);
        }
    }, []);

    // Load file
    useEffect(() => {
        let cancelled = false;
        isLoadingRef.current = true;

        if (!currentFile) {
            setBlobUrl(null);
            setSubtitleTracks([]);
            isLoadingRef.current = false;
            return;
        }

        (async () => {
            try {
                let info: MediaInfo | null = null;
                if (capabilities.canTranscode && currentFile.nativePath) {
                    info = await getMediaInfo(currentFile.nativePath);
                    if (!cancelled) setMediaInfo(info);
                }

                const shouldTranscode = capabilities.canTranscode && needsTranscoding(info, currentFile.name);

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

                // Load subtitles — parse to cues for custom renderer
                const tracks: SubtitleTrack[] = [];
                if (currentFile.subtitleHandles && currentFile.subtitleHandles.length > 0) {
                    const api = await getTauriAPI();
                    for (const handleOrPath of currentFile.subtitleHandles) {
                        let text = '';
                        let name = '';

                        if (typeof handleOrPath === 'string') {
                            if (api) {
                                const contents = await api.readFile(handleOrPath);
                                text = decodeSubtitleBytes(contents);
                                const lastSlash = Math.max(handleOrPath.lastIndexOf('/'), handleOrPath.lastIndexOf('\\'));
                                name = handleOrPath.slice(lastSlash + 1);
                            }
                        } else {
                            const subtitleFile = await handleOrPath.getFile();
                            const buffer = await subtitleFile.arrayBuffer();
                            text = decodeSubtitleBytes(new Uint8Array(buffer));
                            name = handleOrPath.name;
                        }

                        if (text) {
                            tracks.push({ name, cues: parseSubtitleCues(text, name), source: 'local' });
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
            isLoadingRef.current = false;
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
            el.play().catch((err: unknown) => {
                // AbortError = play() interrupted by a new load — loadedmetadata will retry
                if (err instanceof DOMException && err.name !== 'AbortError') {
                    player.setIsPlaying(false);
                }
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

    const handleContainerClick = useCallback(() => {
        if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
            return;
        }
        clickTimerRef.current = setTimeout(() => {
            clickTimerRef.current = null;
            player.setIsPlaying(!isPlaying);
        }, 300);
    }, [isPlaying, player]);

    const handleContainerDoubleClick = useCallback(() => {
        if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
        }
        toggleFullscreen();
    }, []);

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

    // Close subtitle menu on outside click
    useEffect(() => {
        if (!showSubtitleMenu) return;
        const handler = (e: MouseEvent) => {
            if (subtitleMenuRef.current && !subtitleMenuRef.current.contains(e.target as Node)) {
                setShowSubtitleMenu(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showSubtitleMenu]);

    // Key handlers
    useEffect(() => {
        const showSeekFb = (dir: 'fwd' | 'bwd') => {
            setSeekFeedback(prev => ({
                dir,
                seconds: prev && prev.dir === dir ? prev.seconds + 10 : 10,
                n: Date.now(),
            }));
            if (seekFeedbackTimerRef.current) clearTimeout(seekFeedbackTimerRef.current);
            seekFeedbackTimerRef.current = setTimeout(() => setSeekFeedback(null), 800);
        };

        const showVolFb = (vol: number) => {
            setVolumeFeedback({ pct: Math.round(vol * 100), n: Date.now() });
            if (volumeFeedbackTimerRef.current) clearTimeout(volumeFeedbackTimerRef.current);
            volumeFeedbackTimerRef.current = setTimeout(() => setVolumeFeedback(null), 1000);
        };

        const flushTranscodeSeek = (accum: number) => {
            const c = seekContextRef.current;
            const el = mediaRef.current;
            const actualPos = c.transcodeSeekTime + (el?.currentTime ?? 0);
            const newTime = Math.max(0, Math.min(c.duration || 0, actualPos + accum));
            isLoadingRef.current = true;
            if (el) { el.pause(); el.src = ''; el.load(); }
            player.setPosition(newTime);
            setTranscodeSeekTime(newTime);
        };

        const seekBy = (delta: number) => {
            const c = seekContextRef.current;
            const el = mediaRef.current;
            showSeekFb(delta > 0 ? 'fwd' : 'bwd');
            const shouldTranscode = capabilities.canTranscode && needsTranscoding(c.mediaInfo, c.currentFile?.name ?? '');
            if (shouldTranscode) {
                holdAccumRef.current += delta;
                if (holdFlushTimerRef.current) clearTimeout(holdFlushTimerRef.current);
                holdFlushTimerRef.current = setTimeout(() => {
                    const accum = holdAccumRef.current;
                    holdAccumRef.current = 0;
                    holdFlushTimerRef.current = null;
                    flushTranscodeSeek(accum);
                }, 350);
            } else {
                if (!el) return;
                el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + delta));
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    player.setIsPlaying(!isPlaying);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    seekBy(-10);
                    if (!e.repeat) {
                        clearKeyRepeat();
                        keyRepeatTimerRef.current = setInterval(() => seekBy(-10), 500);
                    }
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    seekBy(10);
                    if (!e.repeat) {
                        clearKeyRepeat();
                        keyRepeatTimerRef.current = setInterval(() => seekBy(10), 500);
                    }
                    break;
                case 'ArrowUp': {
                    e.preventDefault();
                    const newVol = Math.min(1, settings.volume + 0.10);
                    player.setVolume(newVol);
                    showVolFb(newVol);
                    break;
                }
                case 'ArrowDown': {
                    e.preventDefault();
                    const newVol = Math.max(0, settings.volume - 0.10);
                    player.setVolume(newVol);
                    showVolFb(newVol);
                    break;
                }
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

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
                clearKeyRepeat();
                // Flush accumulated transcoded seek immediately on release
                if (holdFlushTimerRef.current) {
                    clearTimeout(holdFlushTimerRef.current);
                    holdFlushTimerRef.current = null;
                    const accum = holdAccumRef.current;
                    holdAccumRef.current = 0;
                    if (accum !== 0) flushTranscodeSeek(accum);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPlaying, settings.volume]);

    const clearKeyRepeat = useCallback(() => {
        if (keyRepeatTimerRef.current) {
            clearInterval(keyRepeatTimerRef.current);
            keyRepeatTimerRef.current = null;
        }
    }, []);

    const handleTimeUpdate = () => {
        const el = mediaRef.current;
        if (!el) return;
        
        // If we are transcoding, the actual position is the seek offset + current video time
        const actualPosition = transcodeSeekTime + el.currentTime;
        player.setPosition(actualPosition);

        // Auto-advance if we're at the end (for streams that don't trigger onEnded)
        if (duration > 0 && actualPosition >= duration - 0.5 && !isEndedRef.current) {
            isEndedRef.current = true;
            player.next();
        }
    };

    const handleLoadedMetadata = () => {
        isLoadingRef.current = false;
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

        // Audio track detection — prefer mediaInfo (Tauri) over the audioTracks API
        // because Chrome/Edge don't expose audioTracks on HTMLMediaElement.
        if (mediaInfo) {
            const audioStreams = mediaInfo.streams.filter(s => s.codec_type === 'audio');
            const hasAudio = audioStreams.length > 0;
            setHasAudioTrack(hasAudio);
            if (!hasAudio && mediaInfo.streams.some(s => s.codec_type === 'video')) {
                setShowNoAudioAlert(true);
            }
        } else {
            // Fallback for web mode — audioTracks is supported in Firefox but not Chrome
            const audioTracks = (el as HTMLMediaElement & { audioTracks?: { length: number } }).audioTracks;
            if (audioTracks && audioTracks.length > 0) {
                setHasAudioTrack(true);
                setShowNoAudioAlert(false);
            } else if (audioTracks !== undefined) {
                setHasAudioTrack(false);
                setShowNoAudioAlert(true);
            }
        }

        if (position > 0) {
            el.currentTime = Math.max(0, position - transcodeSeekTime);
        }
        if (isPlaying) {
            el.play().catch((err: unknown) => {
                if (err instanceof DOMException && err.name !== 'AbortError') {
                    player.setIsPlaying(false);
                }
            });
        }
    };

    const handleEnded = () => {
        isEndedRef.current = true;
        player.next();
    };

    const handlePause = () => {
        // Ignore spurious 'pause' DOM events during file transitions:
        // 1. blobUrl=null  → src just cleared during cleanup
        // 2. isLoadingRef  → file is still loading (metadata not yet received)
        if (!blobUrl || isLoadingRef.current) return;
        if (!isEndedRef.current) {
            player.setIsPlaying(false);
        }
        isEndedRef.current = false;
    };

    const handleProgressClick = (e: React.MouseEvent) => {
        e.stopPropagation(); // prevent bubbling to container (would toggle play/pause)
        const el = mediaRef.current;
        const bar = progressRef.current;
        if (!el || !bar) return;
        const rect = bar.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        const newTime = pct * (duration || 0);

        const shouldTranscode = capabilities.canTranscode && needsTranscoding(mediaInfo, currentFile?.name ?? '');

        if (shouldTranscode) {
            isLoadingRef.current = true;
            el.pause();
            el.src = '';
            el.load();
            player.setPosition(newTime);
            setTranscodeSeekTime(newTime);
        } else {
            el.currentTime = newTime;
            player.setPosition(newTime);
            // Resume playback if it was playing (setting currentTime can pause briefly)
            if (isPlaying) {
                el.play().catch(() => {});
            }
        }
    };

    // Active subtitle cue — applied at query time so offset changes don't require re-parse
    const activeCue = useMemo(() => {
        if (!settings.subtitles.enabled || subtitleTracks.length === 0) return null;
        const track = subtitleTracks[selectedSubtitleTrack];
        if (!track) return null;
        return getActiveCue(track.cues, position, settings.subtitles.offset);
    }, [position, subtitleTracks, selectedSubtitleTrack, settings.subtitles.enabled, settings.subtitles.offset]);

    // Auto-search subtitles via OpenSubtitles when a new file loads and API key is set
    useEffect(() => {
        if (!currentFile || !appSettings?.openSubtitlesApiKey) return;

        const apiKey = appSettings.openSubtitlesApiKey;
        const lang = appSettings.subtitleLanguage || 'en';
        const query = cleanFilename(currentFile.name);
        if (!query) return;

        let cancelled = false;
        setIsLoadingSubtitle(true);

        (async () => {
            try {
                const searchRes = await fetch(
                    `https://api.opensubtitles.com/api/v1/subtitles?query=${encodeURIComponent(query)}&languages=${lang}&per_page=3`,
                    { headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' } }
                );
                if (!searchRes.ok || cancelled) return;

                const searchData = await searchRes.json() as {
                    data: Array<{ attributes: { files: Array<{ file_id: number; file_name: string }> } }>;
                };
                const firstResult = searchData.data?.[0];
                const fileId = firstResult?.attributes?.files?.[0]?.file_id;
                const fileName = firstResult?.attributes?.files?.[0]?.file_name ?? 'subtitle.srt';
                if (!fileId || cancelled) return;

                const dlRes = await fetch('https://api.opensubtitles.com/api/v1/download', {
                    method: 'POST',
                    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ file_id: fileId }),
                });
                if (!dlRes.ok || cancelled) return;

                const dlData = await dlRes.json() as { link: string };
                if (!dlData.link || cancelled) return;

                // Validate download URL — must be HTTPS and not an internal address (SSRF guard)
                try {
                    const dlUrl = new URL(dlData.link);
                    if (dlUrl.protocol !== 'https:') return;
                    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(dlUrl.hostname)) return;
                } catch { return; }

                const subRes = await fetch(dlData.link);
                if (!subRes.ok || cancelled) return;

                const text = await subRes.text();
                if (cancelled) return;

                const cues = parseSubtitleCues(text, fileName);
                if (cues.length > 0) {
                    setSubtitleTracks(prev => {
                        const filtered = prev.filter(t => t.source !== 'opensub');
                        return [{ name: `Auto: ${fileName}`, cues, source: 'opensub' }, ...filtered];
                    });
                    setSelectedSubtitleTrack(0);
                }
            } catch (err) {
                if (!cancelled) console.warn('OpenSubtitles search failed:', err);
            } finally {
                if (!cancelled) setIsLoadingSubtitle(false);
            }
        })();

        return () => { cancelled = true; setIsLoadingSubtitle(false); };
    }, [currentFile, appSettings]);

    // Load subtitle from local file (web: file input, Tauri: native dialog)
    const handlePickSubtitleFile = useCallback(async () => {
        if (isTauri()) {
            const api = await getTauriAPI();
            if (!api) return;
            setIsLoadingSubtitle(true);
            try {
                const selected = await api.open({
                    multiple: false,
                    filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'sub', 'ass', 'ssa'] }],
                });
                if (!selected) return;
                const path = selected as string;
                const contents = await api.readFile(path);
                const text = decodeSubtitleBytes(contents);
                const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
                const name = path.slice(lastSlash + 1);
                const cues = parseSubtitleCues(text, name);
                if (cues.length > 0) {
                    setSubtitleTracks(prev => [...prev, { name, cues, source: 'url' }]);
                    setSelectedSubtitleTrack(prev => prev); // keep selection or let user pick
                }
            } catch (err) {
                console.error('Failed to load subtitle file:', err);
            } finally {
                setIsLoadingSubtitle(false);
            }
        } else {
            subtitleFileInputRef.current?.click();
        }
    }, []);

    const handleSubtitleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setIsLoadingSubtitle(true);
        try {
            const buffer = await file.arrayBuffer();
            const text = decodeSubtitleBytes(new Uint8Array(buffer));
            const cues = parseSubtitleCues(text, file.name);
            if (cues.length > 0) {
                setSubtitleTracks(prev => [...prev, { name: file.name, cues, source: 'url' }]);
                setSelectedSubtitleTrack(subtitleTracks.length);
            }
        } catch (err) {
            console.error('Failed to read subtitle file:', err);
        } finally {
            setIsLoadingSubtitle(false);
            e.target.value = '';
        }
    }, [subtitleTracks.length]);

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

    // Keep seekContextRef in sync — read by key handler without stale closures
    seekContextRef.current = { mediaInfo, transcodeSeekTime, currentFile, duration };

    const progress = duration > 0 ? (player.position / duration) * 100 : 0;
    const isVideo = currentFile.type === 'video';

    const aspectRatioClass = {
        'auto':    'w-full h-full object-contain',
        'contain': 'w-full h-full object-contain',
        'cover':   'w-full h-full object-cover',
        'fill':    'w-full h-full object-fill',
        '16/9':    'h-full w-auto max-w-full aspect-video object-fill',
        '4/3':     'h-full w-auto max-w-full aspect-[4/3] object-fill',
    }[settings.aspectRatio] ?? 'w-full h-full object-contain';

    const cycleAspectRatio = () => {
        const ratios: Array<'auto' | 'contain' | 'cover' | 'fill' | '16/9' | '4/3'> = ['auto', 'contain', 'cover', 'fill', '16/9', '4/3'];
        const currentIdx = ratios.indexOf(settings.aspectRatio);
        const nextIdx = (currentIdx + 1) % ratios.length;
        player.setAspectRatio(ratios[nextIdx]);
    };

    const audioStreams = mediaInfo?.streams.filter(s => s.codec_type === 'audio') || [];

    const handleOffsetChange = (delta: number) => {
        player.setSubtitleOffset(settings.subtitles.offset + delta);
    };

    return (
        <div
            ref={containerRef}
            className="relative w-full h-full bg-black flex flex-col select-none"
            onClick={handleContainerClick}
            onDoubleClick={handleContainerDoubleClick}
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
            <div className="flex-1 flex items-center justify-center cursor-pointer">
                {isVideo ? (
                    <>
                        <video
                            key={`${currentFile.nativePath || currentFile.relativePath}-${selectedAudioTrack}`}
                            ref={mediaRef as React.RefObject<HTMLVideoElement>}
                            src={blobUrl || ''}
                            className={aspectRatioClass}
                            onTimeUpdate={handleTimeUpdate}
                            onLoadedMetadata={handleLoadedMetadata}
                            onEnded={handleEnded}
                            onPlay={() => player.setIsPlaying(true)}
                            onPause={handlePause}
                            onError={handleMediaError}
                        />
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

            {/* Unsupported file error overlay */}
            {mediaError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 z-20">
                    <svg className="w-10 h-10 text-amber-500/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                    </svg>
                    <p className="text-sm text-zinc-300 text-center max-w-sm">{mediaError}</p>
                    <div className="flex flex-col items-center gap-2">
                        <button
                            onClick={(e) => { e.stopPropagation(); player.next(); }}
                            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors cursor-pointer"
                        >
                            Skip now
                        </button>
                        {skipCountdown !== null && (
                            <p className="text-xs text-zinc-500">Skipping in {skipCountdown}s...</p>
                        )}
                    </div>
                </div>
            )}

            {/* Subtitle overlay */}
            {settings.subtitles.enabled && activeCue && (
                <div className="absolute bottom-20 inset-x-0 flex justify-center pointer-events-none z-5 px-8">
                    <span
                        style={{
                            fontSize: `${settings.subtitles.fontSize}px`,
                            color: settings.subtitles.color,
                            backgroundColor: `rgba(0,0,0,${settings.subtitles.bgOpacity})`,
                            padding: '2px 10px',
                            borderRadius: '4px',
                            textAlign: 'center',
                            lineHeight: 1.4,
                            maxWidth: '80%',
                            display: 'inline-block',
                            whiteSpace: 'pre-wrap',
                        }}
                        dangerouslySetInnerHTML={{ __html: activeCue.text }}
                    />
                </div>
            )}

            {/* Seek feedback overlay */}
            {seekFeedback && (
                <div
                    key={seekFeedback.n}
                    className="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
                >
                    <div
                        className="bg-black/70 rounded-2xl px-8 py-4 flex items-center gap-3 text-white"
                        style={{ animation: 'seekFlash 0.8s ease-out forwards' }}
                    >
                        <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                            {seekFeedback.dir === 'fwd'
                                ? <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
                                : <path d="M11 18V6l-8.5 6L11 18zm.5-6 8.5 6V6l-8.5 6z" />
                            }
                        </svg>
                        <span className="text-2xl font-bold tabular-nums">
                            {seekFeedback.dir === 'fwd' ? '+' : '-'}{seekFeedback.seconds}s
                        </span>
                    </div>
                </div>
            )}

            {/* Volume feedback overlay */}
            {volumeFeedback && (
                <div
                    key={volumeFeedback.n}
                    className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-10"
                >
                    <div
                        className="bg-black/70 rounded-2xl px-8 py-4 text-white text-center min-w-[110px]"
                        style={{ animation: 'volumeFlash 1s ease-out forwards' }}
                    >
                        <div className="text-2xl font-bold tabular-nums">{volumeFeedback.pct}%</div>
                        <div className="mt-2 w-20 mx-auto h-1.5 bg-zinc-600 rounded-full overflow-hidden">
                            <div className="h-full bg-white rounded-full" style={{ width: `${volumeFeedback.pct}%` }} />
                        </div>
                    </div>
                </div>
            )}

            {/* Controls overlay */}
            <div
                className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-8 transition-opacity duration-300 ${showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
                    }`}
                onClick={(e) => e.stopPropagation()}
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
                                <VolumeIcon volume={settings.volume} muted={isMuted} />
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
                                <VolumeIcon volume={settings.volume} muted={isMuted} />
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

                    {/* Subtitle Sync/Size Menu Trigger */}
                    <div className="relative" ref={subtitleMenuRef}>
                        <button
                            onClick={() => setShowSubtitleMenu(!showSubtitleMenu)}
                            className={`p-1.5 transition-colors cursor-pointer ${showSubtitleMenu ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                            title="Subtitle Settings"
                        >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h12M3 10h12M3 15h12M17 5v14m-4-7h8" />
                            </svg>
                        </button>

                        {showSubtitleMenu && (
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-20">
                                <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-800/50 flex items-center justify-between">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Subtitle Settings</span>
                                    <div className="flex items-center gap-2">
                                        {isLoadingSubtitle && (
                                            <div className="w-3 h-3 border border-indigo-500 border-t-transparent rounded-full animate-spin" />
                                        )}
                                        <button
                                            onClick={() => setShowSubtitleMenu(false)}
                                            className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                                            title="Close"
                                        >
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                                <div className="p-3 space-y-3 max-h-80 overflow-y-auto">
                                    {/* Track selector */}
                                    {subtitleTracks.length > 0 && (
                                        <div className="space-y-1">
                                            <span className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">FAIXA</span>
                                            <div className="space-y-0.5">
                                                {subtitleTracks.map((track, idx) => (
                                                    <button
                                                        key={idx}
                                                        onClick={() => setSelectedSubtitleTrack(idx)}
                                                        className={`w-full text-left px-2 py-1.5 rounded text-[10px] transition-colors cursor-pointer truncate ${selectedSubtitleTrack === idx ? 'bg-indigo-500/20 text-indigo-300' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'}`}
                                                    >
                                                        {track.name}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Sync Offset */}
                                    <div className="space-y-1.5">
                                        <div className="flex justify-between text-[10px] text-zinc-500 font-medium">
                                            <span>SYNC OFFSET</span>
                                            <span className={settings.subtitles.offset === 0 ? 'text-zinc-600' : 'text-indigo-400'}>
                                                {settings.subtitles.offset > 0 ? '+' : ''}{settings.subtitles.offset.toFixed(1)}s
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => handleOffsetChange(-0.5)} className="flex-1 px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition-colors cursor-pointer">-0.5s</button>
                                            <button onClick={() => player.setSubtitleOffset(0)} className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 rounded text-[10px] transition-colors cursor-pointer">Reset</button>
                                            <button onClick={() => handleOffsetChange(0.5)} className="flex-1 px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[10px] transition-colors cursor-pointer">+0.5s</button>
                                        </div>
                                    </div>

                                    {/* Font Size */}
                                    <div className="space-y-1.5">
                                        <div className="flex justify-between text-[10px] text-zinc-500 font-medium">
                                            <span>FONT SIZE</span>
                                            <span className="text-zinc-400">{settings.subtitles.fontSize}px</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={12}
                                            max={96}
                                            step={2}
                                            value={settings.subtitles.fontSize}
                                            onChange={e => player.setSubtitleFontSize(parseInt(e.target.value))}
                                            className="w-full h-1 accent-indigo-500 cursor-pointer"
                                        />
                                    </div>

                                    {/* Text Color */}
                                    <div className="space-y-1.5">
                                        <span className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">COR DO TEXTO</span>
                                        <div className="flex items-center gap-2">
                                            {['#ffffff', '#ffff00', '#00ffff', '#90ee90'].map(color => (
                                                <button
                                                    key={color}
                                                    onClick={() => player.setSubtitleColor(color)}
                                                    title={color}
                                                    className={`w-6 h-6 rounded-full border-2 transition-all cursor-pointer ${settings.subtitles.color === color ? 'border-white scale-110' : 'border-zinc-600 hover:border-zinc-400'}`}
                                                    style={{ backgroundColor: color }}
                                                />
                                            ))}
                                            <input
                                                type="color"
                                                value={settings.subtitles.color}
                                                onChange={e => player.setSubtitleColor(e.target.value)}
                                                className="w-6 h-6 rounded cursor-pointer border border-zinc-600 bg-transparent"
                                                title="Custom color"
                                            />
                                        </div>
                                    </div>

                                    {/* Background opacity */}
                                    <div className="space-y-1.5">
                                        <div className="flex justify-between text-[10px] text-zinc-500 font-medium">
                                            <span>FUNDO</span>
                                            <span className="text-zinc-400">{Math.round(settings.subtitles.bgOpacity * 100)}%</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={0}
                                            max={1}
                                            step={0.05}
                                            value={settings.subtitles.bgOpacity}
                                            onChange={e => player.setSubtitleBgOpacity(parseFloat(e.target.value))}
                                            className="w-full h-1 accent-indigo-500 cursor-pointer"
                                        />
                                    </div>

                                    {/* Load from file */}
                                    <div>
                                        <input
                                            ref={subtitleFileInputRef}
                                            type="file"
                                            accept=".srt,.vtt,.sub,.ass,.ssa"
                                            className="hidden"
                                            onChange={handleSubtitleFileSelected}
                                        />
                                        <button
                                            onClick={handlePickSubtitleFile}
                                            disabled={isLoadingSubtitle}
                                            className="w-full px-2 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 hover:text-white rounded text-[10px] transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                                        >
                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                            </svg>
                                            Carregar legenda…
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Track Selection Menu Trigger */}
                    {capabilities.supportsAudioTracks && audioStreams.length > 0 && (
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

function VolumeIcon({ volume, muted }: { volume: number; muted: boolean }) {
    if (muted || volume === 0) {
        return (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
            </svg>
        );
    }
    if (volume < 0.5) {
        return (
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
            </svg>
        );
    }
    return (
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
        </svg>
    );
}

function needsTranscoding(mediaInfo: import('../types').MediaInfo | null, filename: string): boolean {
    const isHEVC = mediaInfo?.streams.some(s => s.codec_name === 'hevc' || s.codec_name === 'h265');
    const isUnsupportedAudio = mediaInfo?.streams.some(s =>
        s.codec_type === 'audio' &&
        ['ac3', 'eac3', 'dca', 'dts', 'mlp', 'truehd', 'a52'].includes(s.codec_name.toLowerCase())
    );
    const isMKV = filename.toLowerCase().endsWith('.mkv');
    return !!(isHEVC || isUnsupportedAudio || isMKV);
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

function cleanFilename(name: string): string {
    return name
        .replace(/\.[^.]+$/, '')
        .replace(/\[.*?\]/g, '')
        .replace(/\((?:19|20)\d{2}\)/g, '')
        .replace(/S\d{2}E\d{2}/gi, '')
        .replace(/\b\d{3,4}p\b/gi, '')
        .replace(/\b(BluRay|WEB-DL|WEBRip|HDTV|x264|x265|HEVC|AAC|DDP|HDR)\b/gi, '')
        .replace(/[-._]+/g, ' ')
        .trim();
}
