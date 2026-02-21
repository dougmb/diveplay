# DivePlay

A portable, browser-based media player for videos and audio files. Your playback state travels with your files.

## Features

- **No installation required** - Just open `index.html` in your browser
- **Portable** - Save the `dist/` folder anywhere and your data travels with you
- **Automatic progress saving** - Playback position saved in `.player-state.json` inside your media folder
- **Folder scanning** - Recursively scans subfolders for media files
- **Customizable file types** - Choose which file extensions to scan
- **Keyboard shortcuts** - Space (play/pause), Arrow keys (seek), F (fullscreen), M (mute)

## Supported Formats

**Video:** MP4, MKV, WebM, AVI, MOV, M4V  
**Audio:** MP3, FLAC, OGG, WAV, AAC, M4A

## Browser Requirements

DivePlay requires a Chromium-based browser (Chrome, Edge, or Brave) due to the File System Access API.

## How It Works

1. Select a folder containing your media files
2. The app scans all subfolders for supported video and audio files
3. Click any file to start playing
4. Your progress is automatically saved to `.player-state.json` in the selected folder
5. When you reopen the app, you can resume where you left off

## Usage

### Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

### Production Build

```bash
# Build for production
npm run build
```

The output will be in the `dist/` folder. Copy this folder to anywhere you want to use the player.

### Using the Built App

1. Open `dist/index.html` in Chrome or Edge
2. Click "Open Folder" to select your media folder
3. Configure which file types to scan in Settings if needed
4. Start watching!

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play/Pause |
| ← / → | Seek -10s / +10s |
| ↑ / ↓ | Volume + / - |
| F | Toggle fullscreen |
| M | Toggle mute |

## License

Licensed under [GPLv2](LICENSE)

## Tech Stack

- React 19
- TypeScript
- Vite
- TailwindCSS
- File System Access API
- IndexedDB

---

Developed by [@dougmb](https://github.com/dougmb/diveplay)
