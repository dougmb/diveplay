# 📁 FolderPlayer — Project Scope

## Overview

FolderPlayer is a portable, browser-based media player (video and audio).
The user opens `index.html` in a Chromium browser (Chrome, Edge), selects a
media folder, and the app builds a playlist from all files inside that folder
and its subfolders. Playback state (last file, last position, settings) is
saved as a `.player-state.json` file directly inside the selected media folder,
so the state travels with the media and works across machines and locations.

No installation required. No server. No executable.
Just static files opened in the browser.

---

## Goals

- Play video and audio files from a local folder and its subfolders.
- No install: copy the static files anywhere and open `index.html` in Chrome/Edge.
- Save playback state (last file, last position, volume, speed) inside the media
  folder as `.player-state.json`.
- Works on Windows and Linux.
- Remember the last folder between sessions (via IndexedDB) so the user only
  needs to re-grant permission, not re-pick the folder.

---

## Tech Stack

| Layer            | Technology                                      |
|------------------|-------------------------------------------------|
| Language         | TypeScript                                      |
| Bundler          | Vite                                            |
| UI Framework     | React 19                                        |
| Styling          | TailwindCSS                                     |
| File access      | File System Access API (`showDirectoryPicker`)  |
| State in folder  | `.player-state.json` via `createWritable()`     |
| Folder handle    | IndexedDB (persist handle between sessions)     |
| Playback         | Native HTML5 `<video>` element                  |
| Distribution     | Static build (`dist/` folder)                   |

---

## Constraints / Browser Requirements

- Requires a Chromium-based browser (Chrome or Edge).
- File System Access API must be available (`window.showDirectoryPicker`).
- The app must be opened via a local server or `file://` — Vite dev server covers
  this in development; in production, `index.html` can be opened directly or via
  a simple local server script.

---

## Supported File Extensions

**Video:** `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`, `.m4v`  
**Audio:** `.mp3`, `.flac`, `.ogg`, `.wav`, `.aac`, `.m4a`

---

## State File (`.player-state.json`)

Saved directly inside the selected media folder. Structure:

```json
{
  "lastFile": "Series/Season1/ep02.mkv",
  "lastPosition": 1432.7,
  "settings": {
    "volume": 0.8,
    "playbackRate": 1.25,
    "shuffle": false,
    "loop": false
  }
}
```

---

## Folder Structure

```
foldeplayer/
├── public/
│   └── favicon.ico
├── src/
│   ├── components/
│   │   ├── Player.tsx          # <video> element and controls
│   │   ├── Playlist.tsx        # List of media files, grouped by folder
│   │   ├── FolderPicker.tsx    # "Open folder" button and permission logic
│   │   └── ResumeDialog.tsx    # "Continue from where you stopped?" dialog
│   ├── services/
│   │   ├── fileSystem.ts       # showDirectoryPicker, recursive scan, read/write .player-state.json
│   │   └── db.ts               # IndexedDB: persist and restore FileSystemDirectoryHandle
│   ├── store/
│   │   └── playerStore.ts      # Global state (current file, position, settings, playlist)
│   ├── types/
│   │   └── index.ts            # Shared TypeScript types (MediaFile, PlayerState, Settings)
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── SCOPE.md
└── .gitignore
```

---

## Development Phases

### Phase 1 — Project Setup
- Initialize repo with `git init`.
- Set up Vite + React + TypeScript with `npm create vite@latest`.
- Configure TailwindCSS.
- Create base folder structure from the layout above.
- Set up `.gitignore` (node_modules, dist, .env).
- First commit: `chore: project setup`.

---

### Phase 2 — File System Access
**Goal:** User can pick a folder and the app lists all media files.

- Implement `fileSystem.ts`:
  - `pickFolder()` — calls `showDirectoryPicker({ mode: 'readwrite' })`.
  - `scanDirectory()` — recursively reads the directory tree and returns a flat
    list of `MediaFile` objects (name, relative path, `FileSystemFileHandle`,
    type: video/audio).
- Implement `db.ts`:
  - `saveHandle(handle)` — persists `FileSystemDirectoryHandle` in IndexedDB.
  - `loadHandle()` — retrieves stored handle.
  - `requestPermission(handle)` — requests `readwrite` permission on the stored
    handle; returns `true` if granted.
- Implement `FolderPicker.tsx`:
  - On app load: check IndexedDB for a stored handle and try to re-request permission.
  - Show "Open folder" button if no handle or permission denied.
- Deliverable: a working playlist rendered from the selected folder.

---

### Phase 3 — Playback
**Goal:** User can click a file and play it.

- Implement `Player.tsx`:
  - `<video>` element with `src` set from a `Blob URL` created via
    `fileHandle.getFile()`.
  - Custom controls: play/pause, seek bar, current time / duration, volume, speed.
  - Keyboard shortcuts: `Space` (play/pause), `Arrow Left/Right` (seek ±10s),
    `F` (fullscreen), `M` (mute).
- Implement `Playlist.tsx`:
  - Display files grouped by subfolder.
  - Highlight the currently playing file.
  - Click to play.
- Implement `playerStore.ts`:
  - Hold current file, playlist index, position, settings (volume, speed,
    shuffle, loop).
  - Expose actions: `play(file)`, `next()`, `prev()`, `setVolume()`, `setSpeed()`.
- Deliverable: fully functional playback with controls.

---

### Phase 4 — Persistence (State in Folder)
**Goal:** Playback progress and settings are saved to `.player-state.json` in
the media folder.

- Extend `fileSystem.ts`:
  - `readState(dirHandle)` — reads `.player-state.json` from the folder root
    if it exists; returns parsed `PlayerState` or `null`.
  - `writeState(dirHandle, state)` — creates or overwrites `.player-state.json`
    using `createWritable()`.
- Trigger `writeState` on:
  - `timeupdate` event (throttled to every 5 seconds).
  - Pause event.
  - `beforeunload` (window close/refresh).
  - Settings change.
- On app load (after folder access is granted):
  - Call `readState()`.
  - If a state file exists, show `ResumeDialog.tsx` ("Continue from ep02.mkv at 23:52?").
  - User can confirm (seek to last position) or dismiss (start fresh).
- Deliverable: progress and settings persist across sessions and machines.

---

### Phase 5 — UI Polish
**Goal:** Clean, usable interface.

- Layout: left sidebar (playlist) + main area (player), collapsible sidebar.
- Show video thumbnail / audio waveform placeholder.
- Show file name, folder path, duration.
- Empty state when no folder is selected.
- Error states (unsupported browser, permission denied).
- Responsive enough for fullscreen use.

---

### Phase 6 — Distribution Build
**Goal:** App is ready to copy and use anywhere.

- `vite build` produces a `dist/` folder with `index.html` + bundled assets.
- User copies `dist/` folder next to (or inside) the media folder and opens
  `index.html` in Chrome/Edge.
- Optional: add a small `README.md` with usage instructions for the end user.

---

## Out of Scope (for now)

- Firefox / Safari support (File System Access API not fully available).
- Subtitle support (`.srt`, `.vtt`).
- Playlist editing (reorder, delete from list).
- Remote/network folders.
- Mobile support.
