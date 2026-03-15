// Playlist.tsx — File list grouped by subfolder with Search

import { useState, useMemo } from 'react';
import type { MediaFile } from '../types';

interface PlaylistProps {
    files: MediaFile[];
    currentFile: MediaFile | null;
    onFileSelect: (file: MediaFile) => void;
}

export default function Playlist({ files, currentFile, onFileSelect }: PlaylistProps) {
    const [searchQuery, setSearchQuery] = useState('');

    const filteredFiles = useMemo(() => {
        if (!searchQuery.trim()) return files;
        const query = searchQuery.toLowerCase();
        return files.filter(f => 
            f.name.toLowerCase().includes(query) || 
            f.relativePath.toLowerCase().includes(query)
        );
    }, [files, searchQuery]);

    const groups = groupByFolder(filteredFiles);
    const folderNames = Object.keys(groups).sort();

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Search Bar */}
            <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
                <div className="relative group">
                    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 group-focus-within:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search playlist..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-8 pr-8 py-1.5 bg-zinc-800 border border-zinc-700 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 rounded-md text-xs text-zinc-200 placeholder:text-zinc-600 outline-none transition-all"
                    />
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                        >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                {filteredFiles.length === 0 ? (
                    <div className="p-8 text-zinc-500 text-sm text-center">
                        {searchQuery ? 'No files match your search.' : 'No media files found in this folder.'}
                    </div>
                ) : (
                    folderNames.map((folder) => (
                        <div key={folder}>
                            {folder !== '' && (
                                <div className="sticky top-0 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500 bg-zinc-900/95 backdrop-blur-md border-b border-zinc-800/50 z-10">
                                    <span className="inline-flex items-center gap-1.5">
                                        <svg className="w-3 h-3 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.06-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                                        </svg>
                                        {folder}
                                    </span>
                                </div>
                            )}

                            {groups[folder].map((file) => {
                                const isActive = currentFile?.relativePath === file.relativePath;
                                const isVideo = file.type === 'video';

                                return (
                                    <button
                                        key={file.relativePath}
                                        onClick={() => onFileSelect(file)}
                                        className={`
                  w-full text-left px-3 py-2 flex items-center gap-2 text-xs transition-colors cursor-pointer group
                  ${isActive
                                                ? 'bg-indigo-600/15 text-indigo-300 border-l-2 border-indigo-500'
                                                : 'text-zinc-400 hover:bg-zinc-800/60 border-l-2 border-transparent hover:text-zinc-200'
                                            }
                `}
                                    >
                                        <span className="shrink-0">
                                            {isVideo ? (
                                                <svg className={`w-3.5 h-3.5 transition-colors ${isActive ? 'text-indigo-400' : 'text-zinc-600 group-hover:text-blue-400/70'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                </svg>
                                            ) : (
                                                <svg className={`w-3.5 h-3.5 transition-colors ${isActive ? 'text-indigo-400' : 'text-zinc-600 group-hover:text-purple-400/70'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                                                </svg>
                                            )}
                                        </span>
                                        <span className="truncate">{file.name}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

function groupByFolder(files: MediaFile[]): Record<string, MediaFile[]> {
    const groups: Record<string, MediaFile[]> = {};

    for (const file of files) {
        const lastSlash = file.relativePath.lastIndexOf('/');
        const folder = lastSlash === -1 ? '' : file.relativePath.slice(0, lastSlash);

        if (!groups[folder]) {
            groups[folder] = [];
        }
        groups[folder].push(file);
    }

    return groups;
}
