// Playlist.tsx — File list grouped by subfolder

import type { MediaFile } from '../types';

interface PlaylistProps {
    files: MediaFile[];
    currentFile: MediaFile | null;
    onFileSelect: (file: MediaFile) => void;
}

export default function Playlist({ files, currentFile, onFileSelect }: PlaylistProps) {
    // Group files by their parent folder
    const groups = groupByFolder(files);
    const folderNames = Object.keys(groups).sort();

    if (files.length === 0) {
        return (
            <div className="p-4 text-zinc-500 text-sm text-center">
                No media files found in this folder.
            </div>
        );
    }

    return (
        <div className="flex flex-col overflow-y-auto h-full">
            {folderNames.map((folder) => (
                <div key={folder}>
                    {/* Folder header — only show if there are subfolders */}
                    {folder !== '' && (
                        <div className="sticky top-0 px-3 py-1.5 text-xs font-semibold text-zinc-400 bg-zinc-900/90 backdrop-blur-sm border-b border-zinc-800/50">
                            <span className="inline-flex items-center gap-1">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
                  w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors cursor-pointer
                  ${isActive
                                        ? 'bg-indigo-600/20 text-indigo-300 border-l-2 border-indigo-500'
                                        : 'text-zinc-300 hover:bg-zinc-800/60 border-l-2 border-transparent'
                                    }
                `}
                            >
                                <span className="shrink-0">
                                    {isVideo ? (
                                        <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0118 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0 5.25C6 5.754 6.496 5.25 7.125 5.25h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0118 18.375M20.625 4.5c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h1.5m1.5 0c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M12 14.625v-1.5c0-.621.504-1.125 1.125-1.125m-2.25 0c.621 0 1.125.504 1.125 1.125v1.5m0-5.25c0 .621-.504 1.125-1.125 1.125M9.75 9.375c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-9.75 0V7.125c0-.621.504-1.125 1.125-1.125M6 12.75c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-9.75 0v-1.5c0-.621-.504-1.125-1.125-1.125M9 12.75h.008v.008H9V12.75z" />
                                        </svg>
                                    ) : (
                                        <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.479l.653-.315a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.479l.653-.315a2.25 2.25 0 001.632-2.163z" />
                                        </svg>
                                    )}
                                </span>
                                <span className="truncate">{file.name}</span>
                            </button>
                        );
                    })}
                </div>
            ))}
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
