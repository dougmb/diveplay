// InfoOverlay.tsx — diagnostic HUD toggled with the I key.
//
// Exists to answer, at a glance and from an installed build: is this session
// GPU-accelerated or on the software fallback, is the file being transcoded, and
// is playback actually healthy (dropped frames, stalls, event storms)?
import { useState, useEffect, useRef } from 'react';
import { getTauriAPI } from '../services/tauri';
import { capabilities } from '../platform/capabilities';
import type { MediaFile, MediaInfo } from '../types';

export interface PlaybackDiagnostics {
    /** Incremented on every timeupdate event the player handles. */
    timeUpdates: number;
    /** Incremented on every Player render. */
    renders: number;
}

interface InfoOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    mediaRef: React.RefObject<HTMLVideoElement | HTMLAudioElement | null>;
    diagRef: React.RefObject<PlaybackDiagnostics>;
    mediaInfo: MediaInfo | null;
    file: MediaFile | null;
    transcodeMode: string;
    /** Seek offset when transcoding, so reported position matches the timeline. */
    transcodeSeekTime: number;
}

interface RenderInfo {
    gl_mode: string;
    gl_why: string;
    is_appimage: boolean;
}

interface Sample {
    droppedPct: number | null;
    dropped: number | null;
    total: number | null;
    decodedFps: number | null;
    timeUpdateRate: number;
    renderRate: number;
    bufferedAhead: number | null;
    readyState: number;
    position: number;
}

const READY_STATES = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];

function fmtBytes(n: number | undefined): string {
    if (!n || !Number.isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtRate(r: string | null | undefined): string {
    if (!r) return '—';
    const [n, d] = r.split('/').map(Number);
    if (!d) return r;
    const v = n / d;
    return Number.isFinite(v) ? `${v.toFixed(v % 1 === 0 ? 0 : 2)} fps` : r;
}

/** GL mode → how to describe it and whether it deserves a warning colour. */
function describeGlMode(mode: string): { label: string; tone: 'good' | 'warn' | 'bad' } {
    switch (mode) {
        case 'gpu': return { label: 'GPU (hardware EGL + DMABuf)', tone: 'good' };
        case 'gpu-nodmabuf': return { label: 'GPU (hardware EGL, DMABuf off)', tone: 'warn' };
        case 'software': return { label: 'Software (llvmpipe — high CPU)', tone: 'bad' };
        case 'host-default': return { label: 'Host default (not an AppImage)', tone: 'good' };
        default: return { label: mode || 'unknown', tone: 'warn' };
    }
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
    const color = tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : tone === 'good' ? 'text-green-400' : 'text-gray-100';
    return (
        <div className="flex justify-between gap-6 py-0.5">
            <span className="text-gray-400 shrink-0">{label}</span>
            <span className={`${color} text-right break-all`}>{value}</span>
        </div>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 border-b border-white/10 pb-0.5">{title}</div>
            {children}
        </div>
    );
}

export default function InfoOverlay({
    isOpen, onClose, mediaRef, diagRef, mediaInfo, file, transcodeMode, transcodeSeekTime,
}: InfoOverlayProps) {
    const [render, setRender] = useState<RenderInfo | null>(null);
    const [s, setS] = useState<Sample | null>(null);
    const prevRef = useRef({ t: 0, frames: 0, timeUpdates: 0, renders: 0 });

    // Render mode is fixed for the process lifetime — fetch once.
    useEffect(() => {
        if (!isOpen || render || !capabilities.hasNativeLogs) return;
        let cancelled = false;
        getTauriAPI()
            .then(api => api?.invoke<RenderInfo>('get_render_info'))
            .then(info => { if (info && !cancelled) setRender(info); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [isOpen, render]);

    useEffect(() => {
        if (!isOpen) return;
        prevRef.current = { t: performance.now(), frames: 0, timeUpdates: 0, renders: 0 };

        const tick = () => {
            const el = mediaRef.current;
            const now = performance.now();
            const prev = prevRef.current;
            const dt = (now - prev.t) / 1000;
            if (dt <= 0) return;

            const q = (el as HTMLVideoElement | null)?.getVideoPlaybackQuality?.();
            const total = q?.totalVideoFrames ?? null;
            const dropped = q?.droppedVideoFrames ?? null;

            const diag = diagRef.current ?? { timeUpdates: 0, renders: 0 };
            let bufferedAhead: number | null = null;
            if (el && el.buffered.length > 0) {
                for (let i = 0; i < el.buffered.length; i++) {
                    if (el.currentTime >= el.buffered.start(i) && el.currentTime <= el.buffered.end(i)) {
                        bufferedAhead = el.buffered.end(i) - el.currentTime;
                        break;
                    }
                }
            }

            setS({
                total,
                dropped,
                droppedPct: total && total > 0 && dropped !== null ? (dropped / total) * 100 : null,
                decodedFps: total !== null && prev.frames > 0 ? Math.max(0, (total - prev.frames) / dt) : null,
                timeUpdateRate: Math.max(0, (diag.timeUpdates - prev.timeUpdates) / dt),
                renderRate: Math.max(0, (diag.renders - prev.renders) / dt),
                bufferedAhead,
                readyState: el?.readyState ?? 0,
                position: transcodeSeekTime + (el && Number.isFinite(el.currentTime) ? el.currentTime : 0),
            });

            prevRef.current = { t: now, frames: total ?? 0, timeUpdates: diag.timeUpdates, renders: diag.renders };
        };

        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [isOpen, mediaRef, diagRef, transcodeSeekTime]);

    if (!isOpen) return null;

    const v = mediaInfo?.streams.find(x => x.codec_type === 'video');
    const a = mediaInfo?.streams.find(x => x.codec_type === 'audio');
    const gl = describeGlMode(render?.gl_mode ?? (capabilities.hasNativeLogs ? 'unknown' : 'browser'));

    // A transcode means ffmpeg is re-encoding in real time — usually the single
    // largest CPU consumer, so call it out rather than burying it.
    const transcoding = transcodeMode !== 'direct';

    return (
        <div className="absolute top-4 left-4 z-30 w-[26rem] max-w-[calc(100%-2rem)] max-h-[calc(100%-6rem)] overflow-y-auto
                        bg-black/85 backdrop-blur-sm text-[11px] leading-snug font-mono
                        rounded-lg border border-white/15 shadow-2xl p-3 select-text">
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold tracking-wide text-white">Playback info</span>
                <button onClick={onClose} className="text-gray-400 hover:text-white px-1.5 leading-none" title="Close (I)">✕</button>
            </div>

            <Section title="Rendering">
                <Row label="Mode" value={gl.label} tone={gl.tone} />
                {render?.gl_why && <Row label="Decided by" value={render.gl_why} />}
                <Row
                    label="Pipeline"
                    value={transcoding ? `ffmpeg → ${transcodeMode}` : 'direct stream'}
                    tone={transcoding ? 'warn' : 'good'}
                />
            </Section>

            <Section title="Playback health">
                <Row label="Position" value={`${fmtTime(s?.position ?? 0)}`} />
                <Row label="Ready state" value={READY_STATES[s?.readyState ?? 0] ?? String(s?.readyState)} />
                <Row
                    label="Buffered ahead"
                    value={s?.bufferedAhead != null ? `${s.bufferedAhead.toFixed(1)} s` : '—'}
                    tone={s?.bufferedAhead != null && s.bufferedAhead < 1 ? 'warn' : undefined}
                />
                <Row label="Decoded" value={s?.decodedFps != null ? `${s.decodedFps.toFixed(1)} fps` : '—'} />
                <Row
                    label="Dropped frames"
                    value={s?.dropped != null ? `${s.dropped}${s.droppedPct != null ? ` (${s.droppedPct.toFixed(2)}%)` : ''}` : '—'}
                    tone={s?.droppedPct != null ? (s.droppedPct > 5 ? 'bad' : s.droppedPct > 1 ? 'warn' : 'good') : undefined}
                />
                <Row label="Total frames" value={s?.total ?? '—'} />
            </Section>

            <Section title="Event rates (diagnostic)">
                <Row
                    label="timeupdate/s"
                    value={s ? s.timeUpdateRate.toFixed(1) : '—'}
                    tone={s && s.timeUpdateRate > 10 ? 'warn' : undefined}
                />
                <Row
                    label="Player renders/s"
                    value={s ? s.renderRate.toFixed(1) : '—'}
                    tone={s && s.renderRate > 15 ? 'bad' : s && s.renderRate > 8 ? 'warn' : undefined}
                />
            </Section>

            <Section title="File">
                <Row label="Name" value={file?.name ?? '—'} />
                <Row label="Container" value={mediaInfo?.format.format_name ?? '—'} />
                <Row label="Size" value={fmtBytes(mediaInfo?.format.size ? Number(mediaInfo.format.size) : undefined)} />
                <Row label="Duration" value={mediaInfo?.format.duration ? fmtTime(Number(mediaInfo.format.duration)) : '—'} />
                <Row label="Bitrate" value={mediaInfo?.format.bit_rate ? `${(Number(mediaInfo.format.bit_rate) / 1000).toFixed(0)} kbps` : '—'} />
            </Section>

            {v && (
                <Section title="Video stream">
                    <Row label="Codec" value={`${v.codec_name ?? '—'}${v.profile ? ` (${v.profile})` : ''}`} />
                    <Row label="Resolution" value={v.width && v.height ? `${v.width}×${v.height}` : '—'} />
                    <Row label="Frame rate" value={fmtRate(v.r_frame_rate)} />
                    <Row label="Pixel format" value={v.pix_fmt ?? '—'} />
                </Section>
            )}

            {a && (
                <Section title="Audio stream">
                    <Row label="Codec" value={a.codec_name ?? '—'} />
                    <Row label="Channels" value={a.channels ?? '—'} />
                    <Row label="Sample rate" value={a.sample_rate ? `${a.sample_rate} Hz` : '—'} />
                </Section>
            )}

            <div className="text-[10px] text-gray-500 pt-1 border-t border-white/10">Press I to close</div>
        </div>
    );
}
