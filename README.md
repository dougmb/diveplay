# DivePlay

A browser-based media player that lives in your folders and works with your local files.
One single HTML file. Put it anywhere.

> ⚠️ **Note:** Some media files may not play because they require codecs not supported natively by the browser (e.g. AC3, DTS audio, or certain video formats). See [Limitations](#limitations) below.

## Download

Get the latest release from [GitHub Releases](https://github.com/dougmb/diveplay/releases)

## Features

- Play video and audio files from a local folder
- Progress saved automatically to `.player-state.json`
- Subtitle support (SRT, VTT, SUB)
- Keyboard shortcuts (Space, arrows, F, M)
- Works offline

## Supported Browsers

- **Chrome / Edge** (recommended): Full features including folder selection and state persistence
- **Firefox / Safari**: Limited - select individual files, no state saving

## Usage

1. Open `index.html` in a Chromium browser
2. Select a folder with your media
3. Click any file to play

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play/Pause |
| ← → | Seek -10s / +10s |
| ↑ ↓ | Volume |
| F | Fullscreen |
| M | Mute |

## Build

```bash
npm install
npm run build
```

Output in `dist/`.

## Limitations

### Codec Support

DivePlay relies entirely on the browser's built-in media decoders. **Some files may fail to play** if they use codecs that are not natively supported:

| Format | Status | Notes |
|--------|--------|-------|
| H.264 / AAC | ✅ Works | Most common video/audio |
| H.265 / HEVC | ⚠️ Partial | Supported only in some Chromium builds |
| AC3 / Dolby Digital | ❌ May not work | Not supported natively in most browsers |
| DTS audio | ❌ May not work | Not supported natively in most browsers |
| VP9 / Opus | ✅ Works | Open formats, well supported |
| AV1 | ✅ Works | Modern open format |

If a file does not play, try re-encoding the audio/video track to a format supported by your browser (e.g. AAC audio, H.264 video).

## License

[GPLv2](LICENSE)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Q5Q61UQM6J)