// db.ts — IndexedDB utilities for persisting FileSystemDirectoryHandle and preferences

import type { FileTypePreferences } from '../types';

const DB_NAME = 'folderplayer';
const DB_VERSION = 2;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'lastFolder';
const PREFERENCES_KEY = 'preferences';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveHandle(
    handle: FileSystemDirectoryHandle
): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(handle, HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(HANDLE_KEY);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
    });
}

export async function requestPermission(
    handle: FileSystemDirectoryHandle
): Promise<boolean> {
    try {
        const opts = { mode: 'readwrite' as const };

        if ((await handle.queryPermission(opts)) === 'granted') {
            return true;
        }

        return (await handle.requestPermission(opts)) === 'granted';
    } catch {
        return false;
    }
}

export async function savePreferences(prefs: FileTypePreferences): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(prefs, PREFERENCES_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadPreferences(): Promise<FileTypePreferences | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(PREFERENCES_KEY);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
    });
}

export async function clearHandle(): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
