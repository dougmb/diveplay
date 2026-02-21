import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import FolderPicker from './components/FolderPicker';
import Playlist from './components/Playlist';
import Player from './components/Player';
import ResumeDialog from './components/ResumeDialog';
import { PlayerContext, initialState } from './store/playerStore';
import type { PlayerStoreState } from './store/playerStore';
import { readState, writeState } from './services/fileSystem';
import { clearHandle } from './services/db';
import type { MediaFile, PlayerState } from './types';

function isSupportedBrowser(): boolean {
  return 'showDirectoryPicker' in window;
}

function BrowserNotSupported() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
      <div className="text-center max-w-md px-4">
        <div className="w-16 h-16 mx-auto mb-4 text-red-500">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-zinc-100 mb-2">Browser Not Supported</h1>
        <p className="text-zinc-400 mb-4">
          This app requires the File System Access API, which is only available in Chromium-based browsers like Chrome or Edge.
        </p>
        <p className="text-sm text-zinc-500">
          Please open this page in Chrome or Edge to use FolderPlayer.
        </p>
      </div>
    </div>
  );
}

function App() {
  if (!isSupportedBrowser()) {
    return <BrowserNotSupported />;
  }

  const [state, setState] = useState<PlayerStoreState>(initialState);
  const [savedState, setSavedState] = useState<PlayerState | null>(null);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showToggle, setShowToggle] = useState(true);

  // Ref to always have the latest state for beforeunload / throttled writes
  const stateRef = useRef(state);
  stateRef.current = state;

  const lastSaveTimeRef = useRef(0);

  // ── State persistence: auto-save ──

  const saveCurrentState = useCallback(async () => {
    const s = stateRef.current;
    if (!s.dirHandle || !s.currentFile) return;

    const playerState: PlayerState = {
      lastFile: s.currentFile.relativePath,
      lastPosition: s.position,
      settings: { ...s.settings },
    };

    try {
      await writeState(s.dirHandle, playerState);
    } catch (err) {
      console.error('Failed to save state:', err);
    }
  }, []);

  // Save on pause
  const setIsPlaying = useCallback((playing: boolean) => {
    setState((s) => ({ ...s, isPlaying: playing }));
    if (!playing) {
      // Small delay to ensure position is up to date
      setTimeout(() => saveCurrentState(), 100);
    }
  }, [saveCurrentState]);

  // Save on timeupdate (throttled to every 5 seconds)
  const setPosition = useCallback((pos: number) => {
    setState((s) => ({ ...s, position: pos }));

    const now = Date.now();
    if (now - lastSaveTimeRef.current >= 5000) {
      lastSaveTimeRef.current = now;
      saveCurrentState();
    }
  }, [saveCurrentState]);

  // Save on settings change
  const setVolume = useCallback((vol: number) => {
    setState((s) => ({
      ...s,
      settings: { ...s.settings, volume: Math.max(0, Math.min(1, vol)) },
    }));
    saveCurrentState();
  }, [saveCurrentState]);

  const setSpeed = useCallback((rate: number) => {
    setState((s) => ({
      ...s,
      settings: { ...s.settings, playbackRate: rate },
    }));
    saveCurrentState();
  }, [saveCurrentState]);

  const toggleShuffle = useCallback(() => {
    setState((s) => ({
      ...s,
      settings: { ...s.settings, shuffle: !s.settings.shuffle },
    }));
    saveCurrentState();
  }, [saveCurrentState]);

  const toggleLoop = useCallback(() => {
    setState((s) => ({
      ...s,
      settings: { ...s.settings, loop: !s.settings.loop },
    }));
    saveCurrentState();
  }, [saveCurrentState]);

  // Save on beforeunload
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveCurrentState();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [saveCurrentState]);

  // Show toggle button on mouse move, auto-hide after 5 seconds
  useEffect(() => {
    let timeout: number | undefined;

    const handleMouseMove = () => {
      setShowToggle(true);
      if (timeout) clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        setShowToggle(false);
      }, 5000);
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  // Auto-hide sidebar after 5 seconds
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSidebarCollapsed(true);
    }, 5000);
    return () => clearTimeout(timeout);
  }, []);

  // ── Other actions ──

  const setPlaylist = useCallback((files: MediaFile[]) => {
    setState((s) => ({ ...s, playlist: files }));
  }, []);

  const setDirHandle = useCallback((handle: FileSystemDirectoryHandle | null) => {
    setState((s) => ({ ...s, dirHandle: handle }));
  }, []);

  const play = useCallback((file: MediaFile) => {
    setState((s) => {
      const idx = s.playlist.findIndex((f) => f.relativePath === file.relativePath);
      return { ...s, currentFile: file, currentIndex: idx, isPlaying: true, position: 0, duration: 0 };
    });
  }, []);

  const playAtPosition = useCallback((file: MediaFile, position: number) => {
    setState((s) => {
      const idx = s.playlist.findIndex((f) => f.relativePath === file.relativePath);
      return { ...s, currentFile: file, currentIndex: idx, isPlaying: true, position, duration: 0 };
    });
  }, []);

  const next = useCallback(() => {
    setState((s) => {
      if (s.playlist.length === 0) return s;

      let nextIdx: number;
      if (s.settings.shuffle) {
        nextIdx = Math.floor(Math.random() * s.playlist.length);
      } else {
        nextIdx = s.currentIndex + 1;
        if (nextIdx >= s.playlist.length) {
          if (s.settings.loop) {
            nextIdx = 0;
          } else {
            return { ...s, isPlaying: false };
          }
        }
      }

      return {
        ...s,
        currentIndex: nextIdx,
        currentFile: s.playlist[nextIdx],
        isPlaying: true,
        position: 0,
        duration: 0,
      };
    });
  }, []);

  const prev = useCallback(() => {
    setState((s) => {
      if (s.playlist.length === 0) return s;

      if (s.position > 3) {
        return { ...s, position: 0 };
      }

      let prevIdx = s.currentIndex - 1;
      if (prevIdx < 0) prevIdx = s.playlist.length - 1;

      return {
        ...s,
        currentIndex: prevIdx,
        currentFile: s.playlist[prevIdx],
        isPlaying: true,
        position: 0,
        duration: 0,
      };
    });
  }, []);

  const setDuration = useCallback((dur: number) => {
    setState((s) => ({ ...s, duration: dur }));
  }, []);

  const reset = useCallback(() => {
    setState(initialState);
    setSavedState(null);
    setShowResumeDialog(false);
  }, []);

  const contextValue = useMemo(() => ({
    ...state,
    setPlaylist,
    setDirHandle,
    play,
    next,
    prev,
    setIsPlaying,
    setPosition,
    setDuration,
    setVolume,
    setSpeed,
    toggleShuffle,
    toggleLoop,
    reset,
  }), [state, setPlaylist, setDirHandle, play, next, prev, setIsPlaying, setPosition, setDuration, setVolume, setSpeed, toggleShuffle, toggleLoop, reset]);

  // ── Folder ready handler: read saved state ──

  const handleFolderReady = async (handle: FileSystemDirectoryHandle, mediaFiles: MediaFile[]) => {
    setState((s) => ({
      ...s,
      dirHandle: handle,
      playlist: mediaFiles,
      currentFile: null,
      currentIndex: -1,
    }));

    // Check for saved state
    const saved = await readState(handle);
    if (saved && saved.lastFile) {
      // Verify the file still exists in the playlist
      const fileExists = mediaFiles.some((f) => f.relativePath === saved.lastFile);
      if (fileExists) {
        setSavedState(saved);
        setShowResumeDialog(true);

        // Restore settings immediately regardless of resume choice
        setState((s) => ({
          ...s,
          settings: { ...saved.settings },
        }));
      }
    }
  };

  const handleResume = () => {
    if (!savedState) return;
    const file = state.playlist.find((f) => f.relativePath === savedState.lastFile);
    if (file) {
      playAtPosition(file, savedState.lastPosition);
    }
    setShowResumeDialog(false);
    setSavedState(null);
  };

  const handleDismissResume = () => {
    setShowResumeDialog(false);
    setSavedState(null);
  };

  const handleSelectNewFolder = async () => {
    await saveCurrentState();
    await clearHandle();
    setState(initialState);
    setSavedState(null);
    setShowResumeDialog(false);
  };

  const handleChangeFolder = async () => {
    await saveCurrentState();
    await clearHandle();
    setState(initialState);
    setSavedState(null);
    setShowResumeDialog(false);
  };

  // Auto-resume after 15 seconds
  useEffect(() => {
    if (!showResumeDialog) return;

    const timeout = setTimeout(() => {
      handleResume();
    }, 15000);

    return () => clearTimeout(timeout);
  }, [showResumeDialog]);

  // No folder selected — show the picker
  if (!state.dirHandle) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <FolderPicker onFolderReady={handleFolderReady} />
      </div>
    );
  }

  // Folder selected — show sidebar + player area
  return (
    <PlayerContext.Provider value={contextValue}>
      <div className="min-h-screen h-screen bg-zinc-950 text-zinc-100 flex overflow-hidden">
        {/* Sidebar */}
        <aside className={`
          ${sidebarCollapsed ? 'w-0 overflow-hidden' : 'w-72'}
          shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col transition-all duration-200
        `}>
          {/* Folder header */}
          <div className="px-3 py-3 border-b border-zinc-800 flex items-center justify-between gap-2">
            <div className="truncate">
              <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Folder</p>
              <p className="text-sm text-zinc-200 truncate">{state.dirHandle.name}</p>
            </div>
            <button
              onClick={handleChangeFolder}
              className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              title="Change folder"
            >
              ✕
            </button>
          </div>

          {/* File count */}
          <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800/50">
            {state.playlist.length} file{state.playlist.length !== 1 ? 's' : ''} found
          </div>

          {/* Playlist */}
          <Playlist
            files={state.playlist}
            currentFile={state.currentFile}
            onFileSelect={play}
          />
        </aside>

        {/* Collapse toggle */}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className={`absolute left-0 top-1/2 -translate-y-1/2 z-10 p-1.5 bg-zinc-800/90 border border-zinc-700 rounded-r-md hover:bg-zinc-700 transition-all duration-200 cursor-pointer ${
            showToggle ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2 pointer-events-none'
          }`}
          style={{ left: sidebarCollapsed ? 0 : 288 }}
          title={sidebarCollapsed ? 'Show playlist' : 'Hide playlist'}
        >
          <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            {sidebarCollapsed ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            )}
          </svg>
        </button>

        {/* Main area — Player */}
        <Player />

        {/* Resume dialog */}
        {showResumeDialog && savedState && (
          <ResumeDialog
            state={savedState}
            onResume={handleResume}
            onDismiss={handleDismissResume}
            onSelectNewFolder={handleSelectNewFolder}
          />
        )}
      </div>
    </PlayerContext.Provider>
  );
}

export default App;
