export function decodeSubtitleBytes(bytes: Uint8Array): string {
    // UTF-8 BOM
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return new TextDecoder('utf-8').decode(bytes.slice(3));
    }
    // UTF-16 LE BOM
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return new TextDecoder('utf-16le').decode(bytes.slice(2));
    }
    // UTF-16 BE BOM
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return new TextDecoder('utf-16be').decode(bytes.slice(2));
    }
    // Try UTF-8 — if clean (no U+FFFD replacement chars), it's valid UTF-8
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    if (!utf8.includes('�')) return utf8;
    // Fallback: Windows-1252 covers most Latin scripts (PT, ES, FR, DE, IT, PL…)
    try {
        return new TextDecoder('windows-1252').decode(bytes);
    } catch {
        return utf8;
    }
}

export interface SubtitleCue {
    startTime: number;
    endTime: number;
    text: string;
}

function parseTimestamp(ts: string): number {
    const normalized = ts.replace(',', '.');
    const parts = normalized.split(':');
    if (parts.length === 3) {
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    }
    if (parts.length === 2) {
        return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return 0;
}

function sanitizeText(text: string): string {
    return text
        .replace(/<(?!\/?(?:i|b|u)(?:\s[^>]*)?>)[^>]+>/gi, '')
        .trim();
}

function parseSrt(content: string): SubtitleCue[] {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const blocks = normalized.split(/\n{2,}/);
    const cues: SubtitleCue[] = [];

    for (const block of blocks) {
        const lines = block.split('\n');
        let i = 0;
        if (/^\d+$/.test(lines[i]?.trim())) i++;

        const timeLine = lines[i]?.trim();
        if (!timeLine) continue;

        const timeMatch = timeLine.match(
            /(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})/
        );
        if (!timeMatch) continue;

        const text = sanitizeText(lines.slice(i + 1).join('<br>'));
        if (text) {
            cues.push({
                startTime: parseTimestamp(timeMatch[1]),
                endTime: parseTimestamp(timeMatch[2]),
                text,
            });
        }
    }

    return cues;
}

function parseVtt(content: string): SubtitleCue[] {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const cues: SubtitleCue[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();

        if (line.includes('-->')) {
            const timeMatch = line.match(
                /(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})/
            );
            if (timeMatch) {
                const textLines: string[] = [];
                i++;
                while (i < lines.length && lines[i].trim() !== '') {
                    textLines.push(lines[i]);
                    i++;
                }
                const text = sanitizeText(textLines.join('<br>'));
                if (text) {
                    cues.push({
                        startTime: parseTimestamp(timeMatch[1]),
                        endTime: parseTimestamp(timeMatch[2]),
                        text,
                    });
                }
                continue;
            }
        }
        i++;
    }

    return cues;
}

export function parseSubtitleCues(content: string, filename: string): SubtitleCue[] {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'vtt') return parseVtt(content);
    return parseSrt(content);
}

export function getActiveCue(
    cues: SubtitleCue[],
    currentTime: number,
    offset: number
): SubtitleCue | null {
    const t = currentTime - offset;
    return cues.find(c => c.startTime <= t && c.endTime > t) ?? null;
}
