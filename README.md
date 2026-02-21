# DivePlay

A browser-based media player that lives in your folders and works with your local files.
One single HTML file. Put it anywhere and it will work.

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

## License

[GPLv2](LICENSE)
