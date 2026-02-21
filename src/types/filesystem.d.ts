// File System Access API type declarations
declare global {
    interface Window {
        showDirectoryPicker(options?: {
            mode?: 'read' | 'readwrite';
            startIn?: FileSystemHandle;
        }): Promise<FileSystemDirectoryHandle>;
    }

    interface FileSystemDirectoryHandle extends FileSystemHandle {
        kind: 'directory';
        values(): AsyncIterableIterator<FileSystemHandle>;
        getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
        getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
        removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
    }

    interface FileSystemFileHandle extends FileSystemHandle {
        kind: 'file';
        getFile(): Promise<File>;
        createWritable(): Promise<FileSystemWritableFileStream>;
    }

    interface FileSystemWritableFileStream extends WritableStream {
        write(data: string | BufferSource | Blob): Promise<void>;
        seek(position: number): Promise<void>;
        truncate(size: number): Promise<void>;
    }

    interface FileSystemHandle {
        name: string;
        kind: 'file' | 'directory';
        queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
        requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    }

    type FileSystemPermissionMode = 'read' | 'readwrite';
    type PermissionState = 'granted' | 'denied' | 'prompt';
}

export {};
