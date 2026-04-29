import type { MediaFile, SortOrder } from '../types';

export function sortFiles(files: MediaFile[], order: SortOrder = 'name-asc'): MediaFile[] {
    return [...files].sort((a, b) => {
        switch (order) {
            case 'name-desc':
                return b.relativePath.localeCompare(a.relativePath);
            case 'date-desc':
                return (b.lastModified ?? 0) - (a.lastModified ?? 0);
            case 'date-asc':
                return (a.lastModified ?? 0) - (b.lastModified ?? 0);
            case 'type':
                if (a.type !== b.type) return a.type === 'video' ? -1 : 1;
                return a.relativePath.localeCompare(b.relativePath);
            default:
                return a.relativePath.localeCompare(b.relativePath);
        }
    });
}
