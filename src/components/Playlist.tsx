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
                            📁 {folder}
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
                                <span className="shrink-0 text-base">
                                    {isVideo ? '🎬' : '🎵'}
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
