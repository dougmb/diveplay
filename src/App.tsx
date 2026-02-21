import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import FolderPicker from './components/FolderPicker';
import FallbackPicker from './components/FallbackPicker';
import Playlist from './components/Playlist';
import Player from './components/Player';
import ResumeDialog from './components/ResumeDialog';
import { PlayerContext, initialState } from './store/playerStore';
import type { PlayerStoreState } from './store/playerStore';
import { readState, writeState } from './services/fileSystem';
import { clearHandle } from './services/db';
import type { MediaFile, PlayerState } from './types';

function isFullSupportBrowser(): boolean {
  return 'showDirectoryPicker' in window;
}

function App() {
  const hasFullSupport = isFullSupportBrowser();
  const [state, setState] = useState<PlayerStoreState>(initialState);
  const [savedState, setSavedState] = useState<PlayerState | null>(null);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showToggle, setShowToggle] = useState(true);

  // Ref to always have the latest state for beforeunload / throttled writes
  const stateRef = useRef(state);

  const lastSaveTimeRef = useRef(0);

  // Keep ref in sync with state
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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

  const toggleSubtitles = useCallback(() => {
    setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        subtitles: { ...s.settings.subtitles, enabled: !s.settings.subtitles?.enabled },
      },
    }));
    saveCurrentState();
  }, [saveCurrentState]);

  const setSubtitleFontSize = useCallback((size: number) => {
    setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        subtitles: { ...s.settings.subtitles, fontSize: size },
      },
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

  // Show sidebar when mouse is near the left edge
  useEffect(() => {
    let timeout: number | undefined;

    const handleMouseMove = (e: MouseEvent) => {
      const isNearLeftEdge = e.clientX < 80;
      
      if (isNearLeftEdge) {
        setShowToggle(true);
        setSidebarCollapsed(false);
        if (timeout) clearTimeout(timeout);
        timeout = window.setTimeout(() => {
          setShowToggle(false);
        }, 3000);
      } else {
        // Only hide if sidebar is open and mouse is not interacting with it
        if (!sidebarCollapsed) {
          if (timeout) clearTimeout(timeout);
          timeout = window.setTimeout(() => {
            setSidebarCollapsed(true);
            setShowToggle(false);
          }, 2000);
        }
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (timeout) clearTimeout(timeout);
    };
  }, [sidebarCollapsed]);

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
    toggleSubtitles,
    setSubtitleFontSize,
    reset,
  }), [state, setPlaylist, setDirHandle, play, next, prev, setIsPlaying, setPosition, setDuration, setVolume, setSpeed, toggleShuffle, toggleLoop, toggleSubtitles, setSubtitleFontSize, reset]);

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
      }
    }
  };

  // Fallback handler for browsers without File System Access API
  const handleFallbackFiles = (mediaFiles: MediaFile[]) => {
    setState((s) => ({
      ...s,
      dirHandle: null,
      playlist: mediaFiles,
      currentFile: null,
      currentIndex: -1,
    }));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showResumeDialog]);

  // No folder selected — show the picker
  if (!state.dirHandle) {
    if (!hasFullSupport) {
      return (
        <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
          <FallbackPicker onFilesSelected={handleFallbackFiles} />
        </div>
      );
    }
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
          <div className="px-3 py-3 border-b border-zinc-800">
            <button
              onClick={handleChangeFolder}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white rounded-lg transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.06-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
              Open new folder
            </button>
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
          className={`absolute left-0 top-1/2 -translate-y-1/2 z-10 p-1.5 bg-zinc-800/90 border border-zinc-700 rounded-r-md hover:bg-zinc-700 transition-all duration-200 cursor-pointer ${showToggle ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2 pointer-events-none'
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
